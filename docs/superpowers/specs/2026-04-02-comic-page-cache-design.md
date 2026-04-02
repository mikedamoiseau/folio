# Comic Page Cache — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Scope:** CBZ/CBR disk-based page cache with three-layer eviction

## Problem

Opening a comic page in Folio currently re-opens the archive (ZIP or RAR), re-enumerates all entries, and extracts the full-resolution image on every page request. This causes noticeable delay on page turns, especially for large CBR files where sequential RAR walking is required. PDF already has a memory-based LRU cache; CBZ/CBR have none on the backend.

## Solution: Extract-on-Open with Disk Cache

When a comic is first opened, extract all pages from the archive to a disk cache directory. Subsequent page requests read directly from disk — no archive I/O at all. A three-layer eviction strategy keeps disk usage bounded.

## Cache Architecture

### Location & Structure

Extracted pages live at `{app_cache_dir}/page-cache/{book_hash}/` where `book_hash` is the existing SHA-256 file hash from the `books` table.

```
{app_cache_dir}/page-cache/
  ├── {book_hash_1}/
  │   ├── manifest.json
  │   ├── 000.jpg
  │   ├── 001.png
  │   └── ...
  └── {book_hash_2}/
      └── ...
```

Each book directory contains:
- **manifest.json** — metadata for cache management
- **000.ext, 001.ext, ...** — extracted page images with zero-padded sequential names, preserving original format (JPEG/PNG/WEBP/GIF)

### Manifest Schema

```json
{
  "book_id": "uuid",
  "book_hash": "sha256hex",
  "page_count": 56,
  "total_size_bytes": 48000000,
  "extracted_at": "2026-04-02T10:30:00Z",
  "last_accessed": "2026-04-02T14:15:00Z",
  "pages": ["000.jpg", "001.jpg", "002.png"]
}
```

### Extract-on-Open Flow

1. Reader opens a CBZ/CBR → frontend calls `prepare_comic(book_id)`
2. Backend checks if `{cache_dir}/{book_hash}/manifest.json` exists and is valid
3. **Cache hit**: Update `last_accessed` in manifest to current time, return manifest (page count, ready status)
4. **Cache miss**: Extract all pages from archive to cache dir, write manifest with current time as both `extracted_at` and `last_accessed`, return manifest
5. After extraction completes, run eviction check (non-blocking)
6. Subsequent `get_comic_page()` calls read from disk cache instead of archive

### Fallback

If cache read fails (corrupted file, missing page), fall back to direct archive extraction (current behavior). Log the cache failure for diagnostics.

## Three-Layer Eviction

Eviction runs after each new book extraction. All three layers are applied in order:

### Layer 1: LRU by Book Count

- **Default:** 5 books max
- When a new book is extracted and count exceeds limit, evict the book with the oldest `last_accessed` timestamp
- Internal constant, not user-configurable

### Layer 2: Total Size Cap

- **Default:** 500 MB
- **User-configurable** in Settings > Library
- If total cache size exceeds the cap after extraction, evict books by oldest `last_accessed` until under the limit
- Changing the setting triggers an immediate eviction pass

### Layer 3: Age Expiry

- **Default:** 7 days since last access
- Remove any book extraction where `last_accessed` is older than the threshold
- Internal constant, not user-configurable

### Eviction Order

When multiple books are candidates, always evict the one with the oldest `last_accessed` first.

## Backend Changes

### New Module: `page_cache.rs`

Dedicated module for all cache logic, isolated from format parsers:

- **`ensure_cached(book_id, file_path, book_hash, format) -> Result<CacheManifest>`**
  Main entry point. Checks for existing cache, extracts if missing, updates `last_accessed`, returns manifest.

- **`get_cached_page(book_hash, page_index) -> Result<Vec<u8>>`**
  Reads a single page file from disk cache. Returns raw image bytes (caller encodes to base64 data URI).

- **`run_eviction(max_books, max_size_mb, max_age_days) -> Result<()>`**
  Applies the three-layer eviction. Called after each extraction.

- **`get_cache_stats() -> Result<CacheStats>`**
  Returns total size, book count, per-book breakdown. Used by settings UI.

- **`clear_cache() -> Result<()>`**
  Deletes entire `page-cache/` directory contents. Manual action from settings.

### Changes to `commands.rs`

- **New command: `prepare_comic(book_id)`**
  Called when the reader mounts a CBZ/CBR. Triggers extraction if needed. Returns manifest info (page count, cache status). Frontend uses this to show "Preparing pages..." during extraction.

- **Modified: `get_comic_page(book_id, page_index)`**
  Now checks disk cache first via `page_cache::get_cached_page()`. Falls back to direct archive read on cache miss.

- **New command: `get_cache_stats()`**
  Returns current cache usage for the settings panel.

- **New command: `clear_page_cache()`**
  Wipes the cache directory. Called from settings UI.

### Existing Modules Unchanged

`cbz.rs` and `cbr.rs` extraction logic stays as-is. `page_cache` calls into them for the initial extraction — they don't need to know about caching.

## Frontend Changes

### Reader.tsx

- Call `prepare_comic(book_id)` on mount for CBZ/CBR formats, before loading the first page
- During extraction (cache miss), show "Preparing pages..." in the existing loading state
- Once `prepare_comic` returns, proceed as normal — page loads will be near-instant from cache

### SettingsPanel.tsx — Library Section

- **"Page cache size limit"** dropdown: 250 MB / 500 MB / 1 GB / 2 GB (default: 500 MB)
- **Current usage display**: "Using 312 MB (4 books)" — fetched via `get_cache_stats()`
- **"Clear cache" button** — calls `clear_page_cache()`, refreshes usage display

### Localization

New keys in `en.json` and `fr.json`:
- `settings.pageCacheLimit` / `settings.pageCacheLimitDescription`
- `settings.pageCacheUsage`
- `settings.clearPageCache`
- `reader.preparingPages`

## Performance Expectations

| Scenario | Current | After |
|----------|---------|-------|
| CBZ page turn (cached) | ~50-200ms (archive extract) | ~1-5ms (disk read) |
| CBR page turn (cached) | ~100-500ms (sequential RAR walk) | ~1-5ms (disk read) |
| First open (cache miss) | Same as current per-page | ~2-5s upfront extraction |
| First open (cache hit) | N/A | ~10ms (read manifest) |

## Out of Scope (Future Improvements)

These build on top of the disk cache foundation and are noted for later:

- **Thumbnail strip** — scrollable page preview bar, would generate thumbnails from cached full-res pages
- **Extract-on-demand with prefetch (Approach B)** — if upfront extraction proves too slow for 100+ page comics, switch to extracting only the current page + N ahead with background prefetch
- **Image resizing/compression** — serve pages at screen resolution instead of full-res; switch from base64 data URIs to blob URLs for lower transfer overhead
- **PDF disk cache** — extend `page_cache` module to also cache rendered PDF pages on disk (currently memory-only LRU)
- **Frontend cache tuning** — increase the 10-entry LRU or make it size-aware

## Testing

- Rust unit tests in `page_cache.rs`: extraction, manifest read/write, each eviction layer, cache stats, clear
- Use `tempfile` crate for test cache directories (consistent with existing test patterns)
- Frontend: verify `prepare_comic` is called on mount, loading state shown during extraction
