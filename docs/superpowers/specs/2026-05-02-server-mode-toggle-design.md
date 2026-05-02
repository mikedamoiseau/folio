# Server Mode Toggle — Design

**Status:** Draft
**Author:** Mike (with Claude)
**Date:** 2026-05-02

## Goal

Let users independently enable the embedded HTTP server's two user-facing surfaces — the **Web UI** (browser-accessible HTML library) and the **OPDS catalog** (Atom feeds for ebook clients) — instead of bundling them in a single Start/Stop toggle.

## Scope

In scope:

- Two user-facing toggles in Settings: "Web UI" and "OPDS".
- Backend can mount either, both, or neither set of route groups.
- Server is implicitly running iff at least one toggle is on. No separate Start/Stop button.
- Migration from the legacy `web_server_enabled` setting to the new pair.
- Tray menu mirrors the two toggles.

Out of scope:

- Per-mode authentication (single PIN remains).
- Per-mode rate limits.
- Hot-reload of routes without TCP socket restart (design intentionally rebuilds the listener on every mode change).
- Per-mode bind addresses.
- Per-surface localization or telemetry.

## Background

`src-tauri/src/web_server/` currently mounts three route groups on a single Axum router:

| Path | Module | Audience |
|------|--------|----------|
| `/`, `/app.js`, `/app.css`, `/favicon.*` | `web_ui::routes()` | Browsers (HTML library UI) |
| `/api/*` | `api::routes()` | The HTML UI itself (no external consumer; the desktop client uses Tauri `invoke()` IPC, never HTTP) |
| `/opds/*` | `opds_feed::routes()` | OPDS clients (Thorium, KOReader, etc.) |

`/api` is an internal dependency of the Web UI: it has no other consumer. Toggling it independently of the Web UI has no use case, so the toggles collapse to two:

- **Web UI** — root HTML + `/api`
- **OPDS** — `/opds`

## Architecture

```
ServerModes { web_ui: bool, opds: bool }   ← new value type

settings table (DB):
  web_server_enabled   ← legacy, migrated away on first launch
  web_ui_enabled       ← NEW
  opds_enabled         ← NEW
  web_server_port      ← unchanged
  (PIN hash in keychain, unchanged)

src-tauri/src/web_server/mod.rs
  build_router(state, modes) -> Router        (modified — conditional .nest / .merge)
  start(state, port, modes) -> Handle          (modified — passes modes through)

src-tauri/src/commands.rs
  web_server_set_modes(web_ui, opds, port?)   ← single reconciler, replaces start/stop
  web_server_status() -> WebServerStatus       ← gains web_ui_enabled, opds_enabled fields
  migrate_web_server_setting(&conn)            ← runs once at app init
  (web_server_start / web_server_stop removed)

Auto-start at app launch (lib.rs):
  read web_ui_enabled + opds_enabled
  if either true → web_server::start(state, port, modes)
```

State machine: a single command (`web_server_set_modes`) is the only surface that changes server runstate. Settings persist user intent; `running` is derived. The server restarts (~100 ms in-process) on every change to either flag — acceptable since flips are rare and the restart cost is trivial.

## Data model

### `ServerModes` (Rust)

```rust
#[derive(Debug, Clone, Copy)]
pub struct ServerModes {
    pub web_ui: bool,
    pub opds: bool,
}

impl ServerModes {
    pub fn any(&self) -> bool { self.web_ui || self.opds }
}
```

### `WebServerStatus` (existing struct, extended)

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
    pub web_ui_enabled: bool,
    pub opds_enabled: bool,
}
```

### Settings (DB rows in `settings` table)

| Key | Type | Default | Notes |
|---|---|---|---|
| `web_ui_enabled` | `"true"` / `"false"` | `"false"` (fresh install) | Migrated from `web_server_enabled` for existing users. |
| `opds_enabled` | `"true"` / `"false"` | `"false"` (fresh install) | Same migration source. |
| `web_server_port` | `u16` as string | `"7788"` | Unchanged. |
| `web_server_enabled` | `"true"` / `"false"` | n/a | **Legacy.** Cleared by migration on first launch with new code. |

## Backend changes

### `web_server/mod.rs::build_router`

```rust
pub fn build_router(state: WebState, modes: ServerModes) -> Router {
    let mut router = Router::new();

    if modes.web_ui {
        // Web UI consumes /api, so /api lives alongside web_ui mode.
        let api_routes = api::routes(state.clone());
        router = router.nest("/api", api_routes).merge(web_ui::routes());
    }
    if modes.opds {
        router = router.nest("/opds", opds_feed::routes(state.clone()));
    }

    router
        .layer(middleware::from_fn_with_state(state.clone(), auth::auth_middleware))
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}
```

`build_router` with both modes off returns a router that 404s every path. Safe to call (used in tests).

### `web_server/mod.rs::start`

Signature gains a `modes: ServerModes` parameter. Body unchanged except `build_router(state, modes)` instead of `build_router(state)`.

### `commands.rs::web_server_set_modes`

```rust
#[tauri::command]
pub async fn web_server_set_modes(
    web_ui: bool,
    opds: bool,
    port: Option<u16>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<WebServerStatus> {
    // Persist intent first.
    {
        let conn = state.active_db()?.get()?;
        db::set_setting(&conn, "web_ui_enabled", &web_ui.to_string())?;
        db::set_setting(&conn, "opds_enabled", &opds.to_string())?;
        if let Some(p) = port {
            db::set_setting(&conn, "web_server_port", &p.to_string())?;
        }
    }

    let modes = ServerModes { web_ui, opds };

    // Stop existing handle (if any) before starting a fresh one.
    let prev = { state.web_server_handle.lock()?.take() };
    if let Some(h) = prev {
        web_server::stop(h);
    }

    if modes.any() {
        let port = effective_port(&state, port)?;
        let web_state = build_web_state(&state)?;     // factored out of old web_server_start
        let handle = web_server::start(web_state, port, modes).await?;
        *state.web_server_handle.lock()? = Some(handle);
    }

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

    let _ = crate::tray::rebuild_tray_menu(&app);
    web_server_status(state).await
}
```

`web_server_start` and `web_server_stop` commands are removed. `invoke_handler` registration in `lib.rs` updated.

### `commands.rs::migrate_web_server_setting`

```rust
fn migrate_web_server_setting(conn: &rusqlite::Connection) -> FolioResult<()> {
    let Some(old) = db::get_setting(conn, "web_server_enabled")? else {
        return Ok(());  // fresh install — defaults stay at false/false
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

`db::delete_setting(conn, key)` does not yet exist (verified in `folio-core/src/db.rs` — only `get_setting` and `set_setting`). Add it as part of this feature: a one-line `DELETE FROM settings WHERE key = ?1` helper. The migration is idempotent — running twice across launches finds no `web_server_enabled` row the second time.

Called from `lib.rs::run`'s init phase, before the auto-start path reads the new settings.

### Auto-start (`lib.rs`)

The existing block (around `lib.rs:216`) that reads `web_server_enabled` becomes:

```rust
let conn = pool.get()?;
migrate_web_server_setting(&conn).ok();
let web_ui = db::get_setting(&conn, "web_ui_enabled")?.as_deref() == Some("true");
let opds  = db::get_setting(&conn, "opds_enabled")?.as_deref()  == Some("true");
let modes = ServerModes { web_ui, opds };
if modes.any() {
    let port = /* same lookup as today */;
    if let Ok(handle) = web_server::start(web_state, port, modes).await {
        // store handle in app state
    }
}
```

## Frontend changes

### `src/components/SettingsPanel.tsx`

Replace the existing single Start/Stop button + status block with:

- Two checkboxes (Web UI, OPDS), each with a one-line hint underneath.
- Port input (existing, kept).
- PIN section (existing, kept).
- Status row: "Running at `<URL>`" + QR code, only visible when `running === true`.
- Error row: rendered below the checkboxes when `webServerError !== null`.

State:

```ts
const [webUiEnabled, setWebUiEnabled] = useState(false);
const [opdsEnabled,  setOpdsEnabled]  = useState(false);
// existing: webServerPort, webServerUrl, webServerPin, webServerQr, webServerError, webServerRunning
```

`webServerRunning` is derived from `web_server_status` response; not user-controlled.

Toggle handler:

```ts
const handleSetModes = async (next: { webUi?: boolean; opds?: boolean; port?: number }) => {
  setWebServerLoading(true);
  setWebServerError(null);
  try {
    const status = await invoke<WebServerStatus>("web_server_set_modes", {
      webUi: next.webUi ?? webUiEnabled,
      opds:  next.opds  ?? opdsEnabled,
      port:  next.port  ?? parseInt(webServerPort, 10),
    });
    setWebUiEnabled(status.webUiEnabled);
    setOpdsEnabled(status.opdsEnabled);
    setWebServerRunning(status.running);
    setWebServerUrl(status.url ?? null);
  } catch (err) {
    setWebServerError(friendlyError(err, t));
  } finally {
    setWebServerLoading(false);
  }
};
```

Backend persists intent before attempting start. If start fails (port in use), settings still say the user wanted it on; status reflects what actually runs. Mismatch surfaces as the URL row not appearing + an error message. Auto-start retries on next app launch.

### `src/components/Tray` / `src-tauri/src/tray.rs`

Replace the single "Start server" / "Stop server" tray item with two checkable items: "Web UI" and "OPDS". Click toggles the corresponding flag via `web_server_set_modes`. `rebuild_tray_menu` already runs after each command — keep.

### i18n keys

New keys (English + French):

```
settings.remoteAccess.webUiCheckbox      "Web UI"
settings.remoteAccess.webUiHint          "Browse your library from any phone or tablet."
settings.remoteAccess.opdsCheckbox       "OPDS"
settings.remoteAccess.opdsHint           "Catalog feed for OPDS apps (Thorium, KOReader, …)."
tray.server.webUi                        "Web UI"
tray.server.opds                         "OPDS"
```

Removed keys: `settings.startServer`, `settings.stopServer`, `tray.startServer`, `tray.stopServer` (whichever exist today — confirm at implementation time).

## Behavior matrix

| User action | Settings before | Result |
|---|---|---|
| Tick Web UI (was both off) | `web_ui=false, opds=false` | Both settings written; server starts in Web-UI-only mode. |
| Tick OPDS while Web UI on | `web_ui=true, opds=false` | Settings updated; server restarts in Both mode (~100 ms). |
| Untick Web UI while OPDS on | `web_ui=true, opds=true` | Server restarts in OPDS-only mode. Active web UI sessions terminate. |
| Untick the last enabled mode | `web_ui=true, opds=false` | Settings updated; handle stopped. URL/QR/PIN sections hide. |
| Change port while running | `web_ui=true, …` | Implicit restart with new port. Active connections drop. |
| Port-in-use error | n/a | Settings persisted (intent preserved); server stays stopped; error shown. Re-toggling triggers retry. |
| App quit + relaunch | settings persist | Auto-start path reads settings, restores prior mode. |
| Tray toggle while panel open | n/a | `set_modes` invoked from tray; panel re-fetches status on focus or via existing polling. |

## Migration matrix

| Pre-upgrade `web_server_enabled` | Post-migration |
|---|---|
| `"true"` | `web_ui_enabled="true"`, `opds_enabled="true"` (preserves Both behavior) |
| `"false"` | `web_ui_enabled="false"`, `opds_enabled="false"` (server stays off) |
| absent | No new keys written; defaults remain implicit `false`/`false` (fresh install) |
| migrated already | No-op; legacy key stays absent |

The migration is a one-shot upgrade; idempotent in the sense that re-running finds nothing to do.

## Logging

`web_server_started` / `web_server_stopped` activity entries are replaced by a single `web_server_modes_changed` entry containing the new `web_ui` + `opds` booleans + port. Cleaner audit trail (no false start/stop pairs around restarts).

## Testing

### Backend

`web_server/mod.rs::tests` — add four router-shape tests:

- `build_router_web_ui_only_serves_root_and_api_not_opds`
- `build_router_opds_only_serves_opds_not_web_ui`
- `build_router_both_serves_everything`
- `build_router_neither_serves_nothing`

Each spins up the existing TCP test harness and asserts status codes per path.

`commands.rs::tests` — add:

- `migrate_web_server_setting_true_sets_both_new_settings`
- `migrate_web_server_setting_false_sets_both_false`
- `migrate_web_server_setting_no_op_when_absent`
- `migrate_web_server_setting_idempotent`
- `web_server_set_modes_persists_both_settings` (DB assertion only; server start covered by router-shape tests)

### Frontend

`src/components/SettingsPanel.test.tsx` — add cases for:

- two checkboxes render
- ticking Web UI invokes `web_server_set_modes` with `{ webUi: true, opds: false, port: 7788 }`
- unticking the last mode hides URL/QR sections
- port input change re-invokes `set_modes` with new port
- error response renders under checkboxes

### Manual smoke test

1. Fresh install → both checkboxes off, server stopped.
2. Tick Web UI → server starts. `curl /` 200, `curl /opds` 404.
3. Tick OPDS → restart. Both reachable.
4. Untick Web UI → restart. `/` 404, `/opds` 200.
5. Untick OPDS → server stops; URL row hides.
6. Set port to a busy one → error, server stays stopped.
7. Quit + relaunch → previous mode restored.
8. Existing-user upgrade: prep DB with `web_server_enabled="true"`, launch with new code → both checkboxes ticked + server running.
9. Tray: toggle Web UI from tray menu → Settings panel updates within polling interval.

## Implementation phases

Single feature branch. Tasks (TDD, one commit each):

1. Backend — Add `db::delete_setting(conn, key)` helper + test.
2. Backend — `ServerModes` type + `build_router(state, modes)` signature change + 4 router-shape tests.
3. Backend — `web_server::start` accepts `modes`. Update existing call sites.
4. Backend — Add `web_server_set_modes` command + `WebServerStatus` extension.
5. Backend — Migration helper + auto-start path.
6. Backend — Remove `web_server_start` / `web_server_stop` commands; update `invoke_handler` registration.
7. Frontend — types + i18n keys.
8. Frontend — SettingsPanel UI swap (checkboxes replace start/stop button).
9. Tray — replace single item with two toggleable items.
10. Final CI gate + manual smoke.
