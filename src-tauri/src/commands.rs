use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::db;
use crate::epub;
use crate::models::{Book, Bookmark, ReadingProgress};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

// --- Library management ---

#[tauri::command]
pub async fn import_book(
    file_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Book, String> {
    // Return the existing book if this file has already been imported.
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = db::get_book_by_file_path(&conn, &file_path).map_err(|e| e.to_string())? {
            return Ok(existing);
        }
    }

    let metadata = epub::parse_epub_metadata(&file_path).map_err(|e| e.to_string())?;

    let book_id = Uuid::new_v4().to_string();

    let cover_path = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| {
            let cover_dir = dir.join("covers").join(&book_id);
            let dest = cover_dir.to_string_lossy().to_string();
            epub::extract_cover(&file_path, &dest).ok().flatten()
        });

    let chapters = epub::get_chapter_list(&file_path).map_err(|e| e.to_string())?;

    let book = Book {
        id: book_id,
        title: metadata.title,
        author: metadata.author,
        file_path,
        cover_path,
        total_chapters: chapters.len() as u32,
        added_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::insert_book(&conn, &book).map_err(|e| e.to_string())?;

    Ok(book)
}

#[tauri::command]
pub async fn get_library(state: State<'_, AppState>) -> Result<Vec<Book>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_book(book_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_book(&conn, &book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_book(book_id: String, state: State<'_, AppState>) -> Result<Option<Book>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_book(&conn, &book_id).map_err(|e| e.to_string())
}

// --- Reading ---

#[tauri::command]
pub async fn get_chapter_content(
    book_id: String,
    chapter_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file_path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };

    epub::get_chapter_content(&file_path, chapter_index as usize).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_toc(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<epub::TocEntry>, String> {
    let file_path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };

    epub::get_toc(&file_path).map_err(|e| e.to_string())
}

// --- Progress ---

#[tauri::command]
pub async fn get_reading_progress(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ReadingProgress>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_reading_progress(&conn, &book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_reading_progress(
    book_id: String,
    chapter_index: u32,
    scroll_position: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let progress = ReadingProgress {
        book_id,
        chapter_index,
        scroll_position,
        last_read_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::upsert_reading_progress(&conn, &progress).map_err(|e| e.to_string())
}

// --- Bookmarks ---

#[tauri::command]
pub async fn get_bookmarks(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Bookmark>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_bookmarks(&conn, &book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_bookmark(
    book_id: String,
    chapter_index: u32,
    scroll_position: f64,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<Bookmark, String> {
    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        book_id,
        chapter_index,
        scroll_position,
        note,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::insert_bookmark(&conn, &bookmark).map_err(|e| e.to_string())?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_bookmark(&conn, &bookmark_id).map_err(|e| e.to_string())
}

