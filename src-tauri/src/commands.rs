use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::cbr;
use crate::cbz;
use crate::db::{self, DbPool};
use crate::epub;
use crate::models::{Book, BookFormat, Bookmark, Collection, CollectionRule, CollectionType, NewRuleInput, ReadingProgress};
use crate::pdf;

pub struct AppState {
    pub db: DbPool,
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
        let mut file = std::fs::File::open(&file_path)
            .map_err(|e| format!("Cannot open file: {e}"))?;
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
        }
        format!("{:x}", hasher.finalize())
    };

    // Step 2: Hash-based duplicate check — return existing book if already imported.
    {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        if let Some(existing) = db::get_book_by_file_hash(&conn, &hash).map_err(|e| e.to_string())? {
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

    // Step 3: Resolve library folder, creating it if necessary.
    let library_folder = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
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
            }
        }
        BookFormat::Cbz => {
            let meta = cbz::import_cbz(&library_path).map_err(|e| {
                let _ = std::fs::remove_file(&library_path);
                e
            })?;
            Book {
                id: book_id,
                title: meta.title,
                author: String::new(),
                file_path: library_path.clone(),
                cover_path: None,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
            }
        }
        BookFormat::Cbr => {
            let meta = cbr::import_cbr(&library_path).map_err(|e| {
                let _ = std::fs::remove_file(&library_path);
                e
            })?;
            Book {
                id: book_id,
                title: meta.title,
                author: String::new(),
                file_path: library_path.clone(),
                cover_path: None,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
            }
        }
        BookFormat::Pdf => {
            let meta = pdf::import_pdf(&library_path).map_err(|e| {
                let _ = std::fs::remove_file(&library_path);
                e
            })?;
            Book {
                id: book_id,
                title: meta.title,
                author: meta.author,
                file_path: library_path.clone(),
                cover_path: None,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
            }
        }
    };

    let conn = state.db.get().map_err(|e| e.to_string())?;
    if let Err(e) = db::insert_book(&conn, &book) {
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
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_books(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_book(book_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;

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
    let conn = state.db.get().map_err(|e| e.to_string())?;
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
        let conn = state.db.get().map_err(|e| e.to_string())?;
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
        let conn = state.db.get().map_err(|e| e.to_string())?;
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
    let conn = state.db.get().map_err(|e| e.to_string())?;
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

    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::upsert_reading_progress(&conn, &progress).map_err(|e| e.to_string())
}

// --- Bookmarks ---

#[tauri::command]
pub async fn get_bookmarks(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Bookmark>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
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

    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::insert_bookmark(&conn, &bookmark).map_err(|e| e.to_string())?;

    Ok(bookmark)
}

#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::delete_bookmark(&conn, &bookmark_id).map_err(|e| e.to_string())
}

// --- Comic (CBZ / CBR) ---

#[tauri::command]
pub async fn get_comic_page_count(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let book = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
    };

    match book.format {
        BookFormat::Cbz => cbz::get_page_count(&book.file_path),
        BookFormat::Cbr => cbr::get_page_count(&book.file_path),
        _ => Err(format!("get_comic_page_count is not supported for {:?}", book.format)),
    }
}

#[tauri::command]
pub async fn get_comic_page(
    book_id: String,
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let book = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
    };

    match book.format {
        BookFormat::Cbz => cbz::get_page_image(&book.file_path, page_index),
        BookFormat::Cbr => cbr::get_page_image(&book.file_path, page_index),
        _ => Err(format!("get_comic_page is not supported for {:?}", book.format)),
    }
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

    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::insert_collection(&conn, &collection).map_err(|e| e.to_string())?;

    Ok(collection)
}

#[tauri::command]
pub async fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::list_collections(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_collection(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::delete_collection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_book_to_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
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
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::remove_book_from_collection(&conn, &book_id, &collection_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_books_in_collection(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Book>, String> {
    let conn = state.db.get().map_err(|e| e.to_string())?;
    db::get_books_in_collection(&conn, &collection_id).map_err(|e| e.to_string())
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
    let conn = state.db.get().map_err(|e| e.to_string())?;
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
    let conn = state.db.get().map_err(|e| e.to_string())?;
    let path = if let Some(f) = db::get_setting(&conn, "library_folder").map_err(|e| e.to_string())? {
        f
    } else {
        default_library_folder()?
    };
    let books = db::list_books(&conn).map_err(|e| e.to_string())?;

    // Only count books whose path is inside the current library folder — those
    // are the files that would actually be moved on a folder change.
    let prefix = if path.ends_with('/') { path.clone() } else { format!("{}/", path) };
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

    Ok(LibraryFolderInfo { path, file_count, total_size_bytes })
}

#[tauri::command]
pub async fn set_library_folder(
    new_folder: String,
    move_files: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !move_files {
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "library_folder", &new_folder).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Atomic migration: gather books, plan moves, execute all-or-nothing.
    let books = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
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
            std::fs::copy(src, dest).map(|_| ()).and_then(|_| std::fs::remove_file(src))
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
                msg = format!("{}. Rollback also failed: {}", msg, rollback_errors.join("; "));
            }
            return Err(msg);
        }
        completed.push((src.clone(), dest.clone()));
    }

    // All moves succeeded — persist new paths and setting atomically.
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (book, (_, dest)) in books.iter().zip(moves.iter()) {
        db::update_book_file_path(&tx, &book.id, dest).map_err(|e| e.to_string())?;
    }
    db::set_setting(&tx, "library_folder", &new_folder).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

// --- PDF ---

#[tauri::command]
pub async fn get_pdf_page_count(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let file_path = {
        let conn = state.db.get().map_err(|e| e.to_string())?;
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
        let conn = state.db.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };
    pdf::get_page_image(&file_path, page_index, 1200)
}
