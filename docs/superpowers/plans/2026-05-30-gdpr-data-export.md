# F-3-6 GDPR Data Export Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated `GET /api/data-export` web endpoint that returns a timestamped ZIP containing the user's personal data (books metadata, reading progress, bookmarks, highlights, activity log, and redacted settings).

**Architecture:** A shared `build_core_export` helper in `folio-core` produces the common metadata JSON object (reused by the existing desktop `export_library`). A web handler in `web_server/api.rs` extends that object with the activity log and a redacted settings map, zips it in memory, and streams it back. The endpoint sits behind the existing `auth_middleware` (not in its allowlist), so it requires an authenticated session.

**Tech Stack:** Rust, axum, rusqlite, serde_json, zip, chrono.

**Spec:** `docs/superpowers/specs/2026-05-30-gdpr-data-export-design.md`

**Pre-flight notes for the implementer:**
- `folio_status` (`web_server/mod.rs:84`) maps any `E: Into<FolioError>` to `(StatusCode, String)`. `FolioError` already has `From` impls for `serde_json::Error` and `zip::result::ZipError` (the desktop `export_library` relies on these), so `.map_err(folio_status)` works for db, serde, and zip errors.
- The folio-core db test module (`folio-core/src/db.rs`) has a helper `fn setup() -> (tempfile::TempDir, Connection)` — use it: `let (_tmp, conn) = setup();`.
- Run folio-core tests from the **workspace root**: `cargo test -p folio-core`. Run web/binary tests from `src-tauri/`: `cargo test`.

---

### Task 1: Shared `build_core_export` helper + refactor desktop export

**Files:**
- Modify: `folio-core/src/db.rs` (add `build_core_export`; add test in the `#[cfg(test)]` module)
- Modify: `src-tauri/src/commands.rs:3603-3650` (refactor `export_library` to call it)

- [ ] **Step 1: Write the failing test** in the `folio-core/src/db.rs` tests module (alongside the other `#[test]` fns):

```rust
    #[test]
    fn build_core_export_has_expected_keys() {
        let (_tmp, conn) = setup();
        let value = build_core_export(&conn).expect("build_core_export");
        let obj = value.as_object().expect("export is a JSON object");
        for key in [
            "version",
            "books",
            "reading_progress",
            "bookmarks",
            "highlights",
            "collections",
            "tags",
            "book_tags",
        ] {
            assert!(obj.contains_key(key), "missing key: {key}");
        }
        assert_eq!(obj["version"], 1);
        assert!(obj["books"].is_array());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run (from workspace root): `cargo test -p folio-core build_core_export_has_expected_keys`
Expected: FAIL — `cannot find function 'build_core_export'`.

- [ ] **Step 3: Add `build_core_export`** to `folio-core/src/db.rs` (place it near the other read helpers, e.g. just after `list_books`):

```rust
/// Build the metadata object shared by the desktop library export and the
/// web GDPR export: version + books, reading progress, bookmarks, highlights,
/// collections, tags, and book→tag links.
pub fn build_core_export(conn: &Connection) -> Result<serde_json::Value> {
    let books = list_books(conn)?;
    let progress: Vec<_> = books
        .iter()
        .filter_map(|b| get_reading_progress(conn, &b.id).ok().flatten())
        .collect();
    let bookmarks: Vec<_> = books
        .iter()
        .flat_map(|b| list_bookmarks(conn, &b.id).unwrap_or_default())
        .collect();
    let highlights: Vec<_> = books
        .iter()
        .flat_map(|b| list_highlights(conn, &b.id).unwrap_or_default())
        .collect();
    let collections = list_collections(conn)?;
    let tags = list_tags(conn)?;
    let book_tags: Vec<(String, String, String)> = books
        .iter()
        .flat_map(|b| {
            get_book_tags(conn, &b.id)
                .unwrap_or_default()
                .into_iter()
                .map(|(tag_id, tag_name)| (b.id.clone(), tag_id, tag_name))
                .collect::<Vec<_>>()
        })
        .collect();

    Ok(serde_json::json!({
        "version": 1,
        "books": books,
        "reading_progress": progress,
        "bookmarks": bookmarks,
        "highlights": highlights,
        "collections": collections,
        "tags": tags,
        "book_tags": book_tags,
    }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core build_core_export_has_expected_keys`
Expected: PASS.

- [ ] **Step 5: Refactor `export_library`** in `src-tauri/src/commands.rs`. Replace the metadata-gathering block (currently lines ~3604–3650: the `let books = ...` fetch, the `progress`/`bookmarks`/`highlights`/`collections`/`tags`/`book_tags` collects, the `let metadata = serde_json::json!({...})`, and the `let metadata_json = serde_json::to_string_pretty(&metadata)?;`) so that section reads:

```rust
    let conn = state.active_db()?.get()?;
    let books = db::list_books(&conn)?;
    let metadata = db::build_core_export(&conn)?;

    let file = std::fs::File::create(&dest_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Add metadata JSON
    let metadata_json = serde_json::to_string_pretty(&metadata)?;
    zip.start_file("library.json", options)?;
    zip.write_all(metadata_json.as_bytes())?;
```

Leave everything after this (the `include_files` book/cover loop, `zip.finish()`, the `log_event(... LibraryExported ...)`, and `Ok(dest_path)`) unchanged. `books` is still used by the file loop; `metadata` is now a `serde_json::Value` and `to_string_pretty` works on it identically.

- [ ] **Step 6: Verify desktop export still compiles & tests pass**

Run (from `src-tauri/`): `cargo test export`
Expected: PASS (existing export/import tests unchanged).
Run (from `src-tauri/`): `cargo clippy -- -D warnings`
Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add folio-core/src/db.rs src-tauri/src/commands.rs
git commit -m "feat(export): extract shared build_core_export helper"
```

---

### Task 2: `list_settings` db helper

**Files:**
- Modify: `folio-core/src/db.rs` (add `list_settings`; add test)

- [ ] **Step 1: Write the failing test** in the `folio-core/src/db.rs` tests module:

```rust
    #[test]
    fn list_settings_round_trips() {
        let (_tmp, conn) = setup();
        set_setting(&conn, "import_mode", "copy").unwrap();
        set_setting(&conn, "web_server_port", "1421").unwrap();

        let settings = list_settings(&conn).expect("list_settings");
        assert!(settings.contains(&("import_mode".to_string(), "copy".to_string())));
        assert!(settings.contains(&("web_server_port".to_string(), "1421".to_string())));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core list_settings_round_trips`
Expected: FAIL — `cannot find function 'list_settings'`.

- [ ] **Step 3: Add `list_settings`** to `folio-core/src/db.rs` (place it right after `get_setting`):

```rust
/// Return every row of the `settings` table as `(key, value)` pairs,
/// ordered by key.
pub fn list_settings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core list_settings_round_trips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add list_settings helper"
```

---

### Task 3: GDPR export endpoint (`GET /api/data-export`)

**Files:**
- Modify: `src-tauri/src/web_server/api.rs` (add denylist const, `build_gdpr_export`, `export_datestamp`, `log_export_event`, `data_export` handler, route registration; add tests)

- [ ] **Step 1: Write the failing redaction unit test** in the `api.rs` `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn gdpr_export_redacts_backup_config() {
        // `run_schema` is private to folio-core; build a schema-migrated
        // in-memory connection through the pool helper (same as `test_state`).
        let pool = crate::db::create_pool(&std::path::PathBuf::from(":memory:")).unwrap();
        let conn = pool.get().unwrap();
        db::set_setting(&conn, "backup_config", "{\"secret\":\"x\"}").unwrap();
        db::set_setting(&conn, "import_mode", "copy").unwrap();

        let value = build_gdpr_export(&conn).expect("build_gdpr_export");
        let settings = value["settings"].as_object().expect("settings object");
        assert!(
            !settings.contains_key("backup_config"),
            "backup_config must be redacted"
        );
        assert_eq!(settings["import_mode"], "copy");
        assert!(value["activity_log"].is_array());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `src-tauri/`): `cargo test web_server::api::tests::gdpr_export_redacts_backup_config`
Expected: FAIL — `cannot find function 'build_gdpr_export'`.

- [ ] **Step 3: Implement the builder, helpers, and handler** in `src-tauri/src/web_server/api.rs`.

Add these items near the top of the file (after the existing `use` lines):

```rust
/// Settings keys excluded from the GDPR export. Defense-in-depth: live secrets
/// (web PIN, backup credentials) are stored in the OS keyring, not in settings,
/// but `backup_config` can carry remote endpoint details or pre-keyring secret
/// values, so it is never exported.
const EXPORT_SETTINGS_DENYLIST: &[&str] = &["backup_config"];

/// Build the full GDPR export document: the shared core metadata plus the
/// activity log and a redacted settings map.
fn build_gdpr_export(
    conn: &rusqlite::Connection,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let mut value = db::build_core_export(conn).map_err(folio_status)?;

    let activity = db::get_activity_log(conn, 100_000, 0, None).map_err(folio_status)?;
    let activity_val = serde_json::to_value(activity).map_err(folio_status)?;

    let settings: serde_json::Map<String, serde_json::Value> = db::list_settings(conn)
        .map_err(folio_status)?
        .into_iter()
        .filter(|(k, _)| !EXPORT_SETTINGS_DENYLIST.contains(&k.as_str()))
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();

    if let Some(obj) = value.as_object_mut() {
        obj.insert("activity_log".to_string(), activity_val);
        obj.insert("settings".to_string(), serde_json::Value::Object(settings));
    }
    Ok(value)
}

/// Current UTC date as `YYYYMMDD`, used for the export filenames.
fn export_datestamp() -> String {
    chrono::Utc::now().format("%Y%m%d").to_string()
}

/// Best-effort: record the export in the activity log. A failure is logged and
/// swallowed so it never fails the download (mirrors the login-audit pattern).
fn log_export_event(conn: &rusqlite::Connection) {
    use folio_core::activity::ActivityEvent;
    let f = ActivityEvent::LibraryExported {
        detail: "GDPR data export (web)".to_string(),
    }
    .into_fields();
    let entry = crate::models::ActivityEntry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        action: f.action.to_string(),
        entity_type: f.entity_type.to_string(),
        entity_id: f.entity_id,
        entity_name: f.entity_name,
        detail: f.detail,
    };
    if let Err(e) = db::insert_activity(conn, &entry) {
        tracing::warn!(error = %e, "failed to log GDPR export to activity log");
    }
}

async fn data_export(
    State(state): State<WebState>,
) -> Result<Response, (StatusCode, String)> {
    use std::io::Write;

    let conn = state.conn().map_err(folio_status)?;
    let value = build_gdpr_export(&conn)?;
    let json = serde_json::to_string_pretty(&value).map_err(folio_status)?;

    let date = export_datestamp();
    let inner_name = format!("folio-export-{date}.json");
    let zip_name = format!("folio-export-{date}.zip");

    let buf = {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(&inner_name, options).map_err(folio_status)?;
        zip.write_all(json.as_bytes()).map_err(folio_status)?;
        zip.finish().map_err(folio_status)?.into_inner()
    };

    log_export_event(&conn);

    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{zip_name}\""),
            ),
        ],
        buf,
    )
        .into_response())
}
```

Register the route in `routes()` (`api.rs:15`) — add the line immediately after the `/audit/login-history` route:

```rust
        .route("/audit/login-history", get(login_history))
        .route("/data-export", get(data_export))
        .with_state(state)
```

- [ ] **Step 4: Run the redaction test to verify it passes**

Run (from `src-tauri/`): `cargo test web_server::api::tests::gdpr_export_redacts_backup_config`
Expected: PASS.

- [ ] **Step 5: Write the integration tests** in the **`web_server/mod.rs`** `#[cfg(test)] mod tests` block — *not* in `api.rs`. The HTTP tests only exercise the public endpoint, and `mod.rs`'s test module already has `test_state`, `build_router`, `ServerModes`, `auth`, `SocketAddr`, `reqwest`, and `oneshot` in scope (mirror the existing `test_login_sets_cookie` test). Add:

```rust
    #[tokio::test]
    async fn data_export_requires_auth() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let router = build_router(
            state,
            ServerModes { web_ui: true, opds: true },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async { let _ = rx.await; })
            .await
            .ok();
        });

        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/data-export"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        let _ = tx.send(());
    }

    #[tokio::test]
    async fn data_export_returns_zip_for_authed_request() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let router = build_router(
            state,
            ServerModes { web_ui: true, opds: true },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async { let _ = rx.await; })
            .await
            .ok();
        });

        // Authenticate via HTTP Basic Auth (PIN as password).
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/data-export"))
            .basic_auth("folio", Some("1234"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/zip"
        );
        let disp = resp
            .headers()
            .get("content-disposition")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(disp.contains("folio-export-"));
        assert!(disp.ends_with(".zip\""));

        // The body is a valid ZIP whose single entry parses as JSON with the
        // activity_log and settings sections.
        let bytes = resp.bytes().await.unwrap();
        let reader = std::io::Cursor::new(bytes.to_vec());
        let mut archive = zip::ZipArchive::new(reader).expect("valid zip");
        assert_eq!(archive.len(), 1);
        let mut entry = archive.by_index(0).unwrap();
        assert!(entry.name().starts_with("folio-export-"));
        assert!(entry.name().ends_with(".json"));
        let mut contents = String::new();
        std::io::Read::read_to_string(&mut entry, &mut contents).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("valid json");
        assert!(parsed["books"].is_array());
        assert!(parsed["activity_log"].is_array());
        assert!(parsed["settings"].is_object());

        let _ = tx.send(());
    }
```

- [ ] **Step 6: Run the integration tests**

Run (from `src-tauri/`): `cargo test web_server::tests::data_export`
Expected: PASS for both `data_export_requires_auth` and `data_export_returns_zip_for_authed_request`.

- [ ] **Step 7: Full local CI gate**

Run (from `src-tauri/`): `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
Run (from workspace root): `cargo test -p folio-core`
Run (from project root): `npm run type-check`
Expected: all green. (No frontend or MOBI code touched, so no `--features mobi` run needed — but it is harmless to include.)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/web_server/api.rs src-tauri/src/web_server/mod.rs
git commit -m "feat(web): add GDPR data export endpoint (F-3-6)"
```

---

## After all tasks

- [ ] Dispatch a final code reviewer for the whole branch.
- [ ] Run `~/bin/pr-review.sh --no-branch --description "F-3-6 GDPR data export endpoint"`. Do not modify code while that script runs. Antigravity may return empty output (judge by Codex + CI).
- [ ] Update `docs/USER_GUIDE.md` Section 12 (Remote Access) with a short "Data export" subsection: `GET /api/data-export` returns a timestamped ZIP of your library metadata, reading progress, bookmarks, highlights, activity log, and settings (backup credentials excluded); requires an authenticated session.
- [ ] Update the F-3-6 row in `.claude/reports/20260525-research-team-main.md` decisions table.
- [ ] Use superpowers:finishing-a-development-branch.
```
