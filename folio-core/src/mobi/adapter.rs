//! High-level adapter mapping libmobi output to Folio's EPUB-style model.
//!
//! The wrapper in [`super`] exposes libmobi primitives (parts, resources,
//! cover); this module composes them into the same interface the Reader
//! already uses for EPUBs — metadata, ordered chapters, sanitized HTML with
//! `asset://` image URLs, and per-chapter word counts.
//!
//! The module has no Tauri / IPC dependencies; it is consumed by both the
//! desktop commands and the OPDS web server.

use std::path::Path;
use std::str;

use ammonia::clean;

use super::{MobiBook, PartKind};
use crate::epub::{count_words, strip_html_tags, BookMetadata, ChapterInfo, ExtractedCover};
use crate::error::{FolioError, FolioResult};
use crate::storage::Storage;

/// Metadata collected from the MOBI/AZW/AZW3 EXTH records, shaped to match
/// `epub::BookMetadata` so the import path stays polymorphic.
pub type MobiMetadata = BookMetadata;

/// Parse a MOBI/AZW/AZW3 file and return the metadata needed to build a
/// `Book` row at import time. Title and author fall back to empty strings
/// (the Book-building layer substitutes the filename stem) rather than
/// erroring, which matches the EPUB adapter's behavior on minimal files.
pub fn parse_mobi_metadata(file_path: &str) -> FolioResult<MobiMetadata> {
    let book = MobiBook::open(Path::new(file_path))?;
    Ok(BookMetadata {
        title: book.title().unwrap_or_default(),
        author: book.author().unwrap_or_default(),
        language: book.language().unwrap_or_default(),
        description: book.description(),
        isbn: book.isbn(),
        genres: parse_subject_list(book.subject()),
    })
}

/// Extract the full-size cover image, if the EXTH cover record is present
/// and points at a recognizable raster. See [`super::MobiBook::cover`] for
/// the detection rules.
pub fn extract_cover(file_path: &str) -> FolioResult<Option<ExtractedCover>> {
    let book = MobiBook::open(Path::new(file_path))?;
    Ok(book.cover().map(|c| ExtractedCover {
        bytes: c.data.to_vec(),
        ext: c.extension.to_string(),
    }))
}

/// Ordered list of reading-order HTML chapters. For KF8 this is the per-
/// file split libmobi reconstructs from the SKEL/FRAG indexes; for legacy
/// Mobipocket it is a single blob.
///
/// Titles are synthetic ("Chapter N") — MOBI doesn't expose a reliable
/// per-chapter title without parsing the NCX, which is a separate
/// follow-up.
pub fn get_chapter_list(file_path: &str) -> FolioResult<Vec<ChapterInfo>> {
    let book = MobiBook::open(Path::new(file_path))?;
    let rawml = book.rawml()?;
    let chapters: Vec<ChapterInfo> = rawml
        .parts()
        .filter(|p| matches!(p.kind, PartKind::Html))
        .enumerate()
        .map(|(index, part)| ChapterInfo {
            index,
            title: format!("Chapter {}", index + 1),
            href: format!("part{:05}.html", part.uid),
        })
        .collect();
    Ok(chapters)
}

/// Extract sanitized HTML for a single chapter and rewrite inline image
/// references (`src="resource{NNNNN}.{ext}"`) to `asset://` URLs pointing
/// at images extracted into `storage` under `{book_id}/{chapter_index}/`.
///
/// The `{book_id}/{chapter_index}/` layout matches the EPUB adapter and
/// the web reader's asset-serving contract (`api.rs` resolves inline
/// images via `/api/books/{id}/images/{chapter}/{filename}`), so the
/// rewriter output is valid for both the desktop and HTTP reader paths.
///
/// Only raster formats (jpeg/png/gif/bmp) are rewritten; SVG and CSS
/// references are left alone because they aren't meaningful for the
/// Reader's current render path. Images whose write to `storage` fails
/// (disk full, permission denied) keep their original `resource…`
/// reference so a single broken asset doesn't poison the whole chapter
/// with URLs that point at files that never landed on disk.
pub fn get_chapter_content(
    file_path: &str,
    chapter_index: usize,
    storage: &dyn Storage,
    book_id: &str,
) -> FolioResult<String> {
    let book = MobiBook::open(Path::new(file_path))?;
    let rawml = book.rawml()?;

    let html_parts: Vec<_> = rawml
        .parts()
        .filter(|p| matches!(p.kind, PartKind::Html))
        .collect();

    let part = html_parts.get(chapter_index).ok_or_else(|| {
        FolioError::invalid(format!(
            "MOBI chapter index {chapter_index} out of range (have {} HTML parts)",
            html_parts.len()
        ))
    })?;

    // Sanitize first so ammonia strips the XML prologue, `<html>/<head>/
    // <body>`, scripts, and external link rels before our rewriter sees
    // the markup. The result is fragment-level HTML suitable for the
    // Reader pane.
    let raw_html = str::from_utf8(part.data)
        .map_err(|e| FolioError::invalid(format!("MOBI chapter is not valid UTF-8: {e}")))?;
    let cleaned = clean(raw_html);

    // Persist every image resource once under the per-chapter prefix.
    // Failures are silent by design — the rewriter below checks
    // `storage.exists(&key)` before emitting an asset URL, so a failed
    // `put` leaves the original `resource…` reference in place.
    let key_prefix = format!("{book_id}/{chapter_index}");
    for res in rawml.resources() {
        if !res.kind.is_image() {
            continue;
        }
        let Some(ext) = res.kind.extension() else {
            continue;
        };
        let asset_name = format!("resource{:05}.{ext}", res.uid);
        let key = format!("{key_prefix}/{asset_name}");
        if !storage.exists(&key).unwrap_or(false) {
            let _ = storage.put(&key, res.data);
        }
    }

    Ok(rewrite_mobi_image_refs(&cleaned, storage, &key_prefix))
}

/// Per-chapter word counts, matching `epub::get_chapter_word_counts`.
/// Used by the Reader to draw the reading-progress bar.
pub fn get_chapter_word_counts(file_path: &str) -> FolioResult<Vec<usize>> {
    let book = MobiBook::open(Path::new(file_path))?;
    let rawml = book.rawml()?;
    let counts: Vec<usize> = rawml
        .parts()
        .filter(|p| matches!(p.kind, PartKind::Html))
        .map(|p| {
            let html = str::from_utf8(p.data).unwrap_or("");
            let cleaned = clean(html);
            count_words(&strip_html_tags(&cleaned))
        })
        .collect();
    Ok(counts)
}

/// Walk the sanitized HTML looking for quoted attribute values that match
/// libmobi's `resource{NNNNN}.{ext}` naming, and replace them with a
/// `asset://localhost/<url-encoded-local-path>` URL.
///
/// This is a byte-level scanner rather than a real HTML parser for two
/// reasons: (a) the input is already ammonia-cleaned so we know tags and
/// attribute quoting are normalized, and (b) the naming convention is
/// deterministic and restrictive enough that a false positive would
/// require a literal `"resource00000.jpg"` string inside text content,
/// which isn't a realistic collision.
fn rewrite_mobi_image_refs(html: &str, storage: &dyn Storage, key_prefix: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(pos) = rest.find("\"resource") {
        // Copy everything up to and including the opening quote, then try
        // to rewrite whatever the quoted value is.
        out.push_str(&rest[..=pos]);
        let after = &rest[pos + 1..];
        let Some(end) = after.find('"') else {
            // Unbalanced quotes — bail and emit the remainder verbatim so
            // we don't eat half the document on malformed input.
            out.push_str(after);
            return out;
        };
        let value = &after[..end];
        match mobi_resource_to_asset_url(value, storage, key_prefix) {
            Some(url) => out.push_str(&url),
            None => out.push_str(value),
        }
        out.push('"');
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Try to resolve a libmobi resource filename (`resource00001.jpg`) to an
/// `asset://` URL. Returns `None` for anything that doesn't look like a
/// raster image reference or whose key is not actually present in
/// `storage`, so non-image attributes and failed-write references both
/// pass through unchanged. The existence check is what prevents a
/// silently-dropped `put` from producing a broken asset URL.
fn mobi_resource_to_asset_url(
    value: &str,
    storage: &dyn Storage,
    key_prefix: &str,
) -> Option<String> {
    let rest = value.strip_prefix("resource")?;
    let (digits, ext) = rest.split_once('.')?;
    // libmobi always pads the numeric id to 5 digits.
    if digits.len() != 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" => {}
        _ => return None,
    }
    let key = format!("{key_prefix}/{value}");
    if !storage.exists(&key).unwrap_or(false) {
        return None;
    }
    let path = storage.local_path(&key).ok()?;
    let encoded = urlencoding::encode(&path.to_string_lossy()).into_owned();
    Some(format!("asset://localhost/{}", encoded))
}

/// Split a MOBI subject string into a list of genres. EXTH subject fields
/// can be either a single comma/semicolon-separated string or a single
/// untouched genre — we split conservatively and trim whitespace.
fn parse_subject_list(subject: Option<String>) -> Vec<String> {
    let Some(s) = subject else {
        return Vec::new();
    };
    s.split([';', ','])
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::LocalStorage;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn fixture(name: &str) -> Option<PathBuf> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src-tauri")
            .join("test-fixtures")
            .join(name);
        path.exists().then_some(path)
    }

    #[test]
    fn parse_mobi_metadata_extracts_title_and_author() {
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let meta = parse_mobi_metadata(path.to_str().unwrap()).expect("parse");
        assert!(meta.title.to_lowercase().contains("alice"));
        assert!(meta.author.to_lowercase().contains("carroll"));
        assert_eq!(meta.language, "en");
    }

    #[test]
    fn extract_cover_yields_non_empty_bytes() {
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let cover = extract_cover(path.to_str().unwrap())
            .expect("cover result")
            .expect("cover present");
        assert!(!cover.bytes.is_empty());
        assert!(
            matches!(cover.ext.as_str(), "jpg" | "png" | "gif" | "bmp"),
            "ext: {}",
            cover.ext
        );
    }

    #[test]
    fn get_chapter_list_kf8_yields_per_file_split() {
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let chapters = get_chapter_list(path.to_str().unwrap()).expect("chapters");
        assert!(
            chapters.len() > 1,
            "KF8 alice.mobi should split into multiple chapters, got {}",
            chapters.len()
        );
        assert_eq!(chapters[0].index, 0);
        assert!(chapters[0].href.starts_with("part"));
    }

    #[test]
    fn get_chapter_list_legacy_yields_single_chapter() {
        let Some(path) = fixture("alice-legacy.mobi") else {
            return;
        };
        let chapters = get_chapter_list(path.to_str().unwrap()).expect("chapters");
        assert_eq!(chapters.len(), 1, "legacy MOBI has one markup blob");
    }

    #[test]
    fn get_chapter_content_sanitizes_and_returns_html() {
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let html = get_chapter_content(path.to_str().unwrap(), 1, &storage, "bk").expect("chapter");
        // Ammonia strips <?xml?> / <html>/<head>/<body> wrappers, leaving
        // fragment-level HTML.
        assert!(!html.is_empty());
        assert!(
            !html.contains("<?xml"),
            "XML prologue should have been stripped"
        );
        assert!(
            !html.contains("<head>"),
            "head wrapper should have been stripped"
        );
    }

    #[test]
    fn get_chapter_word_counts_is_positive_for_body_chapter() {
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let counts = get_chapter_word_counts(path.to_str().unwrap()).expect("word counts");
        assert!(!counts.is_empty());
        // The cover-only first part has very few words; later body
        // chapters should have many more.
        assert!(
            counts.iter().any(|&c| c > 200),
            "expected at least one chapter with >200 words, got {:?}",
            &counts[..counts.len().min(5)]
        );
    }

    #[test]
    fn rewrite_mobi_image_refs_replaces_resource_urls() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        // Pre-seed a known image under the per-chapter key layout so the
        // rewriter finds it.
        storage
            .put("bk/0/resource00000.jpg", b"\xFF\xD8\xFFdata")
            .unwrap();

        let html = r#"<p><img src="resource00000.jpg" alt="x"/></p>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0");
        assert!(
            out.contains("asset://localhost/"),
            "expected asset:// URL, got {out}"
        );
        assert!(
            !out.contains("\"resource00000.jpg\""),
            "original reference should have been replaced, got {out}"
        );
    }

    #[test]
    fn rewrite_mobi_image_refs_skips_rewrite_when_asset_missing_from_storage() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        // Do not seed the image — simulates `storage.put` failing silently
        // earlier in `get_chapter_content`.
        let html = r#"<p><img src="resource00000.jpg" alt="x"/></p>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0");
        // Reference is left as-is so the Reader shows a broken-image
        // icon for the single failed asset instead of a bogus asset:// URL
        // pointing at a file that never landed on disk.
        assert!(out.contains("\"resource00000.jpg\""), "got {out}");
        assert!(!out.contains("asset://localhost"), "got {out}");
    }

    #[test]
    fn rewrite_mobi_image_refs_leaves_non_image_refs_alone() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let html = r#"<link href="flow00001.css"/><img src="resource00001.svg"/><img src="flow00004.svg"/>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0");
        // CSS and SVG references pass through untouched.
        assert!(out.contains("flow00001.css"));
        assert!(out.contains("flow00004.svg"));
        assert!(out.contains("resource00001.svg"));
        assert!(!out.contains("asset://localhost"));
    }

    #[test]
    fn parse_subject_list_splits_and_trims() {
        assert!(parse_subject_list(None).is_empty());
        assert_eq!(
            parse_subject_list(Some("Fantasy; Adventure".into())),
            vec!["Fantasy", "Adventure"]
        );
        assert_eq!(
            parse_subject_list(Some("Sci-fi, Space opera,  ".into())),
            vec!["Sci-fi", "Space opera"]
        );
        assert_eq!(parse_subject_list(Some("  ".into())), Vec::<String>::new());
    }

    #[test]
    fn mobi_resource_to_asset_url_rejects_non_image_extensions() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        assert!(mobi_resource_to_asset_url("resource00000.css", &storage, "bk/0").is_none());
        assert!(mobi_resource_to_asset_url("resource00000.svg", &storage, "bk/0").is_none());
        assert!(mobi_resource_to_asset_url("resource00.jpg", &storage, "bk/0").is_none());
        assert!(mobi_resource_to_asset_url("flow00000.jpg", &storage, "bk/0").is_none());
    }
}
