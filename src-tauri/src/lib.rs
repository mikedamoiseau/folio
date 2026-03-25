pub mod cbr;
pub mod cbz;
pub mod commands;
pub mod db;
pub mod epub;
pub mod models;
pub mod pdf;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("library.db");
            let pool = db::create_pool(&db_path).expect("Failed to initialize database");

            // Ensure the library folder exists on first launch.
            {
                let conn = pool.get().expect("Failed to get DB connection on startup");
                let library_folder = match db::get_setting(&conn, "library_folder") {
                    Ok(Some(f)) => f,
                    _ => commands::default_library_folder()
                        .expect("Cannot determine home directory"),
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

            let pdfium_path = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join(pdfium_lib_name))
                .filter(|p| p.exists());

            pdf::set_pdfium_library_path(pdfium_path);

            app.manage(AppState { db: pool });
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
            commands::get_comic_page_count,
            commands::get_comic_page,
            commands::get_pdf_page_count,
            commands::get_pdf_page,
            commands::create_collection,
            commands::get_collections,
            commands::delete_collection,
            commands::add_book_to_collection,
            commands::remove_book_from_collection,
            commands::get_books_in_collection,
            commands::get_library_folder,
            commands::get_library_folder_info,
            commands::set_library_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
