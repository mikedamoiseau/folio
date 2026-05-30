# F-3-1 Web Server Login Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and expose an audit trail of web-server login attempts (IP, method, outcome, user-agent) so successes, failures, and rate-limit blocks are recoverable for security review.

**Architecture:** A dedicated `web_session_log` table + db helpers in `folio-core` (mirroring the F-2-2 activity_log shape). The web layer (`web_server/auth.rs`, `web_server/api.rs`) records attempts best-effort via a `log_login_attempt` helper using typed method/outcome enums. The trail is read via an authenticated HTTP endpoint and a desktop Tauri command.

**Tech Stack:** Rust, rusqlite, r2d2, axum, serde, chrono, uuid, Tauri v2, `tracing`. Tests use `tempfile` + `db::init_db`.

**Spec:** `docs/superpowers/specs/2026-05-30-web-login-audit-trail-design.md`

**Key constraints:**
- Audit writes are BEST-EFFORT — a logging failure must never block or fail a login (warn via `tracing`, swallow).
- NEVER store the PIN or its hash — only the outcome enum.
- Session path (`/api/auth`) logs all outcomes; Basic-Auth (OPDS) logs FAILURES ONLY.

---

## File Structure

- **Modify** `folio-core/src/models.rs` — add `WebSessionEntry` struct.
- **Modify** `folio-core/src/db.rs` — `web_session_log` table in `run_schema`; `insert_web_session_log`, `get_web_session_log`, `prune_web_session_log`; import `WebSessionEntry`; tests.
- **Modify** `src-tauri/src/web_server/auth.rs` — `WebAuthMethod`, `LoginOutcome` enums; `log_login_attempt` helper; instrument the Basic-Auth failure paths; tests.
- **Modify** `src-tauri/src/web_server/api.rs` — instrument `login()` (3 outcomes); add `login_history` handler + route.
- **Modify** `src-tauri/src/commands.rs` — `get_login_history` Tauri command.
- **Modify** `src-tauri/src/lib.rs` — register `get_login_history`.

---

### Task 1: `WebSessionEntry` model + `web_session_log` table + db helpers

**Files:**
- Modify: `folio-core/src/models.rs` (add struct after `ActivityEntry`, ~line 206)
- Modify: `folio-core/src/db.rs` (import at line 7 block; schema in `run_schema` after `activity_log` ~line 206; helpers after the activity_log helpers ~line 1883; tests in the `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Add the model**

In `folio-core/src/models.rs`, after the `ActivityEntry` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionEntry {
    pub id: String,
    pub timestamp: i64,
    pub ip: String,
    pub method: String,
    pub outcome: String,
    pub user_agent: Option<String>,
}
```

- [ ] **Step 2: Write failing db tests**

In `folio-core/src/db.rs`, inside the `#[cfg(test)] mod tests` block (near the activity_log tests), add. (`setup()` returns `(TempDir, Connection)` via `init_db`, which runs the full schema.)

```rust
fn sample_web_session(id: &str, outcome: &str, timestamp: i64) -> crate::models::WebSessionEntry {
    crate::models::WebSessionEntry {
        id: id.to_string(),
        timestamp,
        ip: "203.0.113.7".to_string(),
        method: "session".to_string(),
        outcome: outcome.to_string(),
        user_agent: Some("Mozilla/5.0".to_string()),
    }
}

#[test]
fn test_web_session_log_insert_and_get_newest_first() {
    let (_dir, conn) = setup();
    let now = chrono::Utc::now().timestamp();
    insert_web_session_log(&conn, &sample_web_session("w1", "invalid_pin", now - 20)).unwrap();
    insert_web_session_log(&conn, &sample_web_session("w2", "success", now - 5)).unwrap();

    let rows = get_web_session_log(&conn, 10).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, "w2"); // newest first
    assert_eq!(rows[1].id, "w1");
    assert_eq!(rows[0].outcome, "success");
    assert_eq!(rows[0].user_agent.as_deref(), Some("Mozilla/5.0"));
}

#[test]
fn test_web_session_log_get_respects_limit() {
    let (_dir, conn) = setup();
    let now = chrono::Utc::now().timestamp();
    for i in 0..5 {
        insert_web_session_log(&conn, &sample_web_session(&format!("w{i}"), "success", now - 10 + i)).unwrap();
    }
    let rows = get_web_session_log(&conn, 2).unwrap();
    assert_eq!(rows.len(), 2);
}

#[test]
fn test_web_session_log_null_user_agent() {
    let (_dir, conn) = setup();
    let mut e = sample_web_session("wn", "rate_limited", chrono::Utc::now().timestamp());
    e.user_agent = None;
    insert_web_session_log(&conn, &e).unwrap();
    let rows = get_web_session_log(&conn, 10).unwrap();
    assert_eq!(rows[0].user_agent, None);
}

#[test]
fn test_prune_web_session_log_age_and_count() {
    let (_dir, conn) = setup();
    let now = chrono::Utc::now().timestamp();
    insert_web_session_log(&conn, &sample_web_session("old1", "invalid_pin", now - 100 * 86400)).unwrap();
    insert_web_session_log(&conn, &sample_web_session("old2", "invalid_pin", now - 91 * 86400)).unwrap();
    insert_web_session_log(&conn, &sample_web_session("new1", "success", now - 5 * 86400)).unwrap();

    // keep=0, max_age_days=90 -> both >90d rows pruned, recent kept.
    let deleted = prune_web_session_log(&conn, 0, 90).unwrap();
    assert_eq!(deleted, 2);
    let rows = get_web_session_log(&conn, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "new1");
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p folio-core web_session`
Expected: FAIL — `insert_web_session_log` / `get_web_session_log` / `prune_web_session_log` not found, `WebSessionEntry` not imported in db.rs.

- [ ] **Step 4: Implement**

In `folio-core/src/db.rs`, add `WebSessionEntry` to the `use crate::models::{ ... }` import block at line 7 (keep the existing style/ordering).

Add the table to `run_schema`, immediately after the `activity_log` `CREATE TABLE ... );` (~line 206):

```sql
        CREATE TABLE IF NOT EXISTS web_session_log (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            ip TEXT NOT NULL,
            method TEXT NOT NULL,
            outcome TEXT NOT NULL,
            user_agent TEXT
        );
```

Add the helpers after `prune_activity_log` (~line 1883):

```rust
pub fn insert_web_session_log(conn: &Connection, entry: &WebSessionEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO web_session_log (id, timestamp, ip, method, outcome, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            entry.id,
            entry.timestamp,
            entry.ip,
            entry.method,
            entry.outcome,
            entry.user_agent
        ],
    )?;
    Ok(())
}

pub fn get_web_session_log(conn: &Connection, limit: u32) -> Result<Vec<WebSessionEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, timestamp, ip, method, outcome, user_agent FROM web_session_log ORDER BY timestamp DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(WebSessionEntry {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            ip: row.get(2)?,
            method: row.get(3)?,
            outcome: row.get(4)?,
            user_agent: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn prune_web_session_log(conn: &Connection, keep: u32, max_age_days: u32) -> Result<usize> {
    let cutoff = chrono::Utc::now().timestamp() - (max_age_days as i64) * 24 * 60 * 60;
    let deleted = conn.execute(
        "DELETE FROM web_session_log WHERE id NOT IN (SELECT id FROM web_session_log ORDER BY timestamp DESC LIMIT ?1) AND timestamp < ?2",
        params![keep, cutoff],
    )?;
    Ok(deleted)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p folio-core web_session` then `cargo clippy -p folio-core -- -D warnings`
Expected: 4 tests pass; clippy clean.

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/models.rs folio-core/src/db.rs
git commit -m "feat(db): add web_session_log table, WebSessionEntry, and CRUD/prune helpers"
```

---

### Task 2: `WebAuthMethod` / `LoginOutcome` enums + `log_login_attempt` helper

**Files:**
- Modify: `src-tauri/src/web_server/auth.rs` (add enums + helper after the existing free functions, before `auth_middleware`; tests in the existing `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Write failing tests**

In `src-tauri/src/web_server/auth.rs`, inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn web_auth_method_as_str() {
    assert_eq!(WebAuthMethod::Session.as_str(), "session");
    assert_eq!(WebAuthMethod::Basic.as_str(), "basic");
}

#[test]
fn login_outcome_as_str() {
    assert_eq!(LoginOutcome::Success.as_str(), "success");
    assert_eq!(LoginOutcome::InvalidPin.as_str(), "invalid_pin");
    assert_eq!(LoginOutcome::RateLimited.as_str(), "rate_limited");
}

#[test]
fn log_login_attempt_inserts_row() {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::init_db(&dir.path().join("t.db")).unwrap();
    log_login_attempt(
        &conn,
        "198.51.100.4",
        Some("curl/8.0"),
        WebAuthMethod::Basic,
        LoginOutcome::InvalidPin,
    );
    let rows = crate::db::get_web_session_log(&conn, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].ip, "198.51.100.4");
    assert_eq!(rows[0].method, "basic");
    assert_eq!(rows[0].outcome, "invalid_pin");
    assert_eq!(rows[0].user_agent.as_deref(), Some("curl/8.0"));
}
```

- [ ] **Step 2: Run to verify failure**

Run (from repo root, with the macOS header env if needed):
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test web_auth_method_as_str login_outcome_as_str log_login_attempt
```
Expected: FAIL — `WebAuthMethod` / `LoginOutcome` / `log_login_attempt` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/web_server/auth.rs`, add near the top of the file (after the existing `use` lines) if not already imported: `use crate::db;` (the file already uses `crate::error::...`; add `use crate::db;` if absent). Then add, before `auth_middleware`:

```rust
/// Which authentication mechanism produced a login attempt.
#[derive(Clone, Copy)]
pub enum WebAuthMethod {
    Session,
    Basic,
}

impl WebAuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            WebAuthMethod::Session => "session",
            WebAuthMethod::Basic => "basic",
        }
    }
}

/// The result of a login attempt.
#[derive(Clone, Copy)]
pub enum LoginOutcome {
    Success,
    InvalidPin,
    RateLimited,
}

impl LoginOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginOutcome::Success => "success",
            LoginOutcome::InvalidPin => "invalid_pin",
            LoginOutcome::RateLimited => "rate_limited",
        }
    }
}

/// Record a web-server login attempt in `web_session_log`.
///
/// Best-effort: a DB failure must never block or fail a login. Errors are
/// logged via `tracing::warn!` and swallowed. Never stores the PIN or its hash.
pub fn log_login_attempt(
    conn: &rusqlite::Connection,
    ip: &str,
    user_agent: Option<&str>,
    method: WebAuthMethod,
    outcome: LoginOutcome,
) {
    let entry = crate::models::WebSessionEntry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        ip: ip.to_string(),
        method: method.as_str().to_string(),
        outcome: outcome.as_str().to_string(),
        user_agent: user_agent.map(|s| s.to_string()),
    };
    if let Err(e) = db::insert_web_session_log(conn, &entry) {
        tracing::warn!(error = %e, "failed to record web login attempt");
        return;
    }
    let _ = db::prune_web_session_log(conn, 5000, 90);
}
```

Confirm `rusqlite` is referenceable as a path type in this crate (it is — `auth.rs` tests already use `crate::db::create_pool`; `rusqlite::Connection` is re-exported through the dependency). If `rusqlite` is not a direct path, use `crate::db::Connection` — but prefer `rusqlite::Connection` to match `commands.rs::log_event`'s signature style.

- [ ] **Step 4: Run to verify pass**

Run:
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test web_auth_method_as_str login_outcome_as_str log_login_attempt && cargo clippy -- -D warnings
```
Expected: 3 tests pass; clippy clean. (Enums are `pub` and consumed in Task 3, so no dead_code.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/web_server/auth.rs
git commit -m "feat(web): add login audit enums and best-effort log_login_attempt helper"
```

---

### Task 3: Instrument login paths + add `/api/audit/login-history`

**Files:**
- Modify: `src-tauri/src/web_server/api.rs` (`login()` ~lines 61-112; `routes()` ~line 14; new handler)
- Modify: `src-tauri/src/web_server/auth.rs` (`auth_middleware` Basic-Auth branch ~lines 255-277)

- [ ] **Step 1: Instrument `login()` in api.rs**

Add an import shortcut near the top of `api.rs` (with the existing `use super::...`):
`use super::auth::{log_login_attempt, LoginOutcome, WebAuthMethod};`

In `login()`, read the user-agent right after `let client_ip = addr.ip().to_string();`:

```rust
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
```

Rate-limited branch — change it to log before returning:

```rust
    if !state.login_limiter.attempt(&client_ip) {
        if let Ok(conn) = state.conn() {
            log_login_attempt(&conn, &client_ip, user_agent.as_deref(), WebAuthMethod::Session, LoginOutcome::RateLimited);
        }
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many login attempts. Try again later.".to_string(),
        ));
    }
```

Invalid-PIN branch:

```rust
    if !valid {
        if let Ok(conn) = state.conn() {
            log_login_attempt(&conn, &client_ip, user_agent.as_deref(), WebAuthMethod::Session, LoginOutcome::InvalidPin);
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }
```

Success branch — after `state.login_limiter.clear(&client_ip);`:

```rust
    state.login_limiter.clear(&client_ip);
    if let Ok(conn) = state.conn() {
        log_login_attempt(&conn, &client_ip, user_agent.as_deref(), WebAuthMethod::Session, LoginOutcome::Success);
    }
```

(The `user-agent` header is read before `req.into_body()` consumes the request, so ordering is fine.)

- [ ] **Step 2: Add the history endpoint in api.rs**

Add a query struct + handler (near the other handlers):

```rust
#[derive(serde::Deserialize)]
struct HistoryQuery {
    limit: Option<u32>,
}

async fn login_history(
    State(state): State<WebState>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<Vec<crate::models::WebSessionEntry>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let rows = db::get_web_session_log(&conn, params.limit.unwrap_or(100).min(1000))
        .map_err(folio_status)?;
    Ok(Json(rows))
}
```

Register the route inside `routes()` (add before `.with_state(state)`):

```rust
        .route("/audit/login-history", get(login_history))
```

The path `/api/audit/login-history` is not in `auth_middleware`'s unauth allowlist, so it requires a valid session automatically — no extra guard.

- [ ] **Step 3: Instrument the Basic-Auth FAILURE paths in auth_middleware (auth.rs)**

In `auth_middleware`, the Basic-Auth block currently is:

```rust
    if let Some(pin) = extract_basic_pin(&req) {
        let client_ip = addr.ip().to_string();

        if !state.login_limiter.attempt(&client_ip) {
            return (StatusCode::TOO_MANY_REQUESTS, "Too many login attempts. Try again later.").into_response();
        }

        let valid = state
            .pin_hash
            .lock()
            .ok()
            .and_then(|h| h.as_ref().map(|hash| verify_pin(&pin, hash)))
            .unwrap_or(false);

        if valid {
            state.login_limiter.clear(&client_ip);
            return next.run(req).await;
        }
    }
```

Change it to (add UA read; log rate_limited and invalid_pin; do NOT log success):

```rust
    if let Some(pin) = extract_basic_pin(&req) {
        let client_ip = addr.ip().to_string();
        let user_agent = req
            .headers()
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        if !state.login_limiter.attempt(&client_ip) {
            if let Ok(conn) = state.conn() {
                log_login_attempt(&conn, &client_ip, user_agent.as_deref(), WebAuthMethod::Basic, LoginOutcome::RateLimited);
            }
            return (StatusCode::TOO_MANY_REQUESTS, "Too many login attempts. Try again later.").into_response();
        }

        let valid = state
            .pin_hash
            .lock()
            .ok()
            .and_then(|h| h.as_ref().map(|hash| verify_pin(&pin, hash)))
            .unwrap_or(false);

        if valid {
            state.login_limiter.clear(&client_ip);
            return next.run(req).await;
        }

        // Basic-Auth credential present but invalid — record the failure.
        if let Ok(conn) = state.conn() {
            log_login_attempt(&conn, &client_ip, user_agent.as_deref(), WebAuthMethod::Basic, LoginOutcome::InvalidPin);
        }
    }
```

`log_login_attempt`, `WebAuthMethod`, `LoginOutcome` are defined in this same module (`auth.rs`), so call them unqualified. The `user-agent` header is read while `req` is still owned (before any `next.run(req)` move); on the failure path `req` is not consumed.

- [ ] **Step 4: Build, test, lint**

Run:
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
```
Expected: builds; all existing tests + Task 2 helper test pass; clippy + fmt clean.

> No handler-level integration test is added here: `api.rs` has no existing handler test harness (auth is unit-tested in `auth.rs`/`mod.rs`), and `login()`/`auth_middleware` require `ConnectInfo` + `Request` + `Next` wiring that the codebase does not currently scaffold. The audit write path itself is covered by the Task 2 `log_login_attempt_inserts_row` test and the Task 1 db tests; this task's correctness is verified by compilation + the existing web-server test suite remaining green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/web_server/api.rs src-tauri/src/web_server/auth.rs
git commit -m "feat(web): audit login attempts and expose GET /api/audit/login-history"
```

---

### Task 4: Desktop `get_login_history` command + registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (add command near `get_activity_log` ~line 5014)
- Modify: `src-tauri/src/lib.rs` (register after `commands::prune_activity_log` ~line 353)

- [ ] **Step 1: Add a guard test**

In the `#[cfg(test)] mod tests` block of `src-tauri/src/commands.rs`, add a db-path round-trip (the command needs Tauri `State`, so exercise the underlying db call the command makes):

```rust
#[test]
fn get_login_history_reads_web_session_rows() {
    use folio_core::db;
    let dir = tempfile::tempdir().unwrap();
    let conn = db::init_db(&dir.path().join("t.db")).unwrap();
    db::insert_web_session_log(&conn, &folio_core::models::WebSessionEntry {
        id: "x1".into(),
        timestamp: 1000,
        ip: "203.0.113.9".into(),
        method: "session".into(),
        outcome: "success".into(),
        user_agent: None,
    }).unwrap();

    let rows = db::get_web_session_log(&conn, 100).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].outcome, "success");
    assert_eq!(rows[0].ip, "203.0.113.9");
}
```

- [ ] **Step 2: Run to verify it passes (guard)**

Run:
```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test get_login_history_reads_web_session_rows
```
Expected: PASS (uses existing Task 1 db helpers).

- [ ] **Step 3: Add the command**

In `src-tauri/src/commands.rs`, after the `get_activity_log` command:

```rust
#[tauri::command]
pub async fn get_login_history(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::models::WebSessionEntry>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_web_session_log(&conn, limit.unwrap_or(100).min(1000))?)
}
```

- [ ] **Step 4: Register the command**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, after `commands::prune_activity_log`:

```rust
            commands::get_login_history,
```

- [ ] **Step 5: Full verification**

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
git commit -m "feat(activity): add get_login_history Tauri command for web audit trail"
```

---

## Self-Review

**Spec coverage:**
- Dedicated `web_session_log` table (id/timestamp/ip/method/outcome/user_agent) → Task 1. ✓
- `WebSessionEntry` model → Task 1. ✓
- db insert/get/prune helpers (90-day + keep) → Task 1. ✓
- Typed `WebAuthMethod`/`LoginOutcome` + best-effort `log_login_attempt` (warn-and-swallow, never stores PIN/hash) → Task 2. ✓
- Session path logs all 3 outcomes → Task 3 Step 1. ✓
- Basic-Auth logs failures only (rate_limited + invalid_pin, NOT success) → Task 3 Step 3. ✓
- `GET /api/audit/login-history` behind auth → Task 3 Step 2. ✓
- Desktop `get_login_history` command + registration → Task 4. ✓
- Auto-prune keep 5000 + 90 days → Task 2 helper (`prune_web_session_log(conn, 5000, 90)`). ✓
- user-agent captured (nullable) → Tasks 1-3. ✓

**Placeholder scan:** No TBD/TODO. The Task 2 note about `rusqlite::Connection` vs `crate::db::Connection` points at a concrete fallback, not a blank. The Task 3 no-integration-test note cites a real codebase constraint.

**Type consistency:** `WebSessionEntry` fields (id, timestamp, ip, method, outcome, user_agent) identical across models.rs, db helpers, log_login_attempt, handler, and command. `get_web_session_log(conn, limit: u32)`, `prune_web_session_log(conn, keep, max_age_days) -> usize`, `insert_web_session_log(conn, &entry)` consistent across Tasks 1-4. Method/outcome strings (`session`/`basic`, `success`/`invalid_pin`/`rate_limited`) consistent between enum `as_str()` (Task 2), db tests (Task 1), and the schema comment.
