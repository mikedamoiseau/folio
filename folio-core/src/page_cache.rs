use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::OnceLock;
use zip::ZipArchive;

use crate::error::{FolioError, FolioResult};
use crate::models::BookFormat;
use crate::storage::Storage;

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

/// Top-level key prefix under which every page-cache artifact lives.
/// `{CACHE_PREFIX}{book_hash}/manifest.json` + `{CACHE_PREFIX}{book_hash}/{NNN}.{ext}`.
const CACHE_PREFIX: &str = "page-cache/";

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
// Key helpers
// ---------------------------------------------------------------------------

fn manifest_key(book_hash: &str) -> String {
    format!("{CACHE_PREFIX}{book_hash}/manifest.json")
}

fn page_key(book_hash: &str, page_name: &str) -> String {
    format!("{CACHE_PREFIX}{book_hash}/{page_name}")
}

fn book_prefix(book_hash: &str) -> String {
    format!("{CACHE_PREFIX}{book_hash}/")
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

pub fn read_manifest(storage: &dyn Storage, book_hash: &str) -> Option<CacheManifest> {
    let bytes = storage.get(&manifest_key(book_hash)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_manifest(
    storage: &dyn Storage,
    book_hash: &str,
    manifest: &CacheManifest,
) -> FolioResult<()> {
    let json = serde_json::to_string_pretty(manifest)?;
    storage.put(&manifest_key(book_hash), json.as_bytes())
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
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
) -> FolioResult<CacheManifest> {
    let file = std::fs::File::open(file_path)
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
        storage
            .put(&page_key(book_hash, &page_filename), &data)
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

    write_manifest(storage, book_hash, &manifest)?;
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// CBR extraction
// ---------------------------------------------------------------------------

pub fn extract_cbr(
    storage: &dyn Storage,
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
                    storage
                        .put(&page_key(book_hash, &page_filename), &data)
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

    write_manifest(storage, book_hash, &manifest)?;
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// Cache read & ensure_cached
// ---------------------------------------------------------------------------

pub fn get_cached_page(
    storage: &dyn Storage,
    book_hash: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)> {
    let manifest = read_manifest(storage, book_hash)
        .ok_or_else(|| FolioError::not_found("Cache manifest not found"))?;

    let page_name = manifest.pages.get(page_index as usize).ok_or_else(|| {
        FolioError::not_found(format!(
            "Page index {page_index} out of range (total: {})",
            manifest.page_count
        ))
    })?;

    let data = storage
        .get(&page_key(book_hash, page_name))
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
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    format: &BookFormat,
) -> FolioResult<CacheManifest> {
    if let Some(mut manifest) = read_manifest(storage, book_hash) {
        let first_ok = manifest
            .pages
            .first()
            .and_then(|p| storage.exists(&page_key(book_hash, p)).ok())
            .unwrap_or(false);
        let last_ok = manifest
            .pages
            .last()
            .and_then(|p| storage.exists(&page_key(book_hash, p)).ok())
            .unwrap_or(false);

        if first_ok && last_ok {
            page_dbg!(
                "ensure_cached: cache hit for {} ({} pages)",
                book_hash,
                manifest.page_count
            );
            manifest.last_accessed = now_iso();
            let _ = write_manifest(storage, book_hash, &manifest);
            return Ok(manifest);
        }
        page_dbg!(
            "ensure_cached: cache corrupted for {}, re-extracting",
            book_hash
        );
        let _ = evict_book(storage, book_hash);
    }

    page_dbg!("ensure_cached: extracting {:?} {}", format, book_hash);
    let start = std::time::Instant::now();
    let result = match format {
        BookFormat::Cbz => extract_cbz(storage, book_id, book_hash, file_path),
        BookFormat::Cbr => extract_cbr(storage, book_id, book_hash, file_path),
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

/// Enumerate every `{hash}` directly under `CACHE_PREFIX`, then read each
/// book's manifest. Books whose manifest is missing or corrupt are skipped
/// — they remain as dead keys until `clear_cache` or another eviction pass
/// wipes them, but their absence from this result set means they won't be
/// counted toward LRU / size / age budgets.
fn collect_cached_books(storage: &dyn Storage) -> Vec<CacheManifest> {
    let keys = match storage.list(CACHE_PREFIX) {
        Ok(k) => k,
        Err(_) => return Vec::new(),
    };
    let mut hashes: HashSet<String> = HashSet::new();
    for key in keys {
        if let Some(rest) = key.strip_prefix(CACHE_PREFIX) {
            if let Some(hash) = rest.split('/').next() {
                if !hash.is_empty() {
                    hashes.insert(hash.to_string());
                }
            }
        }
    }
    hashes
        .into_iter()
        .filter_map(|h| read_manifest(storage, &h))
        .collect()
}

fn evict_book(storage: &dyn Storage, book_hash: &str) -> FolioResult<()> {
    let prefix = book_prefix(book_hash);
    let keys = storage
        .list(&prefix)
        .map_err(|e| FolioError::io(format!("Failed to list cache for {book_hash}: {e}")))?;
    for key in keys {
        storage
            .delete(&key)
            .map_err(|e| FolioError::io(format!("Failed to evict cache key '{key}': {e}")))?;
    }
    Ok(())
}

pub fn run_eviction(storage: &dyn Storage, max_size_mb: u64) -> FolioResult<()> {
    let mut books = collect_cached_books(storage);
    books.sort_by(|a, b| a.last_accessed.cmp(&b.last_accessed));

    // Layer 1: LRU by book count
    while books.len() > MAX_CACHED_BOOKS {
        let oldest = &books[0];
        evict_book(storage, &oldest.book_hash)?;
        books.remove(0);
    }

    // Layer 2: Total size cap
    let max_size_bytes = max_size_mb * 1024 * 1024;
    let mut total_size: u64 = books.iter().map(|b| b.total_size_bytes).sum();
    while total_size > max_size_bytes && !books.is_empty() {
        let oldest = &books[0];
        total_size -= oldest.total_size_bytes;
        evict_book(storage, &oldest.book_hash)?;
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
        evict_book(storage, &hash)?;
    }

    Ok(())
}

pub fn get_cache_stats(storage: &dyn Storage) -> CacheStats {
    let books = collect_cached_books(storage);
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

pub fn clear_cache(storage: &dyn Storage) -> FolioResult<()> {
    let keys = storage
        .list(CACHE_PREFIX)
        .map_err(|e| FolioError::io(format!("Failed to list page cache: {e}")))?;
    for key in keys {
        storage
            .delete(&key)
            .map_err(|e| FolioError::io(format!("Failed to delete cache key '{key}': {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::LocalStorage;
    use tempfile::TempDir;

    fn temp_storage() -> (TempDir, LocalStorage) {
        let dir = TempDir::new().unwrap();
        let storage = LocalStorage::new(dir.path()).unwrap();
        (dir, storage)
    }

    /// Helper: create a fake cached book with a manifest and dummy page files.
    fn create_fake_cache(
        storage: &dyn Storage,
        book_id: &str,
        book_hash: &str,
        page_count: u32,
        total_size_bytes: u64,
        last_accessed: &str,
    ) -> CacheManifest {
        let mut pages = Vec::new();
        for i in 0..page_count {
            let name = format!("{:03}.jpg", i);
            storage
                .put(&page_key(book_hash, &name), b"fake image data")
                .unwrap();
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
        write_manifest(storage, book_hash, &manifest).unwrap();
        manifest
    }

    #[test]
    fn manifest_roundtrip() {
        let (_d, storage) = temp_storage();
        let hash = "abc123";

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

        write_manifest(&storage, hash, &manifest).unwrap();
        let loaded = read_manifest(&storage, hash).expect("manifest should be readable");

        assert_eq!(loaded.book_id, "book1");
        assert_eq!(loaded.book_hash, hash);
        assert_eq!(loaded.page_count, 3);
        assert_eq!(loaded.total_size_bytes, 1024);
        assert_eq!(loaded.pages.len(), 3);
    }

    #[test]
    fn read_manifest_missing_returns_none() {
        let (_d, storage) = temp_storage();
        assert!(read_manifest(&storage, "nonexistent").is_none());
    }

    #[test]
    fn lru_count_eviction() {
        let (_d, storage) = temp_storage();

        // Create 7 books with increasing last_accessed timestamps (recent, within MAX_AGE_DAYS)
        let base = chrono::Utc::now();
        for i in 0..7 {
            let ts = base + chrono::Duration::seconds(i as i64);
            create_fake_cache(
                &storage,
                &format!("book{i}"),
                &format!("hash{i}"),
                2,
                100,
                &ts.to_rfc3339(),
            );
        }

        let before = collect_cached_books(&storage);
        assert_eq!(before.len(), 7);

        // Run eviction — should trim to MAX_CACHED_BOOKS (5)
        run_eviction(&storage, DEFAULT_MAX_CACHE_SIZE_MB).unwrap();

        let after = collect_cached_books(&storage);
        assert_eq!(after.len(), 5);

        // The two oldest (hash0, hash1) should have been evicted
        assert!(read_manifest(&storage, "hash0").is_none());
        assert!(read_manifest(&storage, "hash1").is_none());
        // The newest should remain
        assert!(read_manifest(&storage, "hash6").is_some());
    }

    #[test]
    fn size_cap_eviction() {
        let (_d, storage) = temp_storage();

        // Create 3 books, each 200 MB in manifest (tiny actual files)
        let base = chrono::Utc::now();
        for i in 0..3 {
            let ts = base + chrono::Duration::seconds(i as i64);
            create_fake_cache(
                &storage,
                &format!("book{i}"),
                &format!("hash{i}"),
                1,
                200 * 1024 * 1024, // 200 MB
                &ts.to_rfc3339(),
            );
        }

        // Total = 600 MB; cap at 500 MB → should evict the oldest
        run_eviction(&storage, 500).unwrap();

        let after = collect_cached_books(&storage);
        // Need to remove at least 1 to get under 500 MB (200*2 = 400 < 500)
        assert!(after.len() <= 2);
        assert!(read_manifest(&storage, "hash0").is_none());
    }

    #[test]
    fn age_expiry() {
        let (_d, storage) = temp_storage();

        // One old book (well outside MAX_AGE_DAYS)
        create_fake_cache(
            &storage,
            "old",
            "hash_old",
            1,
            100,
            "2020-01-01T00:00:00+00:00",
        );

        // One recent book
        let now = now_iso();
        create_fake_cache(&storage, "new", "hash_new", 1, 100, &now);

        run_eviction(&storage, DEFAULT_MAX_CACHE_SIZE_MB).unwrap();

        assert!(read_manifest(&storage, "hash_old").is_none());
        assert!(read_manifest(&storage, "hash_new").is_some());
    }

    #[test]
    fn cache_stats_counts_and_sizes() {
        let (_d, storage) = temp_storage();

        create_fake_cache(
            &storage,
            "a",
            "hash_a",
            3,
            1000,
            "2026-01-01T00:00:00+00:00",
        );
        create_fake_cache(
            &storage,
            "b",
            "hash_b",
            5,
            2000,
            "2026-01-02T00:00:00+00:00",
        );

        let stats = get_cache_stats(&storage);
        assert_eq!(stats.book_count, 2);
        assert_eq!(stats.total_size_bytes, 3000);
        assert_eq!(stats.books.len(), 2);
    }

    #[test]
    fn clear_cache_removes_all_entries() {
        let (_d, storage) = temp_storage();

        create_fake_cache(&storage, "a", "hash_a", 2, 100, "2026-01-01T00:00:00+00:00");
        assert!(!storage.list(CACHE_PREFIX).unwrap().is_empty());

        clear_cache(&storage).unwrap();
        assert!(storage.list(CACHE_PREFIX).unwrap().is_empty());
    }

    #[test]
    fn clear_nonexistent_cache_no_error() {
        let (_d, storage) = temp_storage();
        // No cache created — clearing should be fine
        assert!(clear_cache(&storage).is_ok());
    }

    // --- New behavior (#64 M5) ---

    #[test]
    fn collect_cached_books_groups_keys_by_hash() {
        // Exercises storage.list()-based enumeration: multiple books, each
        // with a manifest + several pages. collect_cached_books must group
        // all keys under a single `{hash}` into one manifest entry.
        let (_d, storage) = temp_storage();
        let now = now_iso();
        create_fake_cache(&storage, "a", "hash_a", 3, 300, &now);
        create_fake_cache(&storage, "b", "hash_b", 4, 400, &now);
        create_fake_cache(&storage, "c", "hash_c", 1, 100, &now);

        let mut books = collect_cached_books(&storage);
        books.sort_by(|a, b| a.book_hash.cmp(&b.book_hash));

        assert_eq!(books.len(), 3);
        assert_eq!(books[0].book_hash, "hash_a");
        assert_eq!(books[0].page_count, 3);
        assert_eq!(books[1].book_hash, "hash_b");
        assert_eq!(books[1].page_count, 4);
        assert_eq!(books[2].book_hash, "hash_c");
        assert_eq!(books[2].page_count, 1);
    }

    #[test]
    fn evict_book_removes_only_that_books_keys() {
        let (_d, storage) = temp_storage();
        let now = now_iso();
        create_fake_cache(&storage, "a", "hash_a", 2, 100, &now);
        create_fake_cache(&storage, "b", "hash_b", 2, 100, &now);

        evict_book(&storage, "hash_a").unwrap();

        // hash_a gone; hash_b untouched
        assert!(read_manifest(&storage, "hash_a").is_none());
        assert!(read_manifest(&storage, "hash_b").is_some());

        // No stray hash_a keys remain
        let remaining_a = storage.list(&book_prefix("hash_a")).unwrap();
        assert!(remaining_a.is_empty());

        // hash_b still has its manifest + 2 pages
        let remaining_b = storage.list(&book_prefix("hash_b")).unwrap();
        assert_eq!(remaining_b.len(), 3);
    }

    #[test]
    fn get_cached_page_reads_bytes_through_storage() {
        let (_d, storage) = temp_storage();
        let now = now_iso();
        create_fake_cache(&storage, "a", "hash_a", 2, 100, &now);

        let (data, mime) = get_cached_page(&storage, "hash_a", 0).unwrap();
        assert_eq!(data, b"fake image data");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn get_cached_page_out_of_range_errors() {
        let (_d, storage) = temp_storage();
        let now = now_iso();
        create_fake_cache(&storage, "a", "hash_a", 2, 100, &now);

        assert!(get_cached_page(&storage, "hash_a", 99).is_err());
    }

    #[test]
    fn ensure_cached_hit_updates_last_accessed() {
        let (_d, storage) = temp_storage();
        create_fake_cache(&storage, "a", "hash_a", 1, 100, "2020-01-01T00:00:00+00:00");

        // Use Cbz format — with an existing valid manifest, the archive is
        // never touched, so the file_path can be bogus.
        let result = ensure_cached(&storage, "a", "hash_a", "/nope.cbz", &BookFormat::Cbz).unwrap();

        // `last_accessed` got bumped to ~now
        assert_ne!(result.last_accessed, "2020-01-01T00:00:00+00:00");
        // Persisted change is readable
        let reloaded = read_manifest(&storage, "hash_a").unwrap();
        assert_ne!(reloaded.last_accessed, "2020-01-01T00:00:00+00:00");
    }
}
