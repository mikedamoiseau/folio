pub mod commands;
pub mod db;
pub mod epub;
pub mod models;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("library.db");
            let conn = db::init_db(&db_path).expect("Failed to initialize database");
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_book,
            commands::get_library,
            commands::get_book,
            commands::remove_book,
            commands::get_chapter_content,
            commands::get_toc,
            commands::get_reading_progress,
            commands::save_reading_progress,
            commands::get_bookmarks,
            commands::add_bookmark,
            commands::remove_bookmark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
