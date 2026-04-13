# System Tray & Launch at Startup — Design Spec

## Goal

Add a system tray icon and launch-at-startup capability so Folio can run as a background service, keeping the web server accessible without the main window open.

## Architecture

Two Tauri features are added:

- **`tauri-plugin-autostart`** — manages OS login item registration (LaunchAgent on macOS, Registry on Windows, XDG autostart on Linux).
- **Tauri tray (core feature)** — system tray icon with a context menu, configured in `tauri.conf.json` and initialized in Rust setup code.

### Data Flow

1. App starts → tray icon initialized with menu → autostart plugin state synced from `autostart_enabled` DB setting.
2. Tray menu provides: Show Folio, Open Web UI, Start/Stop Web Server, Quit Folio.
3. Web server state changes (start/stop) trigger a tray menu rebuild to reflect current state.
4. Window close (X button): if `autostart_enabled` is `"true"`, hide window to tray; otherwise quit normally.
5. "Quit Folio" from tray always fully exits (stops web server, removes tray, terminates process).

### Settings Storage

Uses the existing SQLite `settings` table (key/value via `db::get_setting` / `db::set_setting`):

| Key | Values | Purpose |
|-----|--------|---------|
| `autostart_enabled` | `"true"` / `"false"` | Whether app launches at OS login |
| `web_server_enabled` | `"true"` / `"false"` | Already exists — controls web server auto-start on launch |

### New Tauri IPC Commands

| Command | Direction | Purpose |
|---------|-----------|---------|
| `get_autostart_enabled` | Frontend → Backend | Read current autostart state |
| `set_autostart_enabled` | Frontend → Backend | Enable/disable autostart (writes DB + calls plugin) |

No new commands for tray — tray logic is entirely in Rust (`lib.rs` setup).

## Tray Icon

Reuse the existing `icons/32x32.png` as the tray icon for v1. macOS template-image refinement (monochrome icon) deferred to a future iteration.

## Tray Menu

```
Show Folio              → show/focus the main window
Open Web UI             → open web server URL in default browser
                           (greyed out when web server is off)
─────────────────────────
Start Web Server        → start the web server on saved port
  (or)
Stop Web Server         → stop the running web server
─────────────────────────
Quit Folio              → full exit: stop web server, remove tray, terminate
```

The menu is rebuilt from scratch whenever web server state changes. This is simpler and more reliable than mutating individual menu items.

### Tray Click Behavior

- **macOS:** Left-click opens the menu (standard menu bar behavior).
- **Windows/Linux:** Left-click shows the app window; right-click opens the menu.

## Window Close Behavior

When the user clicks the window close button (X):

1. Read `autostart_enabled` from the DB.
2. If `"true"` → call `event.prevent_close()` and `window.hide()`. App stays in tray. Web server keeps running.
3. If `"false"` → normal quit behavior. Stop web server, exit.

Users who have autostart enabled use "Quit Folio" from the tray menu to fully exit.

## Settings UI

### New "General" Section

Added as the **first** accordion section in `SettingsPanel.tsx`, above "Appearance":

```
▼ General
  Launch at startup          [toggle]
```

- Toggle calls `set_autostart_enabled` on change.
- On mount, reads state via `get_autostart_enabled`.
- If the autostart plugin fails (permissions, OS restrictions), show an error and revert the toggle.

### Web Server Section (existing)

No new toggle needed. The existing start/stop behavior already persists `web_server_enabled`, and `lib.rs` already auto-starts the web server on launch when this is `"true"`. The current UX is sufficient — when users start the web server, it stays on across restarts.

## Backend Implementation

### Dependencies

Add to `Cargo.toml`:

```toml
tauri-plugin-autostart = "2"
```

Enable tray in `tauri.conf.json`:

```json
{
  "app": {
    "tray": {
      "iconPath": "icons/32x32.png",
      "iconAsTemplate": true
    }
  }
}
```

Note: Tauri v2 tray configuration may require the `"tray-icon"` feature on the `tauri` dependency. Verify during implementation.

### Tray Setup (lib.rs)

In `tauri::Builder::default().setup()`:

1. Register `tauri-plugin-autostart`.
2. Build the initial tray menu (web server defaults to off state).
3. Set tray menu event handler for each menu item.
4. Store a reference to the tray so menu can be rebuilt on web server state changes.

### Tray Menu Rebuild

Expose a helper function `rebuild_tray_menu(app_handle, web_server_running: bool)` that:

1. Constructs the menu items with correct labels and enabled/disabled states.
2. Sets the menu on the tray icon.

Called from:
- `web_server_start` command (after successful start)
- `web_server_stop` command (after stop)
- Tray menu "Start/Stop Web Server" handler
- Initial setup

### Window Close Override

Modify the existing `on_window_event` handler:

```
CloseRequested → check autostart_enabled → if true: prevent_close + hide window
Destroyed → stop web server (existing logic, kept as safety net)
```

### Autostart Commands

```rust
#[tauri::command]
fn get_autostart_enabled(state: State<AppState>) -> Result<bool, String>

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<(), String>
```

`set_autostart_enabled`:
1. Call autostart plugin enable/disable.
2. On success, persist `"autostart_enabled"` to DB.
3. On failure, return error (frontend shows toast, doesn't persist).

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Autostart plugin fails to register | Return error to frontend. Don't persist setting. Show error in settings UI. |
| Tray icon fails to initialize | Log error. App works normally without tray. Non-critical. |
| Web server start fails from tray menu | Rebuild menu to reflect "off" state. Log error. |
| Open Web UI when server just stopped | Menu item is greyed out (state check prevents this). |

## Testing

- **Rust unit tests:** `get_autostart_enabled` / `set_autostart_enabled` DB read/write logic.
- **Frontend Vitest:** General settings section renders, toggle calls correct invoke commands.
- **Manual testing:** Tray icon appears, menu works, window hide/show, autostart registers/unregisters, web server start/stop from tray, cross-platform behavior.

Tray and autostart plugin behavior are platform-dependent and not unit-testable — manual testing required.

## Platform Notes

| Platform | Autostart Mechanism | Tray Location |
|----------|-------------------|---------------|
| macOS | LaunchAgent | Menu bar (top-right) |
| Windows | Registry `HKCU\...\Run` | System tray (bottom-right) |
| Linux | XDG autostart `~/.config/autostart/` | System tray / indicator area |

No special permissions required on any platform. No dock-icon hiding in v1.

## Scope Exclusions

- macOS dock icon hiding when minimized to tray (deferred)
- Custom monochrome tray icon for macOS template image (deferred)
- Tray notification badges or unread counts
- Multiple window support
