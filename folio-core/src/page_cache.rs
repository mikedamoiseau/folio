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

fn default_cache_format() -> BookFormat {
    // Legacy comic manifests (pre-PDF-cache) lacked this field.
    // CBZ is a safe default: CBR manifests already carry
    // CBR-specific filenames inside `pages`, so the same comic
    // read path serves both at runtime.
    BookFormat::Cbz
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheManifest {
    pub book_id: String,
    pub book_hash: String,
    pub page_count: u32,
    pub total_size_bytes: u64,
    pub extracted_at: String,
    pub last_accessed: String,
    pub pages: Vec<String>,
    /// Distinguishes comic manifests (dense `pages` populated with
    /// archive entry names) from PDF manifests (empty `pages`,
    /// filenames derived from page index). Defaulted via a named
    /// function so we do not need to declare a global
    /// `Default for BookFormat` impl.
    #[serde(default = "default_cache_format")]
    pub format: BookFormat,
    /// `Some(2400)` for PDF, `None` for comic (which caches archive
    /// bytes as-is and lets the resize helper clamp on read).
    #[serde(default)]
    pub canonical_width: Option<u32>,
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

fn mime_for_page_name(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
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
        format: BookFormat::Cbz,
        canonical_width: None,
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
        format: BookFormat::Cbr,
        canonical_width: None,
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

    let page_name = match manifest.format {
        BookFormat::Pdf => {
            if page_index >= manifest.page_count {
                return Err(FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                )));
            }
            format!("{page_index:03}.jpg")
        }
        _ => manifest
            .pages
            .get(page_index as usize)
            .cloned()
            .ok_or_else(|| {
                FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                ))
            })?,
    };

    let data = storage
        .get(&page_key(book_hash, &page_name))
        .map_err(|e| FolioError::io(format!("Failed to read cached page {page_index}: {e}")))?;

    Ok((data, mime_for_page_name(&page_name).to_string()))
}

pub fn ensure_cached(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    format: &BookFormat,
) -> FolioResult<CacheManifest> {
    // PDF manifests intentionally keep `pages` empty (filenames are
    // derived from the page index), so the comic-style first/last
    // validation below would always report "corrupt" and evict a
    // healthy PDF cache. Delegate to `ensure_pdf_prewarmed`, which
    // has its own format-aware idempotency check.
    if matches!(format, BookFormat::Pdf) {
        return ensure_pdf_prewarmed(storage, book_id, book_hash, file_path, 10);
    }

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
// PDF cache (lazy on-disk render cache)
// ---------------------------------------------------------------------------

/// Lazy cache writes are coalesced into background eviction passes:
/// every `LAZY_EVICTION_BATCH` successful writes fire the caller's
/// `on_batch` hook. The command layer uses this to spawn a background
/// `run_eviction`.
pub const LAZY_EVICTION_BATCH: u32 = 25;

// Global counter rather than per-book — eviction is whole-cache
// anyway, so the trigger cadence does not need to be per-book.
static LAZY_WRITE_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[cfg(test)]
pub fn reset_lazy_eviction_counter_for_tests() {
    LAZY_WRITE_COUNTER.store(0, std::sync::atomic::Ordering::SeqCst);
}

/// Pre-render the first `prewarm.min(page_count)` pages of a PDF and
/// persist a manifest describing the document. The renderer closure is
/// injected so unit tests can stub pdfium out; production callers go
/// through [`ensure_pdf_prewarmed`] (below) which wires
/// [`crate::pdf::get_page_image_bytes`] for them.
///
/// On any disk write failure (or final manifest write failure) the
/// function rolls back partial state via [`evict_book`] and returns
/// the underlying [`FolioError`]; no manifest is persisted in that
/// case. This keeps stray page files out of `collect_cached_books`,
/// which only counts books with a manifest.
pub fn ensure_pdf_prewarmed_with_renderer<F>(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    page_count: u32,
    prewarm: u32,
    render: F,
) -> FolioResult<CacheManifest>
where
    F: Fn(u32) -> FolioResult<(Vec<u8>, String)>,
{
    let prewarm = prewarm.min(page_count);

    if let Some(mut manifest) = read_manifest(storage, book_hash) {
        if manifest.format == BookFormat::Pdf
            && manifest.page_count == page_count
            && (0..prewarm).all(|i| {
                storage
                    .exists(&page_key(book_hash, &format!("{i:03}.jpg")))
                    .unwrap_or(false)
            })
        {
            page_dbg!(
                "ensure_pdf_prewarmed: cache hit for {} ({}/{} pre-warmed)",
                book_hash,
                prewarm,
                page_count
            );
            manifest.last_accessed = now_iso();
            let _ = write_manifest(storage, book_hash, &manifest);
            return Ok(manifest);
        }
    }

    page_dbg!(
        "ensure_pdf_prewarmed: rendering first {} of {} for {}",
        prewarm,
        page_count,
        book_hash
    );
    let start = std::time::Instant::now();

    // Helper: any failure in the loop or the final manifest write
    // leaves the partial output (page files, possibly an old manifest
    // pointing at stale paths) unreferenced from the manifest layer.
    // `collect_cached_books` skips books without a manifest, so those
    // orphans would never be evicted. Roll back explicitly.
    let try_warm = || -> FolioResult<u64> {
        let mut total_size: u64 = 0;
        for i in 0..prewarm {
            let (bytes, _mime) = render(i)?;
            let name = format!("{i:03}.jpg");
            storage.put(&page_key(book_hash, &name), &bytes)?;
            total_size += bytes.len() as u64;
        }
        Ok(total_size)
    };

    let total_size = match try_warm() {
        Ok(s) => s,
        Err(e) => {
            page_dbg!(
                "ensure_pdf_prewarmed: warm failed for {} — rolling back partial cache",
                book_hash
            );
            let _ = evict_book(storage, book_hash);
            return Err(e);
        }
    };

    page_dbg!(
        "ensure_pdf_prewarmed: warmed {} pages ({} KB) in {:?}",
        prewarm,
        total_size / 1024,
        start.elapsed()
    );

    let now = now_iso();
    let manifest = CacheManifest {
        book_id: book_id.to_string(),
        book_hash: book_hash.to_string(),
        page_count,
        total_size_bytes: total_size,
        extracted_at: now.clone(),
        last_accessed: now,
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(crate::pdf::CACHE_CANONICAL_WIDTH),
    };
    if let Err(e) = write_manifest(storage, book_hash, &manifest) {
        let _ = evict_book(storage, book_hash);
        return Err(e);
    }
    Ok(manifest)
}

/// Production entry point: wires [`crate::pdf::get_page_count`] +
/// [`crate::pdf::get_page_image_bytes`] into the generic prewarm above.
pub fn ensure_pdf_prewarmed(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    prewarm: u32,
) -> FolioResult<CacheManifest> {
    let page_count = crate::pdf::get_page_count(file_path)?;
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        let (bytes, mime) = crate::pdf::get_page_image_bytes(
            file_path,
            idx,
            Some(crate::pdf::CACHE_CANONICAL_WIDTH),
        )?;
        Ok((bytes, mime.to_string()))
    };
    ensure_pdf_prewarmed_with_renderer(storage, book_id, book_hash, page_count, prewarm, render)
}

/// Disk-first PDF page lookup. On cache miss, renders via the injected
/// closure, attempts to persist (best-effort), and returns the bytes
/// either way. Manifest must already exist (created by
/// [`ensure_pdf_prewarmed`]); without one, falls back to render-only.
///
/// `on_batch` fires when the lazy-write counter crosses a multiple of
/// [`LAZY_EVICTION_BATCH`] — the command layer wires this to spawn a
/// background eviction.
pub fn get_or_render_pdf_page_with_renderer<F, B>(
    storage: &dyn Storage,
    book_hash: &str,
    page_index: u32,
    render: F,
    on_batch: B,
) -> FolioResult<(Vec<u8>, String)>
where
    F: Fn(u32) -> FolioResult<(Vec<u8>, String)>,
    B: Fn(),
{
    let manifest_opt = read_manifest(storage, book_hash);

    if let Some(ref manifest) = manifest_opt {
        if manifest.format == BookFormat::Pdf {
            // Guard against out-of-range indices before either the
            // disk lookup or the renderer runs. `get_cached_page`
            // returns `NotFound` both for "file missing" and "index
            // >= page_count"; we want the latter to surface to the
            // caller rather than silently fall through to the
            // expensive render + cache path.
            if page_index >= manifest.page_count {
                return Err(FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                )));
            }
            if let Ok((data, mime)) = get_cached_page(storage, book_hash, page_index) {
                return Ok((data, mime));
            }
        }
    }

    let (bytes, mime) = render(page_index)?;

    // Only attempt to cache when a PDF manifest exists; otherwise
    // just return the rendered bytes. Cache writes are best-effort.
    if let Some(mut manifest) = manifest_opt {
        if manifest.format == BookFormat::Pdf {
            let name = format!("{page_index:03}.jpg");
            match storage.put(&page_key(book_hash, &name), &bytes) {
                Ok(()) => {
                    // Only touch last_accessed — `total_size_bytes`
                    // intentionally stays as the warm-time snapshot.
                    // Eviction reads the disk directly via
                    // `book_disk_size_bytes`, so a concurrent lazy
                    // read-modify-write on the field would only ever
                    // cause stats drift, not eviction misbehavior.
                    // Dropping the update kills the lost-increment
                    // race outright.
                    manifest.last_accessed = now_iso();
                    let _ = write_manifest(storage, book_hash, &manifest);

                    let prev =
                        LAZY_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if (prev + 1).is_multiple_of(LAZY_EVICTION_BATCH) {
                        on_batch();
                    }
                }
                Err(e) => {
                    page_dbg!(
                        "lazy cache write failed for {}/{}: {} — serving from memory",
                        book_hash,
                        name,
                        e
                    );
                }
            }
        }
    }

    Ok((bytes, mime))
}

/// Production wrapper: wires [`crate::pdf::get_page_image_bytes`] at
/// the canonical width and forwards the `on_batch` callback unchanged.
pub fn get_or_render_pdf_page_with_eviction<B>(
    storage: &dyn Storage,
    book_hash: &str,
    file_path: &str,
    page_index: u32,
    on_batch: B,
) -> FolioResult<(Vec<u8>, String)>
where
    B: Fn(),
{
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        let (bytes, mime) = crate::pdf::get_page_image_bytes(
            file_path,
            idx,
            Some(crate::pdf::CACHE_CANONICAL_WIDTH),
        )?;
        Ok((bytes, mime.to_string()))
    };
    get_or_render_pdf_page_with_renderer(storage, book_hash, page_index, render, on_batch)
}

/// No-op-eviction variant for callers that do not have a runtime
/// to dispatch the background pass (tests, ad-hoc tooling).
pub fn get_or_render_pdf_page(
    storage: &dyn Storage,
    book_hash: &str,
    file_path: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)> {
    get_or_render_pdf_page_with_eviction(storage, book_hash, file_path, page_index, || {})
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

/// Disk-authoritative size for a single cached book. Sums `storage.size`
/// across every page key under the book's prefix; the manifest JSON
/// is excluded so the number reflects cached payload only (and stays
/// stable across manifest rewrites). Used by `run_eviction` and
/// `get_cache_stats` so a stale `manifest.total_size_bytes` snapshot
/// (which we deliberately do not update on lazy PDF writes to avoid a
/// concurrent read-modify-write race) cannot drift the eviction budget
/// or the Settings stats panel.
fn book_disk_size_bytes(storage: &dyn Storage, book_hash: &str) -> u64 {
    let prefix = book_prefix(book_hash);
    let keys = match storage.list(&prefix) {
        Ok(k) => k,
        Err(_) => return 0,
    };
    keys.into_iter()
        .filter(|k| !k.ends_with("manifest.json"))
        .filter_map(|k| storage.size(&k).ok())
        .sum()
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

    // Layer 2: Total size cap (disk-authoritative — the manifest
    // snapshot is not maintained on lazy PDF writes).
    let max_size_bytes = max_size_mb * 1024 * 1024;
    let mut sizes: Vec<u64> = books
        .iter()
        .map(|b| book_disk_size_bytes(storage, &b.book_hash))
        .collect();
    let mut total_size: u64 = sizes.iter().sum();
    while total_size > max_size_bytes && !books.is_empty() {
        let oldest_size = sizes[0];
        total_size = total_size.saturating_sub(oldest_size);
        evict_book(storage, &books[0].book_hash)?;
        books.remove(0);
        sizes.remove(0);
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
    let book_count = books.len();
    let book_infos: Vec<CacheBookInfo> = books
        .into_iter()
        .map(|b| {
            let size_bytes = book_disk_size_bytes(storage, &b.book_hash);
            CacheBookInfo {
                book_id: b.book_id,
                book_hash: b.book_hash,
                size_bytes,
                page_count: b.page_count,
                last_accessed: b.last_accessed,
            }
        })
        .collect();
    let total_size_bytes: u64 = book_infos.iter().map(|b| b.size_bytes).sum();
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
    /// `total_size_bytes` controls both the manifest field AND the actual
    /// payload written to disk so eviction logic that reads disk-truth
    /// sees the same number as the manifest snapshot. Page payload is
    /// `total_size_bytes / page_count` zero bytes.
    fn create_fake_cache(
        storage: &dyn Storage,
        book_id: &str,
        book_hash: &str,
        page_count: u32,
        total_size_bytes: u64,
        last_accessed: &str,
    ) -> CacheManifest {
        let mut pages = Vec::new();
        let per_page = if page_count == 0 {
            0
        } else {
            total_size_bytes / page_count as u64
        };
        for i in 0..page_count {
            let name = format!("{:03}.jpg", i);
            let payload = vec![0u8; per_page as usize];
            storage.put(&page_key(book_hash, &name), &payload).unwrap();
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
            format: BookFormat::Cbz,
            canonical_width: None,
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
            format: BookFormat::Cbz,
            canonical_width: None,
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

        // Create 3 books, each ~2 MB on disk (real payload — eviction
        // now reads filesystem size directly rather than trusting the
        // manifest field).
        let base = chrono::Utc::now();
        for i in 0..3 {
            let ts = base + chrono::Duration::seconds(i as i64);
            create_fake_cache(
                &storage,
                &format!("book{i}"),
                &format!("hash{i}"),
                1,
                2 * 1024 * 1024, // 2 MB
                &ts.to_rfc3339(),
            );
        }

        // Total ≈ 6 MB; cap at 4 MB → should evict the oldest.
        run_eviction(&storage, 4).unwrap();

        let after = collect_cached_books(&storage);
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

        // create_fake_cache writes payload sized to match the claim
        // (rounded down to per_page = total / page_count). 3 pages
        // for "a" → 333 bytes each = 999 bytes total; 5 pages for "b"
        // → 400 bytes each = 2000 bytes. Stats now read disk-truth.
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
        assert_eq!(stats.books.len(), 2);
        // Disk-truth excludes the manifest. 333*3 + 400*5 = 2999.
        assert_eq!(stats.total_size_bytes, 2999);
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
        // 2 pages × 50 bytes each = 100 bytes total (matches the
        // total_size_bytes claim so disk-truth eviction lines up).
        create_fake_cache(&storage, "a", "hash_a", 2, 100, &now);

        let (data, mime) = get_cached_page(&storage, "hash_a", 0).unwrap();
        assert_eq!(data.len(), 50);
        assert!(data.iter().all(|&b| b == 0));
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

    // ---------------------------------------------------------------------
    // PDF cache tests
    // ---------------------------------------------------------------------

    #[test]
    fn manifest_legacy_comic_loads_without_format_or_canonical_width() {
        let (_d, storage) = temp_storage();
        let hash = "legacy-hash";
        // Hand-craft a manifest JSON missing the new fields, exactly as
        // pre-spec comic manifests on disk.
        let legacy = serde_json::json!({
            "book_id": "legacy",
            "book_hash": hash,
            "page_count": 2,
            "total_size_bytes": 42,
            "extracted_at": "2026-01-01T00:00:00Z",
            "last_accessed": "2026-01-01T00:00:00Z",
            "pages": ["000.jpg", "001.jpg"],
        });
        storage
            .put(&manifest_key(hash), legacy.to_string().as_bytes())
            .unwrap();

        let loaded = read_manifest(&storage, hash).expect("legacy manifest must load");
        assert_eq!(loaded.format, BookFormat::Cbz);
        assert_eq!(loaded.canonical_width, None);
    }

    #[test]
    fn get_cached_page_pdf_derives_filename_from_index() {
        let (_d, storage) = temp_storage();
        let hash = "pdf-hash";

        let manifest = CacheManifest {
            book_id: "b".into(),
            book_hash: hash.into(),
            page_count: 50,
            total_size_bytes: 0,
            extracted_at: now_iso(),
            last_accessed: now_iso(),
            pages: Vec::new(),
            format: BookFormat::Pdf,
            canonical_width: Some(2400),
        };
        write_manifest(&storage, hash, &manifest).unwrap();
        storage
            .put(&page_key(hash, "042.jpg"), b"pdf-page-bytes")
            .unwrap();

        let (bytes, mime) = get_cached_page(&storage, hash, 42).unwrap();
        assert_eq!(bytes, b"pdf-page-bytes");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn get_cached_page_pdf_out_of_range() {
        let (_d, storage) = temp_storage();
        let hash = "pdf-hash";
        let manifest = CacheManifest {
            book_id: "b".into(),
            book_hash: hash.into(),
            page_count: 10,
            total_size_bytes: 0,
            extracted_at: now_iso(),
            last_accessed: now_iso(),
            pages: Vec::new(),
            format: BookFormat::Pdf,
            canonical_width: Some(2400),
        };
        write_manifest(&storage, hash, &manifest).unwrap();

        let err = get_cached_page(&storage, hash, 999).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("out of range"), "got: {msg}");
    }

    #[test]
    fn ensure_pdf_prewarmed_writes_first_n_pages() {
        let (_d, storage) = temp_storage();
        let hash = "warm-hash";

        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
        };

        let manifest = ensure_pdf_prewarmed_with_renderer(
            &storage, "book", hash, /*page_count=*/ 25, /*prewarm=*/ 10, render,
        )
        .unwrap();

        assert_eq!(manifest.format, BookFormat::Pdf);
        assert_eq!(manifest.canonical_width, Some(2400));
        assert!(manifest.pages.is_empty(), "PDF manifests keep pages empty");
        assert_eq!(manifest.page_count, 25);

        for i in 0..10 {
            let key = page_key(hash, &format!("{i:03}.jpg"));
            assert!(storage.exists(&key).unwrap(), "page {i} should be on disk");
        }
        // Pages beyond the prewarm window are not pre-rendered.
        assert!(!storage.exists(&page_key(hash, "010.jpg")).unwrap());
    }

    #[test]
    fn ensure_pdf_prewarmed_is_idempotent() {
        let (_d, storage) = temp_storage();
        let hash = "warm-hash";

        let calls = std::cell::Cell::new(0u32);
        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            calls.set(calls.get() + 1);
            Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
        };

        ensure_pdf_prewarmed_with_renderer(&storage, "book", hash, 25, 5, &render).unwrap();
        let first_calls = calls.get();

        ensure_pdf_prewarmed_with_renderer(&storage, "book", hash, 25, 5, &render).unwrap();
        assert_eq!(
            calls.get(),
            first_calls,
            "second prewarm with cache intact must not re-render"
        );
    }

    #[test]
    fn ensure_pdf_prewarmed_disk_write_failure_aborts_and_rolls_back() {
        use crate::storage::Storage;

        // Custom storage stub that fails the third put(). Uses
        // AtomicU32 instead of Cell so the type is Sync (the Storage
        // trait requires Send + Sync).
        struct FailingStorage {
            inner: LocalStorage,
            fail_after: std::sync::atomic::AtomicU32,
        }
        impl Storage for FailingStorage {
            fn get(&self, k: &str) -> FolioResult<Vec<u8>> {
                self.inner.get(k)
            }
            fn put(&self, k: &str, v: &[u8]) -> FolioResult<()> {
                let n = self.fail_after.load(std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    return Err(FolioError::io("simulated disk failure"));
                }
                self.fail_after
                    .store(n - 1, std::sync::atomic::Ordering::SeqCst);
                self.inner.put(k, v)
            }
            fn delete(&self, k: &str) -> FolioResult<()> {
                self.inner.delete(k)
            }
            fn list(&self, prefix: &str) -> FolioResult<Vec<String>> {
                self.inner.list(prefix)
            }
            fn exists(&self, k: &str) -> FolioResult<bool> {
                self.inner.exists(k)
            }
            fn size(&self, k: &str) -> FolioResult<u64> {
                self.inner.size(k)
            }
            fn local_path(&self, k: &str) -> FolioResult<std::path::PathBuf> {
                self.inner.local_path(k)
            }
        }

        let dir = TempDir::new().unwrap();
        let storage = FailingStorage {
            inner: LocalStorage::new(dir.path()).unwrap(),
            fail_after: std::sync::atomic::AtomicU32::new(3),
        };
        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
        };

        let result = ensure_pdf_prewarmed_with_renderer(&storage, "book", "h", 25, 10, render);
        assert!(result.is_err(), "must surface disk failure");
        assert!(
            read_manifest(&storage, "h").is_none(),
            "manifest must not be persisted on partial failure"
        );
        // Rollback must wipe the partial page files as well — otherwise
        // collect_cached_books cannot count them and eviction can never
        // reclaim the space.
        let remaining_pages: Vec<String> = storage
            .list(&book_prefix("h"))
            .unwrap_or_default()
            .into_iter()
            .filter(|k| !k.ends_with("manifest.json"))
            .collect();
        assert!(
            remaining_pages.is_empty(),
            "partial cache must be rolled back; orphans: {remaining_pages:?}"
        );
    }

    #[test]
    fn get_or_render_pdf_page_disk_hit_skips_renderer() {
        let (_d, storage) = temp_storage();
        let hash = "h";
        let manifest = CacheManifest {
            book_id: "b".into(),
            book_hash: hash.into(),
            page_count: 10,
            total_size_bytes: 0,
            extracted_at: now_iso(),
            last_accessed: now_iso(),
            pages: Vec::new(),
            format: BookFormat::Pdf,
            canonical_width: Some(2400),
        };
        write_manifest(&storage, hash, &manifest).unwrap();
        storage
            .put(&page_key(hash, "003.jpg"), b"cached-bytes")
            .unwrap();

        let render = |_idx: u32| -> FolioResult<(Vec<u8>, String)> {
            panic!("renderer must not be called on cache hit");
        };

        let (bytes, mime) =
            get_or_render_pdf_page_with_renderer(&storage, hash, 3, render, || {}).unwrap();
        assert_eq!(bytes, b"cached-bytes");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn get_or_render_pdf_page_miss_writes_disk_and_updates_manifest() {
        let (_d, storage) = temp_storage();
        let hash = "h";
        let baseline_extracted = "2026-01-01T00:00:00+00:00";
        let manifest = CacheManifest {
            book_id: "b".into(),
            book_hash: hash.into(),
            page_count: 50,
            total_size_bytes: 100,
            extracted_at: baseline_extracted.into(),
            last_accessed: baseline_extracted.into(),
            pages: Vec::new(),
            format: BookFormat::Pdf,
            canonical_width: Some(2400),
        };
        write_manifest(&storage, hash, &manifest).unwrap();

        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()))
        };

        let (bytes, _) =
            get_or_render_pdf_page_with_renderer(&storage, hash, 42, render, || {}).unwrap();
        assert_eq!(bytes, b"p42");

        assert!(storage.exists(&page_key(hash, "042.jpg")).unwrap());
        let updated = read_manifest(&storage, hash).unwrap();
        // total_size_bytes is the warm-time snapshot; lazy writes do
        // NOT update it (would race). Eviction uses disk-truth via
        // `book_disk_size_bytes`. last_accessed is updated so LRU
        // sees the touch.
        assert_eq!(updated.total_size_bytes, 100);
        assert_ne!(updated.last_accessed, baseline_extracted);
        assert!(updated.pages.is_empty(), "PDF manifests keep pages empty");
        // Disk-truth: the new page contributes its bytes.
        assert_eq!(book_disk_size_bytes(&storage, hash), b"p42".len() as u64);
    }

    #[test]
    fn get_or_render_pdf_page_out_of_range_errors_without_rendering() {
        let (_d, storage) = temp_storage();
        let hash = "h";
        write_manifest(
            &storage,
            hash,
            &CacheManifest {
                book_id: "b".into(),
                book_hash: hash.into(),
                page_count: 10,
                total_size_bytes: 0,
                extracted_at: now_iso(),
                last_accessed: now_iso(),
                pages: Vec::new(),
                format: BookFormat::Pdf,
                canonical_width: Some(2400),
            },
        )
        .unwrap();

        let render = |_idx: u32| -> FolioResult<(Vec<u8>, String)> {
            panic!("renderer must not run for out-of-range index");
        };

        let err =
            get_or_render_pdf_page_with_renderer(&storage, hash, 999, render, || {}).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("out of range"), "got: {msg}");
    }

    #[test]
    fn get_or_render_pdf_page_missing_manifest_falls_back_to_render_only() {
        let (_d, storage) = temp_storage();
        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()))
        };

        let (bytes, _) =
            get_or_render_pdf_page_with_renderer(&storage, "nope", 0, render, || {}).unwrap();
        assert_eq!(bytes, b"p0");
        // No manifest → no cache writes.
        assert!(!storage.exists(&page_key("nope", "000.jpg")).unwrap());
    }

    #[test]
    fn get_or_render_pdf_page_swallows_write_failure() {
        use crate::storage::Storage;

        // Storage that fails all puts EXCEPT manifest writes.
        struct PageWriteFails {
            inner: LocalStorage,
        }
        impl Storage for PageWriteFails {
            fn get(&self, k: &str) -> FolioResult<Vec<u8>> {
                self.inner.get(k)
            }
            fn put(&self, k: &str, v: &[u8]) -> FolioResult<()> {
                if k.ends_with("manifest.json") {
                    self.inner.put(k, v)
                } else {
                    Err(FolioError::io("simulated"))
                }
            }
            fn delete(&self, k: &str) -> FolioResult<()> {
                self.inner.delete(k)
            }
            fn list(&self, p: &str) -> FolioResult<Vec<String>> {
                self.inner.list(p)
            }
            fn exists(&self, k: &str) -> FolioResult<bool> {
                self.inner.exists(k)
            }
            fn size(&self, k: &str) -> FolioResult<u64> {
                self.inner.size(k)
            }
            fn local_path(&self, k: &str) -> FolioResult<std::path::PathBuf> {
                self.inner.local_path(k)
            }
        }
        let dir = TempDir::new().unwrap();
        let storage = PageWriteFails {
            inner: LocalStorage::new(dir.path()).unwrap(),
        };
        let hash = "h";
        write_manifest(
            &storage,
            hash,
            &CacheManifest {
                book_id: "b".into(),
                book_hash: hash.into(),
                page_count: 10,
                total_size_bytes: 0,
                extracted_at: now_iso(),
                last_accessed: now_iso(),
                pages: Vec::new(),
                format: BookFormat::Pdf,
                canonical_width: Some(2400),
            },
        )
        .unwrap();

        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()))
        };
        let (bytes, _) =
            get_or_render_pdf_page_with_renderer(&storage, hash, 5, render, || {}).unwrap();
        assert_eq!(bytes, b"p5");
        // Cache write failed silently; manifest size unchanged.
        let m = read_manifest(&storage, hash).unwrap();
        assert_eq!(m.total_size_bytes, 0);
    }

    #[test]
    fn lazy_eviction_callback_fires_every_batch() {
        let (_d, storage) = temp_storage();
        let hash = "h";
        write_manifest(
            &storage,
            hash,
            &CacheManifest {
                book_id: "b".into(),
                book_hash: hash.into(),
                page_count: 200,
                total_size_bytes: 0,
                extracted_at: now_iso(),
                last_accessed: now_iso(),
                pages: Vec::new(),
                format: BookFormat::Pdf,
                canonical_width: Some(2400),
            },
        )
        .unwrap();

        let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
            Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()))
        };
        let calls = std::cell::Cell::new(0u32);
        let on_batch = || calls.set(calls.get() + 1);

        // Reset the global counter so the test is deterministic.
        reset_lazy_eviction_counter_for_tests();

        for i in 0..LAZY_EVICTION_BATCH * 2 {
            get_or_render_pdf_page_with_renderer(&storage, hash, i, &render, &on_batch).unwrap();
        }

        assert_eq!(calls.get(), 2, "callback fires exactly once per batch");
    }

    #[test]
    fn ensure_cached_pdf_does_not_evict_via_comic_validation() {
        // Regression test for the PR review finding: PDF manifests
        // have empty `pages`, so the comic-style first/last validation
        // in `ensure_cached` previously reported every warm PDF as
        // corrupt and called `evict_book` *before* any pdfium I/O.
        // After the fix `ensure_cached` short-circuits to
        // `ensure_pdf_prewarmed`, which only mutates cache state on
        // an actual render/write failure (and rolls back partials).
        //
        // We exercise this without a real pdfium dylib: pass a
        // non-existent path so `ensure_pdf_prewarmed` fails at
        // `get_page_count`. The OLD code would have evicted before
        // that failure surfaced; the NEW code propagates the error
        // with the cache intact.
        let (_d, storage) = temp_storage();
        let hash = "warm-pdf";

        let manifest = CacheManifest {
            book_id: "b".into(),
            book_hash: hash.into(),
            page_count: 25,
            total_size_bytes: 0,
            extracted_at: now_iso(),
            last_accessed: now_iso(),
            pages: Vec::new(),
            format: BookFormat::Pdf,
            canonical_width: Some(2400),
        };
        write_manifest(&storage, hash, &manifest).unwrap();
        // Seed a lazily cached page beyond the prewarm window — the
        // bug would have wiped this via evict_book.
        storage.put(&page_key(hash, "020.jpg"), b"lazy").unwrap();

        let _ = ensure_cached(&storage, "b", hash, "/nonexistent.pdf", &BookFormat::Pdf);

        // Lazy page must survive regardless of whether the PDF
        // open succeeded (it won't in tests without pdfium).
        assert!(
            storage.exists(&page_key(hash, "020.jpg")).unwrap(),
            "ensure_cached must not evict warm PDF state via comic-style validation"
        );
        assert!(
            read_manifest(&storage, hash).is_some(),
            "ensure_cached must not delete the PDF manifest via comic-style validation"
        );
    }
}
