#[cfg(test)]
mod ci_workflow_test;
pub mod commands;
pub mod page_wire;
#[cfg(test)]
mod release_workflow_test;
#[cfg(test)]
mod tauri_config_test;
pub mod tray;
pub mod web_server;

// Re-export every module that now lives in folio-core so existing `crate::…`
// call sites in commands.rs, web_server, and tray keep compiling unchanged.
// New code should prefer `use folio_core::…` directly.
pub use folio_core::{
    backup, cbr, cbz, db, enrichment, epub, error, image_util, models, opds, openlibrary,
    page_cache, paths, pdf, providers, sync,
};

use commands::{AppState, LruCache, ProfileState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    // WebDriver automation plugin — debug builds only
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_webdriver_automation::init());
    }

    builder
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("library.db");
            let pool = db::create_pool(&db_path)?;

            // Ensure the library folder exists on first launch.
            {
                let conn = pool.get()?;
                let library_folder = match db::get_setting(&conn, "library_folder").ok().flatten() {
                    Some(f) => f,
                    None => commands::default_library_folder()?,
                };
                let _ = std::fs::create_dir_all(&library_folder);
            }

            // Resolve bundled pdfium library path.
            #[cfg(target_os = "macos")]
            let pdfium_lib_name = "libpdfium.dylib";
            #[cfg(target_os = "linux")]
            let pdfium_lib_name = "libpdfium.so";
            #[cfg(target_os = "windows")]
            let pdfium_lib_name = "pdfium.dll";

            let pdfium_path = app.path().resource_dir().ok().and_then(|d| {
                // Bundled resources preserve their relative path from tauri.conf.json
                let nested = d.join("resources").join(pdfium_lib_name);
                if nested.exists() {
                    return Some(nested);
                }
                // Fallback: flat layout (e.g. custom bundling)
                let flat = d.join(pdfium_lib_name);
                if flat.exists() {
                    return Some(flat);
                }
                // Dev mode fallback: resource_dir() points to target/debug/ where
                // pdfium isn't copied, so check the source resources/ directory.
                let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join(pdfium_lib_name);
                if dev_path.exists() {
                    return Some(dev_path);
                }
                None
            });

            pdf::set_pdfium_library_path(pdfium_path);

            // Load existing profile databases
            let data_dir = app.path().app_data_dir()?;
            let mut profiles = std::collections::HashMap::new();
            if let Ok(entries) = std::fs::read_dir(&data_dir) {
                for entry in entries.flatten() {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    if let Some(name) = fname
                        .strip_prefix("library-")
                        .and_then(|s| s.strip_suffix(".db"))
                    {
                        if let Ok(p) = db::create_pool(&entry.path()) {
                            profiles.insert(name.to_string(), p);
                        }
                    }
                }
            }

            let enrichment_registry = {
                let mut reg = crate::providers::ProviderRegistry::new();
                if let Ok(conn) = pool.get() {
                    if let Ok(Some(json)) = crate::db::get_setting(&conn, "enrichment_providers") {
                        if let Ok(configs) = serde_json::from_str::<
                            std::collections::HashMap<String, crate::providers::ProviderConfig>,
                        >(&json)
                        {
                            for (id, config) in configs {
                                reg.configure_provider(&id, config);
                            }
                        }
                    }
                    if let Ok(Some(order_json)) =
                        crate::db::get_setting(&conn, "enrichment_provider_order")
                    {
                        if let Ok(order) = serde_json::from_str::<Vec<String>>(&order_json) {
                            reg.reorder(&order);
                        }
                    }
                }
                std::sync::Mutex::new(reg)
            };

            app.manage(AppState {
                shared_active_pool: std::sync::Arc::new(std::sync::Mutex::new(pool.clone())),
                shared_pin_hash: std::sync::Arc::new(std::sync::Mutex::new(
                    crate::web_server::auth::load_pin_hash(),
                )),
                db: pool,
                profile_state: std::sync::Mutex::new(ProfileState {
                    active: "default".to_string(),
                    pools: profiles,
                }),
                data_dir,
                epub_cache: std::sync::Mutex::new(LruCache::new(5)),
                #[cfg(feature = "mobi")]
                mobi_cache: std::sync::Mutex::new({
                    let mut c = LruCache::new(5);
                    // Cap by total bytes — owned MOBI bytes (chapter HTML +
                    // image resources) can run hundreds of MB on illustrated
                    // AZW3s, so entry count alone is not a sufficient guard.
                    // 200 MB matches the PDF cache budget below.
                    c.set_max_bytes(200 * 1024 * 1024);
                    c
                }),
                enrichment_registry,
                web_server_handle: std::sync::Mutex::new(None),
            });

            // Initialize system tray
            if let Err(e) = tray::setup_tray(&app.handle().clone()) {
                log::error!("Failed to initialize tray: {}", e);
            }

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
                    sessions: std::sync::Arc::new(std::sync::Mutex::new(
                        std::collections::HashMap::new(),
                    )),
                    login_limiter: std::sync::Arc::new(web_server::auth::RateLimiter::new(5, 300)),
                };
                if let Ok(handle) = web_server::start(web_state, port, modes).await {
                    {
                        let mut h = match state.web_server_handle.lock() {
                            Ok(g) => g,
                            Err(_) => {
                                log::error!("web-server handle mutex poisoned");
                                return;
                            }
                        };
                        *h = Some(handle);
                    }
                    // Drop the guard before rebuild_tray_menu (which locks
                    // the same mutex) — otherwise we deadlock at boot.
                    let _ = tray::rebuild_tray_menu(&app_handle);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_book,
            commands::get_supported_formats,
            commands::get_library,
            commands::get_library_grid,
            commands::get_recently_read,
            commands::update_book_metadata,
            commands::get_all_tags,
            commands::get_book_tags,
            commands::add_tag_to_book,
            commands::remove_tag_from_book,
            commands::get_all_book_tags,
            commands::scan_folder_for_books,
            commands::add_highlight,
            commands::get_highlights,
            commands::get_chapter_highlights,
            commands::update_highlight_note,
            commands::remove_highlight,
            commands::export_highlights_markdown,
            commands::record_reading_session,
            commands::get_reading_stats,
            commands::export_collection_markdown,
            commands::export_collection_json,
            commands::export_library,
            commands::import_library_backup,
            commands::get_book,
            commands::remove_book,
            commands::get_chapter_content,
            commands::get_all_chapters,
            commands::get_chapter_word_counts,
            commands::search_book_content,
            commands::get_toc,
            commands::get_reading_progress,
            commands::get_all_reading_progress,
            commands::save_reading_progress,
            commands::get_bookmarks,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::update_bookmark,
            commands::get_comic_page_count,
            commands::get_comic_page_bytes,
            commands::check_pdf_support,
            commands::get_pdf_page_count,
            commands::get_pdf_page_bytes,
            commands::prepare_pdf,
            commands::create_collection,
            commands::update_collection,
            commands::get_collections,
            commands::delete_collection,
            commands::add_book_to_collection,
            commands::remove_book_from_collection,
            commands::get_books_in_collection,
            commands::get_books_in_collection_grid,
            commands::get_library_folder,
            commands::get_library_folder_info,
            commands::set_library_folder,
            commands::get_profiles,
            commands::create_profile,
            commands::switch_profile,
            commands::delete_profile,
            commands::search_openlibrary,
            commands::enrich_book_from_openlibrary,
            commands::get_opds_catalogs,
            commands::add_opds_catalog,
            commands::remove_opds_catalog,
            commands::get_discover_books,
            commands::browse_opds,
            commands::search_all_catalogs,
            commands::download_opds_book,
            commands::get_backup_providers,
            commands::save_backup_config,
            commands::get_backup_config,
            commands::run_backup,
            commands::get_backup_status,
            commands::start_scan,
            commands::cancel_scan,
            commands::start_files_import,
            commands::start_folder_import,
            commands::cancel_import,
            commands::is_import_running,
            commands::scan_single_book,
            commands::queue_book_for_scan,
            commands::get_setting_value,
            commands::set_setting_value,
            commands::get_feature_flags,
            commands::set_feature_flag,
            commands::get_feature_flag_value,
            commands::delete_feature_flag,
            commands::get_enrichment_providers,
            commands::set_enrichment_provider_config,
            commands::set_enrichment_provider_order,
            commands::get_activity_log,
            commands::preview_collection_rules,
            commands::import_custom_font,
            commands::get_custom_fonts,
            commands::remove_custom_font,
            commands::get_series,
            commands::copy_to_library,
            commands::check_file_exists,
            commands::cleanup_library,
            commands::list_auto_backups,
            commands::prepare_comic,
            commands::get_cache_stats,
            commands::clear_page_cache,
            commands::sync_pull_book,
            commands::sync_push_book,
            commands::web_server_set_modes,
            commands::web_server_status,
            commands::web_server_set_pin,
            commands::web_server_get_qr,
            commands::bulk_delete_books,
            commands::bulk_add_to_collection,
            commands::bulk_add_tag,
            commands::bulk_update_metadata,
            commands::get_autostart_enabled,
            commands::set_autostart_enabled,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    use tauri_plugin_autostart::ManagerExt;
                    let autostart_enabled = window
                        .app_handle()
                        .autolaunch()
                        .is_enabled()
                        .unwrap_or(false);
                    let tray_available = window.app_handle().tray_by_id("main").is_some();

                    if autostart_enabled && tray_available {
                        api.prevent_close();
                        // Minimize instead of hide — minimized windows keep
                        // the macOS event loop alive so the tray menu works.
                        let _ = window.minimize();
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                // code == None means macOS auto-exit because no visible windows.
                // Prevent this when autostart is enabled (tray should stay alive).
                if code.is_none() {
                    use tauri_plugin_autostart::ManagerExt;
                    let autostart_enabled = app_handle.autolaunch().is_enabled().unwrap_or(false);
                    let tray_available = app_handle.tray_by_id("main").is_some();
                    if autostart_enabled && tray_available {
                        api.prevent_exit();
                    }
                }
            }
        });
}
