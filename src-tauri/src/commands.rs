use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::cbr;
use crate::cbz;
use crate::db::{self, DbPool};
use crate::epub;
use crate::models::{
    AutoBackup, Book, BookFormat, Bookmark, CleanupEntry, CleanupProgress, CleanupResult,
    Collection, CollectionRule, CollectionType, CustomFont, Highlight, NewRuleInput,
    ReadingProgress, SeriesInfo,
};
use crate::opds;
use crate::openlibrary;
use crate::pdf;

/// A simple LRU cache that bundles the data map and access order in a single
/// structure, so only one Mutex is needed. This eliminates the risk of lock
/// poisoning or inversion that arises from guarding the map and order with
/// separate Mutexes.
pub struct LruCache<V> {
    entries: std::collections::HashMap<String, V>,
    order: Vec<String>,
    capacity: usize,
}

impl<V> LruCache<V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            order: Vec::new(),
            capacity,
        }
    }

    /// Move an existing key to the most-recently-used position.
    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push(key.to_string());
    }

    /// Insert a key-value pair, evicting the least-recently-used entry when at
    /// capacity.
    fn insert(&mut self, key: String, value: V) {
        if self.entries.contains_key(&key) {
            self.touch(&key);
            self.entries.insert(key, value);
            return;
        }
        while self.entries.len() >= self.capacity {
            if let Some(oldest) = self.order.first().cloned() {
                self.entries.remove(&oldest);
                self.order.remove(0);
            } else {
                self.entries.clear();
                break;
            }
        }
        self.entries.insert(key.clone(), value);
        self.order.push(key);
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.entries.get(key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key)
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|k| k != key);
    }
}

/// Profile state: active profile name + pool map in a single Mutex.
/// This prevents the race condition where the active profile changes between
/// reading the name and looking up the pool.
///
/// ## Lock ordering
///
/// `AppState` contains multiple Mutexes. To prevent deadlocks, always acquire
/// them in the order listed below. Never hold a higher-numbered lock while
/// waiting for a lower-numbered one.
///
/// 1. `profile_state` — profile name + pool map
/// 2. `epub_cache` — EPUB archive LRU cache
/// 3. `pdf_cache` — PDF render LRU cache
/// 4. `enrichment_registry` — metadata provider registry
pub struct ProfileState {
    pub active: String,
    pub pools: std::collections::HashMap<String, DbPool>,
}

pub struct AppState {
    pub db: DbPool,
    /// Combined profile name + pool map (lock #1). See lock ordering above.
    pub profile_state: std::sync::Mutex<ProfileState>,
    pub data_dir: std::path::PathBuf,
    /// EPUB archive LRU cache (lock #2). Single Mutex replaces the former
    /// dual-Mutex (epub_cache + epub_cache_order).
    pub epub_cache: std::sync::Mutex<LruCache<epub::CachedEpubArchive>>,
    /// PDF render LRU cache (lock #3). Single Mutex replaces the former
    /// dual-Mutex (pdf_render_cache + pdf_render_cache_order).
    pub pdf_cache: std::sync::Mutex<LruCache<String>>,
    /// Metadata provider registry (lock #4).
    pub enrichment_registry: std::sync::Mutex<crate::providers::ProviderRegistry>,
}

impl AppState {
    /// Returns the DB pool for the active profile.
    /// Uses a single lock to read profile name and look up the pool atomically.
    pub fn active_db(&self) -> Result<DbPool, String> {
        let ps = self.profile_state.lock().map_err(|e| e.to_string())?;
        if ps.active == "default" {
            return Ok(self.db.clone());
        }
        ps.pools
            .get(&ps.active)
            .cloned()
            .ok_or_else(|| format!("Profile '{}' not found", ps.active))
    }
}

/// Ensure a file_path is loaded in the EPUB LRU cache. If it's already present,
/// move it to most-recently-used. Otherwise open the archive and insert it.
fn ensure_epub_cached(cache: &mut LruCache<epub::CachedEpubArchive>, file_path: &str) {
    if cache.get(file_path).is_some() {
        cache.touch(file_path);
        return;
    }
    if let Ok(archive) = epub::CachedEpubArchive::open(file_path) {
        cache.insert(file_path.to_string(), archive);
    }
}

// --- Activity logging ---

fn log_activity(
    conn: &rusqlite::Connection,
    action: &str,
    entity_type: &str,
    entity_id: Option<&str>,
    entity_name: Option<&str>,
    detail: Option<&str>,
) {
    let entry = crate::models::ActivityEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        action: action.to_string(),
        entity_type: entity_type.to_string(),
        entity_id: entity_id.map(|s| s.to_string()),
        entity_name: entity_name.map(|s| s.to_string()),
        detail: detail.map(|s| s.to_string()),
    };
    let _ = db::insert_activity(conn, &entry);
    let _ = db::prune_activity_log(conn, 1000);
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
    let bytes = match general_purpose::STANDARD.decode(encoded) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("cover extraction failed for book {book_id}: base64 decode error: {e}");
            return None;
        }
    };
    let dir = data_dir.join("covers").join(book_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!(
            "cover extraction failed for book {book_id}: could not create cover directory: {e}"
        );
        return None;
    }
    let path = dir.join(format!("cover.{ext}"));
    if let Err(e) = std::fs::write(&path, &bytes) {
        log::warn!("cover extraction failed for book {book_id}: could not write cover file: {e}");
        return None;
    }
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

    // Step 2b: File size guard — reject files over 500 MB to prevent indefinite hangs
    // caused by corrupted or pathologically large archives.
    {
        const MAX_IMPORT_SIZE_BYTES: u64 = 500 * 1024 * 1024;
        let metadata =
            std::fs::metadata(&file_path).map_err(|e| format!("Cannot stat file: {e}"))?;
        if metadata.len() > MAX_IMPORT_SIZE_BYTES {
            let size_mb = metadata.len() / (1024 * 1024);
            return Err(format!(
                "File is too large ({size_mb} MB). Maximum supported import size is 500 MB."
            ));
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

    // Step 4: Copy source file into library folder as {book_id}.{ext},
    // or keep original path if import_mode is "link".
    // URL imports always copy (file was downloaded to a temp location).
    let import_mode = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_setting(&conn, "import_mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "import".to_string())
    };
    let is_url_import = file_path.starts_with("http://") || file_path.starts_with("https://");
    let should_copy = import_mode != "link" || is_url_import;

    let (final_path, is_imported) = if should_copy {
        let library_path = format!("{}/{}.{}", library_folder, book_id, extension);
        std::fs::copy(&file_path, &library_path)
            .map_err(|e| format!("Failed to copy file to library: {e}"))?;
        (library_path, true)
    } else {
        (file_path.clone(), false)
    };

    // Steps 5 & 6: Parse using library-internal path; store hash in Book.
    // cover_dir is set by the EPUB arm if a cover was extracted; the outer
    // error handler uses it to clean up on DB insert failure.
    let mut cover_dir: Option<std::path::PathBuf> = None;

    let book = match format {
        BookFormat::Epub => {
            // Open the EPUB zip archive once and reuse it for all operations
            // (metadata, cover extraction, chapter list) instead of reopening 3 times.
            let epub_file = std::fs::File::open(&final_path).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;
            let mut archive = zip::ZipArchive::new(epub_file).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let metadata = epub::parse_epub_metadata_from_archive(&mut archive).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                let dest = dir.to_string_lossy().to_string();
                match epub::extract_cover_from_archive(&mut archive, &dest) {
                    Ok(Some(path)) => {
                        cover_dir = Some(dir);
                        Some(path)
                    }
                    Ok(None) => None,
                    Err(e) => {
                        log::warn!("cover extraction failed for book {book_id}: {e}");
                        None
                    }
                }
            } else {
                None
            };

            let chapters = epub::get_chapter_list_from_archive(&mut archive).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let language = if metadata.language.is_empty() {
                None
            } else {
                Some(metadata.language.clone())
            };
            Book {
                id: book_id,
                title: metadata.title,
                author: metadata.author,
                file_path: final_path.clone(),
                cover_path,
                total_chapters: chapters.len() as u32,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: metadata.description,
                genres: if metadata.genres.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&metadata.genres).unwrap_or_default())
                },
                rating: None,
                isbn: metadata.isbn,
                openlibrary_key: None,
                enrichment_status: None,
                series: None,
                volume: None,
                language,
                publisher: None,
                publish_year: None,
                is_imported,
            }
        }
        BookFormat::Cbz => {
            let meta = cbz::import_cbz(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                let page_result = cbz::get_page_image(&final_path, 0);
                if let Err(ref e) = page_result {
                    log::warn!("cover extraction failed for book {book_id}: {e}");
                }
                if let Some(path) = page_result
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
                title: meta.title,
                author: meta.author.unwrap_or_default(),
                file_path: final_path.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: meta.summary,
                genres: meta.genre.map(|g| {
                    let genres: Vec<String> = g
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    serde_json::to_string(&genres).unwrap_or_else(|_| "[]".to_string())
                }),
                rating: None,
                isbn: None,
                openlibrary_key: None,
                enrichment_status: None,
                series: meta.series,
                volume: meta.volume,
                language: meta.language,
                publisher: meta.publisher,
                publish_year: meta.year,
                is_imported,
            }
        }
        BookFormat::Cbr => {
            let meta = cbr::import_cbr(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            let cover_path = if let Ok(data_dir) = app.path().app_data_dir() {
                let dir = data_dir.join("covers").join(&book_id);
                let page_result = cbr::get_page_image(&final_path, 0);
                if let Err(ref e) = page_result {
                    log::warn!("cover extraction failed for book {book_id}: {e}");
                }
                if let Some(path) = page_result
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
                title: meta.title,
                author: meta.author.unwrap_or_default(),
                file_path: final_path.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: Some(hash),
                description: meta.summary,
                genres: meta.genre.map(|g| {
                    let genres: Vec<String> = g
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    serde_json::to_string(&genres).unwrap_or_else(|_| "[]".to_string())
                }),
                rating: None,
                isbn: None,
                openlibrary_key: None,
                enrichment_status: None,
                series: meta.series,
                volume: meta.volume,
                language: meta.language,
                publisher: meta.publisher,
                publish_year: meta.year,
                is_imported,
            }
        }
        BookFormat::Pdf => {
            let meta = pdf::import_pdf(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            // Use PDF metadata title if available; fall back to original filename.
            let library_stem = std::path::Path::new(&final_path)
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
                let page_result = pdf::get_page_image(&final_path, 0, 400);
                if let Err(ref e) = page_result {
                    log::warn!("cover extraction failed for book {book_id}: {e}");
                }
                if let Some(path) = page_result
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
                file_path: final_path.clone(),
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
                enrichment_status: None,
                series: None,
                volume: None,
                language: None,
                publisher: None,
                publish_year: None,
                is_imported,
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
            if should_copy {
                let _ = std::fs::remove_file(&final_path);
            }
            if let Some(dir) = cover_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            return Ok(existing);
        }
        if should_copy {
            let _ = std::fs::remove_file(&final_path);
        }
        if let Some(dir) = cover_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        return Err(e.to_string());
    }

    log_activity(
        &conn,
        "book_imported",
        "book",
        Some(&book.id),
        Some(&book.title),
        Some(&format!("{} by {}", book.format, book.author)),
    );

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

    // Fetch book before deleting so we can remove the library file and log.
    let existing_book = db::get_book(&conn, &book_id).map_err(|e| e.to_string())?;
    let file_path = existing_book.as_ref().map(|b| b.file_path.clone());

    log_activity(
        &conn,
        "book_deleted",
        "book",
        Some(&book_id),
        existing_book.as_ref().map(|b| b.title.as_str()),
        None,
    );

    db::delete_book(&conn, &book_id).map_err(|e| e.to_string())?;

    // Evict the EPUB archive cache entry for this file.
    if let Some(ref path) = file_path {
        if let Ok(mut cache) = state.epub_cache.lock() {
            cache.remove(path);
        }
    }

    // Remove the physical file only if it was imported (copied) into the library.
    // Linked books reference external files that should not be deleted.
    let is_imported = existing_book
        .as_ref()
        .map(|b| b.is_imported)
        .unwrap_or(true);
    if is_imported {
        if let Some(path) = file_path {
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Warning: could not delete library file '{}': {}", path, e);
                }
            }
        }
    }

    // Clean up extracted image cache for this book.
    let image_cache_dir = state.data_dir.join("images").join(&book_id);
    if image_cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&image_cache_dir);
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
#[allow(clippy::too_many_arguments)]
pub async fn update_book_metadata(
    book_id: String,
    title: Option<String>,
    author: Option<String>,
    cover_image_path: Option<String>,
    series: Option<String>,
    volume: Option<u32>,
    language: Option<String>,
    publisher: Option<String>,
    publish_year: Option<u16>,
    rating: Option<f64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Book, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let mut book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book '{book_id}' not found"))?;

    let has_title = title.is_some();
    let has_author = author.is_some();
    let has_series = series.is_some();
    let has_volume = volume.is_some();
    let has_language = language.is_some();
    let has_publisher = publisher.is_some();
    let has_publish_year = publish_year.is_some();
    let has_cover = cover_image_path.is_some();
    let has_rating = rating.is_some();

    if let Some(t) = title {
        book.title = t;
    }
    if let Some(a) = author {
        book.author = a;
    }
    if let Some(s) = series {
        book.series = Some(s);
    }
    if let Some(v) = volume {
        book.volume = Some(v);
    }
    if let Some(l) = language {
        book.language = Some(l);
    }
    if let Some(p) = publisher {
        book.publisher = Some(p);
    }
    if let Some(y) = publish_year {
        book.publish_year = Some(y);
    }
    if let Some(r) = rating {
        book.rating = if r <= 0.0 { None } else { Some(r.min(5.0)) };
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

    let mut changes = Vec::new();
    if has_title {
        changes.push("title");
    }
    if has_author {
        changes.push("author");
    }
    if has_series {
        changes.push("series");
    }
    if has_volume {
        changes.push("volume");
    }
    if has_language {
        changes.push("language");
    }
    if has_publisher {
        changes.push("publisher");
    }
    if has_publish_year {
        changes.push("year");
    }
    if has_cover {
        changes.push("cover");
    }
    if has_rating {
        changes.push("rating");
    }
    if !changes.is_empty() {
        let detail = format!("Changed: {}", changes.join(", "));
        log_activity(
            &conn,
            "book_updated",
            "book",
            Some(&book_id),
            Some(&book.title),
            Some(&detail),
        );
    }

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

    validate_file_exists(&file_path)?;
    let data_dir = state.data_dir.to_string_lossy().to_string();

    let mut cache = state.epub_cache.lock().map_err(|e| e.to_string())?;
    ensure_epub_cached(&mut cache, &file_path);
    let cached = cache
        .get_mut(&file_path)
        .ok_or("Failed to open EPUB archive")?;
    epub::get_chapter_content_from_cache(cached, chapter_index as usize, &data_dir, &book_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_book_content(
    book_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<epub::SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };

    validate_file_exists(&file_path)?;

    let mut cache = state.epub_cache.lock().map_err(|e| e.to_string())?;
    ensure_epub_cached(&mut cache, &file_path);
    let cached = cache
        .get_mut(&file_path)
        .ok_or("Failed to open EPUB archive")?;
    epub::search_book(cached, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_chapter_word_counts(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<usize>, String> {
    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };

    validate_file_exists(&file_path)?;

    let mut cache = state.epub_cache.lock().map_err(|e| e.to_string())?;
    ensure_epub_cached(&mut cache, &file_path);
    let cached = cache
        .get_mut(&file_path)
        .ok_or("Failed to open EPUB archive")?;
    epub::get_chapter_word_counts(cached).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_chapters(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (file_path, total_chapters) = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        let book = db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?;
        (book.file_path, book.total_chapters)
    };

    validate_file_exists(&file_path)?;
    let data_dir = state.data_dir.to_string_lossy().to_string();

    let mut cache = state.epub_cache.lock().map_err(|e| e.to_string())?;
    ensure_epub_cached(&mut cache, &file_path);
    let cached = cache
        .get_mut(&file_path)
        .ok_or("Failed to open EPUB archive")?;

    let mut chapters = Vec::with_capacity(total_chapters as usize);
    for i in 0..total_chapters as usize {
        let html = epub::get_chapter_content_from_cache(cached, i, &data_dir, &book_id)
            .map_err(|e| e.to_string())?;
        chapters.push(html);
    }
    Ok(chapters)
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

    validate_file_exists(&file_path)?;

    let mut cache = state.epub_cache.lock().map_err(|e| e.to_string())?;
    ensure_epub_cached(&mut cache, &file_path);
    let cached = cache
        .get_mut(&file_path)
        .ok_or("Failed to open EPUB archive")?;
    epub::get_toc_from_cache(cached).map_err(|e| e.to_string())
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

fn validate_file_exists(file_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!(
            "Book file not found at '{}'. It may have been moved or deleted.",
            file_path
        ));
    }
    // Reject symlinks to prevent traversal attacks
    if path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Symbolic links are not supported for book files.".to_string());
    }
    Ok(())
}

/// Validate that a path, once canonicalized, lies within an expected parent directory.
/// Returns the canonical path on success.
#[allow(dead_code)]
fn validate_path_within(path: &str, parent: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve library folder '{}': {}", parent, e))?;
    if !canonical.starts_with(&canonical_parent) {
        return Err(format!("Path '{}' is outside the library folder.", path));
    }
    Ok(canonical)
}

fn validate_scroll_position(pos: f64) -> Result<f64, String> {
    if pos.is_nan() || pos.is_infinite() {
        return Err("scroll_position must be a finite number".to_string());
    }
    Ok(pos.clamp(0.0, 1.0))
}

#[tauri::command]
pub async fn save_reading_progress(
    book_id: String,
    chapter_index: u32,
    scroll_position: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let scroll_position = validate_scroll_position(scroll_position)?;

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    // Validate chapter_index against the book's total chapters
    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book not found: {}", book_id))?;

    if book.total_chapters > 0 && chapter_index >= book.total_chapters {
        return Err(format!(
            "chapter_index {} is out of range (book has {} chapters)",
            chapter_index, book.total_chapters
        ));
    }

    let progress = ReadingProgress {
        book_id,
        chapter_index,
        scroll_position,
        last_read_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

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
        name: None,
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

#[tauri::command]
pub async fn update_bookmark(
    bookmark_id: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let truncated_name: Option<String> = name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.chars().take(100).collect::<String>());
    let name_ref = truncated_name.as_deref();
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::update_bookmark_name(&conn, &bookmark_id, name_ref).map_err(|e| e.to_string())
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

    validate_file_exists(&book.file_path)?;
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

    validate_file_exists(&book.file_path)?;
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

    log_activity(
        &conn,
        "collection_created",
        "collection",
        Some(&collection.id),
        Some(&collection.name),
        None,
    );

    Ok(collection)
}

#[tauri::command]
pub async fn update_collection(
    id: String,
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

    let coll_type_enum = match coll_type.as_str() {
        "automated" => CollectionType::Automated,
        _ => CollectionType::Manual,
    };

    let rule_structs: Vec<CollectionRule> = rules
        .into_iter()
        .map(|r| CollectionRule {
            id: Uuid::new_v4().to_string(),
            collection_id: id.clone(),
            field: r.field,
            operator: r.operator,
            value: r.value,
        })
        .collect();

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM collections WHERE id = ?1",
            rusqlite::params![&id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let collection = Collection {
        id,
        name,
        r#type: coll_type_enum,
        icon,
        color,
        created_at,
        updated_at: now,
        rules: rule_structs,
    };

    db::update_collection(&conn, &collection).map_err(|e| e.to_string())?;

    log_activity(
        &conn,
        "collection_updated",
        "collection",
        Some(&collection.id),
        Some(&collection.name),
        None,
    );

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
    log_activity(
        &conn,
        "collection_deleted",
        "collection",
        Some(&id),
        None,
        None,
    );
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
    db::add_book_to_collection(&conn, &book_id, &collection_id).map_err(|e| e.to_string())?;
    log_activity(
        &conn,
        "collection_modified",
        "collection",
        Some(&collection_id),
        None,
        Some(&format!("Added book {}", book_id)),
    );
    Ok(())
}

#[tauri::command]
pub async fn remove_book_from_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::remove_book_from_collection(&conn, &book_id, &collection_id).map_err(|e| e.to_string())?;
    log_activity(
        &conn,
        "collection_modified",
        "collection",
        Some(&collection_id),
        None,
        Some(&format!("Removed book {}", book_id)),
    );
    Ok(())
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

    log_activity(
        &conn,
        "book_enriched",
        "book",
        Some(&book_id),
        None,
        Some("Enriched from OpenLibrary"),
    );

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

/// Returns a cached list of popular/new books from all configured catalogs.
/// Results are cached for 24 hours in the settings DB to avoid slowing down startup.
#[tauri::command]
pub async fn get_discover_books(
    state: State<'_, AppState>,
) -> Result<Vec<opds::OpdsEntry>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    // Check cache (stored as JSON with a timestamp)
    if let Some(cached) = db::get_setting(&conn, "discover_cache_v3").map_err(|e| e.to_string())? {
        if let Ok(cache) = serde_json::from_str::<serde_json::Value>(&cached) {
            let cached_at = cache["cached_at"].as_i64().unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if now - cached_at < 86400 {
                // Cache is fresh (< 24h)
                if let Ok(entries) =
                    serde_json::from_value::<Vec<opds::OpdsEntry>>(cache["entries"].clone())
                {
                    return Ok(entries);
                }
            }
        }
    }

    // Cache miss or stale — fetch from catalogs in parallel
    let catalogs = get_opds_catalogs(state).await?;
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let mut thread_count = 0;

    for cat in &catalogs {
        let url = cat.url.clone();
        let tx = result_tx.clone();
        let cat_name = cat.name.clone();
        std::thread::spawn(move || {
            let entries = match opds::fetch_feed(&url) {
                Ok(feed) => feed
                    .entries
                    .into_iter()
                    .filter(|e| !e.links.is_empty() && e.nav_url.is_none())
                    .take(10)
                    .map(|mut e| {
                        // Tag with catalog source
                        if e.summary.is_empty() {
                            e.summary = format!("From {}", cat_name);
                        }
                        e
                    })
                    .collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            };
            let _ = tx.send(entries);
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

    // Cache the results
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let cache = serde_json::json!({
        "cached_at": now,
        "entries": all_entries,
    });
    let _ = db::set_setting(
        &conn,
        "discover_cache_v3",
        &serde_json::to_string(&cache).unwrap_or_default(),
    );

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
    let ps = state.profile_state.lock().map_err(|e| e.to_string())?;
    let mut result = vec![Profile {
        name: "default".to_string(),
        is_active: ps.active == "default",
    }];
    for name in ps.pools.keys() {
        result.push(Profile {
            name: name.clone(),
            is_active: *name == ps.active,
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

    let mut ps = state.profile_state.lock().map_err(|e| e.to_string())?;
    ps.pools.insert(name, pool);
    Ok(())
}

#[tauri::command]
pub async fn switch_profile(name: String, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut ps = state.profile_state.lock().map_err(|e| e.to_string())?;
        if name != "default" && !ps.pools.contains_key(&name) {
            return Err(format!("Profile '{name}' not found"));
        }
        ps.active = name.clone();
    }

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    log_activity(
        &conn,
        "profile_switched",
        "profile",
        None,
        Some(&name),
        None,
    );

    Ok(())
}

#[tauri::command]
pub async fn delete_profile(name: String, state: State<'_, AppState>) -> Result<(), String> {
    if name == "default" {
        return Err("Cannot delete the default profile".to_string());
    }
    let mut ps = state.profile_state.lock().map_err(|e| e.to_string())?;
    if ps.active == name {
        return Err(
            "Cannot delete the active profile. Switch to another profile first.".to_string(),
        );
    }
    ps.pools.remove(&name);
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
    // Validate the folder path: reject obviously dangerous values.
    let folder_path = std::path::Path::new(&new_folder);
    if new_folder.is_empty() || new_folder == "/" || new_folder == "\\" {
        return Err("Invalid library folder path.".to_string());
    }
    // Ensure the folder exists (or can be created) then canonicalize.
    std::fs::create_dir_all(&new_folder).map_err(|e| e.to_string())?;
    let canonical = std::fs::canonicalize(folder_path)
        .map_err(|e| format!("Cannot resolve library folder: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    if !move_files {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "library_folder", &canonical_str).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Atomic migration: gather books, plan moves, execute all-or-nothing.
    let books = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::list_books(&conn).map_err(|e| e.to_string())?
    };

    // Build (src, dest) pairs using canonical path.
    let moves: Vec<(String, String)> = books
        .iter()
        .map(|book| {
            let ext = std::path::Path::new(&book.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let dest = format!("{}/{}.{}", canonical_str, book.id, ext);
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
    db::set_setting(&tx, "library_folder", &canonical_str).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn copy_to_library(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Book not found".to_string())?;

    if book.is_imported {
        return Err("Book is already in the library".to_string());
    }

    if !std::path::Path::new(&book.file_path).exists() {
        return Err("Source file not available. Reconnect the drive and try again.".to_string());
    }

    let library_folder = db::get_setting(&conn, "library_folder")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| default_library_folder().unwrap_or_default());

    let ext = std::path::Path::new(&book.file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("epub");
    let library_path = format!("{}/{}.{}", library_folder, book.id, ext);

    std::fs::copy(&book.file_path, &library_path)
        .map_err(|e| format!("Failed to copy file to library: {e}"))?;

    db::update_book_path(&conn, &book.id, &library_path, true).map_err(|e| e.to_string())?;

    log_activity(
        &conn,
        "book_updated",
        "book",
        Some(&book.id),
        Some(&book.title),
        Some("Copied to library"),
    );

    db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Book not found after update".to_string())
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

    let mut linked_count = 0u32;
    if include_files {
        // Add each book file (use Stored for already-compressed formats)
        let stored_options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for book in &books {
            if !book.is_imported {
                linked_count += 1;
                continue;
            }
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

    let export_detail = if include_files {
        if linked_count > 0 {
            &format!(
                "Full backup with files ({} linked books skipped)",
                linked_count
            )
        } else {
            "Full backup with files"
        }
    } else {
        "Metadata only"
    };
    log_activity(
        &conn,
        "library_exported",
        "library",
        None,
        None,
        Some(export_detail),
    );

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

    // Helper: validate that a ZIP entry name is safe (no path traversal).
    let is_safe_zip_entry = |name: &str| -> bool {
        !name.contains("..") && !name.starts_with('/') && !name.starts_with('\\')
    };

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

        // Validate ZIP entry name before extraction
        if !is_safe_zip_entry(&book_archive_name) {
            continue;
        }

        // Extract book file — validate destination is within library folder.
        let library_path = format!("{}/{}.{}", library_folder, book.id, ext);
        // Ensure the destination path doesn't escape the library folder via
        // a crafted book ID containing path separators.
        {
            let dest = std::path::Path::new(&library_path);
            let parent = dest.parent().unwrap_or(std::path::Path::new(""));
            let lib = std::path::Path::new(&library_folder);
            if parent != lib {
                continue; // path escapes library folder
            }
        }
        if let Ok(mut entry) = archive.by_name(&book_archive_name) {
            // Validate the actual entry name from the archive as well
            if !is_safe_zip_entry(entry.name()) {
                continue;
            }
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
            if !is_safe_zip_entry(&cover_name) {
                continue;
            }
            if let Ok(mut entry) = archive.by_name(&cover_name) {
                if !is_safe_zip_entry(entry.name()) {
                    continue;
                }
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

    log_activity(
        &conn,
        "library_imported",
        "library",
        None,
        None,
        Some("Restored from backup"),
    );

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
    validate_file_exists(&file_path)?;
    pdf::get_page_count(&file_path)
}

#[tauri::command]
pub async fn get_pdf_page(
    book_id: String,
    page_index: u32,
    width: Option<u32>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let render_width = width.unwrap_or(1200).min(9600);
    let file_path = {
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::get_book(&conn, &book_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Book '{book_id}' not found"))?
            .file_path
    };
    validate_file_exists(&file_path)?;

    let cache_key = format!("{}:{}:{}", file_path, page_index, render_width);

    // Check cache (single lock for both map and LRU order)
    {
        let mut cache = state.pdf_cache.lock().map_err(|e| e.to_string())?;
        if let Some(data) = cache.get(&cache_key) {
            let result = data.clone();
            cache.touch(&cache_key);
            return Ok(result);
        }
    }

    // Render (outside the lock)
    let data = pdf::get_page_image(&file_path, page_index, render_width)?;

    // Store in cache with LRU eviction
    {
        let mut cache = state.pdf_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(cache_key, data.clone());
    }

    Ok(data)
}

// ---- Remote Backup Commands ----

#[tauri::command]
pub async fn get_backup_providers() -> Result<Vec<crate::backup::ProviderInfo>, String> {
    Ok(crate::backup::provider_schemas())
}

#[tauri::command]
pub async fn save_backup_config(
    config: crate::backup::BackupConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Store secrets in OS keychain, save only non-secret values to DB
    let clean = crate::backup::store_secrets(&config);
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
    db::set_setting(&conn, "backup_config", &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_backup_config(
    state: State<'_, AppState>,
) -> Result<Option<crate::backup::BackupConfig>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    match db::get_setting(&conn, "backup_config").map_err(|e| e.to_string())? {
        Some(j) => {
            let mut config: crate::backup::BackupConfig =
                serde_json::from_str(&j).map_err(|e| e.to_string())?;
            // Load secrets from OS keychain
            crate::backup::load_secrets(&mut config);
            Ok(Some(config))
        }
        None => Ok(None),
    }
}

static BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn run_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::backup::SyncResult, String> {
    if BACKUP_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A backup is already in progress".to_string());
    }
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let json = db::get_setting(&conn, "backup_config")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No backup provider configured".to_string())?;
    let mut config: crate::backup::BackupConfig =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    crate::backup::load_secrets(&mut config);
    let provider_name = config.provider_type.clone();
    let op = crate::backup::build_operator(&config)?;
    let (tx, rx) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let result = crate::backup::run_incremental_backup_with_progress(
            &op,
            &conn,
            &|step, current, total| {
                let _ = app_handle.emit(
                    "backup-progress",
                    serde_json::json!({
                        "step": step,
                        "current": current,
                        "total": total,
                    }),
                );
            },
        );
        let _ = tx.send(result);
    });
    let result = rx.recv().map_err(|e| format!("Thread error: {e}"))?;
    let log_conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    match &result {
        Ok(sync_result) => {
            log_activity(
                &log_conn,
                "backup_completed",
                "library",
                None,
                None,
                Some(&format!(
                    "Provider: {:?} — {} books, {} bookmarks, {} highlights pushed",
                    provider_name,
                    sync_result.books_pushed,
                    sync_result.bookmarks_pushed,
                    sync_result.highlights_pushed,
                )),
            );
        }
        Err(e) => {
            log_activity(
                &log_conn,
                "backup_failed",
                "library",
                None,
                None,
                Some(&format!("Provider: {:?} — {}", provider_name, e)),
            );
        }
    }
    BACKUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn get_backup_status(
    state: State<'_, AppState>,
) -> Result<Option<crate::backup::SyncManifest>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let json = match db::get_setting(&conn, "backup_config").map_err(|e| e.to_string())? {
        Some(j) => j,
        None => return Ok(None),
    };
    let mut config: crate::backup::BackupConfig =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    crate::backup::load_secrets(&mut config);
    let op = crate::backup::build_operator(&config)?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(crate::backup::read_manifest(&op));
    });
    let manifest = rx.recv().map_err(|e| format!("Thread error: {e}"))?;
    Ok(Some(manifest))
}

use std::sync::atomic::{AtomicBool, Ordering};

static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    current: u32,
    total: u32,
    book_title: String,
    status: String,
}

#[tauri::command]
pub async fn start_scan(
    include_skipped: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    SCAN_CANCEL.store(false, Ordering::SeqCst);
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    if include_skipped.unwrap_or(false) {
        // Re-queue previously skipped books so new providers can try them
        conn.execute(
            "UPDATE books SET enrichment_status = NULL WHERE enrichment_status = 'skipped'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let books = db::list_unenriched_books(&conn).map_err(|e| e.to_string())?;
    let total = books.len() as u32;
    if total == 0 {
        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                current: 0,
                total: 0,
                book_title: String::new(),
                status: "done".into(),
            },
        );
        return Ok(());
    }
    let registry = {
        let reg = state
            .enrichment_registry
            .lock()
            .map_err(|e| e.to_string())?;
        let mut new_reg = crate::providers::ProviderRegistry::new();
        for info in reg.list_providers() {
            new_reg.configure_provider(&info.id, info.config.clone());
        }
        new_reg
    };
    let app_clone = app.clone();
    std::thread::spawn(move || {
        for (i, book) in books.iter().enumerate() {
            if SCAN_CANCEL.load(Ordering::SeqCst) {
                let _ = app_clone.emit(
                    "scan-progress",
                    ScanProgress {
                        current: (i + 1) as u32,
                        total,
                        book_title: book.title.clone(),
                        status: "cancelled".into(),
                    },
                );
                return;
            }
            let _ = app_clone.emit(
                "scan-progress",
                ScanProgress {
                    current: (i + 1) as u32,
                    total,
                    book_title: book.title.clone(),
                    status: "running".into(),
                },
            );
            let parsed = crate::enrichment::parse_filename(
                std::path::Path::new(&book.file_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(""),
            );
            let lookup_title = if book.title == "Unknown Title" || book.title == "Unknown" {
                parsed.title.as_deref().unwrap_or(&book.title)
            } else {
                &book.title
            };
            let lookup_author = if book.author.is_empty() || book.author == "Unknown Author" {
                parsed.author.as_deref().unwrap_or(&book.author)
            } else {
                &book.author
            };
            let lookup_isbn = book.isbn.as_deref().or(parsed.isbn.as_deref());
            match crate::enrichment::enrich_book(
                lookup_title,
                lookup_author,
                lookup_isbn,
                &registry,
            ) {
                Some(result) if result.auto_apply => {
                    let genres_json = if !result.data.genres.is_empty() {
                        Some(serde_json::to_string(&result.data.genres).unwrap_or_default())
                    } else {
                        None
                    };
                    let _ = db::update_book_enrichment(
                        &conn,
                        &book.id,
                        result.data.description.as_deref(),
                        genres_json.as_deref(),
                        result.data.rating,
                        result.data.isbn.as_deref().or(lookup_isbn),
                        match result.data.source_key.as_deref() {
                            Some("") | None => None,
                            some => some,
                        },
                    );
                    // Apply new metadata fields if the book doesn't already have them
                    if let Ok(Some(mut db_book)) = db::get_book(&conn, &book.id) {
                        let mut changed = false;
                        if db_book.language.is_none() {
                            if let Some(ref v) = result.data.language {
                                db_book.language = Some(v.clone());
                                changed = true;
                            }
                        }
                        if db_book.publisher.is_none() {
                            if let Some(ref v) = result.data.publisher {
                                db_book.publisher = Some(v.clone());
                                changed = true;
                            }
                        }
                        if db_book.publish_year.is_none() {
                            if let Some(v) = result.data.publish_year {
                                db_book.publish_year = Some(v);
                                changed = true;
                            }
                        }
                        if changed {
                            let _ = db::update_book(&conn, &db_book);
                        }
                    }
                    let _ = db::set_enrichment_status(&conn, &book.id, "enriched");
                }
                _ => {
                    let _ = db::set_enrichment_status(&conn, &book.id, "skipped");
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = app_clone.emit(
            "scan-progress",
            ScanProgress {
                current: total,
                total,
                book_title: String::new(),
                status: "done".into(),
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_scan() -> Result<(), String> {
    SCAN_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn scan_single_book(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book '{}' not found", book_id))?;
    let parsed = crate::enrichment::parse_filename(
        std::path::Path::new(&book.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    );
    let lookup_title = if book.title == "Unknown Title" || book.title == "Unknown" {
        parsed.title.as_deref().unwrap_or(&book.title)
    } else {
        &book.title
    };
    let lookup_author = if book.author.is_empty() || book.author == "Unknown Author" {
        parsed.author.as_deref().unwrap_or(&book.author)
    } else {
        &book.author
    };
    let lookup_isbn = book.isbn.as_deref().or(parsed.isbn.as_deref());
    let registry = {
        let reg = state
            .enrichment_registry
            .lock()
            .map_err(|e| e.to_string())?;
        let mut new_reg = crate::providers::ProviderRegistry::new();
        for info in reg.list_providers() {
            new_reg.configure_provider(&info.id, info.config.clone());
        }
        new_reg
    };
    let enabled_provider_names: Vec<String> = registry
        .list_providers()
        .iter()
        .filter(|p| p.config.enabled)
        .map(|p| p.name.clone())
        .collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let t = lookup_title.to_string();
    let a = lookup_author.to_string();
    let i = lookup_isbn.map(|s| s.to_string());
    std::thread::spawn(move || {
        let _ = tx.send(crate::enrichment::enrich_book(
            &t,
            &a,
            i.as_deref(),
            &registry,
        ));
    });
    let enrichment = rx.recv().map_err(|e| format!("Thread error: {e}"))?;
    match enrichment {
        Some(result) => {
            let genres_json = if !result.data.genres.is_empty() {
                Some(serde_json::to_string(&result.data.genres).unwrap_or_default())
            } else {
                None
            };
            db::update_book_enrichment(
                &conn,
                &book_id,
                result.data.description.as_deref(),
                genres_json.as_deref(),
                result.data.rating,
                result.data.isbn.as_deref().or(lookup_isbn),
                match result.data.source_key.as_deref() {
                    Some("") | None => None,
                    some => some,
                },
            )
            .map_err(|e| e.to_string())?;
            // Apply new metadata fields if the book doesn't already have them
            let mut book = db::get_book(&conn, &book_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Book not found".to_string())?;
            let mut changed = false;
            if book.language.is_none() {
                if let Some(ref v) = result.data.language {
                    book.language = Some(v.clone());
                    changed = true;
                }
            }
            if book.publisher.is_none() {
                if let Some(ref v) = result.data.publisher {
                    book.publisher = Some(v.clone());
                    changed = true;
                }
            }
            if book.publish_year.is_none() {
                if let Some(v) = result.data.publish_year {
                    book.publish_year = Some(v);
                    changed = true;
                }
            }
            if changed {
                db::update_book(&conn, &book).map_err(|e| e.to_string())?;
            }
            db::set_enrichment_status(&conn, &book_id, "enriched").map_err(|e| e.to_string())?;
            let updated_book = db::get_book(&conn, &book_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Book not found".to_string())?;
            let tried = result.providers_tried.join(", ");
            log_activity(
                &conn,
                "book_scanned",
                "book",
                Some(&book_id),
                Some(&updated_book.title),
                Some(&format!(
                    "Matched via {} (searched: {})",
                    result.data.source, tried
                )),
            );
            Ok(updated_book)
        }
        None => {
            db::set_enrichment_status(&conn, &book_id, "skipped").map_err(|e| e.to_string())?;
            let tried = enabled_provider_names.join(", ");
            log_activity(
                &conn,
                "book_scanned",
                "book",
                Some(&book_id),
                Some(&book.title),
                Some(&format!("No match found (searched: {})", tried)),
            );
            Err("No match found".to_string())
        }
    }
}

#[tauri::command]
pub async fn queue_book_for_scan(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::set_enrichment_status(&conn, &book_id, "queued").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_setting_value(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_setting_value(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_enrichment_providers(
    state: State<'_, AppState>,
) -> Result<Vec<crate::providers::ProviderInfo>, String> {
    let reg = state
        .enrichment_registry
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(reg.list_providers())
}

#[tauri::command]
pub async fn set_enrichment_provider_config(
    provider_id: String,
    enabled: bool,
    api_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = crate::providers::ProviderConfig {
        enabled,
        api_key: api_key.filter(|k| !k.is_empty()),
    };
    let mut reg = state
        .enrichment_registry
        .lock()
        .map_err(|e| e.to_string())?;
    reg.configure_provider(&provider_id, config);
    // Persist all provider configs
    let all: std::collections::HashMap<String, crate::providers::ProviderConfig> = reg
        .list_providers()
        .into_iter()
        .map(|p| (p.id, p.config))
        .collect();
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "enrichment_providers", &json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_enrichment_provider_order(
    order: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut reg = state
        .enrichment_registry
        .lock()
        .map_err(|e| e.to_string())?;
    reg.reorder(&order);
    // Persist the order
    let json = serde_json::to_string(&order).map_err(|e| e.to_string())?;
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "enrichment_provider_order", &json).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Activity log ---

#[tauri::command]
pub async fn get_activity_log(
    limit: Option<u32>,
    offset: Option<u32>,
    action_filter: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::ActivityEntry>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_activity_log(
        &conn,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
        action_filter.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_collection_rules(
    rules: Vec<crate::models::NewRuleInput>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::preview_collection_rules(&conn, &rules).map_err(|e| e.to_string())
}

fn derive_font_name(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);

    let known_suffixes = [
        "-Regular",
        "-Bold",
        "-Italic",
        "-Light",
        "-Medium",
        "-SemiBold",
        "-ExtraBold",
        "-Thin",
        "-Black",
        "-BoldItalic",
    ];
    let mut name = stem.to_string();
    for suffix in &known_suffixes {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
            break;
        }
    }
    name
}

#[tauri::command]
pub async fn import_custom_font(
    file_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CustomFont, String> {
    let source = std::path::Path::new(&file_path);
    if !source.exists() {
        return Err(format!("File not found: {file_path}"));
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["ttf", "otf", "woff2"].contains(&extension.as_str()) {
        return Err(format!("Unsupported font format: .{extension}"));
    }

    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let id = Uuid::new_v4().to_string();
    let fonts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    std::fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;

    let dest = fonts_dir.join(format!("{id}.{extension}"));
    std::fs::copy(source, &dest).map_err(|e| e.to_string())?;

    let font = CustomFont {
        id,
        name: derive_font_name(&file_name),
        file_name,
        file_path: dest.to_string_lossy().to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::insert_custom_font(&conn, &font).map_err(|e| e.to_string())?;

    Ok(font)
}

#[tauri::command]
pub async fn get_custom_fonts(state: State<'_, AppState>) -> Result<Vec<CustomFont>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_custom_fonts(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_custom_font(font_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    if let Some(font) = db::get_custom_font(&conn, &font_id).map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(&font.file_path);
    }

    db::delete_custom_font(&conn, &font_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_file_exists(file_path: String) -> Result<bool, String> {
    if std::path::Path::new(&file_path).exists() {
        Ok(true)
    } else {
        Err(format!(
            "Book file not found at '{}'. It may have been moved or deleted.",
            file_path
        ))
    }
}

#[tauri::command]
pub async fn cleanup_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let books = db::list_books(&conn).map_err(|e| e.to_string())?;
    let total = books.len() as u32;

    // Auto-backup metadata before cleanup.
    let backups_dir = state.data_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_path = backups_dir.join(format!("pre-cleanup-{}.zip", timestamp));

    {
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

        let file = std::fs::File::create(&backup_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
        zip.start_file("library.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(metadata_json.as_bytes())
            .map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }

    let mut removed_books: Vec<CleanupEntry> = Vec::new();

    for (i, book) in books.iter().enumerate() {
        let _ = app.emit(
            "cleanup-progress",
            CleanupProgress {
                current: (i + 1) as u32,
                total,
            },
        );

        if std::path::Path::new(&book.file_path).exists() {
            continue;
        }

        // Book file is missing — remove from database.
        db::delete_book(&conn, &book.id).map_err(|e| e.to_string())?;

        // Evict EPUB cache entry.
        if let Ok(mut cache) = state.epub_cache.lock() {
            cache.remove(&book.file_path);
        }

        // Remove cover directory.
        let cover_dir = state.data_dir.join("covers").join(&book.id);
        if cover_dir.exists() {
            let _ = std::fs::remove_dir_all(&cover_dir);
        }

        // Remove extracted image cache.
        let image_cache_dir = state.data_dir.join("images").join(&book.id);
        if image_cache_dir.exists() {
            let _ = std::fs::remove_dir_all(&image_cache_dir);
        }

        log_activity(
            &conn,
            "book_removed_cleanup",
            "book",
            Some(&book.id),
            Some(&book.title),
            None,
        );

        removed_books.push(CleanupEntry {
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
        });
    }

    Ok(CleanupResult {
        removed_count: removed_books.len() as u32,
        removed_books,
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn list_auto_backups(state: State<'_, AppState>) -> Result<Vec<AutoBackup>, String> {
    let backups_dir = state.data_dir.join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut backups: Vec<AutoBackup> = Vec::new();

    let entries = std::fs::read_dir(&backups_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }

        let filename = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Parse known prefixes: "pre-cleanup-{timestamp}"
        let (label, timestamp) = if let Some(ts_str) = filename.strip_prefix("pre-cleanup-") {
            match ts_str.parse::<i64>() {
                Ok(ts) => ("Pre-cleanup".to_string(), ts),
                Err(_) => continue,
            }
        } else {
            continue; // Skip unknown files
        };

        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        backups.push(AutoBackup {
            path: path.to_string_lossy().to_string(),
            label,
            timestamp,
            size_bytes,
        });
    }

    // Sort newest first
    backups.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(backups)
}

#[tauri::command]
pub async fn get_series(state: State<'_, AppState>) -> Result<Vec<SeriesInfo>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_series(&conn).map_err(|e| e.to_string())
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

    #[test]
    fn validate_scroll_position_rejects_nan() {
        assert!(validate_scroll_position(f64::NAN).is_err());
    }

    #[test]
    fn validate_scroll_position_rejects_infinity() {
        assert!(validate_scroll_position(f64::INFINITY).is_err());
        assert!(validate_scroll_position(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn validate_scroll_position_clamps_negative() {
        assert_eq!(validate_scroll_position(-0.5).unwrap(), 0.0);
    }

    #[test]
    fn validate_scroll_position_clamps_above_one() {
        assert_eq!(validate_scroll_position(1.5).unwrap(), 1.0);
    }

    #[test]
    fn validate_scroll_position_accepts_valid_values() {
        assert_eq!(validate_scroll_position(0.0).unwrap(), 0.0);
        assert_eq!(validate_scroll_position(0.5).unwrap(), 0.5);
        assert_eq!(validate_scroll_position(1.0).unwrap(), 1.0);
    }

    #[test]
    fn validate_file_exists_returns_ok_for_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("book.epub");
        std::fs::write(&file, b"dummy").unwrap();
        assert!(validate_file_exists(file.to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_file_exists_returns_clear_error_for_missing_file() {
        let result = validate_file_exists("/nonexistent/path/book.epub");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(
            msg.contains("not found"),
            "error should mention 'not found': {msg}"
        );
        assert!(
            msg.contains("/nonexistent/path/book.epub"),
            "error should include the path: {msg}"
        );
    }

    #[test]
    fn test_derive_font_name() {
        assert_eq!(derive_font_name("Merriweather-Regular.ttf"), "Merriweather");
        assert_eq!(derive_font_name("FiraCode-Bold.woff2"), "FiraCode");
        assert_eq!(derive_font_name("My Font.otf"), "My Font");
        assert_eq!(derive_font_name("Roboto-BoldItalic.ttf"), "Roboto");
        assert_eq!(derive_font_name("SimpleFont.ttf"), "SimpleFont");
    }
}
