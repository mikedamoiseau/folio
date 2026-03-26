use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::cbr;
use crate::cbz;
use crate::db::{self, DbPool};
use crate::epub;
use crate::models::{
    Book, BookFormat, Bookmark, Collection, CollectionRule, CollectionType, Highlight,
    NewRuleInput, ReadingProgress,
};
use crate::opds;
use crate::openlibrary;
use crate::pdf;

pub struct AppState {
    pub db: DbPool,
    pub profiles: std::sync::Mutex<std::collections::HashMap<String, DbPool>>,
    pub active_profile: std::sync::Mutex<String>,
    pub data_dir: std::path::PathBuf,
}

impl AppState {
    /// Returns the DB pool for the active profile.
    pub fn active_db(&self) -> Result<DbPool, String> {
        let profile = self.active_profile.lock().map_err(|e| e.to_string())?;
        if *profile == "default" {
            return Ok(self.db.clone());
        }
        let profiles = self.profiles.lock().map_err(|e| e.to_string())?;
        profiles
            .get(&*profile)
            .cloned()
            .ok_or_else(|| format!("Profile '{}' not found", profile))
    }
}

// --- Cover helpers ---

/// Decode a `data:<mime>;base64,<payload>` URI and write it to
/// `{data_dir}/covers/{book_id}/cover.{ext}`. Returns the file path on success.
fn save_cover_from_data_uri(
    data_uri: &str,
    data_dir: &std::path::Path,
    book_id: &str,
) -> Option<String> {
    use base64::{engine::general_purpose, Engine as _};

    let rest = data_uri.strip_prefix("data:")?;
    let (header, encoded) = rest.split_once(',')?;
    let mime = header.strip_suffix(";base64")?;
    let ext = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let bytes = general_purpose::STANDARD.decode(encoded).ok()?;
    let dir = data_dir.join("covers").join(book_id);
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("cover.{ext}"));
    std::fs::write(&path, &bytes).ok()?;
    Some(path.to_string_lossy().to_string())
}

// --- Library management ---

#[tauri::command]
pub async fn import_book(
    file_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Book, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    // Step 1: Compute SHA-256 hash of source file.
    let hash = {
        let mut hasher = Sha256::new();
        let mut file =
            std::fs::File::open(&file_path).map_err(|e| format!("Cannot open file: {e}"))?;
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        format!("{:x}", hasher.finalize())
    };

    // Step 2: Hash-based duplicate check — return existing book if already imported.
    {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        if let Some(existing) =
            db::get_book_by_file_hash(&conn, &hash).map_err(|e| e.to_string())?
        {
            return Ok(existing);
        }
    }

    // Detect format from file extension and route to the appropriate parser.
    let extension = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let format = match extension.as_str() {
        "epub" => BookFormat::Epub,
        "cbz" => BookFormat::Cbz,
        "cbr" => BookFormat::Cbr,
        "pdf" => BookFormat::Pdf,
        _ => return Err(format!("unsupported file format: .{extension}")),
    };

    let book_id = Uuid::new_v4().to_string();

    // Derive a human-friendly title from the *original* filename before copying
    // to the library (which renames the file to {uuid}.{ext}).
    let original_stem = std::path::Path::new(&file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Step 3: Resolve library folder, creating it if necessary.
    let library_folder = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        match db::get_setting(&conn, "library_folder").map_err(|e| e.to_string())? {
            Some(f) => f,
            None => default_library_folder()?,
        }
    };
    std::fs::create_dir_all(&library_folder).map_err(|e| e.to_string())?;

    // Step 4: Copy source file into library folder as {book_id}.{ext}.
    // On failure, no DB entry is created and the source file is untouched.
    let library_path = format!("{}/{}.{}", library_folder, book_id, extension);
    std::fs::copy(&file_path, &library_path)
        .map_err(|e| format!("Failed to copy file to library: {e}"))?;

    // Steps 5 & 6: Parse using library-internal path; store hash in Book.
    // cover_dir is set by the EPUB arm if a cover was extracted; the outer
    // error handler uses it to clean up on DB insert failure.
    let mut cover_dir: Option<std::path::PathBuf> = None;

    let book = match format {
        BookFormat::Epub => {
            let metadata = epub::parse_epub_metadata(&library_path).map_err(|e| {
                let _ = std::fs::remove_file(&library_path);
                e.to_string()
            })?;

            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                let dest = dir.to_string_lossy().to_string();
                match epub::extract_cover(&library_path, &dest) {
                    Ok(Some(path)) => {
                        cover_dir = Some(dir);
                        Some(path)
                    }
                    _ => None,
                }
            } else {
                None
            };

            let chapters = epub::get_chapter_list(&library_path).map_err(|e| {
                let _ = std::fs::remove_file(&library_path);
                e.to_string()
            })?;

            Book {
                id: book_id,
                title: metadata.title,
                author: metadata.author,
                file_path: library_path.clone(),
                cover_path,
                total_chapters: chapters.len() as u32,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: None,
                genres: None,
                rating: None,
                isbn: None,
                openlibrary_key: None,
            }
        }
        BookFormat::Cbz => {
            let meta = cbz::import_cbz(&library_path).inspect_err(|_e| {
                let _ = std::fs::remove_file(&library_path);
            })?;
            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                if let Some(path) = cbz::get_page_image(&library_path, 0)
                    .ok()
                    .and_then(|uri| save_cover_from_data_uri(&uri, &data_dir, &book_id))
                {
                    cover_dir = Some(dir);
                    Some(path)
                } else {
                    None
                }
            } else {
                None
            };
            Book {
                id: book_id,
                title: original_stem.clone(),
                author: String::new(),
                file_path: library_path.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: None,
                genres: None,
                rating: None,
                isbn: None,
                openlibrary_key: None,
            }
        }
        BookFormat::Cbr => {
            let meta = cbr::import_cbr(&library_path).inspect_err(|_e| {
                let _ = std::fs::remove_file(&library_path);
            })?;
            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                if let Some(path) = cbr::get_page_image(&library_path, 0)
                    .ok()
                    .and_then(|uri| save_cover_from_data_uri(&uri, &data_dir, &book_id))
                {
                    cover_dir = Some(dir);
                    Some(path)
                } else {
                    None
                }
            } else {
                None
            };
            Book {
                id: book_id,
                title: original_stem.clone(),
                author: String::new(),
                file_path: library_path.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: None,
                genres: None,
                rating: None,
                isbn: None,
                openlibrary_key: None,
            }
        }
        BookFormat::Pdf => {
            let meta = pdf::import_pdf(&library_path).inspect_err(|_e| {
                let _ = std::fs::remove_file(&library_path);
            })?;
            // Use PDF metadata title if available; fall back to original filename.
            let library_stem = std::path::Path::new(&library_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let title = if meta.title == library_stem || meta.title.is_empty() {
                original_stem.clone()
            } else {
                meta.title
            };
            // Extract first page as cover thumbnail.
            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                if let Some(path) = pdf::get_page_image(&library_path, 0, 400)
                    .ok()
                    .and_then(|uri| save_cover_from_data_uri(&uri, &data_dir, &book_id))
                {
                    cover_dir = Some(dir);
                    Some(path)
                } else {
                    None
                }
            } else {
                None
            };
            Book {
                id: book_id,
                title,
                author: meta.author,
                file_path: library_path.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: None,
                genres: None,
                rating: None,
                isbn: None,
                openlibrary_key: None,
            }
        }
    };

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    if let Err(e) = db::insert_book(&conn, &book) {
        // If the insert failed due to a duplicate hash, clean up the new copy
        // and return the existing book instead of surfacing a cryptic error.
        if let Some(existing) =
            db::get_book_by_file_hash(&conn, book.file_hash.as_deref().unwrap_or(""))
                .ok()
                .flatten()
        {
            let _ = std::fs::remove_file(&library_path);
            if let Some(dir) = cover_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            return Ok(existing);
        }
        let _ = std::fs::remove_file(&library_path);
        if let Some(dir) = cover_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        return Err(e.to_string());
    }

    Ok(book)
}

#[tauri::command]
pub async fn get_library(state: State<'_, AppState>) -> Result<Vec<Book>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_book(book_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    // Fetch file path before deleting so we can remove the library file.
    let file_path = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .map(|b| b.file_path);

    db::delete_book(&conn, &book_id).map_err(|e| e.to_string())?;

    // Remove the physical file; ignore NotFound, log but don't fail on other errors.
    if let Some(path) = file_path {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Warning: could not delete library file '{}': {}", path, e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_book(book_id: String, state: State<'_, AppState>) -> Result<Option<Book>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_book(&conn, &book_id).map_err(|e| e.to_string())
}

// --- Folder Scan ---

#[tauri::command]
pub async fn scan_folder_for_books(folder_path: String) -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&folder_path);
    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", folder_path));
    }

    let supported = ["epub", "cbz", "cbr", "pdf"];
    let mut found = Vec::new();

    fn walk(dir: &std::path::Path, extensions: &[&str], results: &mut Vec<String>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') && name != "__MACOSX" {
                        walk(&path, extensions, results);
                    }
                }
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let lower = ext.to_lowercase();
                if extensions.iter().any(|&s| s == lower) {
                    results.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    walk(dir, &supported, &mut found);
    found.sort();
    Ok(found)
}

// --- Metadata Editing ---

#[tauri::command]
pub async fn update_book_metadata(
    book_id: String,
    title: Option<String>,
    author: Option<String>,
    cover_image_path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Book, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let mut book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book '{book_id}' not found"))?;

    if let Some(t) = title {
        book.title = t;
    }
    if let Some(a) = author {
        book.author = a;
    }
    if let Some(image_path) = cover_image_path {
        // Copy new cover image into the covers directory
        if let Ok(data_dir) = app.path().app_data_dir() {
            let dir = data_dir.join("covers").join(&book_id);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let ext = std::path::Path::new(&image_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");
            let dest = dir.join(format!("cover.{ext}"));
            std::fs::copy(&image_path, &dest)
                .map_err(|e| format!("Failed to copy cover image: {e}"))?;
            book.cover_path = Some(dest.to_string_lossy().to_string());
        }
    }

    db::update_book(&conn, &book).map_err(|e| e.to_string())?;
    Ok(book)
}

// --- Recently Read ---

#[tauri::command]
pub async fn get_recently_read(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<Book>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_recently_read_books(&conn, limit.unwrap_or(5)).map_err(|e| e.to_string())
}

// --- Reading ---

#[tauri::command]
pub async fn get_chapter_content(
    book_id: String,
    chapter_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
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
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
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
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
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

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::upsert_reading_progress(&conn, &progress).map_err(|e| e.to_string())
}

// --- Bookmarks ---

#[tauri::command]
pub async fn get_bookmarks(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Bookmark>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
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

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::insert_bookmark(&conn, &bookmark).map_err(|e| e.to_string())?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::delete_bookmark(&conn, &bookmark_id).map_err(|e| e.to_string())
}

// --- Comic (CBZ / CBR) ---

#[tauri::command]
pub async fn get_comic_page_count(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let book = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
    };

    match book.format {
        BookFormat::Cbz => cbz::get_page_count(&book.file_path),
        BookFormat::Cbr => cbr::get_page_count(&book.file_path),
        _ => Err(format!(
            "get_comic_page_count is not supported for {:?}",
            book.format
        )),
    }
}

#[tauri::command]
pub async fn get_comic_page(
    book_id: String,
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let book = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
    };

    match book.format {
        BookFormat::Cbz => cbz::get_page_image(&book.file_path, page_index),
        BookFormat::Cbr => cbr::get_page_image(&book.file_path, page_index),
        _ => Err(format!(
            "get_comic_page is not supported for {:?}",
            book.format
        )),
    }
}

// --- Reading Stats ---

#[tauri::command]
pub async fn record_reading_session(
    book_id: String,
    started_at: i64,
    duration_secs: i64,
    pages_read: i32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if duration_secs < 10 {
        return Ok(());
    } // Skip very short sessions
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    db::insert_reading_session(&conn, &id, &book_id, started_at, duration_secs, pages_read)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_reading_stats(state: State<'_, AppState>) -> Result<db::ReadingStats, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_reading_stats(&conn).map_err(|e| e.to_string())
}

// --- Highlights ---

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_highlight(
    book_id: String,
    chapter_index: u32,
    text: String,
    color: String,
    start_offset: u32,
    end_offset: u32,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<Highlight, String> {
    let highlight = Highlight {
        id: Uuid::new_v4().to_string(),
        book_id,
        chapter_index,
        text,
        color,
        note,
        start_offset,
        end_offset,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::insert_highlight(&conn, &highlight).map_err(|e| e.to_string())?;
    Ok(highlight)
}

#[tauri::command]
pub async fn get_highlights(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Highlight>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_highlights(&conn, &book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_chapter_highlights(
    book_id: String,
    chapter_index: u32,
    state: State<'_, AppState>,
) -> Result<Vec<Highlight>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_chapter_highlights(&conn, &book_id, chapter_index).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_highlight_note(
    highlight_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::update_highlight_note(&conn, &highlight_id, note.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_highlight(
    highlight_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::delete_highlight(&conn, &highlight_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_highlights_markdown(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book '{book_id}' not found"))?;
    let highlights = db::list_highlights(&conn, &book_id).map_err(|e| e.to_string())?;

    let mut md = format!("# Highlights: {}\n\n", book.title);
    if !book.author.is_empty() {
        md.push_str(&format!("**{}**\n\n", book.author));
    }
    let mut current_chapter: Option<u32> = None;
    for h in &highlights {
        if current_chapter != Some(h.chapter_index) {
            md.push_str(&format!("\n## Chapter {}\n\n", h.chapter_index + 1));
            current_chapter = Some(h.chapter_index);
        }
        md.push_str(&format!("> {}\n", h.text));
        if let Some(ref note) = h.note {
            md.push_str(&format!("\n*{}*\n", note));
        }
        md.push('\n');
    }
    Ok(md)
}

// --- Tags ---

#[derive(serde::Serialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn get_all_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let tags = db::list_tags(&conn).map_err(|e| e.to_string())?;
    Ok(tags
        .into_iter()
        .map(|(id, name)| Tag { id, name })
        .collect())
}

#[tauri::command]
pub async fn get_book_tags(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Tag>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let tags = db::get_book_tags(&conn, &book_id).map_err(|e| e.to_string())?;
    Ok(tags
        .into_iter()
        .map(|(id, name)| Tag { id, name })
        .collect())
}

#[tauri::command]
pub async fn add_tag_to_book(
    book_id: String,
    tag_name: String,
    state: State<'_, AppState>,
) -> Result<Tag, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    // Find or create tag
    let tag_id =
        if let Some(id) = db::get_tag_by_name(&conn, &tag_name).map_err(|e| e.to_string())? {
            id
        } else {
            let id = Uuid::new_v4().to_string();
            db::get_or_create_tag(&conn, &id, &tag_name).map_err(|e| e.to_string())?;
            id
        };
    db::add_tag_to_book(&conn, &book_id, &tag_id).map_err(|e| e.to_string())?;
    Ok(Tag {
        id: tag_id,
        name: tag_name,
    })
}

#[tauri::command]
pub async fn remove_tag_from_book(
    book_id: String,
    tag_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::remove_tag_from_book(&conn, &book_id, &tag_id).map_err(|e| e.to_string())
}

// --- Collections ---

#[tauri::command]
pub async fn create_collection(
    name: String,
    coll_type: String,
    icon: Option<String>,
    color: Option<String>,
    rules: Vec<NewRuleInput>,
    state: State<'_, AppState>,
) -> Result<Collection, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let collection_id = Uuid::new_v4().to_string();

    let coll_type_enum = match coll_type.as_str() {
        "automated" => CollectionType::Automated,
        _ => CollectionType::Manual,
    };

    let rule_structs: Vec<CollectionRule> = rules
        .into_iter()
        .map(|r| CollectionRule {
            id: Uuid::new_v4().to_string(),
            collection_id: collection_id.clone(),
            field: r.field,
            operator: r.operator,
            value: r.value,
        })
        .collect();

    let collection = Collection {
        id: collection_id,
        name,
        r#type: coll_type_enum,
        icon,
        color,
        created_at: now,
        updated_at: now,
        rules: rule_structs,
    };

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::insert_collection(&conn, &collection).map_err(|e| e.to_string())?;

    Ok(collection)
}

#[tauri::command]
pub async fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_collections(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_collection(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::delete_collection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_book_to_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let coll_type: String = conn
        .query_row(
            "SELECT type FROM collections WHERE id = ?1",
            rusqlite::params![collection_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if coll_type == "automated" {
        return Err("Cannot manually add books to an automated collection".to_string());
    }
    db::add_book_to_collection(&conn, &book_id, &collection_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_book_from_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::remove_book_from_collection(&conn, &book_id, &collection_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_books_in_collection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Book>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_books_in_collection(&conn, &collection_id).map_err(|e| e.to_string())
}

// --- Share Collections ---

#[tauri::command]
pub async fn export_collection_markdown(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    // Get collection name
    let name: String = conn
        .query_row(
            "SELECT name FROM collections WHERE id = ?1",
            rusqlite::params![collection_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let books = db::get_books_in_collection(&conn, &collection_id).map_err(|e| e.to_string())?;

    let mut md = format!("# {}\n\n", name);
    md.push_str(&format!("{} books\n\n", books.len()));
    for (i, book) in books.iter().enumerate() {
        md.push_str(&format!("{}. **{}**", i + 1, book.title));
        if !book.author.is_empty() {
            md.push_str(&format!(" — {}", book.author));
        }
        md.push_str(&format!(" *({})*\n", book.format));
    }
    Ok(md)
}

#[tauri::command]
pub async fn export_collection_json(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let name: String = conn
        .query_row(
            "SELECT name FROM collections WHERE id = ?1",
            rusqlite::params![collection_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let books = db::get_books_in_collection(&conn, &collection_id).map_err(|e| e.to_string())?;

    let list: Vec<serde_json::Value> = books
        .iter()
        .map(|b| {
            serde_json::json!({
                "title": b.title,
                "author": b.author,
                "format": b.format.to_string(),
            })
        })
        .collect();

    let export = serde_json::json!({
        "collection": name,
        "books": list,
    });

    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

// --- OpenLibrary ---

#[tauri::command]
pub async fn search_openlibrary(
    title: String,
    author: Option<String>,
) -> Result<Vec<openlibrary::OpenLibraryResult>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(openlibrary::search(&title, author.as_deref()));
    });
    rx.recv().map_err(|e| format!("Thread error: {e}"))?
}

#[tauri::command]
pub async fn enrich_book_from_openlibrary(
    book_id: String,
    openlibrary_key: String,
    state: State<'_, AppState>,
) -> Result<Book, String> {
    // Fetch detailed metadata from OpenLibrary (on a separate thread)
    let key = openlibrary_key.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(openlibrary::get_work(&key));
    });
    let work = rx.recv().map_err(|e| format!("Thread error: {e}"))??;

    // Also get search result for rating/isbn (work endpoint doesn't have them)
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let mut book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book '{book_id}' not found"))?;

    // Do a quick search to get rating and ISBN
    let search_title = book.title.clone();
    let search_author = if book.author.is_empty() {
        None
    } else {
        Some(book.author.clone())
    };
    let (tx2, rx2) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx2.send(openlibrary::search(&search_title, search_author.as_deref()));
    });
    let search_results = rx2
        .recv()
        .map_err(|e| format!("Thread error: {e}"))?
        .unwrap_or_default();
    let matched = search_results.iter().find(|r| r.key == openlibrary_key);

    // Update book with enriched data
    let description = work
        .description
        .or_else(|| matched.and_then(|m| m.description.clone()));
    let genres = if !work.genres.is_empty() {
        Some(serde_json::to_string(&work.genres).unwrap_or_default())
    } else {
        matched.map(|m| serde_json::to_string(&m.genres).unwrap_or_default())
    };
    let rating = matched.and_then(|m| m.rating);
    let isbn = matched.and_then(|m| m.isbn.clone());

    db::update_book_enrichment(
        &conn,
        &book_id,
        description.as_deref(),
        genres.as_deref(),
        rating,
        isbn.as_deref(),
        Some(&openlibrary_key),
    )
    .map_err(|e| e.to_string())?;

    // Return updated book
    book.description = description;
    book.genres = genres;
    book.rating = rating;
    book.isbn = isbn;
    book.openlibrary_key = Some(openlibrary_key);
    Ok(book)
}

// --- OPDS Catalog ---

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCatalogSource {
    pub name: String,
    pub url: String,
}

const DEFAULT_CATALOGS: &[(&str, &str)] = &[
    ("Project Gutenberg", "https://m.gutenberg.org/ebooks.opds/"),
    (
        "Standard Ebooks (New Releases)",
        "https://standardebooks.org/feeds/atom/new-releases",
    ),
];

#[tauri::command]
pub async fn get_opds_catalogs(
    state: State<'_, AppState>,
) -> Result<Vec<OpdsCatalogSource>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    // Load custom catalogs from settings
    let custom_json = db::get_setting(&conn, "opds_custom_catalogs")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "[]".to_string());
    let custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();

    let mut result: Vec<OpdsCatalogSource> = DEFAULT_CATALOGS
        .iter()
        .map(|(name, url)| OpdsCatalogSource {
            name: name.to_string(),
            url: url.to_string(),
        })
        .collect();
    result.extend(custom);
    Ok(result)
}

#[tauri::command]
pub async fn add_opds_catalog(
    name: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let custom_json = db::get_setting(&conn, "opds_custom_catalogs")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "[]".to_string());
    let mut custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();
    custom.push(OpdsCatalogSource { name, url });
    let json = serde_json::to_string(&custom).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "opds_custom_catalogs", &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_opds_catalog(url: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let custom_json = db::get_setting(&conn, "opds_custom_catalogs")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "[]".to_string());
    let mut custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();
    custom.retain(|c| c.url != url);
    let json = serde_json::to_string(&custom).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "opds_custom_catalogs", &json).map_err(|e| e.to_string())
}

/// Search all configured OPDS catalogs in parallel and return aggregated results.
#[tauri::command]
pub async fn search_all_catalogs(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<opds::OpdsEntry>, String> {
    // Collect all catalog URLs
    let catalogs = get_opds_catalogs(state).await?;

    // Fetch root feeds in parallel to discover search URLs
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let mut thread_count = 0;

    for cat in &catalogs {
        let url = cat.url.clone();
        let q = query.clone();
        let tx = result_tx.clone();
        let cat_name = cat.name.clone();
        std::thread::spawn(move || {
            // 1. Fetch root feed to get searchUrl
            let root = match opds::fetch_feed(&url) {
                Ok(f) => f,
                Err(_) => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            let raw_search_url = match root.search_url {
                Some(u) => u,
                None => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            // 2. Resolve OpenSearch description if needed, then search
            let template = match opds::resolve_search_url(&raw_search_url) {
                Some(t) => t,
                None => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            let search_url = template.replace("{searchTerms}", &opds::url_encode(&q));
            let results = match opds::fetch_feed(&search_url) {
                Ok(f) => f.entries,
                Err(_) => Vec::new(),
            };
            // Tag entries with catalog source
            let tagged: Vec<opds::OpdsEntry> = results
                .into_iter()
                .map(|mut e| {
                    if !e.summary.is_empty() {
                        e.summary = format!("[{}] {}", cat_name, e.summary);
                    } else {
                        e.summary = format!("[{}]", cat_name);
                    }
                    e
                })
                .collect();
            let _ = tx.send(tagged);
        });
        thread_count += 1;
    }
    drop(result_tx);

    let mut all_entries = Vec::new();
    for _ in 0..thread_count {
        if let Ok(entries) = result_rx.recv() {
            all_entries.extend(entries);
        }
    }
    Ok(all_entries)
}

#[tauri::command]
pub async fn browse_opds(url: String) -> Result<opds::OpdsFeed, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(opds::fetch_feed(&url));
    });
    rx.recv().map_err(|e| format!("Thread error: {e}"))?
}

#[tauri::command]
pub async fn download_opds_book(
    download_url: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Book, String> {
    // Determine file extension from URL
    let ext = if download_url.contains(".pdf") {
        "pdf"
    } else if download_url.contains(".cbz") {
        "cbz"
    } else {
        "epub" // default for OPDS
    };

    // Download to a temp file
    let temp_dir = std::env::temp_dir();
    let temp_name = format!("folio-opds-{}.{}", Uuid::new_v4(), ext);
    let temp_path = temp_dir.join(&temp_name);
    let temp_str = temp_path.to_string_lossy().to_string();

    {
        let dl_url = download_url.clone();
        let dl_dest = temp_str.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(opds::download_file(&dl_url, &dl_dest));
        });
        rx.recv().map_err(|e| format!("Thread error: {e}"))??;
    }

    // Import via the standard import pipeline
    let result = import_book(temp_str.clone(), state, app).await;

    // Clean up temp file (import_book copies it to the library folder)
    let _ = std::fs::remove_file(&temp_path);

    result
}

// --- Profiles ---

#[derive(serde::Serialize)]
pub struct Profile {
    pub name: String,
    pub is_active: bool,
}

#[tauri::command]
pub async fn get_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
    let active = state
        .active_profile
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let profiles = state.profiles.lock().map_err(|e| e.to_string())?;
    let mut result = vec![Profile {
        name: "default".to_string(),
        is_active: active == "default",
    }];
    for name in profiles.keys() {
        result.push(Profile {
            name: name.clone(),
            is_active: *name == active,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
pub async fn create_profile(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name == "default" {
        return Err("Invalid profile name".to_string());
    }
    let db_path = state.data_dir.join(format!("library-{name}.db"));
    if db_path.exists() {
        return Err(format!("Profile '{name}' already exists"));
    }
    let pool = db::create_pool(&db_path).map_err(|e| e.to_string())?;

    // Ensure library folder for this profile
    let conn = pool.get().map_err(|e| e.to_string())?;
    let library_folder = default_library_folder()?;
    let profile_folder = format!("{} - {}", library_folder, name);
    let _ = std::fs::create_dir_all(&profile_folder);
    db::set_setting(&conn, "library_folder", &profile_folder).map_err(|e| e.to_string())?;

    let mut profiles = state.profiles.lock().map_err(|e| e.to_string())?;
    profiles.insert(name, pool);
    Ok(())
}

#[tauri::command]
pub async fn switch_profile(name: String, state: State<'_, AppState>) -> Result<(), String> {
    if name != "default" {
        let profiles = state.profiles.lock().map_err(|e| e.to_string())?;
        if !profiles.contains_key(&name) {
            return Err(format!("Profile '{name}' not found"));
        }
    }
    let mut active = state.active_profile.lock().map_err(|e| e.to_string())?;
    *active = name;
    Ok(())
}

#[tauri::command]
pub async fn delete_profile(name: String, state: State<'_, AppState>) -> Result<(), String> {
    if name == "default" {
        return Err("Cannot delete the default profile".to_string());
    }
    let active = state
        .active_profile
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if active == name {
        return Err(
            "Cannot delete the active profile. Switch to another profile first.".to_string(),
        );
    }
    let mut profiles = state.profiles.lock().map_err(|e| e.to_string())?;
    profiles.remove(&name);
    // Remove DB file
    let db_path = state.data_dir.join(format!("library-{name}.db"));
    let _ = std::fs::remove_file(db_path);
    Ok(())
}

// --- Library Folder ---

#[derive(serde::Serialize)]
pub struct LibraryFolderInfo {
    pub path: String,
    pub file_count: u64,
    pub total_size_bytes: u64,
}

pub fn default_library_folder() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home
        .join("Documents")
        .join("Folio Library")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub async fn get_library_folder(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    if let Some(folder) = db::get_setting(&conn, "library_folder").map_err(|e| e.to_string())? {
        Ok(folder)
    } else {
        default_library_folder()
    }
}

#[tauri::command]
pub async fn get_library_folder_info(
    state: State<'_, AppState>,
) -> Result<LibraryFolderInfo, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let path =
        if let Some(f) = db::get_setting(&conn, "library_folder").map_err(|e| e.to_string())? {
            f
        } else {
            default_library_folder()?
        };
    let books = db::list_books(&conn).map_err(|e| e.to_string())?;

    // Only count books whose path is inside the current library folder — those
    // are the files that would actually be moved on a folder change.
    let prefix = if path.ends_with('/') {
        path.clone()
    } else {
        format!("{}/", path)
    };
    let mut file_count = 0u64;
    let mut total_size_bytes = 0u64;
    for book in &books {
        if !book.file_path.starts_with(&prefix) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&book.file_path) {
            if meta.is_file() {
                file_count += 1;
                total_size_bytes += meta.len();
            }
        }
    }

    Ok(LibraryFolderInfo {
        path,
        file_count,
        total_size_bytes,
    })
}

#[tauri::command]
pub async fn set_library_folder(
    new_folder: String,
    move_files: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !move_files {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "library_folder", &new_folder).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Atomic migration: gather books, plan moves, execute all-or-nothing.
    let books = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::list_books(&conn).map_err(|e| e.to_string())?
    };

    std::fs::create_dir_all(&new_folder).map_err(|e| e.to_string())?;

    // Build (src, dest) pairs.
    let moves: Vec<(String, String)> = books
        .iter()
        .map(|book| {
            let ext = std::path::Path::new(&book.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let dest = format!("{}/{}.{}", new_folder, book.id, ext);
            (book.file_path.clone(), dest)
        })
        .collect();

    // Attempt all moves; roll back on first failure.
    let mut completed: Vec<(String, String)> = Vec::new();
    for (src, dest) in &moves {
        let result = std::fs::rename(src, dest).or_else(|_| {
            // Cross-device fallback: copy then delete source.
            std::fs::copy(src, dest)
                .map(|_| ())
                .and_then(|_| std::fs::remove_file(src))
        });
        if let Err(e) = result {
            // Roll back every completed move before returning the error.
            // Collect rollback failures so the caller has full context if
            // rollback itself fails (e.g. cross-device copy-back fails).
            let mut rollback_errors: Vec<String> = Vec::new();
            for (orig_src, orig_dest) in &completed {
                if let Err(re) = std::fs::rename(orig_dest, orig_src).or_else(|_| {
                    std::fs::copy(orig_dest, orig_src)
                        .map(|_| ())
                        .and_then(|_| std::fs::remove_file(orig_dest))
                }) {
                    rollback_errors.push(format!("'{}': {}", orig_dest, re));
                }
            }
            let mut msg = format!("Failed to move '{}': {}", src, e);
            if !rollback_errors.is_empty() {
                msg = format!(
                    "{}. Rollback also failed: {}",
                    msg,
                    rollback_errors.join("; ")
                );
            }
            return Err(msg);
        }
        completed.push((src.clone(), dest.clone()));
    }

    // All moves succeeded — persist new paths and setting atomically.
    let mut conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (book, (_, dest)) in books.iter().zip(moves.iter()) {
        db::update_book_file_path(&tx, &book.id, dest).map_err(|e| e.to_string())?;
    }
    db::set_setting(&tx, "library_folder", &new_folder).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

// --- Library Export/Import ---

#[tauri::command]
pub async fn export_library(
    dest_path: String,
    include_files: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let books = db::list_books(&conn).map_err(|e| e.to_string())?;

    // Gather all metadata into a single export object
    let progress: Vec<ReadingProgress> = books
        .iter()
        .filter_map(|b| db::get_reading_progress(&conn, &b.id).ok().flatten())
        .collect();
    let bookmarks: Vec<Bookmark> = books
        .iter()
        .flat_map(|b| db::list_bookmarks(&conn, &b.id).unwrap_or_default())
        .collect();
    let highlights: Vec<Highlight> = books
        .iter()
        .flat_map(|b| db::list_highlights(&conn, &b.id).unwrap_or_default())
        .collect();
    let collections = db::list_collections(&conn).map_err(|e| e.to_string())?;
    let tags = db::list_tags(&conn).map_err(|e| e.to_string())?;
    let book_tags: Vec<(String, String, String)> = books
        .iter()
        .flat_map(|b| {
            db::get_book_tags(&conn, &b.id)
                .unwrap_or_default()
                .into_iter()
                .map(|(tag_id, tag_name)| (b.id.clone(), tag_id, tag_name))
                .collect::<Vec<_>>()
        })
        .collect();

    let metadata = serde_json::json!({
        "version": 1,
        "books": books,
        "reading_progress": progress,
        "bookmarks": bookmarks,
        "highlights": highlights,
        "collections": collections,
        "tags": tags,
        "book_tags": book_tags,
    });

    let file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Add metadata JSON
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    zip.start_file("library.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(metadata_json.as_bytes())
        .map_err(|e| e.to_string())?;

    if include_files {
        // Add each book file (use Stored for already-compressed formats)
        let stored_options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for book in &books {
            let ext = std::path::Path::new(&book.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let archive_name = format!("books/{}.{}", book.id, ext);
            // epub/cbz are already zips; pdf compresses poorly — use Stored for all
            if let Ok(data) = std::fs::read(&book.file_path) {
                zip.start_file(&archive_name, stored_options)
                    .map_err(|e| e.to_string())?;
                zip.write_all(&data).map_err(|e| e.to_string())?;
            }
        }

        // Add cover files
        if let Ok(_data_dir) = app.path().app_data_dir() {
            for book in &books {
                if let Some(cover_path) = &book.cover_path {
                    if let Ok(data) = std::fs::read(cover_path) {
                        let ext = std::path::Path::new(cover_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("jpg");
                        let archive_name = format!("covers/{}/cover.{}", book.id, ext);
                        zip.start_file(&archive_name, options)
                            .map_err(|e| e.to_string())?;
                        zip.write_all(&data).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(dest_path)
}

#[tauri::command]
pub async fn import_library_backup(
    archive_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<u32, String> {
    use std::io::Read;

    let file = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Read library.json
    let books: Vec<Book> = {
        let mut entry = archive.by_name("library.json").map_err(|e| e.to_string())?;
        let mut json = String::new();
        entry.read_to_string(&mut json).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())?
    };

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let library_folder =
        match db::get_setting(&conn, "library_folder").map_err(|e| e.to_string())? {
            Some(f) => f,
            None => default_library_folder()?,
        };
    std::fs::create_dir_all(&library_folder).map_err(|e| e.to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut imported = 0u32;

    for book in &books {
        // Skip if book already exists by hash
        if let Some(ref hash) = book.file_hash {
            if db::get_book_by_file_hash(&conn, hash)
                .map_err(|e| e.to_string())?
                .is_some()
            {
                continue;
            }
        }

        let ext = std::path::Path::new(&book.file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("epub");
        let book_archive_name = format!("books/{}.{}", book.id, ext);

        // Extract book file
        let library_path = format!("{}/{}.{}", library_folder, book.id, ext);
        if let Ok(mut entry) = archive.by_name(&book_archive_name) {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            std::fs::write(&library_path, &buf).map_err(|e| e.to_string())?;
        } else {
            continue; // skip books without files
        }

        // Extract cover if present
        let mut cover_path = book.cover_path.clone();
        for ext_try in &["jpg", "png", "webp", "gif"] {
            let cover_name = format!("covers/{}/cover.{}", book.id, ext_try);
            if let Ok(mut entry) = archive.by_name(&cover_name) {
                let dir = data_dir.join("covers").join(&book.id);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let dest = dir.join(format!("cover.{ext_try}"));
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                std::fs::write(&dest, &buf).map_err(|e| e.to_string())?;
                cover_path = Some(dest.to_string_lossy().to_string());
                break;
            }
        }

        let restored_book = Book {
            file_path: library_path,
            cover_path,
            ..book.clone()
        };

        if db::insert_book(&conn, &restored_book).is_ok() {
            imported += 1;
        }
    }

    Ok(imported)
}

// --- PDF ---

#[tauri::command]
pub async fn get_pdf_page_count(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };
    pdf::get_page_count(&file_path)
}

#[tauri::command]
pub async fn get_pdf_page(
    book_id: String,
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };
    pdf::get_page_image(&file_path, page_index, 1200)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_cover_png_data_uri() {
        let dir = tempfile::tempdir().unwrap();
        let data_uri = "data:image/png;base64,iVBORw0KGgo=";
        let result = save_cover_from_data_uri(data_uri, dir.path(), "book-123");
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.png"));
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn save_cover_jpeg_data_uri() {
        let dir = tempfile::tempdir().unwrap();
        let data_uri = "data:image/jpeg;base64,/9j/4AAQ";
        let result = save_cover_from_data_uri(data_uri, dir.path(), "book-456");
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.jpg"));
    }

    #[test]
    fn save_cover_webp_data_uri() {
        let dir = tempfile::tempdir().unwrap();
        let data_uri = "data:image/webp;base64,UklGRg==";
        let result = save_cover_from_data_uri(data_uri, dir.path(), "book-789");
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.webp"));
    }

    #[test]
    fn save_cover_invalid_data_uri_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        // Missing data: prefix
        assert!(save_cover_from_data_uri("not-a-data-uri", dir.path(), "book").is_none());
        // Missing ;base64
        assert!(save_cover_from_data_uri("data:image/png,abc", dir.path(), "book").is_none());
        // Missing comma
        assert!(save_cover_from_data_uri("data:image/png;base64", dir.path(), "book").is_none());
    }

    #[test]
    fn save_cover_creates_directory_structure() {
        let dir = tempfile::tempdir().unwrap();
        let data_uri = "data:image/gif;base64,R0lGODlh";
        let result = save_cover_from_data_uri(data_uri, dir.path(), "new-book");
        assert!(result.is_some());
        // Verify the covers/new-book/ directory was created
        assert!(dir.path().join("covers").join("new-book").exists());
    }

    #[test]
    fn save_cover_unknown_mime_defaults_to_jpg() {
        let dir = tempfile::tempdir().unwrap();
        let data_uri = "data:image/bmp;base64,Qk0=";
        let result = save_cover_from_data_uri(data_uri, dir.path(), "book");
        assert!(result.is_some());
        assert!(result.unwrap().contains("cover.jpg"));
    }
}
