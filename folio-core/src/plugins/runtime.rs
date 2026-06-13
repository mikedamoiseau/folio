//! Rhai script runtime for plugins (spec §4.4).
//!
//! One engine per plugin, built at load time with ONLY the host functions
//! the user granted — an ungranted capability is not an authorization error,
//! it simply does not exist in the script's namespace. Execution is bounded
//! by an operation budget and a wall-clock watchdog; a misbehaving script
//! aborts its invocation, never the app.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rhai::{Array, Dynamic, Engine, EvalAltResult, Map as RhaiMap, Scope, AST};

use super::permissions::Permission;
use crate::db::{self, DbPool};
use crate::error::{FolioError, FolioResult};
use crate::events::FolioEvent;
use crate::models::Book;

/// Capabilities that only the embedding app can provide (OS notifications…).
/// `folio-core` stays UI-free; the desktop shell injects an implementation.
pub trait HostServices: Send + Sync {
    fn notify(&self, title: &str, body: &str);
}

/// Everything host functions may need, injected at load time.
#[derive(Clone)]
pub struct RuntimeDeps {
    pub pool: DbPool,
    pub services: Arc<dyn HostServices>,
}

/// A loaded, compiled plugin script with its capability-scoped engine.
pub struct PluginRuntime {
    engine: Engine,
    ast: AST,
    /// Reset before every dispatch; read by the engine's progress hook.
    invocation_start: Arc<Mutex<Instant>>,
}

impl PluginRuntime {
    /// Operation budget per invocation (spec §4.4).
    pub const MAX_OPERATIONS: u64 = 1_000_000;
    /// Wall-clock budget per invocation (spec §4.4).
    pub const MAX_WALL_CLOCK: Duration = Duration::from_secs(5);
    /// Cap on strings a script can build (spec §4.4).
    pub const MAX_STRING_SIZE: usize = 1024 * 1024;
    /// Call-depth cap (spec §4.4).
    pub const MAX_CALL_LEVELS: usize = 64;

    /// Compile `script` with host functions for exactly `granted`.
    pub fn load(script: &str, granted: &[Permission], deps: RuntimeDeps) -> FolioResult<Self> {
        let mut engine = Engine::new();
        engine.set_max_operations(Self::MAX_OPERATIONS);
        engine.set_max_call_levels(Self::MAX_CALL_LEVELS);
        engine.set_max_string_size(Self::MAX_STRING_SIZE);
        engine.disable_symbol("eval");

        let invocation_start = Arc::new(Mutex::new(Instant::now()));
        let watchdog_start = Arc::clone(&invocation_start);
        engine.on_progress(move |_ops| {
            let start = *watchdog_start
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if start.elapsed() > Self::MAX_WALL_CLOCK {
                Some("wall-clock budget exceeded".into())
            } else {
                None
            }
        });

        for permission in granted {
            register_host_fns(&mut engine, *permission, &deps);
        }

        let ast = engine
            .compile(script)
            .map_err(|e| FolioError::invalid(format!("script compile error: {e}")))?;

        Ok(Self {
            engine,
            ast,
            invocation_start,
        })
    }

    /// Run the script's `on_event(event)` for one event. Errors when the
    /// script has no `on_event`, throws, or exceeds its budgets.
    pub fn dispatch(&self, event: &FolioEvent) -> FolioResult<()> {
        *self
            .invocation_start
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();

        let mut scope = Scope::new();
        self.engine
            .call_fn::<()>(&mut scope, &self.ast, "on_event", (event_to_map(event),))
            .map_err(|e| FolioError::internal(format!("plugin dispatch error: {e}")))
    }
}

/// Register the host functions one permission unlocks. Capability scoping
/// happens HERE: an ungranted permission's functions are never registered,
/// so calling one is a function-not-found error inside the script.
fn register_host_fns(engine: &mut Engine, permission: Permission, deps: &RuntimeDeps) {
    match permission {
        Permission::ReadLibrary => {
            let pool = deps.pool.clone();
            engine.register_fn(
                "get_book",
                move |id: &str| -> Result<Dynamic, Box<EvalAltResult>> {
                    let conn = pool.get().map_err(host_err)?;
                    Ok(match db::get_book(&conn, id).map_err(host_err)? {
                        Some(book) => Dynamic::from_map(book_to_map(&book)),
                        None => Dynamic::UNIT,
                    })
                },
            );
            let pool = deps.pool.clone();
            engine.register_fn(
                "find_books",
                move |query: &str| -> Result<Array, Box<EvalAltResult>> {
                    let conn = pool.get().map_err(host_err)?;
                    let needle = query.to_lowercase();
                    Ok(db::list_books(&conn)
                        .map_err(host_err)?
                        .iter()
                        .filter(|b| {
                            b.title.to_lowercase().contains(&needle)
                                || b.author.to_lowercase().contains(&needle)
                        })
                        .take(50)
                        .map(|b| Dynamic::from_map(book_to_map(b)))
                        .collect())
                },
            );
        }
        Permission::WriteTags => {
            let pool = deps.pool.clone();
            engine.register_fn(
                "add_tag",
                move |book_id: &str, name: &str| -> Result<(), Box<EvalAltResult>> {
                    let conn = pool.get().map_err(host_err)?;
                    let tag_id = match db::get_tag_by_name(&conn, name).map_err(host_err)? {
                        Some(id) => id,
                        None => {
                            let id = uuid::Uuid::new_v4().to_string();
                            db::get_or_create_tag(&conn, &id, name).map_err(host_err)?;
                            id
                        }
                    };
                    db::add_tag_to_book(&conn, book_id, &tag_id).map_err(host_err)
                },
            );
            let pool = deps.pool.clone();
            engine.register_fn(
                "remove_tag",
                move |book_id: &str, name: &str| -> Result<(), Box<EvalAltResult>> {
                    let conn = pool.get().map_err(host_err)?;
                    if let Some(tag_id) = db::get_tag_by_name(&conn, name).map_err(host_err)? {
                        db::remove_tag_from_book(&conn, book_id, &tag_id).map_err(host_err)?;
                    }
                    Ok(())
                },
            );
        }
        Permission::Notify => {
            let services = Arc::clone(&deps.services);
            engine.register_fn("notify", move |title: &str, body: &str| {
                services.notify(title, body);
            });
        }
        // Host functions for these arrive in M3/M4 (spec §6); granting them
        // today registers nothing — deny-by-default stays intact.
        Permission::ReadHighlights
        | Permission::WriteMetadata
        | Permission::WriteFiles
        | Permission::Network
        | Permission::ImportBooks => {}
    }
}

fn host_err(e: impl std::fmt::Display) -> Box<EvalAltResult> {
    e.to_string().into()
}

/// Convert an event to the map handed to `on_event`. Every map carries a
/// `type` key matching [`FolioEvent::name`]; payload fields keep their
/// Rust names.
pub fn event_to_map(event: &FolioEvent) -> RhaiMap {
    let mut map = RhaiMap::new();
    map.insert("type".into(), event.name().into());
    match event {
        FolioEvent::AppStarted => {}
        FolioEvent::BookImported {
            book_id,
            format,
            source,
        } => {
            map.insert("book_id".into(), book_id.clone().into());
            map.insert("format".into(), format.to_string().into());
            map.insert("source".into(), format!("{source:?}").into());
        }
        FolioEvent::BookOpened { book_id }
        | FolioEvent::BookClosed { book_id }
        | FolioEvent::BookFinished { book_id } => {
            map.insert("book_id".into(), book_id.clone().into());
        }
        FolioEvent::HighlightCreated {
            book_id,
            highlight_id,
        } => {
            map.insert("book_id".into(), book_id.clone().into());
            map.insert("highlight_id".into(), highlight_id.clone().into());
        }
        FolioEvent::HighlightUpdated { highlight_id }
        | FolioEvent::HighlightDeleted { highlight_id } => {
            map.insert("highlight_id".into(), highlight_id.clone().into());
        }
        FolioEvent::BookmarkCreated {
            book_id,
            bookmark_id,
        } => {
            map.insert("book_id".into(), book_id.clone().into());
            map.insert("bookmark_id".into(), bookmark_id.clone().into());
        }
        FolioEvent::MetadataEnriched { book_id, provider } => {
            map.insert("book_id".into(), book_id.clone().into());
            map.insert("provider".into(), provider.clone().into());
        }
        FolioEvent::BackupCompleted { provider, success } => {
            map.insert("provider".into(), provider.clone().into());
            map.insert("success".into(), (*success).into());
        }
        FolioEvent::SyncCompleted { direction, success } => {
            map.insert("direction".into(), format!("{direction:?}").into());
            map.insert("success".into(), (*success).into());
        }
    }
    map
}

fn book_to_map(book: &Book) -> RhaiMap {
    let mut map = RhaiMap::new();
    map.insert("id".into(), book.id.clone().into());
    map.insert("title".into(), book.title.clone().into());
    map.insert("author".into(), book.author.clone().into());
    map.insert("format".into(), book.format.to_string().into());
    map.insert("total_chapters".into(), (book.total_chapters as i64).into());
    map.insert(
        "series".into(),
        book.series.clone().map(Into::into).unwrap_or(Dynamic::UNIT),
    );
    map.insert(
        "volume".into(),
        book.volume
            .map(|v| Dynamic::from(v as i64))
            .unwrap_or(Dynamic::UNIT),
    );
    map.insert(
        "language".into(),
        book.language
            .clone()
            .map(Into::into)
            .unwrap_or(Dynamic::UNIT),
    );
    map.insert(
        "rating".into(),
        book.rating.map(Dynamic::from).unwrap_or(Dynamic::UNIT),
    );
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::ImportSource;
    use crate::models::BookFormat;

    struct MockServices {
        notes: Mutex<Vec<(String, String)>>,
    }

    impl HostServices for MockServices {
        fn notify(&self, title: &str, body: &str) {
            self.notes
                .lock()
                .unwrap()
                .push((title.to_string(), body.to_string()));
        }
    }

    struct Fixture {
        deps: RuntimeDeps,
        services: Arc<MockServices>,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&dir.path().join("t.db")).unwrap();
        let services = Arc::new(MockServices {
            notes: Mutex::new(Vec::new()),
        });
        Fixture {
            deps: RuntimeDeps {
                pool,
                services: services.clone(),
            },
            services,
            _dir: dir,
        }
    }

    fn sample_book(id: &str, title: &str, author: &str) -> Book {
        Book {
            id: id.into(),
            title: title.into(),
            author: author.into(),
            file_path: format!("{id}.epub"),
            cover_path: None,
            total_chapters: 10,
            added_at: 0,
            format: BookFormat::Epub,
            file_hash: None,
            description: None,
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: true,
        }
    }

    fn imported(book_id: &str) -> FolioEvent {
        FolioEvent::BookImported {
            book_id: book_id.into(),
            format: BookFormat::Epub,
            source: ImportSource::Manual,
        }
    }

    #[test]
    fn event_map_carries_type_and_payload_fields() {
        let map = event_to_map(&imported("b1"));
        assert_eq!(map["type"].clone().into_string().unwrap(), "BookImported");
        assert_eq!(map["book_id"].clone().into_string().unwrap(), "b1");
        assert_eq!(map["format"].clone().into_string().unwrap(), "epub");
        assert_eq!(map["source"].clone().into_string().unwrap(), "Manual");

        let map = event_to_map(&FolioEvent::SyncCompleted {
            direction: crate::events::SyncDirection::Push,
            success: false,
        });
        assert_eq!(map["type"].clone().into_string().unwrap(), "SyncCompleted");
        assert_eq!(map["direction"].clone().into_string().unwrap(), "Push");
        assert!(!map["success"].as_bool().unwrap());
    }

    #[test]
    fn granted_notify_reaches_host_services() {
        let f = fixture();
        let rt = PluginRuntime::load(
            r#"fn on_event(event) { notify("hi", event.type); }"#,
            &[Permission::Notify],
            f.deps.clone(),
        )
        .unwrap();

        rt.dispatch(&imported("b1")).unwrap();
        assert_eq!(
            f.services.notes.lock().unwrap().as_slice(),
            &[("hi".to_string(), "BookImported".to_string())]
        );
    }

    #[test]
    fn ungranted_function_is_absent_from_scope() {
        let f = fixture();
        let rt = PluginRuntime::load(
            r#"fn on_event(event) { notify("hi", "there"); }"#,
            &[], // notify NOT granted
            f.deps.clone(),
        )
        .unwrap();

        let err = rt.dispatch(&imported("b1")).unwrap_err().to_string();
        assert!(err.contains("notify"), "got: {err}");
        assert!(f.services.notes.lock().unwrap().is_empty());
    }

    #[test]
    fn get_book_returns_map_and_unit_for_missing() {
        let f = fixture();
        {
            let conn = f.deps.pool.get().unwrap();
            db::insert_book(&conn, &sample_book("b1", "Dune", "Herbert")).unwrap();
        }
        let rt = PluginRuntime::load(
            r#"fn on_event(event) {
                let b = get_book(event.book_id);
                notify(b.title, b.author);
                let missing = get_book("nope");
                if missing == () { notify("missing", "unit"); }
            }"#,
            &[Permission::ReadLibrary, Permission::Notify],
            f.deps.clone(),
        )
        .unwrap();

        rt.dispatch(&imported("b1")).unwrap();
        let notes = f.services.notes.lock().unwrap();
        assert_eq!(notes[0], ("Dune".to_string(), "Herbert".to_string()));
        assert_eq!(notes[1], ("missing".to_string(), "unit".to_string()));
    }

    #[test]
    fn find_books_filters_by_title_or_author() {
        let f = fixture();
        {
            let conn = f.deps.pool.get().unwrap();
            db::insert_book(&conn, &sample_book("b1", "Dune", "Frank Herbert")).unwrap();
            db::insert_book(&conn, &sample_book("b2", "Hyperion", "Dan Simmons")).unwrap();
            db::insert_book(&conn, &sample_book("b3", "Dune Messiah", "Frank Herbert")).unwrap();
        }
        let rt = PluginRuntime::load(
            r#"fn on_event(event) {
                let dune = find_books("dune");
                notify("dune", dune.len().to_string());
                let herbert = find_books("herbert");
                notify("herbert", herbert.len().to_string());
            }"#,
            &[Permission::ReadLibrary, Permission::Notify],
            f.deps.clone(),
        )
        .unwrap();

        rt.dispatch(&imported("b1")).unwrap();
        let notes = f.services.notes.lock().unwrap();
        assert_eq!(notes[0].1, "2");
        assert_eq!(notes[1].1, "2");
    }

    #[test]
    fn add_and_remove_tag_mutate_db() {
        let f = fixture();
        {
            let conn = f.deps.pool.get().unwrap();
            db::insert_book(&conn, &sample_book("b1", "Dune", "Herbert")).unwrap();
        }
        let rt = PluginRuntime::load(
            r#"fn on_event(event) {
                add_tag(event.book_id, "sci-fi");
                add_tag(event.book_id, "epic");
                remove_tag(event.book_id, "epic");
            }"#,
            &[Permission::WriteTags],
            f.deps.clone(),
        )
        .unwrap();

        rt.dispatch(&imported("b1")).unwrap();
        let conn = f.deps.pool.get().unwrap();
        let tags: Vec<String> = db::get_book_tags(&conn, "b1")
            .unwrap()
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        assert_eq!(tags, vec!["sci-fi"]);
    }

    #[test]
    fn runaway_script_is_aborted_by_budget() {
        let f = fixture();
        let rt = PluginRuntime::load(
            r#"fn on_event(event) { let x = 0; loop { x += 1; } }"#,
            &[],
            f.deps.clone(),
        )
        .unwrap();

        let start = Instant::now();
        assert!(rt.dispatch(&imported("b1")).is_err());
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "budget did not abort the loop in time"
        );
    }

    #[test]
    fn script_without_on_event_errors_on_dispatch() {
        let f = fixture();
        let rt = PluginRuntime::load(r#"fn other() { 1 }"#, &[], f.deps.clone()).unwrap();
        let err = rt.dispatch(&imported("b1")).unwrap_err().to_string();
        assert!(err.contains("on_event"), "got: {err}");
    }

    #[test]
    fn syntax_error_fails_at_load() {
        let f = fixture();
        assert!(PluginRuntime::load("fn on_event(e) {", &[], f.deps).is_err());
    }
}
