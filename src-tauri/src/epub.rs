use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;
use ammonia::clean;

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

// ---- Internal helpers ----

/// Read a file from a zip archive by name (case-insensitive path matching).
fn read_zip_entry(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Result<String, EpubError> {
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
fn read_zip_entry_bytes(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>, EpubError> {
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
fn find_opf_path(archive: &mut ZipArchive<std::fs::File>) -> Result<String, EpubError> {
    let container = read_zip_entry(archive, "META-INF/container.xml")?;
    // Extract rootfile full-path attribute
    for line in container.lines() {
        let trimmed = line.trim();
        if trimmed.contains("rootfile") && trimmed.contains("full-path") {
            if let Some(start) = trimmed.find("full-path=\"") {
                let rest = &trimmed[start + 11..];
                if let Some(end) = rest.find('"') {
                    return Ok(rest[..end].to_string());
                }
            }
        }
    }
    Err(EpubError::InvalidFormat("Cannot find OPF path in container.xml".to_string()))
}

/// Given OPF path, return the base directory (for resolving relative hrefs).
fn opf_base_dir(opf_path: &str) -> &str {
    if let Some(pos) = opf_path.rfind('/') {
        &opf_path[..pos + 1]
    } else {
        ""
    }
}

/// Extract text content between XML tags (very minimal, no full XML parser needed for metadata).
fn extract_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
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

/// Extract attribute value from an XML element string.
fn extract_attr<'a>(element: &'a str, attr: &str) -> Option<&'a str> {
    let key = format!("{attr}=\"");
    let start = element.find(&key)? + key.len();
    let rest = &element[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Parse spine items (idref list) from OPF XML.
fn parse_spine_idrefs(opf: &str) -> Vec<String> {
    let mut idrefs = Vec::new();
    let mut in_spine = false;
    for line in opf.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<spine") {
            in_spine = true;
        }
        if in_spine && trimmed.contains("</spine>") {
            in_spine = false;
        }
        if in_spine && trimmed.contains("<itemref") {
            if let Some(idref) = extract_attr(trimmed, "idref") {
                idrefs.push(idref.to_string());
            }
        }
    }
    idrefs
}

/// Parse manifest items (id → href mapping) from OPF XML.
fn parse_manifest(opf: &str) -> HashMap<String, String> {
    let mut manifest = HashMap::new();
    let mut in_manifest = false;
    for line in opf.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<manifest") {
            in_manifest = true;
        }
        if in_manifest && trimmed.contains("</manifest>") {
            in_manifest = false;
        }
        if in_manifest && trimmed.contains("<item ") {
            if let (Some(id), Some(href)) = (extract_attr(trimmed, "id"), extract_attr(trimmed, "href")) {
                manifest.insert(id.to_string(), href.to_string());
            }
        }
    }
    manifest
}

/// Find the cover image href from OPF (EPUB 2 and 3).
fn find_cover_href(opf: &str) -> Option<String> {
    // EPUB 3: <item properties="cover-image" ...>
    for line in opf.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<item ") && trimmed.contains("cover-image") {
            if let Some(href) = extract_attr(trimmed, "href") {
                return Some(href.to_string());
            }
        }
    }
    // EPUB 2: <meta name="cover" content="cover-id"/>
    let mut cover_id: Option<String> = None;
    for line in opf.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<meta") && trimmed.contains("name=\"cover\"") {
            if let Some(content) = extract_attr(trimmed, "content") {
                cover_id = Some(content.to_string());
                break;
            }
        }
    }
    if let Some(id) = cover_id {
        let manifest = parse_manifest(opf);
        return manifest.get(&id).cloned();
    }
    None
}

/// Find all zip entry names that match a given href prefix (handles path normalization).
fn find_zip_entry_name(archive: &mut ZipArchive<std::fs::File>, base_dir: &str, href: &str) -> Option<String> {
    let candidate = format!("{base_dir}{href}");
    // Strip query/fragment from href
    let clean_href = href.split('#').next().unwrap_or(href);
    let clean_candidate = format!("{base_dir}{clean_href}");
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i) {
            let name = entry.name().to_string();
            if name == candidate || name == clean_candidate
                || name.to_lowercase() == clean_candidate.to_lowercase()
            {
                return Some(name);
            }
        }
    }
    None
}

// ---- Public API ----

/// Parse metadata from the OPF file inside the EPUB.
pub fn parse_epub_metadata(file_path: &str) -> Result<BookMetadata, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;

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

    Ok(BookMetadata { title, author, language, description })
}

/// Extract cover image to dest_dir, return the destination path if found.
pub fn extract_cover(file_path: &str, dest_dir: &str) -> Result<Option<String>, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let base_dir = opf_base_dir(&opf_path).to_string();

    let cover_href = match find_cover_href(&opf) {
        Some(h) => h,
        None => return Ok(None),
    };

    // Determine the entry name in the zip
    let entry_name = match find_zip_entry_name(&mut archive, &base_dir, &cover_href) {
        Some(n) => n,
        None => return Ok(None),
    };

    let bytes = read_zip_entry_bytes(&mut archive, &entry_name)?;

    // Derive extension from href, validated against an allowlist to prevent path traversal.
    // cover_href may contain path components like `../../etc/cron.d/evil` — only the
    // final token after the last '.' is used, and only if it is a known image extension.
    const ALLOWED_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];
    let raw_ext = cover_href.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let ext = if ALLOWED_EXTS.contains(&raw_ext.as_str()) {
        raw_ext
    } else {
        "jpg".to_string()
    };
    let dest = Path::new(dest_dir).join(format!("cover.{ext}"));

    std::fs::create_dir_all(dest_dir).map_err(EpubError::Io)?;
    std::fs::write(&dest, bytes).map_err(EpubError::Io)?;

    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Get ordered list of chapters (spine order).
pub fn get_chapter_list(file_path: &str) -> Result<Vec<ChapterInfo>, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;

    let manifest = parse_manifest(&opf);
    let spine = parse_spine_idrefs(&opf);

    let chapters: Vec<ChapterInfo> = spine
        .into_iter()
        .enumerate()
        .filter_map(|(index, idref)| {
            manifest.get(&idref).map(|href| ChapterInfo {
                index,
                title: format!("Chapter {}", index + 1),
                href: href.clone(),
            })
        })
        .collect();

    Ok(chapters)
}

/// Get HTML content of a specific chapter by index.
pub fn get_chapter_content(file_path: &str, chapter_index: usize) -> Result<String, EpubError> {
    let file = std::fs::File::open(file_path).map_err(EpubError::Io)?;
    let mut archive = ZipArchive::new(file)?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let base_dir = opf_base_dir(&opf_path).to_string();

    let manifest = parse_manifest(&opf);
    let spine = parse_spine_idrefs(&opf);

    let idref = spine
        .get(chapter_index)
        .ok_or_else(|| EpubError::InvalidFormat(format!("Chapter index {chapter_index} out of range")))?;

    let href = manifest
        .get(idref)
        .ok_or_else(|| EpubError::MissingFile(format!("Manifest item '{idref}' not found")))?;

    let entry_name = find_zip_entry_name(&mut archive, &base_dir, href)
        .ok_or_else(|| EpubError::MissingFile(format!("{base_dir}{href}")))?;

    let raw_html = read_zip_entry(&mut archive, &entry_name)?;
    Ok(clean(&raw_html))
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
        .filter_map(|(i, idref)| manifest.get(idref).map(|href| (href.clone(), i)))
        .collect();

    // Try EPUB 3 nav document first
    let nav_entry = manifest.iter().find(|(_, href)| {
        href.ends_with("nav.xhtml") || href.ends_with("nav.html") || href.contains("nav")
    });

    if let Some((_, nav_href)) = nav_entry {
        let entry_name = find_zip_entry_name(&mut archive, &base_dir, nav_href);
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
    let ncx_entry = manifest.iter().find(|(_, href)| href.ends_with(".ncx"));
    if let Some((_, ncx_href)) = ncx_entry {
        let entry_name = find_zip_entry_name(&mut archive, &base_dir, ncx_href);
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

/// Parse EPUB 3 nav TOC.
fn parse_nav_toc(nav: &str, href_to_index: &HashMap<String, usize>) -> Vec<TocEntry> {
    let mut entries = Vec::new();
    let mut in_nav = false;
    let mut in_toc = false;

    for line in nav.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<nav") && trimmed.contains("toc") {
            in_nav = true;
            in_toc = true;
        }
        if in_toc && trimmed.contains("</nav>") {
            in_nav = false;
            in_toc = false;
        }
        if in_nav && trimmed.contains("<a ") && trimmed.contains("href=") {
            if let Some(href) = extract_attr(trimmed, "href") {
                let clean_href = href.split('#').next().unwrap_or(href);
                let chapter_index = href_to_index.get(clean_href).copied().unwrap_or(0);
                // Extract label text between <a ...> and </a>
                let label = if let Some(start) = trimmed.find('>') {
                    let rest = &trimmed[start + 1..];
                    if let Some(end) = rest.find('<') {
                        rest[..end].trim().to_string()
                    } else {
                        format!("Chapter {}", chapter_index + 1)
                    }
                } else {
                    format!("Chapter {}", chapter_index + 1)
                };
                entries.push(TocEntry { label, chapter_index, children: vec![] });
            }
        }
    }
    entries
}

/// Parse EPUB 2 NCX TOC.
fn parse_ncx_toc(ncx: &str, href_to_index: &HashMap<String, usize>) -> Vec<TocEntry> {
    let mut entries = Vec::new();
    let mut in_nav_point = false;
    let mut current_label = String::new();
    let mut current_href = String::new();

    for line in ncx.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<navPoint") {
            in_nav_point = true;
            current_label.clear();
            current_href.clear();
        }
        if in_nav_point {
            if trimmed.contains("<text>") {
                if let Some(text) = extract_tag_text(trimmed, "text") {
                    current_label = text.to_string();
                }
            }
            if trimmed.contains("<content") {
                if let Some(src) = extract_attr(trimmed, "src") {
                    current_href = src.split('#').next().unwrap_or(src).to_string();
                }
            }
            if trimmed.contains("</navPoint>") {
                if !current_label.is_empty() {
                    let chapter_index = href_to_index.get(&current_href).copied().unwrap_or(0);
                    entries.push(TocEntry {
                        label: current_label.clone(),
                        chapter_index,
                        children: vec![],
                    });
                }
                in_nav_point = false;
            }
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests verify internal helpers without needing real EPUB files.

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
    fn test_extract_attr() {
        let el = r#"<item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>"#;
        assert_eq!(extract_attr(el, "href"), Some("images/cover.jpg"));
        assert_eq!(extract_attr(el, "id"), Some("cover"));
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
    fn test_parse_manifest() {
        let opf = r#"
        <manifest>
            <item id="chapter1" href="ch01.xhtml" media-type="application/xhtml+xml"/>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        </manifest>"#;
        let manifest = parse_manifest(opf);
        assert_eq!(manifest.get("chapter1"), Some(&"ch01.xhtml".to_string()));
        assert_eq!(manifest.get("ncx"), Some(&"toc.ncx".to_string()));
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
        assert!(!sanitized.contains("<script>"), "script tag should be stripped");
        assert!(!sanitized.contains("alert(1)"), "script content should be stripped");
        assert!(sanitized.contains("Hello world"), "normal content should be preserved");
        assert!(sanitized.contains("More text"), "normal content should be preserved");
    }

    #[test]
    fn test_sanitize_strips_inline_event_handlers() {
        let dangerous = r#"<p onmouseover="alert(1)">Text</p><img src="x" onerror="alert(2)"/>"#;
        let sanitized = clean(dangerous);
        assert!(!sanitized.contains("onmouseover"), "event handler should be stripped");
        assert!(!sanitized.contains("onerror"), "event handler should be stripped");
        assert!(sanitized.contains("Text"), "normal content should be preserved");
    }

    #[test]
    fn test_cover_ext_allowlist_rejects_traversal() {
        // A crafted cover_href with path traversal should produce "jpg" not an unsafe extension.
        let crafted = "images/cover.jpg/../../../etc/cron.d/evil";
        const ALLOWED_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];
        let raw_ext = crafted.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let ext = if ALLOWED_EXTS.contains(&raw_ext.as_str()) {
            raw_ext
        } else {
            "jpg".to_string()
        };
        assert_eq!(ext, "jpg", "traversal extension should fall back to jpg");
    }

    #[test]
    fn test_cover_ext_allowlist_accepts_valid() {
        const ALLOWED_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];
        for valid in ["cover.jpg", "cover.JPEG", "cover.png", "cover.gif", "cover.webp"] {
            let raw_ext = valid.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let ext = if ALLOWED_EXTS.contains(&raw_ext.as_str()) {
                raw_ext
            } else {
                "jpg".to_string()
            };
            assert!(ALLOWED_EXTS.contains(&ext.as_str()), "{valid} should be accepted");
        }
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
}
