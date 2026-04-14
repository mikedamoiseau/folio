# System Tray & Launch at Startup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a system tray icon with context menu and launch-at-startup capability so Folio can run as a background service.

**Architecture:** Two Tauri features — the built-in `tray-icon` for the system tray menu and `tauri-plugin-autostart` for OS login item registration. Tray menu is rebuilt from scratch on web server state changes. Window close hides to tray when autostart is enabled. Two new IPC commands expose autostart state to the frontend settings panel.

**Tech Stack:** Tauri v2 (tray-icon feature), tauri-plugin-autostart v2, Rust, React 19, TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Add `tauri-plugin-autostart` dep, add `"tray-icon"` feature to `tauri` |
| `src-tauri/tauri.conf.json` | Modify | No tray config needed in v2 (built programmatically) |
| `src-tauri/src/tray.rs` | Create | Tray icon setup, menu building, menu event handling |
| `src-tauri/src/lib.rs` | Modify | Register autostart plugin, call tray setup, modify window close event |
| `src-tauri/src/commands.rs` | Modify | Add `get_autostart_enabled` and `set_autostart_enabled` commands |
| `src/components/SettingsPanel.tsx` | Modify | Add "General" accordion section with autostart toggle |
| `src/locales/en.json` | Modify | Add i18n keys for General section |
| `src/locales/fr.json` | Modify | Add i18n keys for General section |

---

### Task 1: Add Dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add tauri-plugin-autostart and tray-icon feature**

In `src-tauri/Cargo.toml`, add the autostart plugin to `[dependencies]` and add the `"tray-icon"` feature to the existing `tauri` dependency:

```toml
tauri = { version = "2", features = ["protocol-asset", "tray-icon"] }
```

And add:

```toml
tauri-plugin-autostart = "2"
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add tauri-plugin-autostart and tray-icon feature"
```

---

### Task 2: Create Tray Module — Menu Builder

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `tray.rs` with the `build_tray_menu` function**

Create `src-tauri/src/tray.rs`:

```rust
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::commands::AppState;

/// Build (or rebuild) the tray menu based on current web server state.
pub fn build_tray_menu(app: &AppHandle, web_server_running: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let show_item = MenuItemBuilder::with_id("show", "Show Folio").build(app)?;

    let open_webui = MenuItemBuilder::with_id("open_webui", "Open Web UI")
        .enabled(web_server_running)
        .build(app)?;

    let sep1 = PredefinedMenuItem::separator(app)?;

    let web_toggle = if web_server_running {
        MenuItemBuilder::with_id("web_toggle", "Stop Web Server").build(app)?
    } else {
        MenuItemBuilder::with_id("web_toggle", "Start Web Server").build(app)?
    };

    let sep2 = PredefinedMenuItem::separator(app)?;

    let quit_item = MenuItemBuilder::with_id("quit", "Quit Folio").build(app)?;

    MenuBuilder::new(app)
        .item(&show_item)
        .item(&open_webui)
        .item(&sep1)
        .item(&web_toggle)
        .item(&sep2)
        .item(&quit_item)
        .build()
}
```

- [ ] **Step 2: Register the module in `lib.rs`**

In `src-tauri/src/lib.rs`, add `pub mod tray;` to the module declarations (after `pub mod web_server;`):

```rust
pub mod tray;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors (unused warnings are fine at this stage).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "feat(tray): add tray module with menu builder"
```

---

### Task 3: Tray Initialization and Event Handling

**Files:**
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `setup_tray` function to `tray.rs`**

Add the following function to `src-tauri/src/tray.rs` below `build_tray_menu`:

```rust
/// Initialize the tray icon and attach menu event handlers.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let web_server_running = {
        let state = app.state::<AppState>();
        let handle = state.web_server_handle.lock().unwrap();
        handle.is_some()
    };

    let menu = build_tray_menu(app, web_server_running)?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .menu_on_left_click(true)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "open_webui" => {
                    let state = app.state::<AppState>();
                    let url = {
                        let handle = state.web_server_handle.lock().unwrap();
                        handle.as_ref().map(|h| h.url.clone())
                    };
                    if let Some(url) = url {
                        let _ = open::that(&url);
                    }
                }
                "web_toggle" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        toggle_web_server(&app).await;
                    });
                }
                "quit" => {
                    let state = app.state::<AppState>();
                    let handle = state
                        .web_server_handle
                        .lock()
                        .ok()
                        .and_then(|mut h| h.take());
                    if let Some(h) = handle {
                        crate::web_server::stop(h);
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

/// Toggle the web server on/off from the tray menu.
async fn toggle_web_server(app: &AppHandle) {
    let state = app.state::<AppState>();
    let is_running = {
        let handle = state.web_server_handle.lock().unwrap();
        handle.is_some()
    };

    if is_running {
        // Stop the web server
        let handle = {
            let mut h = state.web_server_handle.lock().unwrap();
            h.take()
        };
        if let Some(h) = handle {
            crate::web_server::stop(h);
            let conn = state.active_db().and_then(|p| p.get().map_err(|e| e.to_string()));
            if let Ok(conn) = conn {
                let _ = crate::db::set_setting(&conn, "web_server_enabled", "false");
            }
        }
    } else {
        // Start the web server
        let port = {
            let conn = state.active_db().and_then(|p| p.get().map_err(|e| e.to_string()));
            conn.ok()
                .and_then(|c| crate::db::get_setting(&c, "web_server_port").ok().flatten())
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(crate::web_server::DEFAULT_PORT)
        };

        // Sync PIN hash
        {
            let fresh = crate::web_server::auth::load_pin_hash();
            let mut ph = state.shared_pin_hash.lock().unwrap();
            *ph = fresh;
        }

        let web_state = crate::web_server::WebState {
            pool: state.shared_active_pool.clone(),
            data_dir: state.data_dir.clone(),
            pin_hash: state.shared_pin_hash.clone(),
            sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            login_limiter: std::sync::Arc::new(crate::web_server::auth::RateLimiter::new(5, 300)),
        };

        if let Ok(handle) = crate::web_server::start(web_state, port).await {
            let mut h = state.web_server_handle.lock().unwrap();
            *h = Some(handle);
            let conn = state.active_db().and_then(|p| p.get().map_err(|e| e.to_string()));
            if let Ok(conn) = conn {
                let _ = crate::db::set_setting(&conn, "web_server_enabled", "true");
                let _ = crate::db::set_setting(&conn, "web_server_port", &port.to_string());
            }
        }
    }

    // Rebuild tray menu to reflect new state
    let _ = rebuild_tray_menu(app);
}

/// Rebuild the tray menu to reflect the current web server state.
/// Called after web server start/stop.
pub fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let web_server_running = {
        let handle = state.web_server_handle.lock().unwrap();
        handle.is_some()
    };

    let menu = build_tray_menu(app, web_server_running)?;

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}
```

- [ ] **Step 2: Add the `open` crate to `Cargo.toml`**

The `open::that()` call needs the `open` crate. Add to `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
open = "5"
```

- [ ] **Step 3: Update `TrayIconBuilder` to set an ID**

In the `setup_tray` function, add `.id("main")` to the `TrayIconBuilder` chain so `rebuild_tray_menu` can find it:

```rust
    let _tray = TrayIconBuilder::new()
        .id("main")
        .icon(app.default_window_icon().unwrap().clone())
```

- [ ] **Step 4: Call `setup_tray` from `lib.rs` setup**

In `src-tauri/src/lib.rs`, inside the `.setup(|app| { ... })` closure, after the existing `app.manage(AppState { ... })` call and before the auto-start web server block, add:

```rust
            // Initialize system tray
            if let Err(e) = tray::setup_tray(&app.handle().clone()) {
                log::error!("Failed to initialize tray: {}", e);
            }
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "feat(tray): add tray icon initialization and menu event handling"
```

---

### Task 4: Rebuild Tray Menu on Web Server State Changes

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add tray rebuild call to `web_server_start` command**

In `src-tauri/src/commands.rs`, in the `web_server_start` function, after the line `let _ = db::set_setting(&conn, "web_server_port", &port.to_string());`, add:

```rust
    // Rebuild tray menu to reflect server running state
    if let Some(app) = tauri::async_runtime::handle()
        .block_on(async { None::<AppHandle> })
        .or(None)
    {
        // We need the app handle — get it from the state parameter
    }
```

Actually, the `web_server_start` command doesn't have the `AppHandle`. We need to add it as a parameter. Modify the function signature from:

```rust
pub async fn web_server_start(
    port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<String, String> {
```

to:

```rust
pub async fn web_server_start(
    app: AppHandle,
    port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<String, String> {
```

Then at the end of the function, before `Ok(url)`, add:

```rust
    let _ = crate::tray::rebuild_tray_menu(&app);
```

- [ ] **Step 2: Add tray rebuild call to `web_server_stop` command**

Similarly, modify `web_server_stop` to accept `AppHandle`:

```rust
pub async fn web_server_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
```

Inside the `Some(h)` match arm, after `let _ = db::set_setting(&conn, "web_server_enabled", "false");`, add:

```rust
            let _ = crate::tray::rebuild_tray_menu(&app);
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors. Tauri automatically injects `AppHandle` from the runtime — adding it to the function signature is sufficient.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(tray): rebuild tray menu on web server start/stop"
```

---

### Task 5: Autostart Plugin Registration

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Register the autostart plugin in `lib.rs`**

In `src-tauri/src/lib.rs`, add the autostart plugin registration. Add this import near the top, before the `run()` function:

```rust
use tauri_plugin_autostart::MacosLauncher;
```

Then inside the `tauri::Builder::default()` chain, after `.plugin(tauri_plugin_clipboard_manager::init())`, add:

```rust
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(autostart): register autostart plugin"
```

---

### Task 6: Autostart IPC Commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the test for `get_autostart_enabled`**

In `src-tauri/src/commands.rs`, there are no existing unit tests in this file (tests are in `db.rs` and `web_server/mod.rs`). Since the autostart commands are thin wrappers over `db::get_setting` / `db::set_setting` (which are already tested), we test the DB read/write logic. Add a test in `src-tauri/src/db.rs` at the end of the existing `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn test_autostart_setting_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let pool = create_pool(&dir.path().join("test.db")).unwrap();
        let conn = pool.get().unwrap();

        // Default: no setting exists
        let val = get_setting(&conn, "autostart_enabled").unwrap();
        assert_eq!(val, None);

        // Set to true
        set_setting(&conn, "autostart_enabled", "true").unwrap();
        let val = get_setting(&conn, "autostart_enabled").unwrap();
        assert_eq!(val, Some("true".to_string()));

        // Set to false
        set_setting(&conn, "autostart_enabled", "false").unwrap();
        let val = get_setting(&conn, "autostart_enabled").unwrap();
        assert_eq!(val, Some("false".to_string()));
    }
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd src-tauri && cargo test test_autostart_setting_roundtrip -- --nocapture`
Expected: PASS (this tests existing `get_setting`/`set_setting` with the new key — the functions already exist).

- [ ] **Step 3: Add the `get_autostart_enabled` command**

In `src-tauri/src/commands.rs`, add the following command (near the other `get_setting_value` command):

```rust
#[tauri::command]
pub async fn get_autostart_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "autostart_enabled")
        .map_err(|e| e.to_string())?;
    Ok(val.as_deref() == Some("true"))
}
```

- [ ] **Step 4: Add the `set_autostart_enabled` command**

In `src-tauri/src/commands.rs`, add:

```rust
#[tauri::command]
pub async fn set_autostart_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let autostart = app.autolaunch();

    if enabled {
        autostart.enable().map_err(|e| format!("Failed to enable autostart: {}", e))?;
    } else {
        autostart.disable().map_err(|e| format!("Failed to disable autostart: {}", e))?;
    }

    // Only persist to DB after the plugin call succeeds
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "autostart_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;

    Ok(())
}
```

- [ ] **Step 5: Register the new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add the two new commands to the `invoke_handler` macro. Add them after `commands::web_server_get_qr,`:

```rust
            commands::get_autostart_enabled,
            commands::set_autostart_enabled,
```

- [ ] **Step 6: Verify it compiles and tests pass**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/db.rs
git commit -m "feat(autostart): add get/set autostart IPC commands"
```

---

### Task 7: Window Close-to-Tray Behavior

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Modify the `on_window_event` handler**

In `src-tauri/src/lib.rs`, replace the existing `on_window_event` block:

```rust
        // R5-1: Graceful shutdown — stop web server when app exits
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                let handle = state
                    .web_server_handle
                    .lock()
                    .ok()
                    .and_then(|mut h| h.take());
                if let Some(h) = handle {
                    web_server::stop(h);
                }
            }
        })
```

with:

```rust
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // If autostart is enabled, hide to tray instead of quitting
                    let state = window.state::<AppState>();
                    let autostart_enabled = state
                        .active_db()
                        .and_then(|p| p.get().map_err(|e| e.to_string()))
                        .ok()
                        .and_then(|conn| {
                            db::get_setting(&conn, "autostart_enabled").ok().flatten()
                        })
                        .as_deref()
                        == Some("true");

                    if autostart_enabled {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // R5-1: Graceful shutdown — stop web server when app exits
                    let state = window.state::<AppState>();
                    let handle = state
                        .web_server_handle
                        .lock()
                        .ok()
                        .and_then(|mut h| h.take());
                    if let Some(h) = handle {
                        web_server::stop(h);
                    }
                }
                _ => {}
            }
        })
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): hide window to tray on close when autostart enabled"
```

---

### Task 8: Rebuild Tray on Web Server Auto-Start

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Rebuild tray after web server auto-starts on launch**

In `src-tauri/src/lib.rs`, in the existing auto-start web server block (inside the `tauri::async_runtime::spawn` closure), after the successful web server start:

```rust
                    if let Ok(handle) = web_server::start(web_state, port).await {
                        let mut h = state.web_server_handle.lock().unwrap();
                        *h = Some(handle);
                    }
```

Add a tray menu rebuild after the handle is stored:

```rust
                    if let Ok(handle) = web_server::start(web_state, port).await {
                        let mut h = state.web_server_handle.lock().unwrap();
                        *h = Some(handle);
                        // Update tray menu to show "Stop Web Server"
                        let _ = tray::rebuild_tray_menu(&app_handle);
                    }
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): rebuild tray menu after web server auto-start"
```

---

### Task 9: Frontend — Add i18n Keys

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English i18n keys**

In `src/locales/en.json`, add the following keys in the `settings` section. Find the line `"remoteAccess": "Remote Access",` and add these keys before it:

```json
    "general": "General",
    "launchAtStartup": "Launch at startup",
    "launchAtStartupHint": "Start Folio automatically when you log in",
    "autoStartFailed": "Failed to change autostart: {{error}}",
```

- [ ] **Step 2: Add French i18n keys**

In `src/locales/fr.json`, add the corresponding French translations in the same location:

```json
    "general": "Général",
    "launchAtStartup": "Lancer au démarrage",
    "launchAtStartupHint": "Démarrer Folio automatiquement à la connexion",
    "autoStartFailed": "Erreur lors du changement du démarrage automatique : {{error}}",
```

- [ ] **Step 3: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add autostart setting translation keys"
```

---

### Task 10: Frontend — General Settings Section with Autostart Toggle

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Test: `src/components/SettingsPanel.test.tsx` (if feasible, see note)

- [ ] **Step 1: Add autostart state variable**

In `src/components/SettingsPanel.tsx`, inside the `SettingsPanel` function, after the existing `const [openSection, setOpenSection]` state declaration (around line 292), add:

```typescript
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
```

- [ ] **Step 2: Load autostart state on mount**

In the existing `useEffect` that runs on mount (look for the one that initializes web server state or settings), add a call to load autostart state. If there isn't a suitable existing effect, add a new one after the state declarations:

```typescript
  useEffect(() => {
    invoke<boolean>("get_autostart_enabled").then(setAutoStartEnabled).catch(() => {});
  }, []);
```

- [ ] **Step 3: Add the General accordion section**

In the JSX, find the first `<Accordion>` (the "Appearance" section, around line 876). Add the "General" section **before** it:

```tsx
          {/* General */}
          <Accordion title={t("settings.general")} open={openSection === "general"} onToggle={() => toggleSection("general")}>
            <div className="space-y-2">
              <label className="flex items-center justify-between gap-3 bg-warm-subtle rounded-xl px-3 py-2.5">
                <div>
                  <span className="text-sm text-ink">{t("settings.launchAtStartup")}</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">{t("settings.launchAtStartupHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoStartEnabled}
                  disabled={autoStartLoading}
                  onClick={async () => {
                    const newValue = !autoStartEnabled;
                    setAutoStartLoading(true);
                    setAutoStartError(null);
                    try {
                      await invoke("set_autostart_enabled", { enabled: newValue });
                      setAutoStartEnabled(newValue);
                    } catch (e) {
                      setAutoStartError(t("settings.autoStartFailed", { error: friendlyError(String(e), t) }));
                    }
                    setAutoStartLoading(false);
                  }}
                  className={`relative w-10 h-6 rounded-full transition-colors ${autoStartEnabled ? "bg-accent" : "bg-warm-border"} ${autoStartLoading ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${autoStartEnabled ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
              {autoStartError && (
                <p className="text-xs text-red-500 px-1">{autoStartError}</p>
              )}
            </div>
          </Accordion>
```

- [ ] **Step 4: Run type-check**

Run: `npm run type-check`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): add General section with launch-at-startup toggle"
```

---

### Task 11: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run Rust tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 2: Run Rust lints**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: No warnings.

- [ ] **Step 3: Run Rust format check**

Run: `cd src-tauri && cargo fmt --check`
Expected: No formatting issues (run `cargo fmt` if needed).

- [ ] **Step 4: Run frontend type-check**

Run: `npm run type-check`
Expected: No type errors.

- [ ] **Step 5: Run frontend tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 6: Manual test — dev mode**

Run: `npm run tauri dev`

Verify:
1. Tray icon appears in macOS menu bar (or system tray on Windows/Linux)
2. Click tray icon — menu appears with: Show Folio, Open Web UI (greyed out), separator, Start Web Server, separator, Quit Folio
3. Click "Start Web Server" — menu updates to show "Stop Web Server", "Open Web UI" becomes clickable
4. Click "Open Web UI" — browser opens with the web server URL
5. Click "Stop Web Server" — menu reverts to "Start Web Server", "Open Web UI" greyed out again
6. Open Settings > General > toggle "Launch at startup" on — no errors
7. Toggle it off — no errors
8. With "Launch at startup" ON, close the app window (Cmd+W / X button) — window hides, tray icon stays, app keeps running
9. Click "Show Folio" from tray — window reappears
10. Click "Quit Folio" from tray — app fully exits
11. With "Launch at startup" OFF, close the app window — app fully exits

- [ ] **Step 7: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix(tray): address issues found during manual testing"
```

(Only if fixes were needed.)
