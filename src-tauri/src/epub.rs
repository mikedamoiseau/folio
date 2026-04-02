use ammonia::clean;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

// ---- Error type ----

#[derive(Debug)]
pub enum EpubError {
    InvalidFormat(String),
    MissingFile(String),
    ParseError(String),
    Io(std::io::Error),
}

impl std::fmt::Display for EpubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EpubError::InvalidFormat(msg) => write!(f, "Invalid EPUB format: {msg}"),
            EpubError::MissingFile(path) => write!(f, "Missing file in EPUB: {path}"),
            EpubError::ParseError(msg) => write!(f, "Parse error: {msg}"),
            EpubError::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl From<std::io::Error> for EpubError {
    fn from(e: std::io::Error) -> Self {
        EpubError::Io(e)
    }
}

impl From<zip::result::ZipError> for EpubError {
    fn from(e: zip::result::ZipError) -> Self {
        EpubError::InvalidFormat(e.to_string())
    }
}

// ---- Data structures ----

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BookMetadata {
    pub title: String,
    pub author: String,
    pub language: String,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub genres: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChapterInfo {
    pub index: usize,
    pub title: String,
    pub href: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TocEntry {
    pub label: String,
    pub chapter_index: usize,
    pub children: Vec<TocEntry>,
}

// ---- Cached archive ----

/// Holds an opened EPUB zip archive together with pre-parsed OPF metadata
/// so that consecutive calls (e.g. page turns) do not re-open the file.
pub struct CachedEpubArchive {
    archive: ZipArchive<std::fs::File>,
    #[allow(dead_code)]
    opf: String,
    base_dir: String,
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<String>,
}

// ZipArchive<File> is not Send by default, but we protect access with a std::sync::Mutex
// in AppState so this is safe.
unsafe impl Send for CachedEpubArchive {}

/// Maximum number of entries allowed in an EPUB/CBZ archive.
pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;
/// Maximum decompressed size per archive entry (100 MB).
pub const MAX_ENTRY_SIZE: u64 = 100 * 1024 * 1024;

/// Validate archive bounds: entry count and per-entry decompressed size.
///
/// Defense-in-depth strategy:
///
/// 1. **Pre-filter (this function):** Reject archives whose central directory claims any
///    single entry exceeds `MAX_ENTRY_SIZE` (100 MB). This is a fast O(n) scan over
///    metadata and catches honest or accidental oversized files without decompressing.
///
/// 2. **Runtime protection (zip crate internals):** When entries are actually read via
///    `ZipFile::read()`, the zip crate validates that decompressed output matches the
///    declared size. A malicious archive that lies in its headers will trigger an error
///    during decompression, not silently produce oversized output.
///
/// We use `by_index()` rather than `by_index_raw()` so that sizes are read from the
/// central directory (which the zip crate cross-checks against local headers) instead
/// of only from local file headers, which are easier to forge.
///
/// Full decompression validation at import time is intentionally avoided — it would be
/// prohibitively slow for large archives with many entries.
pub fn validate_archive(archive: &mut ZipArchive<std::fs::File>) -> Result<(), EpubError> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(EpubError::MissingFile(format!(
            "Archive has {} entries (maximum {})",
            archive.len(),
            MAX_ARCHIVE_ENTRIES
        )));
    }
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if entry.size() > MAX_ENTRY_SIZE {
                return Err(EpubError::MissingFile(format!(
                    "Archive entry '{}' decompressed size ({} MB) exceeds limit ({} MB)",
                    entry.name(),
                    entry.size() / (1024 * 1024),
                    MAX_ENTRY_SIZE / (1024 * 1024)
                )));
            }
        }
    }
    Ok(())
}

impl CachedEpubArchive {
    pub fn open(file_path: &str) -> Result<Self, EpubError> {
        let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
        let mut archive = ZipArchive::new(file)?;
        validate_archive(&mut archive)?;
        let opf_path = find_opf_path(&mut archive)?;
        let opf = read_zip_entry(&mut archive, &opf_path)?;
        let base_dir = opf_base_dir(&opf_path).to_string();
        let manifest = parse_manifest(&opf);
        let spine = parse_spine_idrefs(&opf);
        Ok(Self {
            archive,
            opf,
            base_dir,
            manifest,
            spine,
        })
    }
}

// ---- Internal manifest item ----

#[derive(Debug, Clone)]
struct ManifestItem {
    href: String,
    properties: Option<String>,
}

// ---- Internal helpers ----

/// Read a file from a zip archive by name (case-insensitive path matching).
fn read_zip_entry(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
) -> Result<String, EpubError> {
    // Try exact match first
    if let Ok(mut entry) = archive.by_name(name) {
        let mut buf = String::new();
        entry.read_to_string(&mut buf).map_err(EpubError::Io)?;
        return Ok(buf);
    }
    // Try case-insensitive match
    let lower = name.to_lowercase();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name().to_lowercase() == lower {
            let mut buf = String::new();
            entry.read_to_string(&mut buf).map_err(EpubError::Io)?;
            return Ok(buf);
        }
    }
    Err(EpubError::MissingFile(name.to_string()))
}

/// Read a file from a zip archive by name as raw bytes.
fn read_zip_entry_bytes(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Vec<u8>, EpubError> {
    if let Ok(mut entry) = archive.by_name(name) {
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(EpubError::Io)?;
        return Ok(buf);
    }
    let lower = name.to_lowercase();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name().to_lowercase() == lower {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(EpubError::Io)?;
            return Ok(buf);
        }
    }
    Err(EpubError::MissingFile(name.to_string()))
}

/// Parse META-INF/container.xml to find the OPF path.
/// Uses quick-xml so multi-line attribute formatting is handled correctly.
fn find_opf_path(archive: &mut ZipArchive<std::fs::File>) -> Result<String, EpubError> {
    let container = read_zip_entry(archive, "META-INF/container.xml")?;
    let mut reader = Reader::from_str(&container);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if e.local_name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            return Ok(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(EpubError::ParseError(e.to_string())),
            _ => {}
        }
        buf.clear();
    }
    Err(EpubError::InvalidFormat(
        "Cannot find OPF path in container.xml".to_string(),
    ))
}

/// Given OPF path, return the base directory (for resolving relative hrefs).
fn opf_base_dir(opf_path: &str) -> &str {
    if let Some(pos) = opf_path.rfind('/') {
        &opf_path[..pos + 1]
    } else {
        ""
    }
}

/// Extract text content between XML tags (minimal parser for metadata elements).
pub fn extract_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start_tag = xml.find(&open)?;
    let after_open = &xml[start_tag..];
    let content_start = after_open.find('>')? + 1;
    let content = &after_open[content_start..];
    let end = content.find(&close)?;
    Some(content[..end].trim())
}

/// Extract all occurrences of a tag's text content.
fn extract_all_tag_texts(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut results = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        rest = &rest[start..];
        if let Some(content_start) = rest.find('>') {
            let after = &rest[content_start + 1..];
            if let Some(end) = after.find(&close) {
                results.push(after[..end].trim().to_string());
                rest = &after[end + close.len()..];
            } else {
                break;
            }
        } else {
            break;
        }
    }
    results
}

/// Parse manifest items (id → ManifestItem) from OPF XML using quick-xml.
/// Captures href and properties attributes to enable nav/cover detection.
fn parse_manifest(opf: &str) -> HashMap<String, ManifestItem> {
    let mut manifest = HashMap::new();
    let mut reader = Reader::from_str(opf);
    let mut buf = Vec::new();
    let mut in_manifest = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"manifest" {
                    in_manifest = true;
                } else if in_manifest && local.as_ref() == b"item" {
                    let mut id: Option<String> = None;
                    let mut href: Option<String> = None;
                    let mut properties: Option<String> = None;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"id" => id = Some(String::from_utf8_lossy(&attr.value).into_owned()),
                            b"href" => {
                                href = Some(String::from_utf8_lossy(&attr.value).into_owned())
                            }
                            b"properties" => {
                                properties = Some(String::from_utf8_lossy(&attr.value).into_owned())
                            }
                            _ => {}
                        }
                    }
                    if let (Some(id), Some(href)) = (id, href) {
                        manifest.insert(id, ManifestItem { href, properties });
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"manifest" {
                    in_manifest = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    manifest
}

/// Parse spine items (idref list) from OPF XML using quick-xml.
fn parse_spine_idrefs(opf: &str) -> Vec<String> {
    let mut idrefs = Vec::new();
    let mut reader = Reader::from_str(opf);
    let mut buf = Vec::new();
    let mut in_spine = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"spine" {
                    in_spine = true;
                } else if in_spine && local.as_ref() == b"itemref" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"idref" {
                            idrefs.push(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    idrefs
}

/// Find the cover-meta id from EPUB 2 OPF (<meta name="cover" content="id"/>).
fn find_cover_meta_id(opf: &str) -> Option<String> {
    let mut reader = Reader::from_str(opf);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if e.local_name().as_ref() == b"meta" {
                    let mut name: Option<String> = None;
                    let mut content: Option<String> = None;
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"name" => {
                                name = Some(String::from_utf8_lossy(&attr.value).into_owned())
                            }
                            b"content" => {
                                content = Some(String::from_utf8_lossy(&attr.value).into_owned())
                            }
                            _ => {}
                        }
                    }
                    if name.as_deref() == Some("cover") {
                        return content;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

/// Find the cover image href from OPF (EPUB 2 and 3).
fn find_cover_href(opf: &str) -> Option<String> {
    let manifest = parse_manifest(opf);

    // EPUB 3: item with properties="cover-image"
    for item in manifest.values() {
        if let Some(ref props) = item.properties {
            if props.split_whitespace().any(|p| p == "cover-image") {
                return Some(item.href.clone());
            }
        }
    }

    // EPUB 2: <meta name="cover" content="cover-id"/>
    let cover_id = find_cover_meta_id(opf)?;
    manifest.get(&cover_id).map(|item| item.href.clone())
}

/// Find all zip entry names that match a given href prefix (handles path normalization).
fn find_zip_entry_name(
    archive: &mut ZipArchive<std::fs::File>,
    base_dir: &str,
    href: &str,
) -> Option<String> {
    let candidate = format!("{base_dir}{href}");
    // Strip query/fragment from href
    let clean_href = href.split('#').next().unwrap_or(href);
    let clean_candidate = format!("{base_dir}{clean_href}");
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i) {
            let name = entry.name().to_string();
            if name == candidate
                || name == clean_candidate
                || name.to_lowercase() == clean_candidate.to_lowercase()
            {
                return Some(name);
            }
        }
    }
    None
}

// ---- Public API ----

/// Parse metadata from an already-opened EPUB zip archive.
pub fn parse_epub_metadata_from_archive(
    archive: &mut ZipArchive<std::fs::File>,
) -> Result<BookMetadata, EpubError> {
    let opf_path = find_opf_path(archive)?;
    let opf = read_zip_entry(archive, &opf_path)?;

    let title = extract_tag_text(&opf, "dc:title")
        .or_else(|| extract_tag_text(&opf, "title"))
        .unwrap_or("Unknown Title")
        .to_string();

    let author = extract_all_tag_texts(&opf, "dc:creator")
        .into_iter()
        .next()
        .or_else(|| extract_tag_text(&opf, "creator").map(|s| s.to_string()))
        .unwrap_or_else(|| "Unknown Author".to_string());

    let language = extract_tag_text(&opf, "dc:language")
        .or_else(|| extract_tag_text(&opf, "language"))
        .unwrap_or("en")
        .to_string();

    let description = extract_tag_text(&opf, "dc:description")
        .or_else(|| extract_tag_text(&opf, "description"))
        .map(|s| s.to_string());

    let isbn = extract_all_tag_texts(&opf, "dc:identifier")
        .iter()
        .chain(extract_all_tag_texts(&opf, "identifier").iter())
        .find_map(|id| crate::enrichment::extract_isbn(id));

    let genres = {
        let mut subjects = extract_all_tag_texts(&opf, "dc:subject");
        subjects.extend(extract_all_tag_texts(&opf, "subject"));
        subjects
    };

    Ok(BookMetadata {
        title,
        author,
        language,
        description,
        isbn,
        genres,
    })
}

/// Parse metadata from the OPF file inside the EPUB.
pub fn parse_epub_metadata(file_path: &str) -> Result<BookMetadata, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;
    parse_epub_metadata_from_archive(&mut archive)
}

/// Sanitize a cover href from OPF metadata to prevent path traversal attacks.
/// Returns `None` if the href is malicious or would resolve to an empty path.
fn sanitize_cover_href(href: &str) -> Option<String> {
    // Reject null bytes
    if href.contains('\0') {
        return None;
    }

    // Reject absolute paths (Unix and Windows)
    if href.starts_with('/') || href.starts_with('\\') {
        return None;
    }

    // Reject Windows drive letters (e.g., "C:", "D:\")
    if href.len() >= 2 && href.as_bytes()[0].is_ascii_alphabetic() && href.as_bytes()[1] == b':' {
        return None;
    }

    // Resolve the path and reject if it escapes the base directory.
    // We simulate resolving from an empty base — any ".." that would go above
    // the root means the path is trying to escape.
    let mut parts: Vec<&str> = Vec::new();
    for segment in href.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                // Tried to go above root — path traversal
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }

    if parts.is_empty() {
        return None;
    }

    Some(href.to_string())
}

/// Validate a cover image file extension against an allowlist.
/// Returns the extension (lowercase) if it is a recognized image type,
/// or `"jpg"` as a safe default otherwise.
fn sanitize_cover_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" => "jpg",
        "jpeg" => "jpeg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        "svg" => "svg",
        _ => "jpg",
    }
}

/// Extract cover image from an already-opened EPUB zip archive to dest_dir.
pub fn extract_cover_from_archive(
    archive: &mut ZipArchive<std::fs::File>,
    dest_dir: &str,
) -> Result<Option<String>, EpubError> {
    let opf_path = find_opf_path(archive)?;
    let opf = read_zip_entry(archive, &opf_path)?;
    let base_dir = opf_base_dir(&opf_path).to_string();

    let cover_href = match find_cover_href(&opf) {
        Some(h) => h,
        None => return Ok(None),
    };

    // Sanitize cover href to prevent path traversal
    let cover_href = match sanitize_cover_href(&cover_href) {
        Some(h) => h,
        None => return Ok(None),
    };

    // Determine the entry name in the zip
    let entry_name = match find_zip_entry_name(archive, &base_dir, &cover_href) {
        Some(n) => n,
        None => return Ok(None),
    };

    let bytes = read_zip_entry_bytes(archive, &entry_name)?;

    // Derive extension from href, restricted to known image types
    let raw_ext = cover_href.rsplit('.').next().unwrap_or("jpg");
    let ext = sanitize_cover_ext(raw_ext);
    let dest = Path::new(dest_dir).join(format!("cover.{ext}"));

    std::fs::create_dir_all(dest_dir).map_err(EpubError::Io)?;
    std::fs::write(&dest, bytes).map_err(EpubError::Io)?;

    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Extract cover image to dest_dir, return the destination path if found.
pub fn extract_cover(file_path: &str, dest_dir: &str) -> Result<Option<String>, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;
    extract_cover_from_archive(&mut archive, dest_dir)
}

/// Get ordered list of chapters (spine order) from an already-opened archive.
pub fn get_chapter_list_from_archive(
    archive: &mut ZipArchive<std::fs::File>,
) -> Result<Vec<ChapterInfo>, EpubError> {
    let opf_path = find_opf_path(archive)?;
    let opf = read_zip_entry(archive, &opf_path)?;

    let manifest = parse_manifest(&opf);
    let spine = parse_spine_idrefs(&opf);

    let chapters: Vec<ChapterInfo> = spine
        .into_iter()
        .enumerate()
        .filter_map(|(index, idref)| {
            manifest.get(&idref).map(|item| ChapterInfo {
                index,
                title: format!("Chapter {}", index + 1),
                href: item.href.clone(),
            })
        })
        .collect();

    Ok(chapters)
}

/// Get ordered list of chapters (spine order).
pub fn get_chapter_list(file_path: &str) -> Result<Vec<ChapterInfo>, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;
    get_chapter_list_from_archive(&mut archive)
}

/// Get HTML content of a specific chapter by index.
/// Relative `<img src>` attributes are rewritten to `asset://` URLs pointing to
/// images extracted from the EPUB to disk, avoiding large base64 strings in memory.
pub fn get_chapter_content(
    file_path: &str,
    chapter_index: usize,
    data_dir: &str,
    book_id: &str,
) -> Result<String, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let base_dir = opf_base_dir(&opf_path).to_string();

    let manifest = parse_manifest(&opf);
    let spine = parse_spine_idrefs(&opf);

    let idref = spine.get(chapter_index).ok_or_else(|| {
        EpubError::InvalidFormat(format!("Chapter index {chapter_index} out of range"))
    })?;

    let href = manifest
        .get(idref)
        .map(|item| item.href.clone())
        .ok_or_else(|| EpubError::MissingFile(format!("Manifest item '{idref}' not found")))?;

    let entry_name = find_zip_entry_name(&mut archive, &base_dir, &href)
        .ok_or_else(|| EpubError::MissingFile(format!("{base_dir}{href}")))?;

    let raw_html = read_zip_entry(&mut archive, &entry_name)?;
    // Sanitize first so ammonia never sees the asset URLs we are about to inject.
    let cleaned = clean(&raw_html);

    // Compute the directory of the chapter file within the zip so relative
    // image paths (e.g. "../images/foo.png") can be resolved.
    let chapter_dir = {
        let full_path = format!("{base_dir}{href}");
        match full_path.rfind('/') {
            Some(pos) => full_path[..pos + 1].to_string(),
            None => String::new(),
        }
    };

    let image_dir = format!("{}/images/{}/{}", data_dir, book_id, chapter_index);

    Ok(rewrite_img_srcs_to_asset_urls(
        &cleaned,
        &mut archive,
        &chapter_dir,
        &image_dir,
    ))
}

/// Like [`get_chapter_content`] but operates on a [`CachedEpubArchive`],
/// avoiding the cost of re-opening the zip and re-parsing OPF metadata.
pub fn get_chapter_content_from_cache(
    cached: &mut CachedEpubArchive,
    chapter_index: usize,
    data_dir: &str,
    book_id: &str,
) -> Result<String, EpubError> {
    let idref = cached.spine.get(chapter_index).ok_or_else(|| {
        EpubError::InvalidFormat(format!("Chapter index {chapter_index} out of range"))
    })?;

    let href = cached
        .manifest
        .get(idref)
        .map(|item| item.href.clone())
        .ok_or_else(|| EpubError::MissingFile(format!("Manifest item '{idref}' not found")))?;

    let base_dir = &cached.base_dir;
    let entry_name = find_zip_entry_name(&mut cached.archive, base_dir, &href)
        .ok_or_else(|| EpubError::MissingFile(format!("{base_dir}{href}")))?;

    let raw_html = read_zip_entry(&mut cached.archive, &entry_name)?;
    let cleaned = clean(&raw_html);

    let chapter_dir = {
        let full_path = format!("{base_dir}{href}");
        match full_path.rfind('/') {
            Some(pos) => full_path[..pos + 1].to_string(),
            None => String::new(),
        }
    };

    let image_dir = format!("{}/images/{}/{}", data_dir, book_id, chapter_index);

    Ok(rewrite_img_srcs_to_asset_urls(
        &cleaned,
        &mut cached.archive,
        &chapter_dir,
        &image_dir,
    ))
}

// ---- Full-text search ----

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub chapter_index: usize,
    pub snippet: String,
    pub match_offset: usize,
}

/// Clamp a byte index to the nearest valid UTF-8 char boundary (floor).
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Clamp a byte index to the nearest valid UTF-8 char boundary (ceil).
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Extract a context snippet around a match position in plain text.
/// All byte offsets are clamped to valid UTF-8 char boundaries.
pub fn extract_snippet(
    text: &str,
    match_start: usize,
    match_len: usize,
    context_chars: usize,
) -> String {
    let start = floor_char_boundary(text, match_start.saturating_sub(context_chars));
    let end = ceil_char_boundary(
        text,
        (match_start + match_len + context_chars).min(text.len()),
    );

    // Align to word boundaries
    let snippet_start = if start > 0 {
        text[start..]
            .find(' ')
            .map(|p| start + p + 1)
            .unwrap_or(start)
    } else {
        0
    };
    let snippet_end = if end < text.len() {
        text[..end].rfind(' ').unwrap_or(end)
    } else {
        text.len()
    };

    let snippet_start = floor_char_boundary(text, snippet_start);
    let snippet_end = ceil_char_boundary(text, snippet_end);

    let mut snippet = String::new();
    if snippet_start > 0 {
        snippet.push_str("...");
    }
    snippet.push_str(text[snippet_start..snippet_end].trim());
    if snippet_end < text.len() {
        snippet.push_str("...");
    }
    snippet
}

const MAX_SEARCH_RESULTS: usize = 200;

/// Search all chapters of an EPUB for a query string (case-insensitive).
pub fn search_book(
    cached: &mut CachedEpubArchive,
    query: &str,
) -> Result<Vec<SearchResult>, EpubError> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for i in 0..cached.spine.len() {
        let idref = &cached.spine[i];
        let href = cached
            .manifest
            .get(idref)
            .map(|item| item.href.clone())
            .ok_or_else(|| EpubError::MissingFile(format!("Manifest item '{idref}' not found")))?;

        let base_dir = &cached.base_dir;
        let entry_name = find_zip_entry_name(&mut cached.archive, base_dir, &href)
            .ok_or_else(|| EpubError::MissingFile(format!("{base_dir}{href}")))?;

        let raw_html = read_zip_entry(&mut cached.archive, &entry_name)?;
        let body_only = clean(&raw_html);
        let text = strip_html_tags(&body_only);
        let text_lower = text.to_lowercase();

        let mut search_from = 0;
        while let Some(pos) = text_lower[search_from..].find(&query_lower) {
            let match_start = search_from + pos;
            results.push(SearchResult {
                chapter_index: i,
                snippet: extract_snippet(&text, match_start, query_lower.len(), 40),
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

// ---- Word counting ----

/// Strip HTML tags from a string and return plain text.
///
/// This is a simple char-level scanner that replaces `<…>` runs with a space.
/// It does NOT handle HTML entities (`&nbsp;`, `&amp;`), comments (`<!-- -->`),
/// or CDATA sections. This is acceptable because all input has already been
/// sanitized by ammonia's `clean()`, which strips comments and normalizes
/// entities, so the remaining markup is well-formed simple HTML tags.
pub fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' '); // space between tags
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

/// Count words in a string (split by whitespace).
pub fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Get word counts for all chapters from a cached EPUB archive.
pub fn get_chapter_word_counts(cached: &mut CachedEpubArchive) -> Result<Vec<usize>, EpubError> {
    let mut counts = Vec::with_capacity(cached.spine.len());
    for i in 0..cached.spine.len() {
        let idref = &cached.spine[i];
        let href = cached
            .manifest
            .get(idref)
            .map(|item| item.href.clone())
            .ok_or_else(|| EpubError::MissingFile(format!("Manifest item '{idref}' not found")))?;

        let base_dir = &cached.base_dir;
        let entry_name = find_zip_entry_name(&mut cached.archive, base_dir, &href)
            .ok_or_else(|| EpubError::MissingFile(format!("{base_dir}{href}")))?;

        let raw_html = read_zip_entry(&mut cached.archive, &entry_name)?;
        let body_only = clean(&raw_html); // strip <head>, <style>, <script> etc.
        let text = strip_html_tags(&body_only);
        counts.push(count_words(&text));
    }
    Ok(counts)
}

// ---- Inline-image helpers ----

/// Resolve a relative path against a zip-internal base directory.
/// e.g. base="OEBPS/Text/", relative="../images/foo.png" → "OEBPS/images/foo.png"
fn resolve_zip_path(base_dir: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = base_dir
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Extract the value of a quoted HTML attribute from a tag string.
/// Handles both double- and single-quoted values.
fn extract_attr_value(tag: &str, attr: &str) -> Option<String> {
    let dq = format!("{attr}=\"");
    let sq = format!("{attr}='");
    if let Some(pos) = tag.find(&dq) {
        let after = &tag[pos + dq.len()..];
        let end = after.find('"')?;
        Some(after[..end].to_string())
    } else if let Some(pos) = tag.find(&sq) {
        let after = &tag[pos + sq.len()..];
        let end = after.find('\'')?;
        Some(after[..end].to_string())
    } else {
        None
    }
}

/// Replace a specific attribute value within a tag string.
fn replace_attr_value(tag: &str, attr: &str, old_val: &str, new_val: &str) -> String {
    let dq_old = format!("{attr}=\"{old_val}\"");
    let dq_new = format!("{attr}=\"{new_val}\"");
    if tag.contains(&dq_old) {
        return tag.replacen(&dq_old, &dq_new, 1);
    }
    let sq_old = format!("{attr}='{old_val}'");
    let sq_new = format!("{attr}='{new_val}'");
    tag.replacen(&sq_old, &sq_new, 1)
}

/// Walk the sanitized chapter HTML and replace relative `<img src>` values
/// with `asset://localhost/` URLs pointing to images extracted from the EPUB zip
/// to disk. This avoids base64-encoding large images into the HTML string, which
/// can cause memory issues with illustrated books.
///
/// Images are cached in `{image_dir}/` — if a file already exists on disk it is
/// not re-extracted. External URLs and SVG images are left untouched.
/// Missing images fail silently (the tag is left as-is) so a single broken
/// asset doesn't abort the whole chapter.
fn rewrite_img_srcs_to_asset_urls(
    html: &str,
    archive: &mut ZipArchive<std::fs::File>,
    chapter_dir: &str,
    image_dir: &str,
) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(tag_start) = rest.find("<img") {
        // Confirm the match is really an <img tag (not e.g. <imgfoo).
        let after_tag = &rest[tag_start + 4..];
        match after_tag.bytes().next() {
            Some(b)
                if b == b' '
                    || b == b'\t'
                    || b == b'\n'
                    || b == b'\r'
                    || b == b'>'
                    || b == b'/' => {}
            _ => {
                // Not an img tag — advance past the false match.
                result.push_str(&rest[..tag_start + 1]);
                rest = &rest[tag_start + 1..];
                continue;
            }
        }

        result.push_str(&rest[..tag_start]);
        let from_tag = &rest[tag_start..];

        let tag_end = from_tag.find('>').map(|i| i + 1).unwrap_or(from_tag.len());
        let tag = &from_tag[..tag_end];

        let rewritten = match extract_attr_value(tag, "src") {
            None => tag.to_string(),
            Some(src) => {
                // Leave external or already-resolved URLs alone.
                let is_external = src.starts_with("http://")
                    || src.starts_with("https://")
                    || src.starts_with("data:")
                    || src.starts_with("//")
                    || src.starts_with("asset://")
                    || src.starts_with('/');
                if is_external {
                    tag.to_string()
                } else {
                    // Strip fragment / query before resolving.
                    let clean_src = src
                        .split('#')
                        .next()
                        .unwrap_or(&src)
                        .split('?')
                        .next()
                        .unwrap_or(&src);
                    let ext = clean_src.rsplit('.').next().unwrap_or("").to_lowercase();

                    // DOMPurify strips SVG data URIs by default — skip them.
                    if ext == "svg" {
                        tag.to_string()
                    } else {
                        let resolved = resolve_zip_path(chapter_dir, clean_src);
                        // Derive a safe filename from the image path basename.
                        let basename = clean_src.rsplit('/').next().unwrap_or(clean_src);
                        let dest_path = std::path::Path::new(image_dir).join(basename);

                        // Extract to disk if not already cached.
                        let written = if dest_path.exists() {
                            true
                        } else if let Ok(bytes) = read_zip_entry_bytes(archive, &resolved) {
                            if std::fs::create_dir_all(image_dir).is_ok() {
                                std::fs::write(&dest_path, bytes).is_ok()
                            } else {
                                false
                            }
                        } else {
                            false
                        };

                        if written {
                            let abs_path = dest_path.to_string_lossy();
                            let encoded = urlencoding::encode(&abs_path);
                            let asset_url = format!("asset://localhost/{}", encoded);
                            replace_attr_value(tag, "src", &src, &asset_url)
                        } else {
                            tag.to_string()
                        }
                    }
                }
            }
        };

        result.push_str(&rewritten);
        rest = &from_tag[tag_end..];
    }

    result.push_str(rest);
    result
}

/// Get table of contents from NCX (EPUB 2) or nav document (EPUB 3).
pub fn get_toc(file_path: &str) -> Result<Vec<TocEntry>, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let base_dir = opf_base_dir(&opf_path).to_string();
    let manifest = parse_manifest(&opf);
    let spine = parse_spine_idrefs(&opf);

    // Build href → chapter_index map
    let href_to_index: HashMap<String, usize> = spine
        .iter()
        .enumerate()
        .filter_map(|(i, idref)| manifest.get(idref).map(|item| (item.href.clone(), i)))
        .collect();

    // Try EPUB 3 nav document first (detected via properties="nav" attribute per spec)
    let nav_href = manifest.iter().find_map(|(_, item)| {
        item.properties
            .as_deref()
            .filter(|p| p.split_whitespace().any(|prop| prop == "nav"))
            .map(|_| item.href.clone())
    });

    if let Some(nav_href) = nav_href {
        let entry_name = find_zip_entry_name(&mut archive, &base_dir, &nav_href);
        if let Some(name) = entry_name {
            if let Ok(nav_content) = read_zip_entry(&mut archive, &name) {
                let entries = parse_nav_toc(&nav_content, &href_to_index);
                if !entries.is_empty() {
                    return Ok(entries);
                }
            }
        }
    }

    // Fall back to EPUB 2 NCX
    let ncx_href = manifest.iter().find_map(|(_, item)| {
        if item.href.ends_with(".ncx") {
            Some(item.href.clone())
        } else {
            None
        }
    });

    if let Some(ncx_href) = ncx_href {
        let entry_name = find_zip_entry_name(&mut archive, &base_dir, &ncx_href);
        if let Some(name) = entry_name {
            if let Ok(ncx_content) = read_zip_entry(&mut archive, &name) {
                return Ok(parse_ncx_toc(&ncx_content, &href_to_index));
            }
        }
    }

    // Fallback: generate TOC from spine
    let toc = spine
        .iter()
        .enumerate()
        .filter_map(|(i, idref)| {
            manifest.get(idref).map(|_| TocEntry {
                label: format!("Chapter {}", i + 1),
                chapter_index: i,
                children: vec![],
            })
        })
        .collect();
    Ok(toc)
}

/// Like [`get_toc`] but operates on a [`CachedEpubArchive`].
pub fn get_toc_from_cache(cached: &mut CachedEpubArchive) -> Result<Vec<TocEntry>, EpubError> {
    let href_to_index: HashMap<String, usize> = cached
        .spine
        .iter()
        .enumerate()
        .filter_map(|(i, idref)| {
            cached
                .manifest
                .get(idref)
                .map(|item| (item.href.clone(), i))
        })
        .collect();

    // Try EPUB 3 nav document first
    let nav_href = cached.manifest.iter().find_map(|(_, item)| {
        item.properties
            .as_deref()
            .filter(|p| p.split_whitespace().any(|prop| prop == "nav"))
            .map(|_| item.href.clone())
    });

    if let Some(nav_href) = nav_href {
        let entry_name = find_zip_entry_name(&mut cached.archive, &cached.base_dir, &nav_href);
        if let Some(name) = entry_name {
            if let Ok(nav_content) = read_zip_entry(&mut cached.archive, &name) {
                let entries = parse_nav_toc(&nav_content, &href_to_index);
                if !entries.is_empty() {
                    return Ok(entries);
                }
            }
        }
    }

    // Fall back to EPUB 2 NCX
    let ncx_href = cached.manifest.iter().find_map(|(_, item)| {
        if item.href.ends_with(".ncx") {
            Some(item.href.clone())
        } else {
            None
        }
    });

    if let Some(ncx_href) = ncx_href {
        let entry_name = find_zip_entry_name(&mut cached.archive, &cached.base_dir, &ncx_href);
        if let Some(name) = entry_name {
            if let Ok(ncx_content) = read_zip_entry(&mut cached.archive, &name) {
                return Ok(parse_ncx_toc(&ncx_content, &href_to_index));
            }
        }
    }

    // Fallback: generate TOC from spine
    let toc = cached
        .spine
        .iter()
        .enumerate()
        .filter_map(|(i, idref)| {
            cached.manifest.get(idref).map(|_| TocEntry {
                label: format!("Chapter {}", i + 1),
                chapter_index: i,
                children: vec![],
            })
        })
        .collect();
    Ok(toc)
}

/// Parse EPUB 3 nav TOC using quick-xml.
/// Finds the nav element with epub:type="toc" and extracts anchor links.
fn parse_nav_toc(nav: &str, href_to_index: &HashMap<String, usize>) -> Vec<TocEntry> {
    let mut entries = Vec::new();
    let mut reader = Reader::from_str(nav);
    let mut buf = Vec::new();
    let mut in_toc_nav = false;
    let mut nav_depth = 0u32;
    let mut in_anchor = false;
    let mut anchor_depth = 0u32;
    let mut current_href: Option<String> = None;
    let mut current_label = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local = e.local_name();
                if !in_toc_nav {
                    if local.as_ref() == b"nav" {
                        // Check for epub:type="toc" — strip namespace prefix from attribute key
                        let is_toc = e.attributes().flatten().any(|attr| {
                            let key = attr.key.as_ref();
                            let local_key = key.splitn(2, |&b| b == b':').last().unwrap_or(key);
                            local_key == b"type" && attr.value.as_ref() == b"toc"
                        });
                        if is_toc {
                            in_toc_nav = true;
                            nav_depth = 1;
                        }
                    }
                } else if in_anchor {
                    anchor_depth += 1;
                } else if local.as_ref() == b"nav" {
                    nav_depth += 1;
                } else if local.as_ref() == b"a" {
                    in_anchor = true;
                    anchor_depth = 1;
                    current_label.clear();
                    current_href = None;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"href" {
                            current_href = Some(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_anchor {
                    if let Ok(text) = e.unescape() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            if !current_label.is_empty() {
                                current_label.push(' ');
                            }
                            current_label.push_str(trimmed);
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if in_toc_nav {
                    if in_anchor {
                        anchor_depth = anchor_depth.saturating_sub(1);
                        if anchor_depth == 0 {
                            if let Some(href) = current_href.take() {
                                let clean_href =
                                    href.split('#').next().unwrap_or(&href).to_string();
                                let chapter_index =
                                    href_to_index.get(&clean_href).copied().unwrap_or(0);
                                let label = if current_label.is_empty() {
                                    format!("Chapter {}", chapter_index + 1)
                                } else {
                                    current_label.clone()
                                };
                                entries.push(TocEntry {
                                    label,
                                    chapter_index,
                                    children: vec![],
                                });
                            }
                            in_anchor = false;
                        }
                    } else if e.local_name().as_ref() == b"nav" {
                        nav_depth = nav_depth.saturating_sub(1);
                        if nav_depth == 0 {
                            in_toc_nav = false;
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    entries
}

/// Parse EPUB 2 NCX TOC using quick-xml.
fn parse_ncx_toc(ncx: &str, href_to_index: &HashMap<String, usize>) -> Vec<TocEntry> {
    let mut entries = Vec::new();
    let mut reader = Reader::from_str(ncx);
    let mut buf = Vec::new();

    #[derive(Default)]
    struct NavState {
        label: String,
        src: String,
        in_text: bool,
    }

    let mut stack: Vec<NavState> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match e.local_name().as_ref() {
                    b"navPoint" => stack.push(NavState::default()),
                    b"text" => {
                        if let Some(state) = stack.last_mut() {
                            state.in_text = true;
                        }
                    }
                    b"content" => {
                        // Handle non-self-closing <content src="..."></content>
                        if let Some(state) = stack.last_mut() {
                            for attr in e.attributes().flatten() {
                                if attr.key.as_ref() == b"src" {
                                    state.src = String::from_utf8_lossy(&attr.value).into_owned();
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => match e.local_name().as_ref() {
                b"content" => {
                    if let Some(state) = stack.last_mut() {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"src" {
                                state.src = String::from_utf8_lossy(&attr.value).into_owned();
                            }
                        }
                    }
                }
                b"navPoint" => stack.push(NavState::default()),
                _ => {}
            },
            Ok(Event::Text(ref e)) => {
                if let Some(state) = stack.last_mut() {
                    if state.in_text {
                        if let Ok(text) = e.unescape() {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                state.label.push_str(trimmed);
                            }
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                b"text" => {
                    if let Some(state) = stack.last_mut() {
                        state.in_text = false;
                    }
                }
                b"navPoint" => {
                    if let Some(state) = stack.pop() {
                        if !state.label.is_empty() {
                            let clean_src = state
                                .src
                                .split('#')
                                .next()
                                .unwrap_or(&state.src)
                                .to_string();
                            let chapter_index = href_to_index.get(&clean_src).copied().unwrap_or(0);
                            entries.push(TocEntry {
                                label: state.label,
                                chapter_index,
                                children: vec![],
                            });
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tag_text() {
        let xml = "<dc:title>My Book Title</dc:title>";
        assert_eq!(extract_tag_text(xml, "dc:title"), Some("My Book Title"));
    }

    #[test]
    fn test_extract_all_tag_texts() {
        let xml = "<dc:creator>Alice</dc:creator><dc:creator>Bob</dc:creator>";
        let results = extract_all_tag_texts(xml, "dc:creator");
        assert_eq!(results, vec!["Alice", "Bob"]);
    }

    #[test]
    fn test_opf_base_dir() {
        assert_eq!(opf_base_dir("OEBPS/content.opf"), "OEBPS/");
        assert_eq!(opf_base_dir("content.opf"), "");
    }

    #[test]
    fn test_parse_spine() {
        let opf = r#"
        <spine toc="ncx">
            <itemref idref="chapter1"/>
            <itemref idref="chapter2"/>
        </spine>"#;
        let spine = parse_spine_idrefs(opf);
        assert_eq!(spine, vec!["chapter1", "chapter2"]);
    }

    #[test]
    fn test_parse_spine_multiline_attributes() {
        // Validates that multi-line attribute formatting is handled correctly
        let opf = r#"
        <spine toc="ncx">
            <itemref
                idref="chapter1"/>
            <itemref
                idref="chapter2"/>
        </spine>"#;
        let spine = parse_spine_idrefs(opf);
        assert_eq!(spine, vec!["chapter1", "chapter2"]);
    }

    #[test]
    fn test_parse_manifest() {
        let opf = r#"
        <manifest>
            <item id="chapter1" href="ch01.xhtml" media-type="application/xhtml+xml"/>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        </manifest>"#;
        let manifest = parse_manifest(opf);
        assert_eq!(
            manifest.get("chapter1").map(|i| i.href.as_str()),
            Some("ch01.xhtml")
        );
        assert_eq!(
            manifest.get("ncx").map(|i| i.href.as_str()),
            Some("toc.ncx")
        );
    }

    #[test]
    fn test_parse_manifest_multiline_attributes() {
        // Validates that multi-line attribute formatting is handled correctly
        let opf = r#"
        <manifest>
            <item
                id="chapter1"
                href="ch01.xhtml"
                media-type="application/xhtml+xml"/>
        </manifest>"#;
        let manifest = parse_manifest(opf);
        assert_eq!(
            manifest.get("chapter1").map(|i| i.href.as_str()),
            Some("ch01.xhtml")
        );
    }

    #[test]
    fn test_manifest_nav_properties() {
        let opf = r#"
        <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="ch1" href="ch01.xhtml" media-type="application/xhtml+xml"/>
        </manifest>"#;
        let manifest = parse_manifest(opf);
        let nav_item = manifest.values().find(|item| {
            item.properties
                .as_deref()
                .map(|p| p.split_whitespace().any(|prop| prop == "nav"))
                .unwrap_or(false)
        });
        assert!(nav_item.is_some());
        assert_eq!(nav_item.unwrap().href, "nav.xhtml");
    }

    #[test]
    fn test_find_cover_href_epub3() {
        let opf = r#"
        <manifest>
            <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
        </manifest>"#;
        assert_eq!(find_cover_href(opf), Some("images/cover.jpg".to_string()));
    }

    #[test]
    fn test_sanitize_strips_script_tags() {
        let dangerous = r#"<p>Hello world</p><script>alert(1)</script><p>More text</p>"#;
        let sanitized = clean(dangerous);
        assert!(
            !sanitized.contains("<script>"),
            "script tag should be stripped"
        );
        assert!(
            !sanitized.contains("alert(1)"),
            "script content should be stripped"
        );
        assert!(
            sanitized.contains("Hello world"),
            "normal content should be preserved"
        );
        assert!(
            sanitized.contains("More text"),
            "normal content should be preserved"
        );
    }

    #[test]
    fn test_sanitize_strips_inline_event_handlers() {
        let dangerous = r#"<p onmouseover="alert(1)">Text</p><img src="x" onerror="alert(2)"/>"#;
        let sanitized = clean(dangerous);
        assert!(
            !sanitized.contains("onmouseover"),
            "event handler should be stripped"
        );
        assert!(
            !sanitized.contains("onerror"),
            "event handler should be stripped"
        );
        assert!(
            sanitized.contains("Text"),
            "normal content should be preserved"
        );
    }

    #[test]
    fn test_find_cover_href_epub2() {
        let opf = r#"
        <metadata>
            <meta name="cover" content="cover-image"/>
        </metadata>
        <manifest>
            <item id="cover-image" href="cover.jpeg" media-type="image/jpeg"/>
        </manifest>"#;
        assert_eq!(find_cover_href(opf), Some("cover.jpeg".to_string()));
    }

    #[test]
    fn test_sanitize_cover_href_valid_paths() {
        assert_eq!(
            sanitize_cover_href("images/cover.jpg"),
            Some("images/cover.jpg".to_string())
        );
        assert_eq!(
            sanitize_cover_href("cover.png"),
            Some("cover.png".to_string())
        );
        assert_eq!(
            sanitize_cover_href("OEBPS/images/cover.jpeg"),
            Some("OEBPS/images/cover.jpeg".to_string())
        );
        // Relative path that stays within bounds
        assert_eq!(
            sanitize_cover_href("a/b/../cover.jpg"),
            Some("a/b/../cover.jpg".to_string())
        );
    }

    #[test]
    fn test_sanitize_cover_href_rejects_null_bytes() {
        assert_eq!(sanitize_cover_href("cover\0.jpg"), None);
        assert_eq!(sanitize_cover_href("\0"), None);
    }

    #[test]
    fn test_sanitize_cover_href_rejects_absolute_paths() {
        assert_eq!(sanitize_cover_href("/etc/passwd"), None);
        assert_eq!(sanitize_cover_href("\\Windows\\system32"), None);
    }

    #[test]
    fn test_sanitize_cover_href_rejects_windows_drive() {
        assert_eq!(sanitize_cover_href("C:\\cover.jpg"), None);
        assert_eq!(sanitize_cover_href("D:cover.jpg"), None);
    }

    #[test]
    fn test_sanitize_cover_href_rejects_traversal() {
        assert_eq!(sanitize_cover_href("../../etc/passwd"), None);
        assert_eq!(sanitize_cover_href("../secret"), None);
        assert_eq!(sanitize_cover_href(".."), None);
        assert_eq!(sanitize_cover_href("a/../../b"), None);
    }

    #[test]
    fn test_sanitize_cover_href_rejects_empty_resolution() {
        assert_eq!(sanitize_cover_href(""), None);
        assert_eq!(sanitize_cover_href("."), None);
        assert_eq!(sanitize_cover_href("a/.."), None);
    }

    #[test]
    fn test_sanitize_cover_ext_valid_extensions() {
        assert_eq!(sanitize_cover_ext("jpg"), "jpg");
        assert_eq!(sanitize_cover_ext("jpeg"), "jpeg");
        assert_eq!(sanitize_cover_ext("png"), "png");
        assert_eq!(sanitize_cover_ext("gif"), "gif");
        assert_eq!(sanitize_cover_ext("webp"), "webp");
        assert_eq!(sanitize_cover_ext("svg"), "svg");
    }

    #[test]
    fn test_sanitize_cover_ext_case_insensitive() {
        assert_eq!(sanitize_cover_ext("JPG"), "jpg");
        assert_eq!(sanitize_cover_ext("Png"), "png");
        assert_eq!(sanitize_cover_ext("JPEG"), "jpeg");
        assert_eq!(sanitize_cover_ext("WebP"), "webp");
    }

    #[test]
    fn test_sanitize_cover_ext_rejects_dangerous_extensions() {
        assert_eq!(sanitize_cover_ext("exe"), "jpg");
        assert_eq!(sanitize_cover_ext("sh"), "jpg");
        assert_eq!(sanitize_cover_ext("bat"), "jpg");
        assert_eq!(sanitize_cover_ext("js"), "jpg");
        assert_eq!(sanitize_cover_ext("html"), "jpg");
        assert_eq!(sanitize_cover_ext("php"), "jpg");
    }

    #[test]
    fn test_sanitize_cover_ext_rejects_empty_and_unusual() {
        assert_eq!(sanitize_cover_ext(""), "jpg");
        assert_eq!(sanitize_cover_ext(".."), "jpg");
        assert_eq!(sanitize_cover_ext("jpg.exe"), "jpg");
    }

    /// Helper to create a zip archive with an image entry for testing.
    fn create_test_zip_with_image(
        dir: &std::path::Path,
        zip_name: &str,
        image_path: &str,
        image_bytes: &[u8],
    ) -> String {
        let zip_path = dir.join(zip_name);
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(image_path, options).unwrap();
        std::io::Write::write_all(&mut writer, image_bytes).unwrap();
        writer.finish().unwrap();
        zip_path.to_string_lossy().to_string()
    }

    #[test]
    fn test_rewrite_img_srcs_produces_asset_urls() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = create_test_zip_with_image(
            tmp.path(),
            "test.zip",
            "OEBPS/images/photo.jpg",
            &[0xFF, 0xD8, 0xFF, 0xE0], // JPEG magic bytes
        );

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let image_dir = tmp.path().join("images").join("book1").join("0");
        let image_dir_str = image_dir.to_string_lossy().to_string();

        let html = r#"<p>Text</p><img src="../images/photo.jpg"/><p>More</p>"#;
        let result =
            rewrite_img_srcs_to_asset_urls(html, &mut archive, "OEBPS/Text/", &image_dir_str);

        assert!(
            result.contains("asset://localhost/"),
            "should contain asset URL, got: {result}"
        );
        assert!(
            !result.contains("data:"),
            "should not contain data URI, got: {result}"
        );
        assert!(
            result.contains("photo.jpg"),
            "should reference the image filename"
        );
        // Verify image was written to disk
        assert!(image_dir.join("photo.jpg").exists());
    }

    #[test]
    fn test_rewrite_img_srcs_caches_images_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = create_test_zip_with_image(
            tmp.path(),
            "test.zip",
            "images/icon.png",
            &[0x89, 0x50, 0x4E, 0x47], // PNG magic bytes
        );

        let image_dir = tmp.path().join("images").join("book1").join("0");
        let image_dir_str = image_dir.to_string_lossy().to_string();
        let html = r#"<img src="images/icon.png"/>"#;

        // First call: extracts image
        {
            let file = std::fs::File::open(&zip_path).unwrap();
            let mut archive = ZipArchive::new(file).unwrap();
            rewrite_img_srcs_to_asset_urls(html, &mut archive, "", &image_dir_str);
        }
        let dest = image_dir.join("icon.png");
        assert!(dest.exists());
        let mtime_first = std::fs::metadata(&dest).unwrap().modified().unwrap();

        // Small delay to ensure filesystem time resolution
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Second call: should skip extraction (file already cached)
        {
            let file = std::fs::File::open(&zip_path).unwrap();
            let mut archive = ZipArchive::new(file).unwrap();
            rewrite_img_srcs_to_asset_urls(html, &mut archive, "", &image_dir_str);
        }
        let mtime_second = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(
            mtime_first, mtime_second,
            "cached file should not be rewritten"
        );
    }

    #[test]
    fn test_rewrite_img_srcs_leaves_external_urls_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = create_test_zip_with_image(tmp.path(), "test.zip", "img.jpg", &[0xFF]);

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let image_dir = tmp.path().join("out");
        let image_dir_str = image_dir.to_string_lossy().to_string();

        let html =
            r#"<img src="https://example.com/photo.jpg"/><img src="data:image/png;base64,abc"/>"#;
        let result = rewrite_img_srcs_to_asset_urls(html, &mut archive, "", &image_dir_str);

        assert_eq!(result, html, "external URLs should be unchanged");
    }

    #[test]
    fn test_rewrite_img_srcs_skips_svg() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = create_test_zip_with_image(tmp.path(), "test.zip", "icon.svg", b"<svg/>");

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let image_dir = tmp.path().join("out");
        let image_dir_str = image_dir.to_string_lossy().to_string();

        let html = r#"<img src="icon.svg"/>"#;
        let result = rewrite_img_srcs_to_asset_urls(html, &mut archive, "", &image_dir_str);

        assert_eq!(result, html, "SVG images should be left as-is");
    }

    #[test]
    fn test_rewrite_img_srcs_missing_image_leaves_tag_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        // Create zip without the referenced image
        let zip_path = create_test_zip_with_image(tmp.path(), "test.zip", "other.jpg", &[0xFF]);

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let image_dir = tmp.path().join("out");
        let image_dir_str = image_dir.to_string_lossy().to_string();

        let html = r#"<img src="missing.jpg"/>"#;
        let result = rewrite_img_srcs_to_asset_urls(html, &mut archive, "", &image_dir_str);

        assert_eq!(result, html, "missing images should leave tag unchanged");
    }

    // ---- Word counting tests ----

    #[test]
    fn test_strip_html_tags_basic() {
        assert_eq!(strip_html_tags("<p>Hello world</p>"), " Hello world ");
    }

    #[test]
    fn test_strip_html_tags_nested() {
        assert_eq!(
            strip_html_tags("<div><p>One <strong>two</strong> three</p></div>"),
            "  One  two  three  "
        );
    }

    #[test]
    fn test_strip_html_tags_empty() {
        assert_eq!(strip_html_tags(""), "");
        assert_eq!(strip_html_tags("<br/><hr/>"), "  ");
    }

    #[test]
    fn test_count_words_basic() {
        assert_eq!(count_words("hello world"), 2);
        assert_eq!(count_words("  one  two  three  "), 3);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   "), 0);
    }

    #[test]
    fn test_count_words_from_html() {
        let html = "<p>The quick brown fox jumps over the lazy dog.</p>";
        let text = strip_html_tags(html);
        assert_eq!(count_words(&text), 9);
    }

    // ---- Search tests ----

    #[test]
    fn test_extract_snippet_middle() {
        let text = "The quick brown fox jumps over the lazy dog and runs away fast.";
        let snippet = extract_snippet(text, 16, 3, 15);
        assert!(snippet.contains("fox"));
        assert!(snippet.starts_with("..."));
    }

    #[test]
    fn test_extract_snippet_at_start() {
        let text = "Fox jumps over the lazy dog.";
        let snippet = extract_snippet(text, 0, 3, 15);
        assert!(snippet.contains("Fox"));
        assert!(!snippet.starts_with("..."));
    }

    #[test]
    fn test_extract_snippet_at_end() {
        let text = "The quick brown fox.";
        let snippet = extract_snippet(text, 16, 3, 15);
        assert!(snippet.contains("fox"));
        assert!(!snippet.ends_with("..."));
    }

    #[test]
    fn test_extract_snippet_short_text() {
        let text = "Hello world";
        let snippet = extract_snippet(text, 0, 5, 100);
        assert_eq!(snippet, "Hello world");
    }

    #[test]
    fn test_extract_snippet_multibyte_chars() {
        let text = "Le café est très bon et délicieux.";
        // "café" starts at byte 3 and is 5 bytes (é = 2 bytes)
        let pos = text.find("café").unwrap();
        let snippet = extract_snippet(text, pos, "café".len(), 10);
        assert!(
            snippet.contains("café"),
            "snippet should contain the match: {snippet}"
        );
    }

    #[test]
    fn test_extract_snippet_cjk() {
        let text = "这是一个中文测试句子。";
        let pos = text.find("中文").unwrap();
        let snippet = extract_snippet(text, pos, "中文".len(), 10);
        assert!(
            snippet.contains("中文"),
            "snippet should contain CJK match: {snippet}"
        );
    }
}
