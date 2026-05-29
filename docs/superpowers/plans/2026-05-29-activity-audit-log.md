# F-2-2 Structured Activity Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the loose string-based `activity_log` write API with a typed `ActivityEvent` enum in folio-core, and add JSON-export and manual-prune commands — without changing the DB schema or the frontend `action`-string contract.

**Architecture:** A new `folio-core/src/activity.rs` defines `ActivityEvent` (one variant per real call site) and `ActivityFields`. `ActivityEvent::into_fields()` is the single source of truth mapping each variant to the exact legacy `(action, entity_type, entity_id, entity_name, detail)` values. `commands.rs` gains `log_event(conn, ActivityEvent)`, all 27 `log_activity` call sites migrate to typed variants, and the old free-string `log_activity` is removed. Two new Tauri commands (`export_activity_log`, `prune_activity_log`) wrap new/generalized db helpers.

**Tech Stack:** Rust, rusqlite, serde_json, chrono, uuid, Tauri v2. Tests use `tempfile`.

**Spec:** `docs/superpowers/specs/2026-05-29-activity-audit-log-design.md`

**Critical constraint:** The `action` and `entity_type` strings produced by `into_fields()` MUST exactly equal today's values — `src/components/ActivityLog.tsx` keys `ACTION_ICONS`, `ACTION_LABEL_KEYS`, and its filter dropdown off the raw `action` string. Any drift breaks the UI silently. No DB migration.

---

## Authoritative call-site → variant map

Derived from the 27 live `log_activity(...)` calls in `src-tauri/src/commands.rs`. This is the contract the enum must reproduce. `(action, entity_type, entity_id, entity_name, detail)`:

| Call site (line) | action | entity_type | entity_id | entity_name | detail |
|---|---|---|---|---|---|
| 1076 | `book_imported` | `book` | book.id | book.title | `format!("{} by {}", book.format, book.author)` |
| 1121 | `book_deleted` | `book` | book_id | existing title (Option) | None |
| 1431 | `book_updated` | `book` | book_id | book.title | dynamic `detail` |
| 1898 | `book_completed` | `book` | book_id | book.title | None |
| 2522 | `collection_created` | `collection` | collection.id | collection.name | None |
| 2587 | `collection_updated` | `collection` | collection.id | collection.name | None |
| 2608 | `collection_deleted` | `collection` | id | None | None |
| 2637 | `collection_modified` | `collection` | collection_id | None | `format!("Added book {}", book_id)` |
| 2656 | `collection_modified` | `collection` | collection_id | None | `format!("Removed book {}", book_id)` |
| 2827 | `book_enriched` | `book` | book_id | None | `"Enriched from OpenLibrary"` (fixed) |
| 3370 | `profile_switched` | `profile` | None | name | None |
| 3608 | `book_updated` | `book` | book.id | book.title | `"Copied to library"` |
| 3741 | `library_exported` | `library` | None | None | `export_detail` |
| 3864 | `library_imported` | `library` | None | None | `"Restored from backup"` |
| 4189 | `backup_completed` | `library` | None | None | dynamic provider summary |
| 4205 | `backup_failed` | `library` | None | None | dynamic provider/error |
| 4876 | `book_scanned` | `book` | book_id | updated_book.title | dynamic match summary |
| 4892 | `book_scanned` | `book` | book_id | book.title | dynamic "No match" |
| 5272 | `book_removed_cleanup` | `book` | book.id | book.title | None |
| 5454 | `sync_pull_success` | `book` | book_id | book.title | `summary` |
| 5481 | `sync_pull_failed` | `book` | book_id | book.title | `e.to_string()` |
| 5496 | `sync_pull_failed` | `book` | book_id | book.title | `"timeout after 5s"` |
| 5556 | `sync_push_success` | `book` | book_id | book_title | `"progress and annotations pushed"` |
| 5571 | `sync_push_failed` | `book` | book_id | book_title | `e.to_string()` |
| 5596 | `bulk_delete` | `book` | None | None | `format!("{} books deleted", n)` |
| 5691 | `bulk_edit` | `book` | None | None | `format!("{} books updated", count)` |
| 5808 | `web_server_modes_changed` | `system` | None | None | `format!("web_ui={web_ui} opds={opds}")` |

**Variant design rules** (from the table): book identity (id, title) is typed; free-form `detail` text stays a `String`/`Option<String>` carried by the variant (counts, error strings, summaries are inherently per-call). Fixed detail strings (`book_enriched`) bake into `into_fields()`. `book_deleted` title is `Option` (other call sites always have it). Sync variants carry `book_id` + `title` + `detail`.

---

## File Structure

- **Create** `folio-core/src/activity.rs` — `ActivityEvent`, `ActivityFields`, `into_fields()`, contract tests. Responsibility: typed event vocabulary + the action/entity wire-contract mapping.
- **Modify** `folio-core/src/lib.rs` — declare `pub mod activity;`.
- **Modify** `folio-core/src/db.rs` — generalize `prune_activity_log` signature; add `get_all_activity`; update 2 prune tests; add 1 age-param test.
- **Modify** `src-tauri/src/commands.rs` — add `log_event`; migrate 27 call sites; remove `log_activity`; add `export_activity_log` + `prune_activity_log` commands.
- **Modify** `src-tauri/src/lib.rs` — register the 2 new commands in `invoke_handler`.

---

### Task 1: `ActivityEvent` enum + `into_fields()` in folio-core

**Files:**
- Create: `folio-core/src/activity.rs`
- Modify: `folio-core/src/lib.rs` (add `pub mod activity;` after `pub mod db;` — keep alphabetical: insert before `pub mod backup;`? No — place `pub mod activity;` as the first module, line ~10, before `pub mod backup;`)

- [ ] **Step 1: Write the failing contract test**

Create `folio-core/src/activity.rs` with ONLY the test module first so it fails to compile (type not defined):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn f(e: ActivityEvent) -> ActivityFields {
        e.into_fields()
    }

    #[test]
    fn book_imported_maps_to_legacy_contract() {
        let r = f(ActivityEvent::BookImported {
            id: "b1".into(),
            title: "T".into(),
            format: "EPUB".into(),
            author: "A".into(),
        });
        assert_eq!(r.action, "book_imported");
        assert_eq!(r.entity_type, "book");
        assert_eq!(r.entity_id.as_deref(), Some("b1"));
        assert_eq!(r.entity_name.as_deref(), Some("T"));
        assert_eq!(r.detail.as_deref(), Some("EPUB by A"));
    }

    #[test]
    fn action_and_entity_strings_match_legacy_values() {
        // (event, expected action, expected entity_type)
        let cases: Vec<(ActivityEvent, &str, &str)> = vec![
            (ActivityEvent::BookImported { id: "i".into(), title: "t".into(), format: "f".into(), author: "a".into() }, "book_imported", "book"),
            (ActivityEvent::BookDeleted { id: "i".into(), title: Some("t".into()) }, "book_deleted", "book"),
            (ActivityEvent::BookUpdated { id: "i".into(), title: "t".into(), detail: "d".into() }, "book_updated", "book"),
            (ActivityEvent::BookCompleted { id: "i".into(), title: "t".into() }, "book_completed", "book"),
            (ActivityEvent::BookEnriched { id: "i".into() }, "book_enriched", "book"),
            (ActivityEvent::BookScanned { id: "i".into(), title: "t".into(), detail: "d".into() }, "book_scanned", "book"),
            (ActivityEvent::BookRemovedCleanup { id: "i".into(), title: "t".into() }, "book_removed_cleanup", "book"),
            (ActivityEvent::BulkEdit { count: 3 }, "bulk_edit", "book"),
            (ActivityEvent::BulkDelete { count: 3 }, "bulk_delete", "book"),
            (ActivityEvent::SyncPullSuccess { book_id: "i".into(), title: "t".into(), detail: "d".into() }, "sync_pull_success", "book"),
            (ActivityEvent::SyncPullFailed { book_id: "i".into(), title: "t".into(), detail: "d".into() }, "sync_pull_failed", "book"),
            (ActivityEvent::SyncPushSuccess { book_id: "i".into(), title: "t".into(), detail: "d".into() }, "sync_push_success", "book"),
            (ActivityEvent::SyncPushFailed { book_id: "i".into(), title: "t".into(), detail: "d".into() }, "sync_push_failed", "book"),
            (ActivityEvent::CollectionCreated { id: "i".into(), name: "n".into() }, "collection_created", "collection"),
            (ActivityEvent::CollectionUpdated { id: "i".into(), name: "n".into() }, "collection_updated", "collection"),
            (ActivityEvent::CollectionDeleted { id: "i".into() }, "collection_deleted", "collection"),
            (ActivityEvent::CollectionModified { id: "i".into(), detail: "d".into() }, "collection_modified", "collection"),
            (ActivityEvent::LibraryExported { detail: "d".into() }, "library_exported", "library"),
            (ActivityEvent::LibraryImported { detail: "d".into() }, "library_imported", "library"),
            (ActivityEvent::BackupCompleted { detail: "d".into() }, "backup_completed", "library"),
            (ActivityEvent::BackupFailed { detail: "d".into() }, "backup_failed", "library"),
            (ActivityEvent::ProfileSwitched { name: "n".into() }, "profile_switched", "profile"),
            (ActivityEvent::WebServerModesChanged { detail: "d".into() }, "web_server_modes_changed", "system"),
        ];
        for (event, action, entity) in cases {
            let r = event.into_fields();
            assert_eq!(r.action, action, "action mismatch for {action}");
            assert_eq!(r.entity_type, entity, "entity mismatch for {action}");
        }
    }

    #[test]
    fn enriched_detail_is_fixed_string() {
        let r = ActivityEvent::BookEnriched { id: "b".into() }.into_fields();
        assert_eq!(r.entity_name, None);
        assert_eq!(r.detail.as_deref(), Some("Enriched from OpenLibrary"));
    }

    #[test]
    fn collection_deleted_has_no_name_or_detail() {
        let r = ActivityEvent::CollectionDeleted { id: "c".into() }.into_fields();
        assert_eq!(r.entity_id.as_deref(), Some("c"));
        assert_eq!(r.entity_name, None);
        assert_eq!(r.detail, None);
    }

    #[test]
    fn bulk_delete_detail_formats_count() {
        let r = ActivityEvent::BulkDelete { count: 5 }.into_fields();
        assert_eq!(r.entity_id, None);
        assert_eq!(r.detail.as_deref(), Some("5 books deleted"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core activity::`
Expected: FAIL — `cannot find type ActivityEvent` / module empty (compile error).

- [ ] **Step 3: Implement the enum + mapping**

Prepend to `folio-core/src/activity.rs` (above the test module):

```rust
//! Typed activity-log events. `ActivityEvent::into_fields` is the single
//! source of truth for the `action`/`entity_type` strings consumed by the
//! frontend (`src/components/ActivityLog.tsx`). Do not change those strings
//! without updating the frontend in lockstep.

/// Resolved columns for one `activity_log` row.
pub struct ActivityFields {
    pub action: &'static str,
    pub entity_type: &'static str,
    pub entity_id: Option<String>,
    pub entity_name: Option<String>,
    pub detail: Option<String>,
}

/// A typed activity event. One variant per real call site action.
pub enum ActivityEvent {
    BookImported { id: String, title: String, format: String, author: String },
    BookDeleted { id: String, title: Option<String> },
    BookUpdated { id: String, title: String, detail: String },
    BookEnriched { id: String },
    BookScanned { id: String, title: String, detail: String },
    BookCompleted { id: String, title: String },
    BookRemovedCleanup { id: String, title: String },
    BulkEdit { count: usize },
    BulkDelete { count: usize },
    SyncPullSuccess { book_id: String, title: String, detail: String },
    SyncPullFailed { book_id: String, title: String, detail: String },
    SyncPushSuccess { book_id: String, title: String, detail: String },
    SyncPushFailed { book_id: String, title: String, detail: String },
    CollectionCreated { id: String, name: String },
    CollectionUpdated { id: String, name: String },
    CollectionDeleted { id: String },
    CollectionModified { id: String, detail: String },
    LibraryExported { detail: String },
    LibraryImported { detail: String },
    BackupCompleted { detail: String },
    BackupFailed { detail: String },
    ProfileSwitched { name: String },
    WebServerModesChanged { detail: String },
}

impl ActivityEvent {
    /// Map this event to the legacy activity_log columns. Consumes self so
    /// owned Strings move into the result without cloning.
    pub fn into_fields(self) -> ActivityFields {
        use ActivityEvent::*;
        match self {
            BookImported { id, title, format, author } => ActivityFields {
                action: "book_imported", entity_type: "book",
                entity_id: Some(id), entity_name: Some(title),
                detail: Some(format!("{format} by {author}")),
            },
            BookDeleted { id, title } => ActivityFields {
                action: "book_deleted", entity_type: "book",
                entity_id: Some(id), entity_name: title, detail: None,
            },
            BookUpdated { id, title, detail } => ActivityFields {
                action: "book_updated", entity_type: "book",
                entity_id: Some(id), entity_name: Some(title), detail: Some(detail),
            },
            BookEnriched { id } => ActivityFields {
                action: "book_enriched", entity_type: "book",
                entity_id: Some(id), entity_name: None,
                detail: Some("Enriched from OpenLibrary".to_string()),
            },
            BookScanned { id, title, detail } => ActivityFields {
                action: "book_scanned", entity_type: "book",
                entity_id: Some(id), entity_name: Some(title), detail: Some(detail),
            },
            BookCompleted { id, title } => ActivityFields {
                action: "book_completed", entity_type: "book",
                entity_id: Some(id), entity_name: Some(title), detail: None,
            },
            BookRemovedCleanup { id, title } => ActivityFields {
                action: "book_removed_cleanup", entity_type: "book",
                entity_id: Some(id), entity_name: Some(title), detail: None,
            },
            BulkEdit { count } => ActivityFields {
                action: "bulk_edit", entity_type: "book",
                entity_id: None, entity_name: None,
                detail: Some(format!("{count} books updated")),
            },
            BulkDelete { count } => ActivityFields {
                action: "bulk_delete", entity_type: "book",
                entity_id: None, entity_name: None,
                detail: Some(format!("{count} books deleted")),
            },
            SyncPullSuccess { book_id, title, detail } => ActivityFields {
                action: "sync_pull_success", entity_type: "book",
                entity_id: Some(book_id), entity_name: Some(title), detail: Some(detail),
            },
            SyncPullFailed { book_id, title, detail } => ActivityFields {
                action: "sync_pull_failed", entity_type: "book",
                entity_id: Some(book_id), entity_name: Some(title), detail: Some(detail),
            },
            SyncPushSuccess { book_id, title, detail } => ActivityFields {
                action: "sync_push_success", entity_type: "book",
                entity_id: Some(book_id), entity_name: Some(title), detail: Some(detail),
            },
            SyncPushFailed { book_id, title, detail } => ActivityFields {
                action: "sync_push_failed", entity_type: "book",
                entity_id: Some(book_id), entity_name: Some(title), detail: Some(detail),
            },
            CollectionCreated { id, name } => ActivityFields {
                action: "collection_created", entity_type: "collection",
                entity_id: Some(id), entity_name: Some(name), detail: None,
            },
            CollectionUpdated { id, name } => ActivityFields {
                action: "collection_updated", entity_type: "collection",
                entity_id: Some(id), entity_name: Some(name), detail: None,
            },
            CollectionDeleted { id } => ActivityFields {
                action: "collection_deleted", entity_type: "collection",
                entity_id: Some(id), entity_name: None, detail: None,
            },
            CollectionModified { id, detail } => ActivityFields {
                action: "collection_modified", entity_type: "collection",
                entity_id: Some(id), entity_name: None, detail: Some(detail),
            },
            LibraryExported { detail } => ActivityFields {
                action: "library_exported", entity_type: "library",
                entity_id: None, entity_name: None, detail: Some(detail),
            },
            LibraryImported { detail } => ActivityFields {
                action: "library_imported", entity_type: "library",
                entity_id: None, entity_name: None, detail: Some(detail),
            },
            BackupCompleted { detail } => ActivityFields {
                action: "backup_completed", entity_type: "library",
                entity_id: None, entity_name: None, detail: Some(detail),
            },
            BackupFailed { detail } => ActivityFields {
                action: "backup_failed", entity_type: "library",
                entity_id: None, entity_name: None, detail: Some(detail),
            },
            ProfileSwitched { name } => ActivityFields {
                action: "profile_switched", entity_type: "profile",
                entity_id: None, entity_name: Some(name), detail: None,
            },
            WebServerModesChanged { detail } => ActivityFields {
                action: "web_server_modes_changed", entity_type: "system",
                entity_id: None, entity_name: None, detail: Some(detail),
            },
        }
    }
}
```

Then add to `folio-core/src/lib.rs` — insert as the first `pub mod` (before `pub mod backup;` at line ~10):

```rust
pub mod activity;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p folio-core activity::`
Expected: PASS (6 tests). Then `cargo clippy -p folio-core -- -D warnings` clean.

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/activity.rs folio-core/src/lib.rs
git commit -m "feat(activity): add typed ActivityEvent enum with legacy field mapping"
```

---

### Task 2: Generalize `prune_activity_log` + add `get_all_activity`

**Files:**
- Modify: `folio-core/src/db.rs:1876` (`prune_activity_log`)
- Modify: `folio-core/src/db.rs` (add `get_all_activity` near `get_activity_log:1832`)
- Modify: `folio-core/src/db.rs:2650,2687` (update two existing prune tests) + add one new test

- [ ] **Step 1: Update existing tests + add age-param test (failing)**

In `folio-core/src/db.rs`, change the two existing prune calls to pass the new `max_age_days` argument:

- Line 2650: `prune_activity_log(&conn, 3).unwrap();` → `prune_activity_log(&conn, 3, 90).unwrap();`
- Line 2687: `prune_activity_log(&conn, 2).unwrap();` → `prune_activity_log(&conn, 2, 90).unwrap();`

Add a new test in the same `#[cfg(test)] mod tests` block (after `test_activity_log_age_pruning`, ~line 2693):

```rust
#[test]
fn test_prune_respects_custom_max_age_and_returns_count() {
    let (_dir, conn) = setup();
    let now = chrono::Utc::now().timestamp();
    // Two entries ~40 days old, outside keep=0.
    insert_activity(&conn, &sample_activity("a-40a", "import", now - 40 * 86400)).unwrap();
    insert_activity(&conn, &sample_activity("a-40b", "import", now - 41 * 86400)).unwrap();
    // One entry 5 days old.
    insert_activity(&conn, &sample_activity("a-5", "import", now - 5 * 86400)).unwrap();

    // keep=0, max_age_days=30 -> both 40-day rows pruned, 5-day row kept.
    let deleted = prune_activity_log(&conn, 0, 30).unwrap();
    assert_eq!(deleted, 2);

    let results = get_activity_log(&conn, 100, 0, None).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "a-5");
}

#[test]
fn test_get_all_activity_returns_all_newest_first() {
    let (_dir, conn) = setup();
    let now = chrono::Utc::now().timestamp();
    insert_activity(&conn, &sample_activity("g1", "import", now - 30)).unwrap();
    insert_activity(&conn, &sample_activity("g2", "import", now - 10)).unwrap();
    let all = get_all_activity(&conn).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, "g2");
    assert_eq!(all[1].id, "g1");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p folio-core activity_log` (and `get_all_activity`)
Expected: FAIL — arity mismatch on `prune_activity_log` / `get_all_activity` not found.

- [ ] **Step 3: Implement signature change + new helper**

Replace `prune_activity_log` (db.rs:1876-1883) with:

```rust
pub fn prune_activity_log(conn: &Connection, keep: u32, max_age_days: u32) -> Result<usize> {
    let cutoff = chrono::Utc::now().timestamp() - (max_age_days as i64) * 24 * 60 * 60;
    let deleted = conn.execute(
        "DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY timestamp DESC LIMIT ?1) AND timestamp < ?2",
        params![keep, cutoff],
    )?;
    Ok(deleted)
}
```

Add `get_all_activity` immediately after `get_activity_log` (after db.rs:1874):

```rust
pub fn get_all_activity(conn: &Connection) -> Result<Vec<ActivityEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, timestamp, action, entity_type, entity_id, entity_name, detail FROM activity_log ORDER BY timestamp DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ActivityEntry {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            action: row.get(2)?,
            entity_type: row.get(3)?,
            entity_id: row.get(4)?,
            entity_name: row.get(5)?,
            detail: row.get(6)?,
        })
    })?;
    rows.collect()
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p folio-core activity_log` then `cargo test -p folio-core get_all_activity`
Expected: PASS. Note: the src-tauri caller still calls the old 2-arg form — that breaks the `folio` crate build, fixed in Task 3. Do NOT build src-tauri yet; this task is scoped to folio-core.

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): parameterize prune_activity_log max-age and add get_all_activity"
```

---

### Task 3: `log_event` + migrate all 27 call sites + remove `log_activity`

**Files:**
- Modify: `src-tauri/src/commands.rs:341-363` (replace `log_activity` with `log_event`)
- Modify: `src-tauri/src/commands.rs` (27 call sites listed in the map above)

- [ ] **Step 1: Replace the helper**

Replace `log_activity` (commands.rs:341-363) with:

```rust
fn log_event(conn: &rusqlite::Connection, event: folio_core::activity::ActivityEvent) {
    let f = event.into_fields();
    let entry = crate::models::ActivityEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        action: f.action.to_string(),
        entity_type: f.entity_type.to_string(),
        entity_id: f.entity_id,
        entity_name: f.entity_name,
        detail: f.detail,
    };
    let _ = db::insert_activity(conn, &entry);
    let _ = db::prune_activity_log(conn, 1000, 90);
}
```

- [ ] **Step 2: Migrate each call site**

Replace each `log_activity(...)` with the matching `log_event(conn, ActivityEvent::Variant{..})`. Use `folio_core::activity::ActivityEvent` (add `use folio_core::activity::ActivityEvent;` near the top of commands.rs to shorten). The connection expression (`&tx`, `&conn`, `&log_conn`, `&bg_conn`) is preserved per call site. Concrete replacements:

```rust
// 1076
log_event(&tx, ActivityEvent::BookImported { id: book.id.clone(), title: book.title.clone(), format: book.format.to_string(), author: book.author.clone() });
// 1121
log_event(&conn, ActivityEvent::BookDeleted { id: book_id.clone(), title: existing_book.as_ref().map(|b| b.title.clone()) });
// 1431
log_event(&conn, ActivityEvent::BookUpdated { id: book_id.clone(), title: book.title.clone(), detail });
// 1898
log_event(&conn, ActivityEvent::BookCompleted { id: book_id.clone(), title: book.title.clone() });
// 2522
log_event(&conn, ActivityEvent::CollectionCreated { id: collection.id.clone(), name: collection.name.clone() });
// 2587
log_event(&conn, ActivityEvent::CollectionUpdated { id: collection.id.clone(), name: collection.name.clone() });
// 2608
log_event(&conn, ActivityEvent::CollectionDeleted { id: id.clone() });
// 2637
log_event(&conn, ActivityEvent::CollectionModified { id: collection_id.clone(), detail: format!("Added book {}", book_id) });
// 2656
log_event(&conn, ActivityEvent::CollectionModified { id: collection_id.clone(), detail: format!("Removed book {}", book_id) });
// 2827
log_event(&conn, ActivityEvent::BookEnriched { id: book_id.clone() });
// 3370
log_event(&conn, ActivityEvent::ProfileSwitched { name: name.clone() });
// 3608
log_event(&conn, ActivityEvent::BookUpdated { id: book.id.clone(), title: book.title.clone(), detail: "Copied to library".to_string() });
// 3741
log_event(&conn, ActivityEvent::LibraryExported { detail: export_detail.to_string() });
// 3864
log_event(&conn, ActivityEvent::LibraryImported { detail: "Restored from backup".to_string() });
// 4189 (preserve the existing format! body verbatim as the detail)
log_event(&log_conn, ActivityEvent::BackupCompleted { detail: format!("Provider: {:?} — {} books, {} bookmarks, {} highlights pushed", /* same args as today */) });
// 4205
log_event(&log_conn, ActivityEvent::BackupFailed { detail: format!("Provider: {:?} — {}", provider_name, e) });
// 4876 (preserve existing format! body)
log_event(&conn, ActivityEvent::BookScanned { id: book_id.clone(), title: updated_book.title.clone(), detail: format!("Matched via {} (searched: {})", /* same args */) });
// 4892
log_event(&conn, ActivityEvent::BookScanned { id: book_id.clone(), title: book.title.clone(), detail: format!("No match found (searched: {})", tried) });
// 5272
log_event(&conn, ActivityEvent::BookRemovedCleanup { id: book.id.clone(), title: book.title.clone() });
// 5454
log_event(&conn, ActivityEvent::SyncPullSuccess { book_id: book_id.clone(), title: book.title.clone(), detail: summary.clone() });
// 5481
log_event(&conn, ActivityEvent::SyncPullFailed { book_id: book_id.clone(), title: book.title.clone(), detail: e.to_string() });
// 5496
log_event(&conn, ActivityEvent::SyncPullFailed { book_id: book_id.clone(), title: book.title.clone(), detail: "timeout after 5s".to_string() });
// 5556
log_event(&bg_conn, ActivityEvent::SyncPushSuccess { book_id: book_id.clone(), title: book_title.clone(), detail: "progress and annotations pushed".to_string() });
// 5571
log_event(&bg_conn, ActivityEvent::SyncPushFailed { book_id: book_id.clone(), title: book_title.clone(), detail: e.to_string() });
// 5596
log_event(&conn, ActivityEvent::BulkDelete { count: book_ids.len() });
// 5691
log_event(&conn, ActivityEvent::BulkEdit { count });
// 5808
log_event(&conn, ActivityEvent::WebServerModesChanged { detail: format!("web_ui={web_ui} opds={opds}") });
```

> For lines 4189 and 4876 the original `format!` spans multiple lines — copy the exact format string and argument list from the current code into the `detail:` field; do not paraphrase. `.clone()` is added where the original passed `&local` borrows of values still used later; if a value is not used after the call, move it without `.clone()` to satisfy clippy. Resolve any borrow/move errors the compiler reports — the original `Some(&x)` borrows become owned `String`s.

- [ ] **Step 3: Confirm no `log_activity` callers remain**

Run: `grep -rn "log_activity" src-tauri/src/`
Expected: no matches (helper renamed, all call sites migrated). If any remain, migrate them.

- [ ] **Step 4: Build + test**

Run (with the macOS Tahoe header env if needed):
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
```
Expected: builds; all tests pass; clippy clean (no `unused`/`needless_clone`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(activity): migrate all log_activity call sites to typed log_event"
```

---

### Task 4: `export_activity_log` + `prune_activity_log` commands + registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (add two `#[tauri::command]` fns near `get_activity_log:5014`)
- Modify: `src-tauri/src/lib.rs:256-360` (register both in `generate_handler!`)
- Test: integration test in `src-tauri/src/commands.rs` test module (db-level round-trip via a tempfile DB)

- [ ] **Step 1: Write failing export round-trip test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/commands.rs` (find existing test module; if none, create `#[cfg(test)] mod tests { use super::*; ... }` at end of file). The test exercises the db + serde path directly (commands need Tauri `State`, so test the underlying logic):

```rust
#[test]
fn export_activity_log_writes_parseable_json() {
    use folio_core::db;
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("t.db")).unwrap();
    db::run_schema(&conn).unwrap();

    log_event(&conn, folio_core::activity::ActivityEvent::BookImported {
        id: "b1".into(), title: "Title".into(), format: "EPUB".into(), author: "Auth".into(),
    });

    let rows = db::get_all_activity(&conn).unwrap();
    let dest = dir.path().join("activity.json");
    std::fs::write(&dest, serde_json::to_string_pretty(&rows).unwrap()).unwrap();

    let parsed: Vec<folio_core::models::ActivityEntry> =
        serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].action, "book_imported");
    assert_eq!(parsed[0].detail.as_deref(), Some("EPUB by Auth"));
}
```

> Confirm `db::run_schema` is the schema-init function name (it is per CLAUDE.md). If `ActivityEntry` lacks `Deserialize`, the test won't compile — in that case deserialize into `serde_json::Value` and assert on `parsed.as_array().unwrap().len()` and `parsed[0]["action"]`.

- [ ] **Step 2: Run to verify failure/compile-check**

Run: `cd src-tauri && cargo test export_activity_log_writes_parseable_json`
Expected: compiles and PASSES already if `get_all_activity` + `log_event` exist (this test is a guard, not strictly red-first since it uses existing helpers). If it fails, fix the helper usage before proceeding.

- [ ] **Step 3: Add the two commands**

Add after `get_activity_log` (commands.rs:5027):

```rust
#[tauri::command]
pub async fn export_activity_log(
    dest_path: String,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;
    let rows = db::get_all_activity(&conn)?;
    let json = serde_json::to_string_pretty(&rows).map_err(|e| {
        crate::error::FolioError::from(e) // if a From<serde_json::Error> exists; else map to a string variant
    })?;
    std::fs::write(&dest_path, json)?;
    Ok(dest_path)
}

#[tauri::command]
pub async fn prune_activity_log(
    keep: Option<u32>,
    max_age_days: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<usize> {
    let conn = state.active_db()?.get()?;
    let deleted = db::prune_activity_log(&conn, keep.unwrap_or(1000), max_age_days.unwrap_or(90))?;
    Ok(deleted)
}
```

> Match the error-conversion pattern already used by neighboring commands (e.g. how `export_library` maps `serde_json`/`std::io` errors into `FolioError`). If `FolioError` already has `#[from]` impls for `serde_json::Error` and `std::io::Error`, the `?` operator works directly and the explicit `.map_err` is unnecessary — prefer the existing pattern. Inspect `src-tauri/src/error.rs` / `folio_core::error` before writing this and follow it exactly.

- [ ] **Step 4: Register commands**

In `src-tauri/src/lib.rs`, add inside `generate_handler![ ... ]` (next to `commands::get_activity_log` at line 351):

```rust
            commands::export_activity_log,
            commands::prune_activity_log,
```

- [ ] **Step 5: Full build + test + lint**

Run:
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
cd .. && cargo test -p folio-core && npm run type-check
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(activity): add export_activity_log and prune_activity_log commands"
```

---

## Self-Review

**Spec coverage:**
- Typed enum / same columns → Task 1. ✓
- All 27 call sites migrated, old API removed → Task 3 (+ grep guard). ✓
- JSON export command returning path → Task 4. ✓
- Generalized prune (age+count) + command, returns count → Task 2 + Task 4. ✓
- No schema migration, frontend contract preserved → Task 1 contract test asserts exact action/entity strings. ✓
- Backend only, no enum serde, keep detail → reflected (detail baked/passed in `into_fields`; no `derive(Serialize)` on enum). ✓
- folio-core emits no UUID/time (kept in `log_event`) → library/binary hygiene preserved. ✓

**Placeholder scan:** No TBD/TODO. The two notes (error-conversion pattern, multi-line `format!` bodies) instruct the implementer to copy existing exact code rather than leaving blanks — acceptable because the source is the current file, cited by line.

**Type consistency:** `ActivityEvent` variant field names/types in Task 1 match the constructions in Task 3 and the test in Task 4. `prune_activity_log(conn, keep, max_age_days) -> usize` consistent across Tasks 2/4. `get_all_activity(conn) -> Result<Vec<ActivityEntry>>` consistent across Tasks 2/4.
