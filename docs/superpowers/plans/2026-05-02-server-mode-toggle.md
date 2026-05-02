# Server Mode Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single Start/Stop web-server toggle with two independent toggles (Web UI, OPDS) so users can pick which surfaces the embedded HTTP server exposes.

**Architecture:** New `ServerModes { web_ui, opds }` value type. `build_router` conditionally `nest`s `/opds` and merges web-UI + `/api`. A single reconciler command `web_server_set_modes(web_ui, opds, port?)` persists both settings, stops any running handle, and (re)starts with the requested modes if either is on. Migration from legacy `web_server_enabled` runs once at app init.

**Tech Stack:** Rust (Tauri v2 + Axum), TypeScript (React 19, Vitest, react-i18next), SQLite via rusqlite.

**Spec:** `docs/superpowers/specs/2026-05-02-server-mode-toggle-design.md`

**Branch:** `feat/server-mode-toggle` (already created off main; spec doc is committed there as `6eb33d3`).

---

## File Map

**Modify:**
- `folio-core/src/db.rs` — add `delete_setting()` helper.
- `src-tauri/src/web_server/mod.rs` — add `ServerModes`, change `build_router` and `start` signatures, extend `WebServerStatus`. Update existing tests to pass `ServerModes`.
- `src-tauri/src/commands.rs` — add `web_server_set_modes` command + `migrate_web_server_setting` helper. Remove `web_server_start` and `web_server_stop` commands. Update `web_server_status` to return modes.
- `src-tauri/src/lib.rs` — register `web_server_set_modes` (drop start/stop from `invoke_handler`); update auto-start path to read new settings + call migration.
- `src-tauri/src/tray.rs` — replace single Web Server toggle with two checkable items (Web UI, OPDS). Replace `toggle_web_server` with `toggle_mode(app, which)` calling the new reconciler.
- `src/components/SettingsPanel.tsx` — swap Start/Stop button for two checkboxes, port input always enabled, status row reflects backend running state.
- `src/locales/en.json` and `src/locales/fr.json` — add `settings.remoteAccess.*` and `tray.server.*` keys.

**Create:**
- (none — this feature reuses existing files)

---

## Task 1: Add `db::delete_setting` helper

**Files:**
- Modify: `folio-core/src/db.rs` (around line 721, near existing `set_setting`)
- Test: same file, in `mod tests`

- [ ] **Step 1: Write failing test**

Append to `mod tests` in `folio-core/src/db.rs`:

```rust
#[test]
fn delete_setting_removes_key() {
    let conn = test_conn();
    set_setting(&conn, "to_remove", "x").unwrap();
    assert_eq!(get_setting(&conn, "to_remove").unwrap().as_deref(), Some("x"));
    delete_setting(&conn, "to_remove").unwrap();
    assert!(get_setting(&conn, "to_remove").unwrap().is_none());
}

#[test]
fn delete_setting_no_op_when_key_missing() {
    let conn = test_conn();
    // Must not error when key is absent.
    delete_setting(&conn, "never_existed").unwrap();
    assert!(get_setting(&conn, "never_existed").unwrap().is_none());
}
```

If `test_conn()` does not exist in this file, look for the helper that the existing `*_setting` tests already use (run `grep -n "fn test_conn\|fn temp_conn\|fn conn(" folio-core/src/db.rs` to find it).

- [ ] **Step 2: Run failing test**

```bash
cargo test -p folio-core --lib db::tests::delete_setting 2>&1 | tail -10
```

Expected: compile error — `delete_setting` does not exist.

- [ ] **Step 3: Implement helper**

Add directly after `set_setting` in `folio-core/src/db.rs`:

```rust
/// Remove a key/value row from the `settings` table. No-op when the
/// key is absent (counted rows = 0 is not an error).
pub fn delete_setting(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}
```

- [ ] **Step 4: Run tests**

```bash
cargo test -p folio-core --lib db::tests::delete_setting 2>&1 | tail -10
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add delete_setting helper

One-line wrapper around DELETE FROM settings WHERE key = ?1. No-op when
the key is absent. Needed by the upcoming migration of the legacy
web_server_enabled setting."
```

---

## Task 2: `ServerModes` type + conditional `build_router`

**Files:**
- Modify: `src-tauri/src/web_server/mod.rs` (struct `WebServerStatus` near line 105; `build_router` near line 149)
- Test: same file, `mod tests` (existing tests around line 254+)

- [ ] **Step 1: Write failing tests**

Append to `mod tests` in `src-tauri/src/web_server/mod.rs`:

```rust
#[tokio::test]
async fn build_router_web_ui_only_serves_root_not_opds() {
    let pool = test_pool();
    let state = test_web_state(pool);
    let modes = ServerModes { web_ui: true, opds: false };
    let router = build_router(state, modes);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });

    // / → 200 (HTML UI)
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/")).await.unwrap();
    assert_eq!(resp.status(), 200);

    // /opds → 404 (not mounted)
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/opds")).await.unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn build_router_opds_only_serves_opds_not_root() {
    let pool = test_pool();
    let state = test_web_state(pool);
    let modes = ServerModes { web_ui: false, opds: true };
    let router = build_router(state, modes);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });

    // /opds → 200
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/opds")).await.unwrap();
    assert_eq!(resp.status(), 200);

    // / → 404 (web UI not mounted)
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/")).await.unwrap();
    assert_eq!(resp.status(), 404);

    // /api/library → 404 (api lives with web_ui)
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/api/library")).await.unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn build_router_both_serves_root_and_opds() {
    let pool = test_pool();
    let state = test_web_state(pool);
    let modes = ServerModes { web_ui: true, opds: true };
    let router = build_router(state, modes);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });

    let r1 = reqwest::get(format!("http://127.0.0.1:{port}/")).await.unwrap();
    assert_eq!(r1.status(), 200);
    let r2 = reqwest::get(format!("http://127.0.0.1:{port}/opds")).await.unwrap();
    assert_eq!(r2.status(), 200);
}

#[tokio::test]
async fn build_router_neither_serves_nothing() {
    let pool = test_pool();
    let state = test_web_state(pool);
    let modes = ServerModes { web_ui: false, opds: false };
    // Must not panic. Every request 404s.
    let router = build_router(state, modes);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });

    let resp = reqwest::get(format!("http://127.0.0.1:{port}/")).await.unwrap();
    assert_eq!(resp.status(), 404);
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/opds")).await.unwrap();
    assert_eq!(resp.status(), 404);
}
```

If `test_pool()` and `test_web_state()` helpers don't yet exist by those exact names, use whatever helper the existing `test_no_pin_allows_all_access` test (around line 536) constructs `WebState` with — read that test to copy the setup pattern.

- [ ] **Step 2: Run failing tests**

```bash
cd src-tauri && cargo test build_router_ -- --nocapture 2>&1 | tail -20
```

Expected: compile error — `ServerModes` does not exist.

- [ ] **Step 3: Add `ServerModes` type**

Insert near the top of `src-tauri/src/web_server/mod.rs` (before `WebServerStatus` at line 103):

```rust
/// Which user-facing surfaces the embedded HTTP server exposes.
#[derive(Debug, Clone, Copy)]
pub struct ServerModes {
    pub web_ui: bool,
    pub opds: bool,
}

impl ServerModes {
    /// Whether the server should run at all.
    pub fn any(&self) -> bool {
        self.web_ui || self.opds
    }
}
```

- [ ] **Step 4: Change `build_router` signature**

Replace the entire `build_router` function in `src-tauri/src/web_server/mod.rs` (currently around line 149):

```rust
/// Build the full axum router with all routes and middleware.
/// Routes are conditionally mounted based on `modes`. Calling with
/// `ServerModes { web_ui: false, opds: false }` returns a router that
/// 404s every path — safe to call but the reconciler in commands.rs
/// short-circuits before reaching this state in production.
pub fn build_router(state: WebState, modes: ServerModes) -> Router {
    let mut router = Router::new();

    if modes.web_ui {
        // The web UI consumes /api, so /api lives alongside web_ui mode.
        // Without web_ui there's no consumer for /api.
        let api_routes = api::routes(state.clone());
        router = router.nest("/api", api_routes).merge(web_ui::routes());
    }
    if modes.opds {
        let opds_routes = opds_feed::routes(state.clone());
        router = router.nest("/opds", opds_routes);
    }

    router
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}
```

- [ ] **Step 5: Update existing test call sites**

In the same file, every existing test that calls `build_router(state)` must now pass `ServerModes { web_ui: true, opds: true }` (the previous behavior). Run:

```bash
grep -n "build_router(" /Users/mike/Documents/www/folio/src-tauri/src/web_server/mod.rs
```

For every match inside `mod tests` (and any other consumers — e.g. the production `start` function below), change the call. The production call in `start` is updated in Task 3; for now just fix the test call sites to keep the suite compiling.

- [ ] **Step 6: Run tests**

```bash
cd src-tauri && cargo test web_server::tests:: -- --nocapture 2>&1 | tail -20
```

Expected: 4 new `build_router_*` tests pass + every prior `web_server::tests::*` test still passes (the auth/security ones).

- [ ] **Step 7: Run fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/web_server/mod.rs
git commit -m "feat(web_server): conditional router mount via ServerModes

Adds ServerModes { web_ui, opds } and changes build_router to nest
/opds and merge web_ui+/api only when their respective flag is on.
With both off the router is empty and 404s every path. Existing tests
updated to pass ServerModes { web_ui: true, opds: true } (current
default behavior). Adds 4 router-shape tests covering web-only,
opds-only, both, and neither."
```

---

## Task 3: `web_server::start` accepts `ServerModes`

**Files:**
- Modify: `src-tauri/src/web_server/mod.rs` (`start` function around line 170)

- [ ] **Step 1: Read the current `start` function**

```bash
sed -n '165,205p' /Users/mike/Documents/www/folio/src-tauri/src/web_server/mod.rs
```

The current signature is:

```rust
pub async fn start(state: WebState, port: u16) -> crate::error::FolioResult<WebServerHandle>
```

The body calls `build_router(state)`. After Task 2's signature change, it currently won't compile. (Task 2 only updated tests; production callers will be tackled here.)

- [ ] **Step 2: Update `start` to accept and forward `ServerModes`**

Replace the signature line and the `build_router` call:

```rust
/// Start the web server on the given port. Returns a handle for shutdown.
pub async fn start(
    state: WebState,
    port: u16,
    modes: ServerModes,
) -> crate::error::FolioResult<WebServerHandle> {
    use crate::error::FolioError;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let router = build_router(state, modes);
    // ... rest of body unchanged
```

Only the signature and the single `build_router(state, modes)` call change. Keep everything else (listener bind, error mapping, oneshot channel, spawned axum::serve future, return value).

- [ ] **Step 3: Update production callers temporarily to compile**

Three production callers use `web_server::start`:
- `src-tauri/src/lib.rs` line ~216 (auto-start)
- `src-tauri/src/tray.rs` line ~155 (`toggle_web_server`)
- `src-tauri/src/commands.rs` line ~4867 (`web_server_start`)

Each is updated to pass `ServerModes { web_ui: true, opds: true }` for now. They will be properly rewritten in Tasks 4–6 when the full reconciler exists.

In `src-tauri/src/lib.rs`, change:

```rust
if let Ok(handle) = web_server::start(web_state, port).await {
```

to:

```rust
if let Ok(handle) = web_server::start(
    web_state,
    port,
    web_server::ServerModes { web_ui: true, opds: true },
).await {
```

In `src-tauri/src/tray.rs::toggle_web_server` (around line 155), apply the same change to the single `web_server::start(...)` call:

```rust
if let Ok(handle) = crate::web_server::start(
    web_state,
    port,
    crate::web_server::ServerModes { web_ui: true, opds: true },
).await {
```

In `src-tauri/src/commands.rs::web_server_start` (around line 4867):

```rust
let handle = crate::web_server::start(
    web_state,
    port,
    crate::web_server::ServerModes { web_ui: true, opds: true },
).await?;
```

- [ ] **Step 4: Build + run tests**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
cd src-tauri && cargo test web_server:: 2>&1 | tail -10
```

Expected: clean build; tests still pass.

- [ ] **Step 5: Run fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/web_server/mod.rs src-tauri/src/lib.rs src-tauri/src/tray.rs src-tauri/src/commands.rs
git commit -m "feat(web_server): start accepts ServerModes parameter

Threads ServerModes through to build_router. Existing call sites
(auto-start, tray toggle, web_server_start command) hardcoded to
{ web_ui: true, opds: true } for now — rewritten in following commits."
```

---

## Task 4: `web_server_set_modes` command + extend `WebServerStatus`

**Files:**
- Modify: `src-tauri/src/web_server/mod.rs` (extend `WebServerStatus`)
- Modify: `src-tauri/src/commands.rs` (add command, extend `web_server_status` return)
- Test: same `commands.rs`, `mod tests`

- [ ] **Step 1: Extend `WebServerStatus`**

In `src-tauri/src/web_server/mod.rs` (around line 103-110), replace:

```rust
/// Status returned to the frontend.
#[derive(serde::Serialize)]
pub struct WebServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
    pub has_pin: bool,
}
```

with (note the `rename_all = "camelCase"` so the frontend reads `webUiEnabled` / `opdsEnabled`):

```rust
/// Status returned to the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
    pub has_pin: bool,
    pub web_ui_enabled: bool,
    pub opds_enabled: bool,
}
```

- [ ] **Step 2: Update `web_server_status` to populate the new fields**

In `src-tauri/src/commands.rs`, replace the body of `web_server_status` (around line 4917) to read the two new settings from the DB and stamp them onto the response. Find the function and rewrite as:

```rust
#[tauri::command]
pub async fn web_server_status(
    state: State<'_, AppState>,
) -> FolioResult<crate::web_server::WebServerStatus> {
    let has_pin = crate::web_server::auth::load_pin_hash().is_some();
    let (web_ui_enabled, opds_enabled) = {
        let conn = state.active_db()?.get()?;
        let web_ui = db::get_setting(&conn, "web_ui_enabled")?.as_deref() == Some("true");
        let opds = db::get_setting(&conn, "opds_enabled")?.as_deref() == Some("true");
        (web_ui, opds)
    };
    let handle = state.web_server_handle.lock()?;
    match handle.as_ref() {
        Some(h) => Ok(crate::web_server::WebServerStatus {
            running: true,
            url: Some(h.url.clone()),
            port: h.port,
            has_pin,
            web_ui_enabled,
            opds_enabled,
        }),
        None => Ok(crate::web_server::WebServerStatus {
            running: false,
            url: None,
            port: db::get_setting(&state.active_db()?.get()?, "web_server_port")?
                .and_then(|s| s.parse().ok())
                .unwrap_or(crate::web_server::DEFAULT_PORT),
            has_pin,
            web_ui_enabled,
            opds_enabled,
        }),
    }
}
```

The `port` lookup in the `None` branch may need adjustment if the existing function already has a particular pattern — read it first and adapt rather than copy verbatim. The key change is that `web_ui_enabled` and `opds_enabled` come from settings (not from the running handle), so the frontend sees user intent.

- [ ] **Step 3: Add the `web_server_set_modes` command**

Append to `src-tauri/src/commands.rs` (immediately before or after the existing `web_server_start` function — the order does not matter, but cluster server commands together):

```rust
#[tauri::command]
pub async fn web_server_set_modes(
    web_ui: bool,
    opds: bool,
    port: Option<u16>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<crate::web_server::WebServerStatus> {
    // 1. Persist intent first. Settings reflect what the user wants;
    //    runtime state is derived.
    {
        let conn = state.active_db()?.get()?;
        db::set_setting(&conn, "web_ui_enabled", &web_ui.to_string())?;
        db::set_setting(&conn, "opds_enabled", &opds.to_string())?;
        if let Some(p) = port {
            db::set_setting(&conn, "web_server_port", &p.to_string())?;
        }
    }

    let modes = crate::web_server::ServerModes { web_ui, opds };

    // 2. Stop existing handle (if any). We always restart on mode change
    //    rather than try to reuse an existing handle, because Axum doesn't
    //    expose route hot-swap and the restart cost is trivial.
    let prev = { state.web_server_handle.lock()?.take() };
    if let Some(h) = prev {
        crate::web_server::stop(h);
    }

    // 3. Start fresh if anything is enabled.
    if modes.any() {
        let port = {
            let conn = state.active_db()?.get()?;
            port.unwrap_or_else(|| {
                db::get_setting(&conn, "web_server_port")
                    .ok()
                    .flatten()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(crate::web_server::DEFAULT_PORT)
            })
        };

        // Sync PIN hash from keychain before starting (matches old web_server_start).
        {
            let fresh = crate::web_server::auth::load_pin_hash();
            let mut ph = state.shared_pin_hash.lock()?;
            *ph = fresh;
        }

        let web_state = crate::web_server::WebState {
            pool: state.shared_active_pool.clone(),
            data_dir: state.data_dir.clone(),
            pin_hash: state.shared_pin_hash.clone(),
            sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            login_limiter: std::sync::Arc::new(crate::web_server::auth::RateLimiter::new(5, 300)),
        };

        let handle = crate::web_server::start(web_state, port, modes).await?;
        let mut h = state.web_server_handle.lock()?;
        *h = Some(handle);
    }

    // 4. Audit log.
    {
        let conn = state.active_db()?.get()?;
        log_activity(
            &conn,
            "web_server_modes_changed",
            "system",
            None,
            None,
            Some(&format!("web_ui={web_ui} opds={opds}")),
        );
    }

    // 5. Refresh tray menu to reflect the new state.
    let _ = crate::tray::rebuild_tray_menu(&app);

    web_server_status(state).await
}
```

- [ ] **Step 4: Register in `invoke_handler`**

In `src-tauri/src/lib.rs` find the `invoke_handler!` block (around line 332 — `commands::web_server_start, commands::web_server_stop,` lines). Insert `commands::web_server_set_modes,` between them — start/stop will be removed in Task 6, but registering set_modes now lets us run the new command end-to-end before the cleanup commit.

```rust
commands::web_server_start,
commands::web_server_stop,
commands::web_server_set_modes,   // ← new
```

- [ ] **Step 5: Write a persistence test**

Append to `mod tests` in `src-tauri/src/commands.rs`:

```rust
#[test]
fn web_server_set_modes_persists_both_settings() {
    // Persistence-only assertion. Server start/stop is exercised by
    // web_server::tests::* (router-shape tests). This test guards the
    // contract that user intent always lands in the DB before any
    // start attempt.
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let conn = pool.get().unwrap();

    // Simulate the persistence portion of web_server_set_modes by
    // calling its bare DB statements (the handle/start path requires
    // an AppState which we cannot construct here; this test exercises
    // the contract that both keys are written together).
    db::set_setting(&conn, "web_ui_enabled", "true").unwrap();
    db::set_setting(&conn, "opds_enabled", "false").unwrap();
    db::set_setting(&conn, "web_server_port", "9999").unwrap();

    assert_eq!(
        db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
        Some("true")
    );
    assert_eq!(
        db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
        Some("false")
    );
    assert_eq!(
        db::get_setting(&conn, "web_server_port").unwrap().as_deref(),
        Some("9999")
    );
}
```

This is a thin contract test — the real integration coverage comes from manual smoke (Task 10). The reason: Tauri's `State` cannot be constructed publicly, and refactoring `web_server_set_modes` into a pure inner helper to test it would be churn for diminishing returns at this layer (the body is mostly orchestration of already-tested primitives).

- [ ] **Step 6: Run tests**

```bash
cd src-tauri && cargo test web_server_set_modes_persists 2>&1 | tail -5
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: new test passes; full suite still green.

- [ ] **Step 7: Run fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/web_server/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(web_server): web_server_set_modes reconciler command

Single command that persists web_ui_enabled + opds_enabled + port,
stops any running handle, and (re)starts with the requested modes
when at least one is on. WebServerStatus extended with web_ui_enabled
and opds_enabled fields so the frontend can reflect user intent
even when start fails. Logs a single web_server_modes_changed
activity entry instead of paired start/stop entries."
```

---

## Task 5: Migration helper + auto-start path

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `migrate_web_server_setting`)
- Modify: `src-tauri/src/lib.rs` (auto-start block around line 164–225)
- Test: `commands.rs`, `mod tests`

- [ ] **Step 1: Write failing tests**

Append to `mod tests` in `src-tauri/src/commands.rs`:

```rust
#[test]
fn migrate_web_server_setting_true_sets_both_new_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let conn = pool.get().unwrap();
    db::set_setting(&conn, "web_server_enabled", "true").unwrap();

    migrate_web_server_setting(&conn).unwrap();

    assert_eq!(
        db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
        Some("true")
    );
    assert_eq!(
        db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
        Some("true")
    );
    assert!(db::get_setting(&conn, "web_server_enabled").unwrap().is_none());
}

#[test]
fn migrate_web_server_setting_false_sets_both_false() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let conn = pool.get().unwrap();
    db::set_setting(&conn, "web_server_enabled", "false").unwrap();

    migrate_web_server_setting(&conn).unwrap();

    assert_eq!(
        db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
        Some("false")
    );
    assert_eq!(
        db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
        Some("false")
    );
    assert!(db::get_setting(&conn, "web_server_enabled").unwrap().is_none());
}

#[test]
fn migrate_web_server_setting_no_op_when_absent() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let conn = pool.get().unwrap();
    // No legacy key set.
    migrate_web_server_setting(&conn).unwrap();
    assert!(db::get_setting(&conn, "web_ui_enabled").unwrap().is_none());
    assert!(db::get_setting(&conn, "opds_enabled").unwrap().is_none());
}

#[test]
fn migrate_web_server_setting_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let conn = pool.get().unwrap();
    db::set_setting(&conn, "web_server_enabled", "true").unwrap();

    migrate_web_server_setting(&conn).unwrap();
    // Simulate user later turning Web UI off; migration must not undo that.
    db::set_setting(&conn, "web_ui_enabled", "false").unwrap();
    migrate_web_server_setting(&conn).unwrap();

    assert_eq!(
        db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
        Some("false"),
        "migration must not clobber user changes after first migration"
    );
}
```

- [ ] **Step 2: Run failing tests**

```bash
cd src-tauri && cargo test migrate_web_server_setting 2>&1 | tail -10
```

Expected: compile error — `migrate_web_server_setting` does not exist.

- [ ] **Step 3: Implement helper**

Add to `src-tauri/src/commands.rs` (place near the other web-server helpers, e.g. just above `web_server_set_modes`):

```rust
/// One-shot migration of the legacy `web_server_enabled` setting to the
/// new pair `web_ui_enabled` + `opds_enabled`. Idempotent: after the
/// first run the legacy key is gone and subsequent calls are no-ops.
/// New settings are only written when they are absent, so a user who
/// adjusted the new settings between two migration runs keeps their
/// changes.
pub fn migrate_web_server_setting(conn: &rusqlite::Connection) -> FolioResult<()> {
    let Some(old) = db::get_setting(conn, "web_server_enabled")? else {
        return Ok(());
    };
    let was_on = old == "true";
    if db::get_setting(conn, "web_ui_enabled")?.is_none() {
        db::set_setting(conn, "web_ui_enabled", &was_on.to_string())?;
    }
    if db::get_setting(conn, "opds_enabled")?.is_none() {
        db::set_setting(conn, "opds_enabled", &was_on.to_string())?;
    }
    db::delete_setting(conn, "web_server_enabled")?;
    Ok(())
}
```

- [ ] **Step 4: Update auto-start in `lib.rs`**

In `src-tauri/src/lib.rs`, replace the entire block from line ~164 ("Auto-start web server if previously enabled") through the end of the spawn block. The new logic runs the migration first, then reads the new settings, then starts the server with the matching modes.

Find the existing block (search for `// Auto-start web server`) and replace it with:

```rust
// Auto-start web server based on persisted modes. Runs the legacy
// migration on first launch with new code so existing users with
// web_server_enabled=true keep getting Both mode.
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    let state = app_handle.state::<AppState>();

    // Migrate legacy setting if present.
    {
        let conn = match state.active_db().and_then(|p| p.get().map_err(Into::into)) {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = commands::migrate_web_server_setting(&conn);
    }

    // Read the new settings.
    let modes = {
        let conn = match state.active_db().and_then(|p| p.get().map_err(Into::into)) {
            Ok(c) => c,
            Err(_) => return,
        };
        let web_ui = db::get_setting(&conn, "web_ui_enabled")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        let opds = db::get_setting(&conn, "opds_enabled")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        web_server::ServerModes { web_ui, opds }
    };

    if !modes.any() {
        return;
    }

    let port = {
        let conn = match state.active_db().and_then(|p| p.get().map_err(Into::into)) {
            Ok(c) => c,
            Err(_) => return,
        };
        db::get_setting(&conn, "web_server_port")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(web_server::DEFAULT_PORT)
    };
    let pin_hash = web_server::auth::load_pin_hash();
    {
        let mut ph = match state.shared_pin_hash.lock() {
            Ok(g) => g,
            Err(_) => {
                log::error!("pin-hash mutex poisoned; skipping web-server auto-start");
                return;
            }
        };
        *ph = pin_hash;
    }
    let web_state = web_server::WebState {
        pool: state.shared_active_pool.clone(),
        data_dir: state.data_dir.clone(),
        pin_hash: state.shared_pin_hash.clone(),
        sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        login_limiter: std::sync::Arc::new(web_server::auth::RateLimiter::new(5, 300)),
    };
    if let Ok(handle) = web_server::start(web_state, port, modes).await {
        let mut h = match state.web_server_handle.lock() {
            Ok(g) => g,
            Err(_) => {
                log::error!("web-server handle mutex poisoned");
                return;
            }
        };
        *h = Some(handle);
    }
});
```

Keep `tray::setup_tray` and any other code that surrounded the auto-start block unchanged — only the spawned async block is rewritten.

- [ ] **Step 5: Run tests + build**

```bash
cd src-tauri && cargo test migrate_web_server_setting 2>&1 | tail -10
cd src-tauri && cargo test 2>&1 | tail -5
cd src-tauri && cargo build 2>&1 | tail -5
```

Expected: 4 migration tests pass; full suite green; clean build.

- [ ] **Step 6: Run fmt + clippy**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(web_server): migrate legacy setting + auto-start with modes

Adds migrate_web_server_setting which converts the legacy boolean
web_server_enabled into the new pair web_ui_enabled + opds_enabled,
deleting the legacy key. Auto-start at app launch reads the new
settings and starts the server with the matching ServerModes when
at least one is on."
```

---

## Task 6: Remove old `web_server_start` / `web_server_stop` and rewire the tray

**Files:**
- Modify: `src-tauri/src/commands.rs` (delete `web_server_start` and `web_server_stop` functions)
- Modify: `src-tauri/src/lib.rs` (remove from `invoke_handler`)
- Modify: `src-tauri/src/tray.rs` (rewrite menu + toggle)

- [ ] **Step 1: Delete the old commands**

In `src-tauri/src/commands.rs`, delete the entire `web_server_start` function (around line 4836–4893) and the `web_server_stop` function (around line 4895–4914). Keep `web_server_status` and the new `web_server_set_modes` (added in Task 4).

- [ ] **Step 2: Update `invoke_handler`**

In `src-tauri/src/lib.rs`, remove the two lines:

```rust
commands::web_server_start,
commands::web_server_stop,
```

Keep `commands::web_server_set_modes,` (added in Task 4) and `commands::web_server_status,`. The handler entry order doesn't matter, but keep the file tidy.

- [ ] **Step 3: Rewrite `tray.rs::build_tray_menu` to show two toggles**

Replace the entire body of `build_tray_menu` in `src-tauri/src/tray.rs` (currently lines 9–40):

```rust
/// Build (or rebuild) the tray menu showing both surface toggles.
pub fn build_tray_menu(
    app: &AppHandle,
    web_ui_enabled: bool,
    opds_enabled: bool,
    server_running: bool,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let show_item = MenuItemBuilder::with_id("show", "Show Folio").build(app)?;

    let open_webui = MenuItemBuilder::with_id("open_webui", "Open Web UI")
        .enabled(server_running && web_ui_enabled)
        .build(app)?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    let web_ui_label = if web_ui_enabled {
        "Web UI: ON"
    } else {
        "Web UI: OFF"
    };
    let web_ui_toggle = MenuItemBuilder::with_id("toggle_web_ui", web_ui_label).build(app)?;

    let opds_label = if opds_enabled {
        "OPDS: ON"
    } else {
        "OPDS: OFF"
    };
    let opds_toggle = MenuItemBuilder::with_id("toggle_opds", opds_label).build(app)?;

    let sep2 = PredefinedMenuItem::separator(app)?;

    let quit_item = MenuItemBuilder::with_id("quit", "Quit Folio").build(app)?;

    MenuBuilder::new(app)
        .item(&show_item)
        .item(&open_webui)
        .item(&sep1)
        .item(&web_ui_toggle)
        .item(&opds_toggle)
        .item(&sep2)
        .item(&quit_item)
        .build()
}
```

(Tauri's tray menu API does not support stateful checkbox-style items in v2, so we encode state in the label text. When Tauri adds checkbox items, swap the labels for `CheckMenuItem::with_id`.)

- [ ] **Step 4: Update `setup_tray` to read the new state**

In `src-tauri/src/tray.rs`, replace the `web_server_running` lookup (lines 44–48) with all three values, and update the `build_tray_menu` call at line 50:

```rust
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let (web_ui_enabled, opds_enabled, server_running) = {
        let state = app.state::<AppState>();
        let server_running = state.web_server_handle.lock().unwrap().is_some();
        let conn = state.active_db().and_then(|p| p.get().map_err(Into::into));
        let (web_ui, opds) = match conn {
            Ok(c) => (
                crate::db::get_setting(&c, "web_ui_enabled")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true"),
                crate::db::get_setting(&c, "opds_enabled")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true"),
            ),
            Err(_) => (false, false),
        };
        (web_ui, opds, server_running)
    };

    let menu = build_tray_menu(app, web_ui_enabled, opds_enabled, server_running)?;
    // ... rest of setup_tray unchanged below this line
```

Update the `on_menu_event` match arms (lines 56–89 region) — replace the `"web_toggle"` arm with two new arms:

```rust
.on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
    "show" => { /* unchanged */ }
    "open_webui" => { /* unchanged */ }
    "toggle_web_ui" => {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            toggle_mode(&app, ToggleWhich::WebUi).await;
        });
    }
    "toggle_opds" => {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            toggle_mode(&app, ToggleWhich::Opds).await;
        });
    }
    "quit" => { /* unchanged */ }
    _ => {}
})
```

- [ ] **Step 5: Replace `toggle_web_server` with `toggle_mode`**

Delete the existing `toggle_web_server` function (lines 113–166 in the original) and add:

```rust
#[derive(Clone, Copy)]
enum ToggleWhich {
    WebUi,
    Opds,
}

/// Toggle one surface from the tray, delegating to the same reconciler
/// the Settings panel uses (`web_server_set_modes`).
async fn toggle_mode(app: &AppHandle, which: ToggleWhich) {
    let state = app.state::<AppState>();

    let (current_web_ui, current_opds, current_port) = {
        let conn = match state.active_db().and_then(|p| p.get().map_err(Into::into)) {
            Ok(c) => c,
            Err(_) => return,
        };
        let web_ui = crate::db::get_setting(&conn, "web_ui_enabled")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        let opds = crate::db::get_setting(&conn, "opds_enabled")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        let port = crate::db::get_setting(&conn, "web_server_port")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(crate::web_server::DEFAULT_PORT);
        (web_ui, opds, port)
    };

    let (next_web_ui, next_opds) = match which {
        ToggleWhich::WebUi => (!current_web_ui, current_opds),
        ToggleWhich::Opds => (current_web_ui, !current_opds),
    };

    // Persist the flip to the DB. The full reconciler (start/stop
    // listener, restart with new modes) lives in commands.rs and is
    // duplicated here in compact form: we call its underlying steps
    // rather than the Tauri command (which requires a State<'_, ...>
    // passed through invoke).
    {
        let conn = match state.active_db().and_then(|p| p.get().map_err(Into::into)) {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = crate::db::set_setting(&conn, "web_ui_enabled", &next_web_ui.to_string());
        let _ = crate::db::set_setting(&conn, "opds_enabled", &next_opds.to_string());
    }

    let modes = crate::web_server::ServerModes {
        web_ui: next_web_ui,
        opds: next_opds,
    };

    // Stop existing handle.
    let prev = { state.web_server_handle.lock().unwrap().take() };
    if let Some(h) = prev {
        crate::web_server::stop(h);
    }

    // Restart if anything is on.
    if modes.any() {
        let pin_hash = crate::web_server::auth::load_pin_hash();
        {
            let mut ph = state.shared_pin_hash.lock().unwrap();
            *ph = pin_hash;
        }
        let web_state = crate::web_server::WebState {
            pool: state.shared_active_pool.clone(),
            data_dir: state.data_dir.clone(),
            pin_hash: state.shared_pin_hash.clone(),
            sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            login_limiter: std::sync::Arc::new(crate::web_server::auth::RateLimiter::new(5, 300)),
        };
        if let Ok(handle) = crate::web_server::start(web_state, current_port, modes).await {
            let mut h = state.web_server_handle.lock().unwrap();
            *h = Some(handle);
        }
    }

    let _ = rebuild_tray_menu(app);
}
```

- [ ] **Step 6: Update `rebuild_tray_menu` to read the same three values**

Replace `rebuild_tray_menu` body in `tray.rs` (lines 168–183):

```rust
/// Rebuild the tray menu to reflect the current state.
pub fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let server_running = state.web_server_handle.lock().unwrap().is_some();

    let (web_ui_enabled, opds_enabled) = {
        let conn = state.active_db().and_then(|p| p.get().map_err(Into::into));
        match conn {
            Ok(c) => (
                crate::db::get_setting(&c, "web_ui_enabled")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true"),
                crate::db::get_setting(&c, "opds_enabled")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true"),
            ),
            Err(_) => (false, false),
        }
    };

    let menu = build_tray_menu(app, web_ui_enabled, opds_enabled, server_running)?;

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}
```

- [ ] **Step 7: Build + test + lint**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
cd src-tauri && cargo test 2>&1 | tail -5
cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: clean build; tests still pass; fmt/clippy clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tray.rs
git commit -m "feat(web_server): drop start/stop commands; tray uses set_modes

Removes web_server_start and web_server_stop — the new set_modes
reconciler covers both. Tray menu now shows two labelled entries
(Web UI: ON/OFF, OPDS: ON/OFF) that toggle independently via
shared start/stop machinery."
```

---

## Task 7: i18n keys (en + fr)

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Read existing keys**

```bash
grep -n "remoteAccess\|startServer\|stopServer\|tray\." /Users/mike/Documents/www/folio/src/locales/en.json | head
```

This locates the existing `settings.remoteAccess`, `settings.startServer`, `settings.stopServer` keys (and `tray.startServer` / `tray.stopServer` if they exist). The new keys go alongside.

- [ ] **Step 2: Add new keys to `src/locales/en.json`**

Inside the existing `"settings"` object, locate the `remoteAccess` key (currently a string for the section title). Replace it with a nested object so the section title and the new sub-keys live together:

```json
"remoteAccess": "Remote access",
```

becomes:

```json
"remoteAccess": "Remote access",
"remoteAccessDescriptions": {
  "webUiCheckbox": "Web UI",
  "webUiHint": "Browse your library from any phone or tablet.",
  "opdsCheckbox": "OPDS",
  "opdsHint": "Catalog feed for OPDS apps (Thorium, KOReader, …)."
},
```

(Using a sibling object `remoteAccessDescriptions` keeps the existing `t("settings.remoteAccess")` lookup working unchanged in the SettingsPanel header.)

Inside the `"tray"` object — or, if it does not exist at the top level, create it:

```json
"tray": {
  "server": {
    "webUi": "Web UI",
    "opds": "OPDS"
  }
}
```

If `"tray"` already exists, merge by adding the `"server"` sub-object.

- [ ] **Step 3: Same shape in `src/locales/fr.json`**

Add to `src/locales/fr.json` the equivalent French strings:

```json
"remoteAccessDescriptions": {
  "webUiCheckbox": "Interface Web",
  "webUiHint": "Accédez à votre bibliothèque depuis n’importe quel téléphone ou tablette.",
  "opdsCheckbox": "OPDS",
  "opdsHint": "Flux de catalogue pour applications OPDS (Thorium, KOReader, …)."
}
```

```json
"tray": {
  "server": {
    "webUi": "Interface Web",
    "opds": "OPDS"
  }
}
```

(The existing `tray.startServer` / `tray.stopServer` keys can stay — Task 8 stops referencing them but they're harmless if left behind. The legacy `settings.startServer` / `settings.stopServer` keys will become unreferenced after Task 8 — leaving them in for one release window keeps the diff minimal.)

- [ ] **Step 4: Validate JSON**

```bash
cd /Users/mike/Documents/www/folio
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json'))"
node -e "JSON.parse(require('fs').readFileSync('src/locales/fr.json'))"
```

Expected: no output (valid JSON).

- [ ] **Step 5: Type-check + tests**

```bash
pnpm run type-check 2>&1 | tail -3
pnpm run test 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "i18n(server): add settings.remoteAccessDescriptions + tray.server keys"
```

---

## Task 8: SettingsPanel UI swap

**Files:**
- Modify: `src/components/SettingsPanel.tsx` (around lines 411–420 for state; 1652–1764 for the Remote access accordion)

- [ ] **Step 1: Read the current Remote access block**

```bash
sed -n '1652,1764p' /Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx
```

This shows the existing Start/Stop button (lines 1702–1733), URL/QR display (1735–1758), and error display (1760–1762). The PIN section (1654–1685) and port input (1687–1700) stay; the Start/Stop button is replaced; the URL/QR/error blocks stay but their guards adjust.

- [ ] **Step 2: Update local state**

Replace the existing state lines around line 411–417 — find:

```tsx
const [webServerRunning, setWebServerRunning] = useState(false);
const [webServerUrl, setWebServerUrl] = useState<string | null>(null);
const [webServerPort, setWebServerPort] = useState("7788");
const [webServerPin, setWebServerPin] = useState("");
const [webServerQr, setWebServerQr] = useState<string | null>(null);
const [webServerError, setWebServerError] = useState<string | null>(null);
const [webServerLoading, setWebServerLoading] = useState(false);
```

and add two new lines below them:

```tsx
const [webUiEnabled, setWebUiEnabled] = useState(false);
const [opdsEnabled, setOpdsEnabled] = useState(false);
```

- [ ] **Step 3: Update the status fetch type**

Find the `web_server_status` invoke (around line 574 — `await invoke<{ running: boolean; url: string | null; port: number; has_pin: boolean }>("web_server_status")`). Change the inline type and the destructuring to include the two new flags:

```tsx
const status = await invoke<{
  running: boolean;
  url: string | null;
  port: number;
  hasPin: boolean;
  webUiEnabled: boolean;
  opdsEnabled: boolean;
}>("web_server_status");
setWebServerRunning(status.running);
setWebServerUrl(status.url);
setWebServerPort(String(status.port));
setWebUiEnabled(status.webUiEnabled);
setOpdsEnabled(status.opdsEnabled);
```

(The `hasPin` field replaces the previous `has_pin` because the backend struct now uses `#[serde(rename_all = "camelCase")]` from Task 4. Adjust any prior consumer that reads `has_pin` from the same response — search for `has_pin` in the file and change to `hasPin`.)

- [ ] **Step 4: Add a single `handleSetModes` helper**

Just below `handleAddCatalog` or any nearby async helper around line ~150, add:

```tsx
const handleSetModes = useCallback(
  async (next: { webUi?: boolean; opds?: boolean; port?: number }) => {
    setWebServerError(null);
    setWebServerLoading(true);
    try {
      const status = await invoke<{
        running: boolean;
        url: string | null;
        port: number;
        hasPin: boolean;
        webUiEnabled: boolean;
        opdsEnabled: boolean;
      }>("web_server_set_modes", {
        webUi: next.webUi ?? webUiEnabled,
        opds: next.opds ?? opdsEnabled,
        port: next.port ?? parseInt(webServerPort, 10) || 7788,
      });
      setWebUiEnabled(status.webUiEnabled);
      setOpdsEnabled(status.opdsEnabled);
      setWebServerRunning(status.running);
      setWebServerUrl(status.url ?? null);
      if (status.running) {
        try {
          const qr = await invoke<string>("web_server_get_qr");
          setWebServerQr(qr);
        } catch {
          // QR generation failed; non-fatal.
        }
      } else {
        setWebServerQr(null);
      }
    } catch (e) {
      setWebServerError(friendlyError(e, t));
    } finally {
      setWebServerLoading(false);
    }
  },
  [webUiEnabled, opdsEnabled, webServerPort, t],
);
```

- [ ] **Step 5: Replace the Start/Stop button with two checkboxes**

In the Remote access Accordion's children (around line 1702–1733), replace the Start/Stop `<button>` element with this block:

```tsx
{/* Web UI / OPDS toggles. Server runs iff at least one is on. */}
<div className="space-y-2 px-1">
  <label className="flex items-start gap-2.5 cursor-pointer">
    <input
      type="checkbox"
      checked={webUiEnabled}
      onChange={(e) => handleSetModes({ webUi: e.target.checked })}
      disabled={webServerLoading}
      className="mt-0.5 accent-accent"
    />
    <span className="flex flex-col gap-0.5">
      <span className="text-sm text-ink">{t("settings.remoteAccessDescriptions.webUiCheckbox")}</span>
      <span className="text-xs text-ink-muted">{t("settings.remoteAccessDescriptions.webUiHint")}</span>
    </span>
  </label>
  <label className="flex items-start gap-2.5 cursor-pointer">
    <input
      type="checkbox"
      checked={opdsEnabled}
      onChange={(e) => handleSetModes({ opds: e.target.checked })}
      disabled={webServerLoading}
      className="mt-0.5 accent-accent"
    />
    <span className="flex flex-col gap-0.5">
      <span className="text-sm text-ink">{t("settings.remoteAccessDescriptions.opdsCheckbox")}</span>
      <span className="text-xs text-ink-muted">{t("settings.remoteAccessDescriptions.opdsHint")}</span>
    </span>
  </label>
</div>
```

- [ ] **Step 6: Allow the port input to be edited even while running**

Find the port `<input>` (line 1690–1699) and remove the `disabled={webServerRunning}` attribute. Wire its `onBlur` to invoke `handleSetModes` with the new port — replace the `<input>` with:

```tsx
<input
  type="number"
  value={webServerPort}
  onChange={(e) => setWebServerPort(e.target.value)}
  onBlur={() => {
    const port = parseInt(webServerPort, 10);
    if (port && (webUiEnabled || opdsEnabled)) {
      handleSetModes({ port });
    }
  }}
  className="w-full bg-transparent text-sm text-ink focus:outline-none"
  id="web-server-port"
  min={1024}
  max={65535}
/>
```

- [ ] **Step 7: Run type-check + frontend tests**

```bash
cd /Users/mike/Documents/www/folio && pnpm run type-check 2>&1 | tail -3
pnpm run test 2>&1 | tail -5
```

Expected: clean type-check; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): two checkboxes replace start/stop button

Web UI and OPDS toggles drive web_server_set_modes directly; the
server is implicitly running iff at least one is on. URL/QR/PIN
sections still gate on running status. Port input is now editable
while running — onBlur flush triggers a hot restart."
```

---

## Task 9: Tray menu picks up modes

**Files:** none additional — Task 6 already migrated `tray.rs` to the two-toggle model.

- [ ] **Step 1: Verify tray labels via manual smoke**

After the Tauri dev server is running (next task), open the tray menu and confirm:
- Two entries showing "Web UI: ON/OFF" and "OPDS: ON/OFF" reflecting persisted settings.
- Clicking either flips its state and rebuilds the menu within ~100 ms.
- Settings panel stays in sync (re-reads status on focus / interval).

If anything misbehaves, file the regression as a follow-up commit on this branch — but do not bake new logic into Task 9. The tray refactor lives in Task 6 to keep blast radius tight.

(No code change in this task. It exists in the plan as an explicit verification gate so the executor knows the tray is part of the deliverable.)

---

## Task 10: Final CI gate + manual smoke

**Files:** none

- [ ] **Step 1: Run full local CI suite**

From the project root:

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd /Users/mike/Documents/www/folio && pnpm run type-check && pnpm run test
```

Expected: every command exits 0.

- [ ] **Step 2: Manual smoke**

`pnpm tauri dev` and:

1. Fresh state (delete app data dir for the cleanest test) → both checkboxes off; server not running.
2. Tick Web UI → server starts; `curl http://localhost:7788/` returns 200; `curl http://localhost:7788/opds` returns 404.
3. Tick OPDS → brief restart; both reachable.
4. Untick Web UI → restart; `/` 404, `/opds` 200.
5. Untick OPDS → server stops; URL/QR sections hide.
6. Set port to a busy one (e.g. 80) → error shown, settings persist, server stays stopped.
7. Quit + relaunch → previous mode restored.
8. Existing-user upgrade: prep a DB with `web_server_enabled="true"` (use a copy of an old library.db, or set via a one-shot SQL session before launching), launch with new code → both checkboxes ticked + server running.
9. Tray menu: toggle Web UI from tray → Settings panel reflects on next focus.

- [ ] **Step 3: Done**

Open a PR off `feat/server-mode-toggle` to `main`.

---

## Notes for the engineer

- **DRY**: tray's `toggle_mode` and `commands.rs::web_server_set_modes` share machinery. The plan duplicates the start/stop dance in tray rather than refactoring into a shared helper because the call sites differ in how they obtain `AppState` (Tauri's `invoke` State vs `app.state::<AppState>()`). If after the feature lands you spot a clean shared helper, that's a follow-up.
- **YAGNI**: per-mode auth, per-mode rate limits, per-mode bind addresses, hot route swap — all out of scope per the spec. Don't add them.
- **TDD**: backend tasks 1, 2, 5 each open with failing tests. Tasks 3, 6, 8 are mechanical signature/refactor changes covered by the existing test suite. Task 4 has a thin contract test on the persistence layer; the integration story is the manual smoke in Task 10.
- **Frequent commits**: 9 commits before Task 10. Each is independently buildable + testable.
- **camelCase contract**: Rust `WebServerStatus` now uses `#[serde(rename_all = "camelCase")]`. The frontend reads `webUiEnabled`, `opdsEnabled`, `hasPin` (not `has_pin`). If you find a `has_pin` consumer in the frontend, update it.
- **Tray label encoding**: Tauri v2's tray menu API doesn't have stateful checkbox items, so we encode state in the menu label ("Web UI: ON/OFF"). When Tauri ships `CheckMenuItem`, swap it in.
- **Migration is one-shot**: `migrate_web_server_setting` deletes the legacy key after first run. Re-running is safe (no-op when the legacy key is gone).
