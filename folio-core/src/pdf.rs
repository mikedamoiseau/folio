use base64::Engine;
use pdfium_render::prelude::*;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};

use crate::epub;
use crate::error::{FolioError, FolioResult};
use crate::page_cache;
use crate::storage::Storage;

/// Canonical render width used when populating the on-disk page cache.
/// Wider than typical reading viewports so zoomed-in views can downscale
/// rather than re-render, but small enough that 200-page books stay
/// comfortably inside the shared `page-cache/` budget (≈ 200–500 KB JPEG
/// per page at this width).
pub const CACHE_CANONICAL_WIDTH: u32 = 2400;

// ---- PDF text cache ----

/// Maximum number of books whose extracted text we keep in memory.
const TEXT_CACHE_MAX_BOOKS: usize = 5;

static PDF_TEXT_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ---- Data structures ----

pub struct PdfMeta {
    pub title: String,
    pub author: String,
    pub page_count: u32,
}

// ---- Library path ----

static PDFIUM_LIBRARY_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Called once during app setup to point pdfium at the bundled library.
/// Pass `None` to fall back to the system library search path.
pub fn set_pdfium_library_path(path: Option<PathBuf>) {
    let _ = PDFIUM_LIBRARY_PATH.set(path);
}

/// Check whether pdfium can be loaded. Used at startup so the frontend
/// can disable PDF-related UI when the library is unavailable.
pub fn is_available() -> bool {
    bind_pdfium().is_ok()
}

// ---- Internal helpers ----

fn bind_pdfium() -> FolioResult<Pdfium> {
    let bindings = match PDFIUM_LIBRARY_PATH.get().and_then(|p| p.as_deref()) {
        Some(path) => {
            let path_str = path
                .to_str()
                .ok_or_else(|| FolioError::internal("pdfium path is not valid UTF-8"))?;
            Pdfium::bind_to_library(path_str).map_err(|e| {
                FolioError::internal(format!(
                    "failed to load bundled pdfium from {path_str}: {e}"
                ))
            })?
        }
        None => Pdfium::bind_to_system_library().map_err(|e| {
            FolioError::internal(format!(
                "pdfium library not found: {e}. Install the pdfium shared library and ensure it \
                 is on your library path (e.g. DYLD_LIBRARY_PATH on macOS)."
            ))
        })?,
    };
    Ok(Pdfium::new(bindings))
}

fn filename_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

/// True when `s` is exactly a canonical UUID (`8-4-4-4-12` hex groups).
/// Tools like ImageMagick stamp a bare UUID into the PDF Title; that is
/// never a real book title, so callers fall back to the filename.
fn is_uuid_like(s: &str) -> bool {
    let parts: Vec<&str> = s.trim().split('-').collect();
    let groups = [8usize, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(groups)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// True when `s` looks like a URL. PDF tooling (e.g. ImageMagick) leaks its
/// homepage into the Author field; an author name is never a URL.
fn looks_like_url(s: &str) -> bool {
    let s = s.trim().to_ascii_lowercase();
    s.starts_with("http://") || s.starts_with("https://")
}

fn read_metadata_tag(document: &PdfDocument, tag: PdfDocumentMetadataTagType) -> Option<String> {
    let entry: PdfDocumentMetadataTag = document.metadata().get(tag)?;
    let s = entry.value().to_string();
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---- Public API ----

/// Parse a PDF file and return its title, author, and page count.
pub fn import_pdf(path: &str) -> FolioResult<PdfMeta> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;

    let page_count = document.pages().len() as u32;

    // A bare-UUID Title (common in tool-generated PDFs) is junk — fall back
    // to the filename so the library shows something meaningful.
    let title = read_metadata_tag(&document, PdfDocumentMetadataTagType::Title)
        .filter(|t| !is_uuid_like(t))
        .unwrap_or_else(|| filename_stem(path));

    // A URL is never an author name (e.g. ImageMagick leaks its homepage).
    let author = read_metadata_tag(&document, PdfDocumentMetadataTagType::Author)
        .filter(|a| !looks_like_url(a))
        .unwrap_or_default();

    Ok(PdfMeta {
        title,
        author,
        page_count,
    })
}

/// Return the number of pages in a PDF.
pub fn get_page_count(path: &str) -> FolioResult<u32> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;
    Ok(document.pages().len() as u32)
}

/// Render one PDF page to a base64-encoded JPEG data URI.
///
/// `width` is the target pixel width; height is calculated to preserve aspect ratio.
/// Uses JPEG encoding for fast encode times and small transfer sizes.
pub fn get_page_image(path: &str, page_index: u32, width: u32) -> FolioResult<String> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;

    let pages = document.pages();
    if page_index > u16::MAX as u32 {
        return Err(FolioError::invalid(format!(
            "page index {page_index} exceeds maximum supported ({})",
            u16::MAX
        )));
    }
    let page = pages
        .get(page_index as u16)
        .map_err(|e| FolioError::not_found(format!("page {page_index} not found: {e}")))?;

    let config = PdfRenderConfig::new().set_target_width(width as i32);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| FolioError::internal(format!("render failed: {e}")))?;

    let img = bitmap.as_image();
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 90);
    img.write_with_encoder(encoder)
        .map_err(|e| FolioError::internal(format!("JPEG encode failed: {e}")))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

/// Render one PDF page to raw JPEG bytes + mime type.
/// Avoids the base64 encode/decode round-trip for web serving.
///
/// `target_width` controls the render resolution. When `None`, falls
/// back to [`DEFAULT_RENDER_WIDTH`] (preserves the legacy 1200 px web
/// default). The caller is responsible for clamping to a sensible
/// upper bound (a 10 000 px request will be honored).
pub fn get_page_image_bytes(
    path: &str,
    page_index: u32,
    target_width: Option<u32>,
) -> FolioResult<(Vec<u8>, &'static str)> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;

    let pages = document.pages();
    if page_index > u16::MAX as u32 {
        return Err(FolioError::invalid(format!(
            "page index {page_index} exceeds maximum supported ({})",
            u16::MAX
        )));
    }
    let page = pages
        .get(page_index as u16)
        .map_err(|e| FolioError::not_found(format!("page {page_index} not found: {e}")))?;

    let width = match target_width {
        Some(0) | None => DEFAULT_RENDER_WIDTH,
        Some(w) => w,
    };
    let config = PdfRenderConfig::new().set_target_width(width as i32);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| FolioError::internal(format!("render failed: {e}")))?;

    let img = bitmap.as_image();
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 90);
    img.write_with_encoder(encoder)
        .map_err(|e| FolioError::internal(format!("JPEG encode failed: {e}")))?;

    Ok((jpeg_bytes, "image/jpeg"))
}

/// Default render width when no `target_width` is supplied. Picked to
/// match the historical web-server fallback resolution.
pub const DEFAULT_RENDER_WIDTH: u32 = 1200;

/// Search result from PDF text search — mirrors epub::SearchResult so the
/// frontend can use the same type for both formats.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchResult {
    pub chapter_index: usize, // page index (reuses "chapter_index" for frontend compat)
    pub snippet: String,
    pub match_offset: usize,
}

const MAX_SEARCH_RESULTS: usize = 200;

/// Version tag for [`PdfTextIndex`]'s on-disk format
/// (`page_cache::read_text_index`/`write_text_index`). Bump this when the
/// schema changes incompatibly — a read whose `version` doesn't match is
/// treated as a miss, forcing a clean re-extract, rather than needing a
/// migration.
pub const TEXT_INDEX_VERSION: u32 = 1;

/// Persisted per-book PDF text index (F-4-6): one full-page text string per
/// page, written to `page-cache/{book_hash}/text-index.json` via the
/// `Storage` trait (see `page_cache::write_text_index`/`read_text_index`).
///
/// `pages[i]` is built by concatenating `page.text()?.chars()` in iteration
/// order (see [`extract_all_page_texts`]) — the same offset space used by
/// search's `match_offset` and, in a later milestone, glyph bounds, so
/// downstream consumers can share one char-offset space per page.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextIndex {
    pub version: u32,
    pub page_count: u32,
    pub pages: Vec<String>,
}

/// Extract text from every page of a PDF and return as a Vec (one entry per page).
///
/// Built by iterating `page.text()?.chars()` and concatenating each
/// character's `unicode_char()`, NOT `PdfPageText::all()`. `all()` calls
/// pdfium's bulk `FPDFText_GetBoundedText`, which can inject characters
/// (e.g. synthetic line breaks) that don't correspond 1:1 to the per-char
/// codepoints `chars()` yields — pdfium's own docs note that `len()` (char
/// count) "may differ slightly" from `all().len()`. Search (`match_offset`)
/// and, in a later milestone, glyph bounds both index into this
/// `chars()`-built string, so it must be the single source of truth for
/// page text (see the PDF text epic design doc's "Global Constraints").
fn extract_all_page_texts(path: &str) -> FolioResult<Vec<String>> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;

    let pages = document.pages();
    let page_count = pages.len();
    let mut texts = Vec::with_capacity(page_count as usize);

    for page_idx in 0..page_count {
        let page = pages
            .get(page_idx)
            .map_err(|e| FolioError::not_found(format!("page {page_idx} not found: {e}")))?;
        let text = page.text().map_err(|e| {
            FolioError::internal(format!("failed to extract text from page {page_idx}: {e}"))
        })?;

        let mut page_text = String::new();
        for ch in text.chars().iter() {
            if let Some(c) = ch.unicode_char() {
                page_text.push(c);
            }
        }
        texts.push(page_text);
    }

    Ok(texts)
}

/// Read-only peek at the in-memory `PDF_TEXT_CACHE`, without extracting on miss.
fn peek_cached_page_texts(path: &str) -> FolioResult<Option<Vec<String>>> {
    let cache = PDF_TEXT_CACHE.lock()?;
    Ok(cache.get(path).cloned())
}

/// Populate the in-memory `PDF_TEXT_CACHE` for `path`, evicting the whole
/// cache first if it's at capacity (matches the pre-existing eviction
/// policy in `get_cached_page_texts`).
fn store_cached_page_texts(path: &str, texts: &[String]) -> FolioResult<()> {
    let mut cache = PDF_TEXT_CACHE.lock()?;
    if cache.len() >= TEXT_CACHE_MAX_BOOKS && !cache.contains_key(path) {
        cache.clear();
    }
    cache.insert(path.to_string(), texts.to_vec());
    Ok(())
}

/// Return cached page texts for a PDF, extracting and caching if needed.
/// Memory-only (no disk index) — kept as the simple two-tier path backing
/// [`search_pdf`]. Session-crossing durability goes through
/// [`resolve_page_texts`]/[`search_pdf_with_storage`] instead.
fn get_cached_page_texts(path: &str) -> FolioResult<Vec<String>> {
    if let Some(texts) = peek_cached_page_texts(path)? {
        return Ok(texts);
    }
    let texts = extract_all_page_texts(path)?;
    store_cached_page_texts(path, &texts)?;
    Ok(texts)
}

/// Text resolution order backing [`search_pdf_with_storage`] (F-4-6):
/// in-memory `PDF_TEXT_CACHE` → persisted `text-index.json` (populating the
/// in-memory layer on hit) → `extract` (memory-only). The extractor is
/// injected so tests can stub pdfium out and assert it's never called on a
/// disk-index hit.
///
/// Read-only with respect to disk: this never writes `text-index.json`.
/// Persisting the index is the background build's job alone (`prepare_pdf`
/// in the command layer), which is the single guarded writer — see that
/// function's doc comment for why the search/resolve path must not also
/// write.
fn resolve_page_texts_with_extractor<F>(
    path: &str,
    storage: &dyn Storage,
    book_hash: &str,
    extract: F,
) -> FolioResult<Vec<String>>
where
    F: Fn(&str) -> FolioResult<Vec<String>>,
{
    if let Some(texts) = peek_cached_page_texts(path)? {
        return Ok(texts);
    }

    if let Some(index) = page_cache::read_text_index(storage, book_hash) {
        store_cached_page_texts(path, &index.pages)?;
        return Ok(index.pages);
    }

    let texts = extract(path)?;
    store_cached_page_texts(path, &texts)?;

    Ok(texts)
}

/// Production entry point for [`resolve_page_texts_with_extractor`], wiring
/// [`extract_all_page_texts`] as the extractor.
pub fn resolve_page_texts(
    path: &str,
    storage: &dyn Storage,
    book_hash: &str,
) -> FolioResult<Vec<String>> {
    resolve_page_texts_with_extractor(path, storage, book_hash, extract_all_page_texts)
}

/// Case-insensitive substring search across already-resolved page texts.
/// Pure and pdfium-free — shared by [`search_pdf`] and
/// [`search_pdf_with_storage`], and directly testable with stubbed page text.
fn search_in_texts(page_texts: &[String], query: &str) -> Vec<PdfSearchResult> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    if query_lower.is_empty() {
        return results;
    }

    for (page_idx, text) in page_texts.iter().enumerate() {
        // Case-fold the page text char-by-char while recording, for every
        // char of the LOWERED string, which original char ordinal / byte
        // offset it came from. This is necessary because `to_lowercase()`
        // is not always 1:1: some codepoints expand to multiple chars
        // (İ -> "i̇"), which would otherwise disconnect a match position in
        // the lowered string from the original text's char/byte offsets.
        let mut lowered = String::new();
        let mut lc_to_orig_char: Vec<usize> = Vec::new();
        let mut lc_to_orig_byte: Vec<usize> = Vec::new();
        for (orig_char_idx, (orig_byte, ch)) in text.char_indices().enumerate() {
            for lc in ch.to_lowercase() {
                lowered.push(lc);
                lc_to_orig_char.push(orig_char_idx);
                lc_to_orig_byte.push(orig_byte);
            }
        }

        let mut from = 0usize;
        while let Some(rel) = lowered[from..].find(&query_lower) {
            let mb = from + rel; // byte offset of the match within `lowered`
            let lc_idx = lowered[..mb].chars().count(); // lowered char index
                                                        // The CHAR ordinal into the ORIGINAL text — the shared offset
                                                        // space search, glyph bounds, and highlight anchors all index
                                                        // into.
            let match_offset = lc_to_orig_char[lc_idx];
            let orig_byte = lc_to_orig_byte[lc_idx];
            let end_lc = lc_idx + query_lower.chars().count();
            let end_byte = if end_lc < lc_to_orig_byte.len() {
                lc_to_orig_byte[end_lc]
            } else {
                text.len()
            };
            let snippet =
                epub::extract_snippet(text, orig_byte, end_byte.saturating_sub(orig_byte), 40);
            results.push(PdfSearchResult {
                chapter_index: page_idx,
                snippet,
                match_offset,
            });
            if results.len() >= MAX_SEARCH_RESULTS {
                return results;
            }
            from = mb + query_lower.len();
        }
    }

    results
}

/// Search all pages of a PDF for a query string (case-insensitive).
/// Returns up to MAX_SEARCH_RESULTS matches with surrounding context snippets.
/// Memory-cache only; see [`search_pdf_with_storage`] for the disk-backed,
/// cross-session variant (F-4-6).
pub fn search_pdf(path: &str, query: &str) -> FolioResult<Vec<PdfSearchResult>> {
    let page_texts = get_cached_page_texts(path)?;
    Ok(search_in_texts(&page_texts, query))
}

/// Search all pages of a PDF for a query string (case-insensitive), resolving
/// page text via [`resolve_page_texts`] (memory → disk index → extract).
/// A cold session with a persisted `text-index.json` hits the disk layer
/// instead of re-extracting. Never persists — search is read-only w.r.t.
/// disk; see [`resolve_page_texts_with_extractor`].
pub fn search_pdf_with_storage(
    path: &str,
    query: &str,
    storage: &dyn Storage,
    book_hash: &str,
) -> FolioResult<Vec<PdfSearchResult>> {
    let page_texts = resolve_page_texts(path, storage, book_hash)?;
    Ok(search_in_texts(&page_texts, query))
}

/// Drop the in-memory `PDF_TEXT_CACHE` entry for `path`, if present.
/// Used when a book is removed so a stale in-memory text cache can't
/// resurrect a deleted book's page text (the disk-side
/// `page-cache/{hash}/text-index.json` is cleared separately via
/// [`crate::page_cache::evict_book`]).
pub fn evict_memory_cache(path: &str) {
    if let Ok(mut cache) = PDF_TEXT_CACHE.lock() {
        cache.remove(path);
    }
}

// ---- Glyph bounds (F-1-4, M2) ----

/// One character's normalized bounding rectangle on a single PDF page,
/// returned on demand by [`get_page_glyphs`]. Never persisted to disk —
/// only page TEXT is durable (see [`PdfTextIndex`]); bounds are cheap to
/// recompute and kept in a small in-memory LRU instead.
///
/// `off` is the character's ordinal into the SAME `chars()`-built page
/// text string produced by [`extract_all_page_texts`]/[`PdfTextIndex`] and
/// consumed by search's `match_offset` — the shared offset space required
/// by the epic's "Global Constraints", so a highlight's `start_offset`/
/// `end_offset` line up with the glyph rects that render it.
///
/// `x`/`y`/`w`/`h` are fractions (0..1) of the page's width/height, with
/// `y` measured top-down (screen orientation) even though pdfium's native
/// origin is bottom-left.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Glyph {
    pub off: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Maximum number of `(path, page_index)` pages whose glyph rects are
/// kept in memory at once. Small — the reader only ever needs the
/// currently visible page(s) and maybe an adjacent prefetch.
const GLYPH_CACHE_MAX_PAGES: usize = 4;

/// Key identifying one page's glyph rects in [`GLYPH_CACHE`].
type GlyphCacheKey = (String, usize);

/// One [`GLYPH_CACHE`] entry: the page it belongs to, plus its glyphs.
type GlyphCacheEntry = (GlyphCacheKey, Vec<Glyph>);

/// In-memory-only LRU of recent pages' glyph rects, most-recently-used
/// entry at the front. Never persisted — see [`Glyph`]'s doc comment.
static GLYPH_CACHE: LazyLock<Mutex<VecDeque<GlyphCacheEntry>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

fn glyph_cache_get(path: &str, page_index: usize) -> FolioResult<Option<Vec<Glyph>>> {
    let mut cache = GLYPH_CACHE.lock()?;
    let Some(pos) = cache
        .iter()
        .position(|((p, idx), _)| p == path && *idx == page_index)
    else {
        return Ok(None);
    };
    // Safe: `pos` was just found by `position()` above.
    let entry = cache.remove(pos).expect("position() found this index");
    let value = entry.1.clone();
    cache.push_front(entry);
    Ok(Some(value))
}

fn glyph_cache_put(path: &str, page_index: usize, glyphs: Vec<Glyph>) -> FolioResult<()> {
    let mut cache = GLYPH_CACHE.lock()?;
    cache.retain(|((p, idx), _)| !(p == path && *idx == page_index));
    cache.push_front(((path.to_string(), page_index), glyphs));
    while cache.len() > GLYPH_CACHE_MAX_PAGES {
        cache.pop_back();
    }
    Ok(())
}

/// Normalize one char's `loose_bounds()` (pdfium points, bottom-left
/// origin) into a [`Glyph`] with 0..1 page-fraction coordinates, `y`
/// converted to top-down (screen) orientation. Pure — no pdfium calls —
/// so it's directly unit-testable without a real PDF.
///
/// Tiny negative results from float noise (e.g. a char box that's
/// epsilon past a page edge) are clamped to 0.0.
fn normalize_glyph(
    off: u32,
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
    page_w: f32,
    page_h: f32,
) -> Glyph {
    Glyph {
        off,
        x: (left / page_w).max(0.0),
        y: ((page_h - top) / page_h).max(0.0),
        w: ((right - left) / page_w).max(0.0),
        h: ((top - bottom) / page_h).max(0.0),
    }
}

/// Return normalized, top-down glyph rectangles for one page of a PDF,
/// keyed by `off` — the char ordinal into the SAME `chars()`-built text
/// string as [`extract_all_page_texts`]/[`PdfTextIndex`]/search's
/// `match_offset` (see the epic's offset invariant). Computed on demand;
/// never persisted (see [`Glyph`]'s doc comment). Recent pages are kept
/// in a small in-memory LRU ([`GLYPH_CACHE`]).
///
/// A char whose `unicode_char()` is `None` is skipped entirely — no
/// glyph, no `off` slot — mirroring [`extract_all_page_texts`], which
/// doesn't push it to the page text either. A char whose bounds lookup
/// fails still consumes an `off` slot (pushed as a zero-area glyph) so
/// `off` never desyncs from the text.
pub fn get_page_glyphs(path: &str, page_index: usize) -> FolioResult<Vec<Glyph>> {
    if let Some(glyphs) = glyph_cache_get(path, page_index)? {
        return Ok(glyphs);
    }

    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| FolioError::invalid(format!("failed to open PDF: {e}")))?;

    if page_index > u16::MAX as usize {
        return Err(FolioError::invalid(format!(
            "page index {page_index} exceeds maximum supported ({})",
            u16::MAX
        )));
    }
    let pages = document.pages();
    let page = pages
        .get(page_index as u16)
        .map_err(|e| FolioError::not_found(format!("page {page_index} not found: {e}")))?;

    let page_w = page.width().value;
    let page_h = page.height().value;

    let text = page.text().map_err(|e| {
        FolioError::internal(format!(
            "failed to extract text from page {page_index}: {e}"
        ))
    })?;

    let mut glyphs = Vec::new();
    let mut counter: u32 = 0;
    for ch in text.chars().iter() {
        if ch.unicode_char().is_none() {
            continue;
        }
        let glyph = match ch.loose_bounds() {
            Ok(rect) => normalize_glyph(
                counter,
                rect.left().value,
                rect.bottom().value,
                rect.right().value,
                rect.top().value,
                page_w,
                page_h,
            ),
            Err(_) => Glyph {
                off: counter,
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
        };
        glyphs.push(glyph);
        counter += 1;
    }

    glyph_cache_put(path, page_index, glyphs.clone())?;
    Ok(glyphs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::LocalStorage;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    fn temp_storage() -> (TempDir, LocalStorage) {
        let dir = TempDir::new().unwrap();
        let storage = LocalStorage::new(dir.path()).unwrap();
        (dir, storage)
    }

    /// Pins the offset invariant (epic "Global Constraints"): `match_offset`
    /// must equal the index of the query substring inside the page's
    /// `chars()`-built text string — the same offset space search, and
    /// later glyph bounds, both index into. Uses stubbed page text (no real
    /// pdfium) since `search_in_texts` is pure.
    #[test]
    fn test_page_text_from_chars_matches_search_offset() {
        let pages = vec!["hello world".to_string(), "goodbye cruel world".to_string()];

        let results = search_in_texts(&pages, "world");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].chapter_index, 0);
        assert_eq!(results[0].match_offset, pages[0].find("world").unwrap());
        assert_eq!(results[1].chapter_index, 1);
        assert_eq!(results[1].match_offset, pages[1].find("world").unwrap());
    }

    /// Multibyte text before the match: `match_offset` must be the CHAR
    /// ordinal (é=0, x=1, space=2, n=3), not the byte offset (which would be
    /// 4, since é is 2 bytes in UTF-8).
    #[test]
    fn test_search_match_offset_is_char_ordinal_with_multibyte_prefix() {
        let pages = vec!["éx needle".to_string()];

        let results = search_in_texts(&pages, "needle");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_offset, 3);
    }

    /// Case-folding a Turkish capital dotted I (İ) expands to two chars
    /// ("i̇") under `to_lowercase()`. The lowered-string match position must
    /// still be mapped back to the correct ORIGINAL char ordinal (İ=0, n=1),
    /// not the (larger) lowered-string position.
    #[test]
    fn test_search_match_offset_survives_case_fold_expansion() {
        let pages = vec!["İneedle".to_string()];

        let results = search_in_texts(&pages, "needle");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_offset, 1);
    }

    #[test]
    fn test_search_uses_disk_index_without_extracting() {
        let (_d, storage) = temp_storage();
        let book_hash = "hash-cold-session";
        let index = PdfTextIndex {
            version: TEXT_INDEX_VERSION,
            page_count: 1,
            pages: vec!["needle in a haystack".to_string()],
        };
        page_cache::write_text_index(&storage, book_hash, &index).unwrap();

        let extractor_calls = AtomicUsize::new(0);
        let extractor = |_path: &str| -> FolioResult<Vec<String>> {
            extractor_calls.fetch_add(1, Ordering::SeqCst);
            Err(FolioError::internal("extractor should not be called"))
        };

        let texts = resolve_page_texts_with_extractor(
            "test_search_uses_disk_index_without_extracting.pdf",
            &storage,
            book_hash,
            extractor,
        )
        .expect("should resolve from the disk index");

        let results = search_in_texts(&texts, "needle");

        assert_eq!(
            extractor_calls.load(Ordering::SeqCst),
            0,
            "extractor must not run on a disk-index hit"
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_offset, texts[0].find("needle").unwrap());
    }

    #[test]
    fn filename_stem_normal_path() {
        assert_eq!(filename_stem("/home/user/docs/book.pdf"), "book");
    }

    #[test]
    fn filename_stem_no_extension() {
        assert_eq!(filename_stem("/home/user/docs/readme"), "readme");
    }

    #[test]
    fn filename_stem_multiple_dots() {
        assert_eq!(filename_stem("/path/to/my.great.book.pdf"), "my.great.book");
    }

    #[test]
    fn filename_stem_just_filename() {
        assert_eq!(filename_stem("document.pdf"), "document");
    }

    #[test]
    fn filename_stem_empty_string() {
        // Empty path has no stem — should fall back to "Unknown"
        assert_eq!(filename_stem(""), "Unknown");
    }

    #[test]
    fn is_uuid_like_matches_canonical_uuid() {
        assert!(is_uuid_like("e86d890e-1288-4044-98fd-d0e50be373f9"));
        assert!(is_uuid_like("  742ae232-d411-4c1f-aace-84dedc9a4cb8  "));
    }

    #[test]
    fn is_uuid_like_rejects_real_titles() {
        assert!(!is_uuid_like("Wunderwaffen - T21 - Starjet"));
        assert!(!is_uuid_like("Dune"));
        assert!(!is_uuid_like("")); // empty
        assert!(!is_uuid_like("e86d890e-1288-4044-98fd-d0e50be373f9-extra")); // 6 groups
        assert!(!is_uuid_like("g86d890e-1288-4044-98fd-d0e50be373f9")); // non-hex
    }

    #[test]
    fn looks_like_url_matches_urls() {
        assert!(looks_like_url("https://imagemagick.org"));
        assert!(looks_like_url("HTTP://Example.com"));
        assert!(looks_like_url("  https://x.io "));
    }

    #[test]
    fn looks_like_url_rejects_names() {
        assert!(!looks_like_url("Frank Herbert"));
        assert!(!looks_like_url("O'Reilly"));
        assert!(!looks_like_url(""));
    }

    /// Guards the pdfium bottom-left -> screen top-down conversion: a char
    /// near the visual TOP of the page (high `top`/`bottom` in points, close
    /// to `page_h`) must yield a SMALLER `y` than one near the bottom (low
    /// `top`/`bottom`, close to 0).
    #[test]
    fn test_normalize_glyph_top_down() {
        let page_w = 600.0;
        let page_h = 800.0;

        let top_char = normalize_glyph(0, 50.0, 770.0, 60.0, 790.0, page_w, page_h);
        let bottom_char = normalize_glyph(1, 50.0, 10.0, 60.0, 30.0, page_w, page_h);

        assert!(
            top_char.y < bottom_char.y,
            "top_char.y={} should be < bottom_char.y={}",
            top_char.y,
            bottom_char.y
        );
    }

    #[test]
    fn test_normalize_glyph_within_unit_range() {
        let page_w = 600.0;
        let page_h = 800.0;
        let eps = 1e-4;

        let glyph = normalize_glyph(0, 50.0, 700.0, 80.0, 720.0, page_w, page_h);

        assert!((0.0..=1.0).contains(&glyph.x), "x={}", glyph.x);
        assert!((0.0..=1.0).contains(&glyph.y), "y={}", glyph.y);
        assert!(glyph.x + glyph.w <= 1.0 + eps, "x+w={}", glyph.x + glyph.w);
        assert!(glyph.y + glyph.h <= 1.0 + eps, "y+h={}", glyph.y + glyph.h);
    }

    /// A bogus path can never resolve to a real PDF, so `get_page_glyphs`
    /// must error rather than panic — covers the error-return path without
    /// requiring a real pdfium binary (unavailable in this test
    /// environment; see the M2 report for what this does/doesn't exercise).
    #[test]
    fn test_get_page_glyphs_nonexistent_file_errors() {
        let result = get_page_glyphs("test_get_page_glyphs_nonexistent_file_errors.pdf", 0);
        assert!(result.is_err());
    }
}
