# Comic Page Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate archive I/O on every comic page turn by extracting all pages to a disk cache on first open, with three-layer eviction to bound disk usage.

**Architecture:** New `page_cache.rs` module handles extraction, caching, and eviction. `commands.rs` gains a `prepare_comic` command called on reader mount and modifies `get_comic_page` to read from cache. Settings UI adds a cache size limit control.

**Tech Stack:** Rust (serde_json for manifests, std::fs for disk I/O), React (invoke IPC), SQLite settings table.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src-tauri/src/page_cache.rs` | All cache logic: extraction, manifest, eviction, stats |
| Create | `src-tauri/tests/page_cache_tests.rs` | Unit tests for cache module |
| Modify | `src-tauri/src/lib.rs` | Register new commands, add `mod page_cache` |
| Modify | `src-tauri/src/commands.rs` | Add `prepare_comic`, `get_cache_stats`, `clear_page_cache`; modify `get_comic_page` |
| Modify | `src/screens/Reader.tsx` | Call `prepare_comic` on mount for CBZ/CBR |
| Modify | `src/components/SettingsPanel.tsx` | Cache size limit dropdown, usage display, clear button |
| Modify | `src/locales/en.json` | New i18n keys for cache settings and preparing state |
| Modify | `src/locales/fr.json` | French translations for same keys |

---

## Task 1: Cache Manifest Types and Disk Helpers

**Files:**
- Create: `src-tauri/src/page_cache.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod page_cache;`)

- [ ] **Step 1: Create `page_cache.rs` with manifest struct and constants**

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_CACHED_BOOKS: usize = 5;
const DEFAULT_MAX_CACHE_SIZE_MB: u64 = 500;
const MAX_AGE_DAYS: u64 = 7;

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

/// Returns the page-cache root directory: `{cache_dir}/page-cache/`
pub fn cache_root(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("page-cache")
}

/// Returns the cache directory for a specific book: `{cache_root}/{book_hash}/`
pub fn book_cache_dir(app_cache_dir: &Path, book_hash: &str) -> PathBuf {
    cache_root(app_cache_dir).join(book_hash)
}

/// Reads the manifest.json from a book's cache directory, if it exists and is valid.
pub fn read_manifest(app_cache_dir: &Path, book_hash: &str) -> Option<CacheManifest> {
    let manifest_path = book_cache_dir(app_cache_dir, book_hash).join("manifest.json");
    let data = fs::read_to_string(&manifest_path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Writes the manifest.json to a book's cache directory.
pub fn write_manifest(app_cache_dir: &Path, book_hash: &str, manifest: &CacheManifest) -> Result<(), String> {
    let dir = book_cache_dir(app_cache_dir, book_hash);
    let manifest_path = dir.join("manifest.json");
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, json).map_err(|e| format!("Failed to write manifest: {e}"))
}

/// Returns the current UTC timestamp as an ISO 8601 string.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
```

- [ ] **Step 2: Register the module in `lib.rs`**

In `src-tauri/src/lib.rs`, add `pub mod page_cache;` alongside the other module declarations (near `pub mod cbz;`, `pub mod cbr;`, etc.).

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/page_cache.rs src-tauri/src/lib.rs
git commit -m "feat(page-cache): add manifest types and disk helpers"
```

---

## Task 2: Extract-on-Open for CBZ

**Files:**
- Modify: `src-tauri/src/page_cache.rs`

- [ ] **Step 1: Write the `extract_cbz` function**

This extracts all pages from a CBZ archive to the cache directory.

```rust
use zip::ZipArchive;
use std::io::Read;

/// File extensions considered images.
fn is_image_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
}

/// Returns the file extension from a filename (lowercase, with dot).
fn file_extension(name: &str) -> &str {
    if let Some(pos) = name.rfind('.') {
        &name[pos..]
    } else {
        ".jpg"
    }
}

/// Extracts all image pages from a CBZ (ZIP) archive into the cache directory.
/// Returns the manifest on success.
pub fn extract_cbz(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
) -> Result<CacheManifest, String> {
    let file = fs::File::open(file_path).map_err(|e| format!("Failed to open CBZ: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid CBZ archive: {e}"))?;

    // Collect and sort image entry names
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

    // Create cache directory
    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let mut pages: Vec<String> = Vec::new();
    let mut total_size: u64 = 0;

    for (idx, name) in image_names.iter().enumerate() {
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("Failed to read entry {name}: {e}"))?;

        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| format!("Failed to extract {name}: {e}"))?;

        let ext = file_extension(name).to_lowercase();
        let page_filename = format!("{:03}{}", idx, ext);
        let page_path = dir.join(&page_filename);

        fs::write(&page_path, &data).map_err(|e| format!("Failed to write page {idx}: {e}"))?;

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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/page_cache.rs
git commit -m "feat(page-cache): add CBZ extraction to disk cache"
```

---

## Task 3: Extract-on-Open for CBR

**Files:**
- Modify: `src-tauri/src/page_cache.rs`

- [ ] **Step 1: Write the `extract_cbr` function**

CBR uses the `unrar` crate which requires sequential reading.

```rust
/// Extracts all image pages from a CBR (RAR) archive into the cache directory.
/// Returns the manifest on success.
pub fn extract_cbr(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
) -> Result<CacheManifest, String> {
    // First pass: collect sorted image names
    let mut image_names: Vec<String> = Vec::new();
    {
        let archive = unrar::Archive::new(file_path)
            .open_for_listing()
            .map_err(|e| format!("Failed to open CBR for listing: {e}"))?;
        for entry in archive {
            let entry = entry.map_err(|e| format!("Failed to read CBR entry: {e}"))?;
            let name = entry.filename.to_string_lossy().to_string();
            if !entry.is_directory() && is_image_ext(&name) {
                image_names.push(name);
            }
        }
    }
    image_names.sort();

    // Create cache directory
    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    // Second pass: extract pages in archive order, write to cache with sorted index
    // Build a map from archive name -> sorted index
    let name_to_idx: std::collections::HashMap<String, usize> = image_names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i))
        .collect();

    let mut pages_data: Vec<(usize, String, u64)> = Vec::new(); // (idx, filename, size)

    let archive = unrar::Archive::new(file_path)
        .open_for_processing()
        .map_err(|e| format!("Failed to open CBR for processing: {e}"))?;

    let mut current = Some(archive);
    while let Some(cursor) = current {
        let header = cursor.read_header();
        match header {
            Ok(header) => {
                let entry_name = header.entry().filename.to_string_lossy().to_string();
                if let Some(&idx) = name_to_idx.get(&entry_name) {
                    let (data, next) = header.read().map_err(|e| format!("Failed to extract CBR entry: {e}"))?;
                    let ext = file_extension(&entry_name).to_lowercase();
                    let page_filename = format!("{:03}{}", idx, ext);
                    let page_path = dir.join(&page_filename);

                    fs::write(&page_path, &data).map_err(|e| format!("Failed to write page {idx}: {e}"))?;
                    pages_data.push((idx, page_filename, data.len() as u64));
                    current = Some(next);
                } else {
                    let next = header.skip().map_err(|e| format!("Failed to skip CBR entry: {e}"))?;
                    current = Some(next);
                }
            }
            Err(_) => {
                current = None;
            }
        }
    }

    // Sort by index to build ordered pages list
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/page_cache.rs
git commit -m "feat(page-cache): add CBR extraction to disk cache"
```

---

## Task 4: Cache Read and `ensure_cached`

**Files:**
- Modify: `src-tauri/src/page_cache.rs`

- [ ] **Step 1: Write `get_cached_page` and `ensure_cached`**

```rust
use crate::models::BookFormat;

/// Reads a cached page image from disk. Returns raw image bytes.
pub fn get_cached_page(app_cache_dir: &Path, book_hash: &str, page_index: u32) -> Result<(Vec<u8>, String), String> {
    let manifest = read_manifest(app_cache_dir, book_hash)
        .ok_or_else(|| "Cache manifest not found".to_string())?;

    let page_name = manifest
        .pages
        .get(page_index as usize)
        .ok_or_else(|| format!("Page index {page_index} out of range (total: {})", manifest.page_count))?;

    let page_path = book_cache_dir(app_cache_dir, book_hash).join(page_name);
    let data = fs::read(&page_path)
        .map_err(|e| format!("Failed to read cached page {page_index}: {e}"))?;

    // Determine MIME type from extension
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

/// Ensures a comic book's pages are cached. Extracts if missing, returns manifest.
/// Updates `last_accessed` on cache hit.
pub fn ensure_cached(
    app_cache_dir: &Path,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    format: &BookFormat,
) -> Result<CacheManifest, String> {
    // Check for existing valid cache
    if let Some(mut manifest) = read_manifest(app_cache_dir, book_hash) {
        // Validate cache is complete (spot-check first and last page files exist)
        let dir = book_cache_dir(app_cache_dir, book_hash);
        let first_ok = manifest.pages.first().is_some_and(|p| dir.join(p).exists());
        let last_ok = manifest.pages.last().is_some_and(|p| dir.join(p).exists());

        if first_ok && last_ok {
            // Cache hit — update last_accessed
            manifest.last_accessed = now_iso();
            let _ = write_manifest(app_cache_dir, book_hash, &manifest);
            return Ok(manifest);
        }
        // Cache corrupted — remove and re-extract
        let _ = fs::remove_dir_all(book_cache_dir(app_cache_dir, book_hash));
    }

    // Cache miss — extract based on format
    match format {
        BookFormat::Cbz => extract_cbz(app_cache_dir, book_id, book_hash, file_path),
        BookFormat::Cbr => extract_cbr(app_cache_dir, book_id, book_hash, file_path),
        _ => Err(format!("Page cache not supported for format: {:?}", format)),
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/page_cache.rs
git commit -m "feat(page-cache): add cache read and ensure_cached entry point"
```

---

## Task 5: Three-Layer Eviction

**Files:**
- Modify: `src-tauri/src/page_cache.rs`

- [ ] **Step 1: Write eviction functions**

```rust
use chrono::{DateTime, Utc, Duration};

/// Collects info about all cached books by reading their manifests.
fn collect_cached_books(app_cache_dir: &Path) -> Vec<CacheManifest> {
    let root = cache_root(app_cache_dir);
    let entries = match fs::read_dir(&root) {
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

/// Removes a cached book's directory entirely.
fn evict_book(app_cache_dir: &Path, book_hash: &str) -> Result<(), String> {
    let dir = book_cache_dir(app_cache_dir, book_hash);
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to evict cache for {book_hash}: {e}"))
}

/// Runs three-layer eviction: LRU count, size cap, age expiry.
/// `max_size_mb` comes from user settings; other limits are constants.
pub fn run_eviction(app_cache_dir: &Path, max_size_mb: u64) -> Result<(), String> {
    let mut books = collect_cached_books(app_cache_dir);

    // Sort by last_accessed ascending (oldest first) for eviction priority
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
    let cutoff = Utc::now() - Duration::days(MAX_AGE_DAYS as i64);
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

/// Returns stats about the current cache contents.
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

/// Clears the entire page cache directory.
pub fn clear_cache(app_cache_dir: &Path) -> Result<(), String> {
    let root = cache_root(app_cache_dir);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("Failed to clear cache: {e}"))?;
    }
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/page_cache.rs
git commit -m "feat(page-cache): add three-layer eviction and cache stats"
```

---

## Task 6: Unit Tests for Page Cache

**Files:**
- Modify: `src-tauri/src/page_cache.rs` (add `#[cfg(test)]` module)

- [ ] **Step 1: Write tests for manifest read/write, eviction, and cache stats**

Add at the bottom of `page_cache.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_fake_cache(cache_dir: &Path, book_hash: &str, book_id: &str, size: u64, last_accessed: &str) {
        let dir = book_cache_dir(cache_dir, book_hash);
        fs::create_dir_all(&dir).unwrap();

        // Write a fake page file with the specified size
        let page_data = vec![0u8; size as usize];
        fs::write(dir.join("000.jpg"), &page_data).unwrap();

        let manifest = CacheManifest {
            book_id: book_id.to_string(),
            book_hash: book_hash.to_string(),
            page_count: 1,
            total_size_bytes: size,
            extracted_at: last_accessed.to_string(),
            last_accessed: last_accessed.to_string(),
            pages: vec!["000.jpg".to_string()],
        };
        write_manifest(cache_dir, book_hash, &manifest).unwrap();
    }

    #[test]
    fn test_manifest_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();
        let hash = "abc123";

        let dir = book_cache_dir(cache_dir, hash);
        fs::create_dir_all(&dir).unwrap();

        let manifest = CacheManifest {
            book_id: "book-1".to_string(),
            book_hash: hash.to_string(),
            page_count: 3,
            total_size_bytes: 1024,
            extracted_at: "2026-04-02T10:00:00Z".to_string(),
            last_accessed: "2026-04-02T10:00:00Z".to_string(),
            pages: vec!["000.jpg".to_string(), "001.png".to_string(), "002.jpg".to_string()],
        };

        write_manifest(cache_dir, hash, &manifest).unwrap();
        let loaded = read_manifest(cache_dir, hash).unwrap();

        assert_eq!(loaded.book_id, "book-1");
        assert_eq!(loaded.page_count, 3);
        assert_eq!(loaded.pages.len(), 3);
        assert_eq!(loaded.pages[1], "001.png");
    }

    #[test]
    fn test_read_manifest_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(read_manifest(tmp.path(), "nonexistent").is_none());
    }

    #[test]
    fn test_eviction_lru_count() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();
        let now = Utc::now();

        // Create 7 cached books (exceeds MAX_CACHED_BOOKS = 5)
        for i in 0..7 {
            let hash = format!("hash{i}");
            let accessed = (now - Duration::hours(7 - i as i64)).to_rfc3339();
            create_fake_cache(cache_dir, &hash, &format!("book-{i}"), 1000, &accessed);
        }

        // Run eviction with generous size cap
        run_eviction(cache_dir, 10000).unwrap();

        // Should have evicted 2 oldest, keeping 5
        let stats = get_cache_stats(cache_dir);
        assert_eq!(stats.book_count, 5);

        // hash0 and hash1 (oldest) should be evicted
        assert!(!book_cache_dir(cache_dir, "hash0").exists());
        assert!(!book_cache_dir(cache_dir, "hash1").exists());
        assert!(book_cache_dir(cache_dir, "hash6").exists());
    }

    #[test]
    fn test_eviction_size_cap() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();
        let now = Utc::now();

        // Create 3 books, each ~200KB
        for i in 0..3 {
            let hash = format!("hash{i}");
            let accessed = (now - Duration::hours(3 - i as i64)).to_rfc3339();
            create_fake_cache(cache_dir, &hash, &format!("book-{i}"), 200 * 1024, &accessed);
        }

        // Total = ~600KB. Set cap to 0 MB (force all eviction via size)
        // Actually set cap very low: 1 MB = 1048576 bytes > 600KB, so all fit
        // Set cap to 0 to force eviction
        let stats_before = get_cache_stats(cache_dir);
        assert_eq!(stats_before.book_count, 3);

        // With 1MB cap, all 3 books (~600KB total) should survive
        run_eviction(cache_dir, 1).unwrap();
        let stats_after = get_cache_stats(cache_dir);
        assert_eq!(stats_after.book_count, 3);

        // Recreate and test with very small cap that forces eviction
        // 400KB cap: need to evict at least 1 book
        let tmp2 = TempDir::new().unwrap();
        let cache_dir2 = tmp2.path();
        for i in 0..3 {
            let hash = format!("hash{i}");
            let accessed = (now - Duration::hours(3 - i as i64)).to_rfc3339();
            create_fake_cache(cache_dir2, &hash, &format!("book-{i}"), 200 * 1024, &accessed);
        }

        // Cap at 0 MB — should evict everything (0 bytes allowed)
        // Since 0 * 1024 * 1024 = 0, total > 0, evict all
        // Actually test with a fractional scenario: total ~600KB, cap ~400KB
        // We can't do fractional MB, so let's use the raw logic:
        // 3 books * 200KB = 600KB. Cap of 1MB = 1048576 > 614400 — all fit.
        // Instead, make books bigger: 200MB each
        let tmp3 = TempDir::new().unwrap();
        let cache_dir3 = tmp3.path();
        for i in 0..3 {
            let hash = format!("hash{i}");
            let accessed = (now - Duration::hours(3 - i as i64)).to_rfc3339();
            // Fake: set manifest size to 200MB but only write 1 byte (size_bytes is what eviction checks)
            let dir = book_cache_dir(cache_dir3, &hash);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("000.jpg"), &[0u8]).unwrap();
            let manifest = CacheManifest {
                book_id: format!("book-{i}"),
                book_hash: hash.clone(),
                page_count: 1,
                total_size_bytes: 200 * 1024 * 1024, // 200MB in manifest
                extracted_at: accessed.clone(),
                last_accessed: accessed,
                pages: vec!["000.jpg".to_string()],
            };
            write_manifest(cache_dir3, &hash, &manifest).unwrap();
        }

        // 3 books * 200MB = 600MB. Cap at 500MB. Should evict oldest (hash0).
        run_eviction(cache_dir3, 500).unwrap();
        let stats3 = get_cache_stats(cache_dir3);
        assert_eq!(stats3.book_count, 2);
        assert!(!book_cache_dir(cache_dir3, "hash0").exists());
    }

    #[test]
    fn test_eviction_age_expiry() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();

        // Create a book last accessed 10 days ago (beyond 7-day limit)
        let old_time = (Utc::now() - Duration::days(10)).to_rfc3339();
        create_fake_cache(cache_dir, "old_hash", "old-book", 1000, &old_time);

        // Create a recent book
        let recent_time = (Utc::now() - Duration::hours(1)).to_rfc3339();
        create_fake_cache(cache_dir, "new_hash", "new-book", 1000, &recent_time);

        run_eviction(cache_dir, 10000).unwrap();

        // Old book evicted, new book kept
        assert!(!book_cache_dir(cache_dir, "old_hash").exists());
        assert!(book_cache_dir(cache_dir, "new_hash").exists());
    }

    #[test]
    fn test_cache_stats() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();

        create_fake_cache(cache_dir, "h1", "b1", 5000, &now_iso());
        create_fake_cache(cache_dir, "h2", "b2", 3000, &now_iso());

        let stats = get_cache_stats(cache_dir);
        assert_eq!(stats.book_count, 2);
        assert_eq!(stats.total_size_bytes, 8000);
        assert_eq!(stats.books.len(), 2);
    }

    #[test]
    fn test_clear_cache() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path();

        create_fake_cache(cache_dir, "h1", "b1", 1000, &now_iso());
        create_fake_cache(cache_dir, "h2", "b2", 1000, &now_iso());

        assert!(cache_root(cache_dir).exists());
        clear_cache(cache_dir).unwrap();
        assert!(!cache_root(cache_dir).exists());
    }

    #[test]
    fn test_clear_cache_nonexistent() {
        let tmp = TempDir::new().unwrap();
        // Clear on empty dir should not error
        clear_cache(tmp.path()).unwrap();
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test page_cache`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/page_cache.rs
git commit -m "test(page-cache): add unit tests for manifest, eviction, stats, clear"
```

---

## Task 7: Wire Up Backend Commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `prepare_comic`, `get_cache_stats_cmd`, `clear_page_cache`; modify `get_comic_page`)
- Modify: `src-tauri/src/lib.rs` (register new commands)

- [ ] **Step 1: Add `prepare_comic` command to `commands.rs`**

Add near the existing `get_comic_page` command (around line 1240):

```rust
#[tauri::command]
pub async fn prepare_comic(
    book_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<page_cache::CacheManifest, String> {
    let conn = state.db_pool.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id).ok_or("Book not found")?;

    let format = &book.format;
    if *format != BookFormat::Cbz && *format != BookFormat::Cbr {
        return Err("prepare_comic only supports CBZ/CBR formats".to_string());
    }

    let file_path = &book.file_path;
    let book_hash = book.file_hash.as_deref().ok_or("Book has no file hash")?;

    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {e}"))?;

    let manifest = page_cache::ensure_cached(&cache_dir, &book_id, book_hash, file_path, format)?;

    // Run eviction in background
    let max_size_mb = db::get_setting(&conn, "page_cache_max_size_mb")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(page_cache::DEFAULT_MAX_CACHE_SIZE_MB);

    let evict_cache_dir = cache_dir.clone();
    std::thread::spawn(move || {
        let _ = page_cache::run_eviction(&evict_cache_dir, max_size_mb);
    });

    Ok(manifest)
}
```

- [ ] **Step 2: Modify `get_comic_page` to use cache**

Replace the body of the existing `get_comic_page` command (around lines 1218-1240) to check cache first:

```rust
#[tauri::command]
pub async fn get_comic_page(
    book_id: String,
    page_index: u32,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let conn = state.db_pool.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id).ok_or("Book not found")?;

    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {e}"))?;

    // Try cache first if book has a hash
    if let Some(ref book_hash) = book.file_hash {
        if let Ok((data, mime)) = page_cache::get_cached_page(&cache_dir, book_hash, page_index) {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
            return Ok(format!("data:{mime};base64,{encoded}"));
        }
    }

    // Fallback to direct archive read
    match book.format {
        BookFormat::Cbz => cbz::get_page_image(&book.file_path, page_index),
        BookFormat::Cbr => cbr::get_page_image(&book.file_path, page_index),
        _ => Err("Not a comic format".to_string()),
    }
}
```

Note: The existing `get_comic_page` does not have `app_handle` as a parameter. Adding it requires updating the function signature. Tauri will inject it automatically.

- [ ] **Step 3: Add `get_cache_stats_cmd` and `clear_page_cache` commands**

```rust
#[tauri::command]
pub async fn get_cache_stats(
    app_handle: tauri::AppHandle,
) -> Result<page_cache::CacheStats, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {e}"))?;

    Ok(page_cache::get_cache_stats(&cache_dir))
}

#[tauri::command]
pub async fn clear_page_cache(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {e}"))?;

    page_cache::clear_cache(&cache_dir)
}
```

- [ ] **Step 4: Register new commands in `lib.rs`**

In the `invoke_handler` macro call (around line 160), add the three new commands:

```rust
commands::prepare_comic,
commands::get_cache_stats,
commands::clear_page_cache,
```

- [ ] **Step 5: Make `DEFAULT_MAX_CACHE_SIZE_MB` public**

In `page_cache.rs`, change:
```rust
const DEFAULT_MAX_CACHE_SIZE_MB: u64 = 500;
```
to:
```rust
pub const DEFAULT_MAX_CACHE_SIZE_MB: u64 = 500;
```

- [ ] **Step 6: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 7: Run all tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass (existing + page_cache tests).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/page_cache.rs
git commit -m "feat(page-cache): wire up prepare_comic, get_cache_stats, clear_page_cache commands"
```

---

## Task 8: Frontend — Call `prepare_comic` on Reader Mount

**Files:**
- Modify: `src/screens/Reader.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add i18n keys**

In `src/locales/en.json`, add to the `"reader"` section:

```json
"preparingPages": "Preparing pages...",
"preparingPagesDetail": "Extracting pages for faster reading"
```

In `src/locales/fr.json`, add to the `"reader"` section:

```json
"preparingPages": "Pr\u00e9paration des pages...",
"preparingPagesDetail": "Extraction des pages pour une lecture plus rapide"
```

- [ ] **Step 2: Add `prepare_comic` call in Reader.tsx**

In the main book-loading useEffect (around line 137), add a `prepare_comic` call before the page count fetch for CBZ/CBR formats. Find the block that starts with `if (bookInfo.format !== "epub")` and modify it:

```typescript
if (bookInfo.format === "cbz" || bookInfo.format === "cbr") {
  try {
    await invoke("prepare_comic", { bookId });
  } catch (e) {
    console.warn("Cache preparation failed, falling back to direct read:", e);
  }
}

if (bookInfo.format !== "epub") {
  try {
    const command =
      bookInfo.format === "pdf"
        ? "get_pdf_page_count"
        : "get_comic_page_count";
    const count = await invoke<number>(command, { bookId });
    if (!cancelled) setPageCount(count);
  } catch {
    // page count unavailable
  }
}
```

The existing loading state (`loading === true` renders the loading indicator) naturally covers the extraction delay — no additional UI changes needed since the reader already shows a loading state while initializing.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Reader.tsx src/locales/en.json src/locales/fr.json
git commit -m "feat(page-cache): call prepare_comic on reader mount for CBZ/CBR"
```

---

## Task 9: Settings UI — Cache Size Limit and Management

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add i18n keys**

In `src/locales/en.json`, add to the `"settings"` section:

```json
"pageCacheSection": "Page Cache",
"pageCacheLimit": "Cache size limit",
"pageCacheLimitHelp": "Maximum disk space for cached comic pages. Older books are evicted when the limit is exceeded.",
"pageCacheUsage": "Using {{size}} ({{count}} books)",
"pageCacheUsageEmpty": "Cache is empty",
"clearPageCache": "Clear cache",
"clearPageCacheConfirm": "Cache cleared"
```

In `src/locales/fr.json`, add to the `"settings"` section:

```json
"pageCacheSection": "Cache des pages",
"pageCacheLimit": "Limite de taille du cache",
"pageCacheLimitHelp": "Espace disque maximal pour les pages de BD en cache. Les livres les plus anciens sont supprim\u00e9s lorsque la limite est d\u00e9pass\u00e9e.",
"pageCacheUsage": "Utilisation : {{size}} ({{count}} livres)",
"pageCacheUsageEmpty": "Le cache est vide",
"clearPageCache": "Vider le cache",
"clearPageCacheConfirm": "Cache vid\u00e9"
```

- [ ] **Step 2: Add cache settings state and loaders to SettingsPanel.tsx**

Add state variables near the existing library state (around line 273):

```typescript
const [pageCacheLimit, setPageCacheLimit] = useState("500");
const [cacheStats, setCacheStats] = useState<{
  total_size_bytes: number;
  book_count: number;
} | null>(null);
```

Add a loader function near `loadLibraryFolder` (around line 392):

```typescript
const loadCacheInfo = useCallback(async () => {
  try {
    const limit = await invoke<string | null>("get_setting", {
      key: "page_cache_max_size_mb",
    });
    if (limit) setPageCacheLimit(limit);

    const stats = await invoke<{ total_size_bytes: number; book_count: number }>(
      "get_cache_stats"
    );
    setCacheStats(stats);
  } catch {
    // Cache stats unavailable
  }
}, []);
```

Call `loadCacheInfo()` in the existing useEffect that loads settings on mount.

- [ ] **Step 3: Add cache size limit handler**

```typescript
const handleCacheLimitChange = useCallback(
  async (value: string) => {
    setPageCacheLimit(value);
    try {
      await invoke("set_setting", {
        key: "page_cache_max_size_mb",
        value,
      });
    } catch {
      // Setting save failed
    }
  },
  []
);

const handleClearCache = useCallback(async () => {
  try {
    await invoke("clear_page_cache");
    setCacheStats({ total_size_bytes: 0, book_count: 0 });
  } catch {
    // Clear failed
  }
}, []);
```

- [ ] **Step 4: Add cache UI to the Library accordion section**

Inside the Library accordion (around line 1121), after the existing import mode toggle, add:

```tsx
{/* Page Cache */}
<div className="border-t border-border pt-3 mt-3">
  <h4 className="text-sm font-medium text-foreground mb-2">
    {t("settings.pageCacheSection")}
  </h4>

  <label className="block text-sm text-muted mb-1">
    {t("settings.pageCacheLimit")}
  </label>
  <select
    value={pageCacheLimit}
    onChange={(e) => handleCacheLimitChange(e.target.value)}
    className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
  >
    <option value="250">250 MB</option>
    <option value="500">500 MB</option>
    <option value="1024">1 GB</option>
    <option value="2048">2 GB</option>
  </select>
  <p className="text-xs text-muted mt-1">
    {t("settings.pageCacheLimitHelp")}
  </p>

  <div className="mt-2 text-sm text-muted">
    {cacheStats && cacheStats.book_count > 0
      ? t("settings.pageCacheUsage", {
          size:
            cacheStats.total_size_bytes < 1024 * 1024
              ? `${Math.round(cacheStats.total_size_bytes / 1024)} KB`
              : `${Math.round(cacheStats.total_size_bytes / (1024 * 1024))} MB`,
          count: cacheStats.book_count,
        })
      : t("settings.pageCacheUsageEmpty")}
  </div>

  {cacheStats && cacheStats.book_count > 0 && (
    <button
      onClick={handleClearCache}
      className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface transition-colors"
    >
      {t("settings.clearPageCache")}
    </button>
  )}
</div>
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx src/locales/en.json src/locales/fr.json
git commit -m "feat(page-cache): add cache size limit setting and usage display"
```

---

## Task 10: Clippy, Fmt, Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run Rust formatting check**

Run: `cd src-tauri && cargo fmt --check`
Expected: No formatting issues. If there are, run `cargo fmt` to fix.

- [ ] **Step 2: Run Clippy**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: No warnings.

- [ ] **Step 3: Run all Rust tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 4: Run frontend type check**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Run frontend tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 6: Fix any issues found, then commit fixes if needed**

```bash
git add -A
git commit -m "fix: address clippy/fmt/test issues from page cache implementation"
```

---

## Task 11: Update Roadmap

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Mark feature 62 as Done**

In `docs/ROADMAP.md`, change `#### 62. Comic Page Cache (CBZ/CBR Performance)` to `#### 62. Comic Page Cache (CBZ/CBR Performance) — **Done**` and strikethrough completed items (the first 5 bullets). Keep the "Future:" items unstrikethrough.

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: mark comic page cache as done in roadmap"
```
