use tauri::{
    menu::{MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::commands::AppState;

/// Build (or rebuild) the tray menu based on current web server state.
pub fn build_tray_menu(
    app: &AppHandle,
    web_server_running: bool,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
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

/// Initialize the tray icon and attach menu event handlers.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let web_server_running = {
        let state = app.state::<AppState>();
        let handle = state.web_server_handle.lock().unwrap();
        handle.is_some()
    };

    let menu = build_tray_menu(app, web_server_running)?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
            "show" => {
                // macOS: restore Regular activation policy so the dock icon
                // reappears and the window can take focus.
                #[cfg(target_os = "macos")]
                {
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                }
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
        let handle = {
            let mut h = state.web_server_handle.lock().unwrap();
            h.take()
        };
        if let Some(h) = handle {
            crate::web_server::stop(h);
            if let Ok(conn) = state
                .active_db()
                .and_then(|p| p.get().map_err(|e| e.to_string()))
            {
                let _ = crate::db::set_setting(&conn, "web_server_enabled", "false");
            }
        }
    } else {
        let port = {
            let conn = state
                .active_db()
                .and_then(|p| p.get().map_err(|e| e.to_string()));
            conn.ok()
                .and_then(|c| crate::db::get_setting(&c, "web_server_port").ok().flatten())
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(crate::web_server::DEFAULT_PORT)
        };

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
            if let Ok(conn) = state
                .active_db()
                .and_then(|p| p.get().map_err(|e| e.to_string()))
            {
                let _ = crate::db::set_setting(&conn, "web_server_enabled", "true");
                let _ = crate::db::set_setting(&conn, "web_server_port", &port.to_string());
            }
        }
    }

    let _ = rebuild_tray_menu(app);
}

/// Rebuild the tray menu to reflect the current web server state.
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
