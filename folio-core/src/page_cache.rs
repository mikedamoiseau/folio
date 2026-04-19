use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zip::ZipArchive;

use crate::error::{FolioError, FolioResult};
use crate::models::BookFormat;

/// Enable with: FOLIO_DEBUG_PAGES=1
/// Prints to stderr so it shows in the terminal running `npm run tauri dev`.
pub fn page_debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("FOLIO_DEBUG_PAGES").unwrap_or_default() == "1")
}

#[macro_export]
macro_rules! page_dbg {
    ($($arg:tt)*) => {
        if $crate::page_cache::page_debug_enabled() {
            eprintln!("[page-load] {}", format!($($arg)*));
        }
    };
}

pub use page_dbg;

const MAX_CACHED_BOOKS: usize = 5;
pub const DEFAULT_MAX_CACHE_SIZE_MB: u64 = 500;
const MAX_AGE_DAYS: u64 = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheManifest {
    pub book_id: String,
    pub book_hash: String,
    pub page_count: u32,
    pub total_size_bytes: u64,
    pub extracted_at: String,
    pub last_accessed: String,
    pub pages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    pub total_size_bytes: u64,
    pub book_count: usize,
    pub books: Vec<CacheBookInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheBookInfo {
    pub book_id: String,
    pub book_hash: String,
    pub size_bytes: u64,
    pub page_count: u32,
    pub last_accessed: String,
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

pub fn cache_root(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("page-cache")
}

pub fn book_cache_dir(app_cache_dir: &Path, book_hash: &str) -> PathBuf {
    cache_root(app_cache_dir).join(book_hash)
}

pub fn read_manifest(app_cache_dir: &Path, book_hash: &str) -> Option<CacheManifest> {
    let manifest_path = book_cache_dir(app_cache_dir, book_hash).join("manifest.json");
    let data = fs::read_to_string(manifest_path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn write_manifest(
    app_cache_dir: &Path,
    book_hash: &str,
    manifest: &CacheManifest,
) -> FolioResult<()> {
    let dir = book_cache_dir(app_cache_dir, book_hash);
    let manifest_path = dir.join("manifest.json");
    let json = serde_json::to_string_pretty(manifest)?;
    fs::write(manifest_path, json)
        .map_err(|e| FolioError::io(format!("Failed to write manifest: {e}")))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

fn is_image_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
}

fn file_extension(name: &str) -> &str {
    if let Some(pos) = name.rfind('.') {
        &name[pos..]
    } else {
        ".jpg"
    }
}

// ---------------------------------------------------------------------------
// CBZ extraction
// ---------------------------------------------------------------------------

pub fn extract_cbz(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
) -> FolioResult<CacheManifest> {
    let file = fs::File::open(file_path)
        .map_err(|e| FolioError::io(format!("Failed to open CBZ: {e}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| FolioError::invalid(format!("Invalid CBZ archive: {e}")))?;

    let mut image_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if !entry.is_dir() && is_image_ext(&name) {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    image_names.sort();

    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::create_dir_all(&dir)
        .map_err(|e| FolioError::io(format!("Failed to create cache dir: {e}")))?;

    let mut pages: Vec<String> = Vec::new();
    let mut total_size: u64 = 0;

    for (idx, name) in image_names.iter().enumerate() {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| FolioError::invalid(format!("Failed to read entry {name}: {e}")))?;
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| FolioError::io(format!("Failed to extract {name}: {e}")))?;

        let ext = file_extension(name).to_lowercase();
        let page_filename = format!("{:03}{}", idx, ext);
        let page_path = dir.join(&page_filename);
        fs::write(&page_path, &data)
            .map_err(|e| FolioError::io(format!("Failed to write page {idx}: {e}")))?;

        total_size += data.len() as u64;
        pages.push(page_filename);
    }

    let now = now_iso();
    let manifest = CacheManifest {
        book_id: book_id.to_string(),
        book_hash: book_hash.to_string(),
        page_count: pages.len() as u32,
        total_size_bytes: total_size,
        extracted_at: now.clone(),
        last_accessed: now,
        pages,
    };

    write_manifest(app_cache_dir, book_hash, &manifest)?;
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// CBR extraction
// ---------------------------------------------------------------------------

pub fn extract_cbr(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
) -> FolioResult<CacheManifest> {
    // First pass: collect sorted image names
    let mut image_names: Vec<String> = Vec::new();
    {
        let archive = unrar::Archive::new(file_path)
            .open_for_listing()
            .map_err(|e| FolioError::invalid(format!("Failed to open CBR for listing: {e}")))?;
        for entry in archive {
            let entry =
                entry.map_err(|e| FolioError::invalid(format!("Failed to read CBR entry: {e}")))?;
            let name = entry.filename.to_string_lossy().to_string();
            if !entry.is_directory() && is_image_ext(&name) {
                image_names.push(name);
            }
        }
    }
    image_names.sort();

    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::create_dir_all(&dir)
        .map_err(|e| FolioError::io(format!("Failed to create cache dir: {e}")))?;

    // Build name->index map
    let name_to_idx: HashMap<String, usize> = image_names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i))
        .collect();

    let mut pages_data: Vec<(usize, String, u64)> = Vec::new();

    let archive = unrar::Archive::new(file_path)
        .open_for_processing()
        .map_err(|e| FolioError::invalid(format!("Failed to open CBR for processing: {e}")))?;

    let mut cursor = archive;
    loop {
        let header = cursor
            .read_header()
            .map_err(|e| FolioError::invalid(format!("Error reading CBR header: {e}")))?;
        match header {
            None => break,
            Some(entry) => {
                let entry_name = entry.entry().filename.to_string_lossy().to_string();
                if let Some(&idx) = name_to_idx.get(&entry_name) {
                    let (data, next) = entry.read().map_err(|e| {
                        FolioError::invalid(format!("Failed to extract CBR entry: {e}"))
                    })?;
                    let ext = file_extension(&entry_name).to_lowercase();
                    let page_filename = format!("{:03}{}", idx, ext);
                    let page_path = dir.join(&page_filename);
                    fs::write(&page_path, &data)
                        .map_err(|e| FolioError::io(format!("Failed to write page {idx}: {e}")))?;
                    pages_data.push((idx, page_filename, data.len() as u64));
                    cursor = next;
                } else {
                    cursor = entry.skip().map_err(|e| {
                        FolioError::invalid(format!("Failed to skip CBR entry: {e}"))
                    })?;
                }
            }
        }
    }

    pages_data.sort_by_key(|(idx, _, _)| *idx);
    let total_size: u64 = pages_data.iter().map(|(_, _, s)| s).sum();
    let pages: Vec<String> = pages_data.into_iter().map(|(_, name, _)| name).collect();

    let now = now_iso();
    let manifest = CacheManifest {
        book_id: book_id.to_string(),
        book_hash: book_hash.to_string(),
        page_count: pages.len() as u32,
        total_size_bytes: total_size,
        extracted_at: now.clone(),
        last_accessed: now,
        pages,
    };

    write_manifest(app_cache_dir, book_hash, &manifest)?;
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// Cache read & ensure_cached
// ---------------------------------------------------------------------------

pub fn get_cached_page(
    app_cache_dir: &Path,
    book_hash: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)> {
    let manifest = read_manifest(app_cache_dir, book_hash)
        .ok_or_else(|| FolioError::not_found("Cache manifest not found"))?;

    let page_name = manifest.pages.get(page_index as usize).ok_or_else(|| {
        FolioError::not_found(format!(
            "Page index {page_index} out of range (total: {})",
            manifest.page_count
        ))
    })?;

    let page_path = book_cache_dir(app_cache_dir, book_hash).join(page_name);
    let data = fs::read(&page_path)
        .map_err(|e| FolioError::io(format!("Failed to read cached page {page_index}: {e}")))?;

    let mime = if page_name.ends_with(".png") {
        "image/png"
    } else if page_name.ends_with(".webp") {
        "image/webp"
    } else if page_name.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    };

    Ok((data, mime.to_string()))
}

pub fn ensure_cached(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    format: &BookFormat,
) -> FolioResult<CacheManifest> {
    if let Some(mut manifest) = read_manifest(app_cache_dir, book_hash) {
        let dir = book_cache_dir(app_cache_dir, book_hash);
        let first_ok = manifest.pages.first().is_some_and(|p| dir.join(p).exists());
        let last_ok = manifest.pages.last().is_some_and(|p| dir.join(p).exists());

        if first_ok && last_ok {
            page_dbg!(
                "ensure_cached: cache hit for {} ({} pages)",
                book_hash,
                manifest.page_count
            );
            manifest.last_accessed = now_iso();
            let _ = write_manifest(app_cache_dir, book_hash, &manifest);
            return Ok(manifest);
        }
        page_dbg!(
            "ensure_cached: cache corrupted for {}, re-extracting",
            book_hash
        );
        let _ = fs::remove_dir_all(book_cache_dir(app_cache_dir, book_hash));
    }

    page_dbg!("ensure_cached: extracting {:?} {}", format, book_hash);
    let start = std::time::Instant::now();
    let result = match format {
        BookFormat::Cbz => extract_cbz(app_cache_dir, book_id, book_hash, file_path),
        BookFormat::Cbr => extract_cbr(app_cache_dir, book_id, book_hash, file_path),
        _ => Err(FolioError::invalid(format!(
            "Page cache not supported for format: {:?}",
            format
        ))),
    };
    page_dbg!("ensure_cached: extraction took {:?}", start.elapsed());
    result
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

fn collect_cached_books(app_cache_dir: &Path) -> Vec<CacheManifest> {
    let root = cache_root(app_cache_dir);
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let hash = e.file_name().to_string_lossy().to_string();
            read_manifest(app_cache_dir, &hash)
        })
        .collect()
}

fn evict_book(app_cache_dir: &Path, book_hash: &str) -> FolioResult<()> {
    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::remove_dir_all(dir)
        .map_err(|e| FolioError::io(format!("Failed to evict cache for {book_hash}: {e}")))
}

pub fn run_eviction(app_cache_dir: &Path, max_size_mb: u64) -> FolioResult<()> {
    let mut books = collect_cached_books(app_cache_dir);
    books.sort_by(|a, b| a.last_accessed.cmp(&b.last_accessed));

    // Layer 1: LRU by book count
    while books.len() > MAX_CACHED_BOOKS {
        let oldest = &books[0];
        evict_book(app_cache_dir, &oldest.book_hash)?;
        books.remove(0);
    }

    // Layer 2: Total size cap
    let max_size_bytes = max_size_mb * 1024 * 1024;
    let mut total_size: u64 = books.iter().map(|b| b.total_size_bytes).sum();
    while total_size > max_size_bytes && !books.is_empty() {
        let oldest = &books[0];
        total_size -= oldest.total_size_bytes;
        evict_book(app_cache_dir, &oldest.book_hash)?;
        books.remove(0);
    }

    // Layer 3: Age expiry
    let cutoff = chrono::Utc::now() - chrono::Duration::days(MAX_AGE_DAYS as i64);
    let cutoff_str = cutoff.to_rfc3339();
    let expired: Vec<String> = books
        .iter()
        .filter(|b| b.last_accessed < cutoff_str)
        .map(|b| b.book_hash.clone())
        .collect();
    for hash in expired {
        evict_book(app_cache_dir, &hash)?;
    }

    Ok(())
}

pub fn get_cache_stats(app_cache_dir: &Path) -> CacheStats {
    let books = collect_cached_books(app_cache_dir);
    let total_size_bytes: u64 = books.iter().map(|b| b.total_size_bytes).sum();
    let book_count = books.len();
    let book_infos: Vec<CacheBookInfo> = books
        .into_iter()
        .map(|b| CacheBookInfo {
            book_id: b.book_id,
            book_hash: b.book_hash,
            size_bytes: b.total_size_bytes,
            page_count: b.page_count,
            last_accessed: b.last_accessed,
        })
        .collect();
    CacheStats {
        total_size_bytes,
        book_count,
        books: book_infos,
    }
}

pub fn clear_cache(app_cache_dir: &Path) -> FolioResult<()> {
    let root = cache_root(app_cache_dir);
    if root.exists() {
        fs::remove_dir_all(root)
            .map_err(|e| FolioError::io(format!("Failed to clear cache: {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Helper: create a fake cached book with a manifest and dummy page files.
    fn create_fake_cache(
        app_cache_dir: &Path,
        book_id: &str,
        book_hash: &str,
        page_count: u32,
        total_size_bytes: u64,
        last_accessed: &str,
    ) -> CacheManifest {
        let dir = book_cache_dir(app_cache_dir, book_hash);
        fs::create_dir_all(&dir).unwrap();

        let mut pages = Vec::new();
        for i in 0..page_count {
            let name = format!("{:03}.jpg", i);
            fs::write(dir.join(&name), b"fake image data").unwrap();
            pages.push(name);
        }

        let manifest = CacheManifest {
            book_id: book_id.to_string(),
            book_hash: book_hash.to_string(),
            page_count,
            total_size_bytes,
            extracted_at: last_accessed.to_string(),
            last_accessed: last_accessed.to_string(),
            pages,
        };
        write_manifest(app_cache_dir, book_hash, &manifest).unwrap();
        manifest
    }

    #[test]
    fn manifest_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let hash = "abc123";

        // Ensure the book cache dir exists before writing
        fs::create_dir_all(book_cache_dir(dir, hash)).unwrap();

        let manifest = CacheManifest {
            book_id: "book1".to_string(),
            book_hash: hash.to_string(),
            page_count: 3,
            total_size_bytes: 1024,
            extracted_at: "2026-01-01T00:00:00Z".to_string(),
            last_accessed: "2026-01-01T00:00:00Z".to_string(),
            pages: vec![
                "000.jpg".to_string(),
                "001.jpg".to_string(),
                "002.jpg".to_string(),
            ],
        };

        write_manifest(dir, hash, &manifest).unwrap();
        let loaded = read_manifest(dir, hash).expect("manifest should be readable");

        assert_eq!(loaded.book_id, "book1");
        assert_eq!(loaded.book_hash, hash);
        assert_eq!(loaded.page_count, 3);
        assert_eq!(loaded.total_size_bytes, 1024);
        assert_eq!(loaded.pages.len(), 3);
    }

    #[test]
    fn read_manifest_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(read_manifest(tmp.path(), "nonexistent").is_none());
    }

    #[test]
    fn lru_count_eviction() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // Create 7 books with increasing last_accessed timestamps (recent, within MAX_AGE_DAYS)
        let base = chrono::Utc::now();
        for i in 0..7 {
            let ts = base + chrono::Duration::seconds(i as i64);
            create_fake_cache(
                dir,
                &format!("book{i}"),
                &format!("hash{i}"),
                2,
                100,
                &ts.to_rfc3339(),
            );
        }

        let before = collect_cached_books(dir);
        assert_eq!(before.len(), 7);

        // Run eviction — should trim to MAX_CACHED_BOOKS (5)
        run_eviction(dir, DEFAULT_MAX_CACHE_SIZE_MB).unwrap();

        let after = collect_cached_books(dir);
        assert_eq!(after.len(), 5);

        // The two oldest (hash0, hash1) should have been evicted
        assert!(read_manifest(dir, "hash0").is_none());
        assert!(read_manifest(dir, "hash1").is_none());
        // The newest should remain
        assert!(read_manifest(dir, "hash6").is_some());
    }

    #[test]
    fn size_cap_eviction() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // Create 3 books, each 200 MB in manifest (tiny actual files)
        let base = chrono::Utc::now();
        for i in 0..3 {
            let ts = base + chrono::Duration::seconds(i as i64);
            create_fake_cache(
                dir,
                &format!("book{i}"),
                &format!("hash{i}"),
                1,
                200 * 1024 * 1024, // 200 MB
                &ts.to_rfc3339(),
            );
        }

        // Total = 600 MB; cap at 500 MB → should evict the oldest
        run_eviction(dir, 500).unwrap();

        let after = collect_cached_books(dir);
        // Need to remove at least 1 to get under 500 MB (200*2 = 400 < 500)
        assert!(after.len() <= 2);
        assert!(read_manifest(dir, "hash0").is_none());
    }

    #[test]
    fn age_expiry() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // One old book (30 days ago)
        create_fake_cache(dir, "old", "hash_old", 1, 100, "2020-01-01T00:00:00+00:00");

        // One recent book
        let now = now_iso();
        create_fake_cache(dir, "new", "hash_new", 1, 100, &now);

        run_eviction(dir, DEFAULT_MAX_CACHE_SIZE_MB).unwrap();

        assert!(read_manifest(dir, "hash_old").is_none());
        assert!(read_manifest(dir, "hash_new").is_some());
    }

    #[test]
    fn cache_stats_counts_and_sizes() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        create_fake_cache(dir, "a", "hash_a", 3, 1000, "2026-01-01T00:00:00+00:00");
        create_fake_cache(dir, "b", "hash_b", 5, 2000, "2026-01-02T00:00:00+00:00");

        let stats = get_cache_stats(dir);
        assert_eq!(stats.book_count, 2);
        assert_eq!(stats.total_size_bytes, 3000);
        assert_eq!(stats.books.len(), 2);
    }

    #[test]
    fn clear_cache_removes_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        create_fake_cache(dir, "a", "hash_a", 1, 100, "2026-01-01T00:00:00+00:00");
        assert!(cache_root(dir).exists());

        clear_cache(dir).unwrap();
        assert!(!cache_root(dir).exists());
    }

    #[test]
    fn clear_nonexistent_cache_no_error() {
        let tmp = TempDir::new().unwrap();
        // No cache created — clearing should be fine
        assert!(clear_cache(tmp.path()).is_ok());
    }
}
