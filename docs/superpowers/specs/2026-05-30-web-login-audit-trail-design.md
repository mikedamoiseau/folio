# F-3-1 Web Server Login Audit Trail — Design Spec

**Status:** Approved 2026-05-30
**Feature:** F-3-1 (Web Server Login Activity Audit Trail)

## Goal

Persist an audit trail of authentication attempts against the embedded web
server (`src-tauri/src/web_server/`), so login successes and failures (and
rate-limit blocks) are recoverable for security review. Expose the trail via
an authenticated HTTP endpoint and a desktop Tauri command.

## Problem

- `web_server/api.rs::login` (`/api/auth`) and `web_server/auth.rs::auth_middleware`
  (HTTP Basic Auth, used by OPDS clients) verify a PIN but record **nothing**.
- There is no way to tell whether the server has seen brute-force attempts,
  from which IPs, or when a successful login occurred.
- The desktop app surfaces a `web_server_modes_changed` activity event but has
  no visibility into who logged in to the web server.

## Decisions (locked during brainstorming)

1. **Dedicated `web_session_log` table** in `folio-core` (not reusing the F-2-2
   `activity_log`). Web-auth rows have a different shape (ip / method / outcome
   / user-agent) than desktop activity rows, and keeping them separate avoids
   coupling web auth to the desktop activity model.
2. **Both auth paths audited, with asymmetric success logging:**
   - `/api/auth` (session login): log **all** outcomes — `success`,
     `invalid_pin`, `rate_limited`.
   - Basic Auth (OPDS, in `auth_middleware`): log **failures only** —
     `invalid_pin`, `rate_limited`. Basic Auth is stateless and re-sent on every
     OPDS request, so logging every success would flood the table with
     low-value rows. Failures are the security signal.
3. **Exposed two ways:** an authenticated HTTP endpoint
   `GET /api/audit/login-history` AND a desktop Tauri command `get_login_history`.
4. **Minimal row plus user-agent:** columns are `id, timestamp, ip, method,
   outcome, user_agent` (`user_agent` nullable). No other fields.
5. **Never store the PIN or its hash** — only the `outcome` enum. ("PIN hash
   match" in the research note means the success boolean, not the hash itself.)
6. **90-day retention**, auto-pruned on insert (keep the most recent 5000 rows
   AND drop anything older than 90 days), mirroring the F-2-2 activity_log
   prune shape.

## Architecture

### Database layer — `folio-core/src/db.rs`

Add to `run_schema` (additive, after the `activity_log` table):

```sql
CREATE TABLE IF NOT EXISTS web_session_log (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    ip TEXT NOT NULL,
    method TEXT NOT NULL,       -- "session" | "basic"
    outcome TEXT NOT NULL,      -- "success" | "invalid_pin" | "rate_limited"
    user_agent TEXT
);
```

Functions (mirroring `insert_activity` / `get_activity_log` / `prune_activity_log`):

```rust
pub fn insert_web_session_log(conn: &Connection, entry: &WebSessionEntry) -> Result<()>;
pub fn get_web_session_log(conn: &Connection, limit: u32) -> Result<Vec<WebSessionEntry>>; // newest-first
pub fn prune_web_session_log(conn: &Connection, keep: u32, max_age_days: u32) -> Result<usize>;
```

`prune_web_session_log` reuses the activity_log prune SQL shape:
`DELETE ... WHERE id NOT IN (SELECT id ... ORDER BY timestamp DESC LIMIT ?keep) AND timestamp < ?cutoff`.

### Model — `folio-core/src/models.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionEntry {
    pub id: String,
    pub timestamp: i64,
    pub ip: String,
    pub method: String,
    pub outcome: String,
    pub user_agent: Option<String>,
}
```

### Web layer — `src-tauri/src/web_server/auth.rs`

Typed enums (web-auth vocabulary; `&'static str` mapping, F-2-2 style):

```rust
#[derive(Clone, Copy)]
pub enum WebAuthMethod { Session, Basic }
impl WebAuthMethod { pub fn as_str(self) -> &'static str { /* "session" | "basic" */ } }

#[derive(Clone, Copy)]
pub enum LoginOutcome { Success, InvalidPin, RateLimited }
impl LoginOutcome { pub fn as_str(self) -> &'static str { /* "success" | "invalid_pin" | "rate_limited" */ } }
```

Best-effort logging helper:

```rust
/// Record a login attempt. Best-effort: a DB failure must never block or fail
/// a login — it is logged via `tracing::warn!` and swallowed.
pub fn log_login_attempt(
    conn: &rusqlite::Connection,
    ip: &str,
    user_agent: Option<&str>,
    method: WebAuthMethod,
    outcome: LoginOutcome,
) {
    let entry = WebSessionEntry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: /* now() unix secs */,
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

A small header helper extracts the `user-agent` request header as `Option<String>`.

### Instrumentation points

`api.rs::login` (`/api/auth`, method = `Session`) — acquire `state.conn()` and call `log_login_attempt` at each return:
- rate-limited (before body read) → `RateLimited`
- invalid PIN → `InvalidPin`
- successful login (after `create_session`) → `Success`

`auth.rs::auth_middleware` Basic-Auth branch (method = `Basic`) — **failures only**:
- rate-limited → `RateLimited`
- Basic PIN present but invalid → `InvalidPin` (log inside the `if let Some(pin)` block when `valid == false`, before the fall-through 401)
- Do NOT log Basic-Auth success.

Session/cookie validation (bearer/cookie reuse) is NOT a login attempt and is not logged. The connection is obtained via `state.conn()`; if it fails, skip logging (best-effort) — never fail the request because of audit logging.

### HTTP endpoint — `api.rs`

```rust
// GET /api/audit/login-history?limit=N   (default 100, cap 1000)
async fn login_history(
    State(state): State<WebState>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<Vec<WebSessionEntry>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let rows = db::get_web_session_log(&conn, params.limit.unwrap_or(100).min(1000))
        .map_err(folio_status)?;
    Ok(Json(rows))
}
```

Add `.route("/audit/login-history", get(login_history))` to `api.rs::routes`.
The path `/api/audit/login-history` is NOT in the `auth_middleware` unauth
allowlist, so it requires a valid session — no extra guard needed.

### Desktop command — `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn get_login_history(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<WebSessionEntry>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_web_session_log(&conn, limit.unwrap_or(100).min(1000))?)
}
```

Register `commands::get_login_history` in `lib.rs` `generate_handler!`.

## Error handling

- Audit logging is best-effort everywhere: failures are warned via `tracing`
  and never propagate to the login/auth result.
- `login_history` HTTP handler and `get_login_history` command surface DB errors
  normally (via `folio_status` / `?`), since reading the trail is not on the
  auth hot path.

## Testing

| Test | Location | Asserts |
|------|----------|---------|
| insert/get round-trip | folio-core db.rs | inserted rows returned newest-first with all fields incl. `user_agent` None and Some |
| prune by age + count | folio-core db.rs | `keep`/`max_age_days` honored; returns deleted count (mirror activity_log prune tests) |
| enum → string mapping | web_server/auth.rs | `WebAuthMethod`/`LoginOutcome` `as_str()` produce exact column strings (`session`/`basic`, `success`/`invalid_pin`/`rate_limited`) |
| best-effort logging | web_server/auth.rs | `log_login_attempt` against a real in-memory conn inserts a row; a closed/failing conn does not panic |

Auth handler outcome wiring is verified at the db layer (the existing api.rs
tests construct `WebState` with an in-memory pool; a handler-level test may
assert that a failed login writes an `invalid_pin` row).

## Out of scope (YAGNI)

- Logging Basic-Auth successes (decision 2).
- Bearer/cookie session-reuse logging (not a login attempt).
- Configurable retention / settings UI (fixed 90 days + keep 5000).
- Geo-IP, threat scoring, alerting, lockout escalation.
- A frontend UI for the desktop `get_login_history` command (command only).
- folio-server (separate project).

## Verification commands

```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
cd .. && cargo test -p folio-core && npm run type-check
```
