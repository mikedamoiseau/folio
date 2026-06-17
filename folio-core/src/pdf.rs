use base64::Engine;
use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};

use crate::epub;
use crate::error::{FolioError, FolioResult};

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

/// Extract text from every page of a PDF and return as a Vec (one entry per page).
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
        let text = page
            .text()
            .map_err(|e| {
                FolioError::internal(format!("failed to extract text from page {page_idx}: {e}"))
            })?
            .all();
        texts.push(text);
    }

    Ok(texts)
}

/// Return cached page texts for a PDF, extracting and caching if needed.
fn get_cached_page_texts(path: &str) -> FolioResult<Vec<String>> {
    {
        let cache = PDF_TEXT_CACHE.lock()?;

        if let Some(texts) = cache.get(path) {
            return Ok(texts.clone());
        }
    }

    // Extract text without holding the lock (I/O-heavy).
    let texts = extract_all_page_texts(path)?;

    {
        let mut cache = PDF_TEXT_CACHE.lock()?;

        // Evict all entries if the cache is at capacity.
        if cache.len() >= TEXT_CACHE_MAX_BOOKS && !cache.contains_key(path) {
            cache.clear();
        }

        cache.insert(path.to_string(), texts.clone());
    }

    Ok(texts)
}

/// Search all pages of a PDF for a query string (case-insensitive).
/// Returns up to MAX_SEARCH_RESULTS matches with surrounding context snippets.
pub fn search_pdf(path: &str, query: &str) -> FolioResult<Vec<PdfSearchResult>> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let page_texts = get_cached_page_texts(path)?;

    for (page_idx, text) in page_texts.iter().enumerate() {
        let text_lower = text.to_lowercase();
        let mut search_from = 0;

        while let Some(pos) = text_lower[search_from..].find(&query_lower) {
            let match_start = search_from + pos;
            results.push(PdfSearchResult {
                chapter_index: page_idx,
                snippet: epub::extract_snippet(text, match_start, query_lower.len(), 40),
                match_offset: match_start,
            });
            if results.len() >= MAX_SEARCH_RESULTS {
                return Ok(results);
            }
            search_from = match_start + query_lower.len();
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
