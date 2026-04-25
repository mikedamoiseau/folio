//! High-level adapter mapping libmobi output to Folio's EPUB-style model.
//!
//! The wrapper in [`super`] exposes libmobi primitives (parts, resources,
//! cover); this module composes them into the same interface the Reader
//! already uses for EPUBs — metadata, ordered chapters, sanitized HTML with
//! `asset://` image URLs, and per-chapter word counts.
//!
//! The module has no Tauri / IPC dependencies; it is consumed by both the
//! desktop commands and the OPDS web server.

use std::collections::HashMap;
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

    // Index image resources by their canonical filename (`resource00001.jpg`)
    // so the rewriter can look up only the ones the chapter actually
    // references. Writing every image for every chapter (the previous
    // behavior) causes on-disk amplification of ~N×M for an N-chapter /
    // M-image book; illustrated MOBI files can easily burn gigabytes of
    // library storage with mostly-duplicate copies.
    let image_resources: HashMap<String, &[u8]> = rawml
        .resources()
        .filter(|p| p.kind.is_image())
        .filter_map(|r| {
            let ext = r.kind.extension()?;
            Some((format!("resource{:05}.{ext}", r.uid), r.data))
        })
        .collect();

    let key_prefix = format!("{book_id}/{chapter_index}");
    Ok(rewrite_mobi_image_refs(
        &cleaned,
        storage,
        &key_prefix,
        &image_resources,
    ))
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
/// libmobi's `resource{NNNNN}.{ext}` naming, persist only the referenced
/// images to `storage`, and replace the references with
/// `asset://localhost/<url-encoded-local-path>` URLs.
///
/// Persisting inside the rewriter — as opposed to eagerly writing every
/// image in the rawml — prevents on-disk amplification: illustrated MOBI
/// books with N chapters and M images would otherwise store N×M copies
/// instead of M (at most, one per chapter that references the image).
///
/// This is a byte-level scanner rather than a real HTML parser for two
/// reasons: (a) the input is already ammonia-cleaned so we know tags and
/// attribute quoting are normalized, and (b) the naming convention is
/// deterministic and restrictive enough that a false positive would
/// require a literal `"resource00000.jpg"` string inside text content,
/// which isn't a realistic collision.
fn rewrite_mobi_image_refs(
    html: &str,
    storage: &dyn Storage,
    key_prefix: &str,
    image_resources: &HashMap<String, &[u8]>,
) -> String {
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
        match mobi_resource_to_asset_url(value, storage, key_prefix, image_resources) {
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
/// `asset://` URL, persisting the underlying bytes to `storage` on first
/// use. Returns `None` when the reference does not match libmobi's
/// naming, when there is no matching entry in `image_resources`, or when
/// the persist fails — in each case the caller leaves the original
/// reference untouched so the Reader shows a single broken-image icon
/// rather than emitting an `asset://` URL that points at a file that
/// never landed on disk.
fn mobi_resource_to_asset_url(
    value: &str,
    storage: &dyn Storage,
    key_prefix: &str,
    image_resources: &HashMap<String, &[u8]>,
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
    let bytes = image_resources.get(value)?;
    let key = format!("{key_prefix}/{value}");
    if !storage.exists(&key).unwrap_or(false) {
        if let Err(e) = storage.put(&key, bytes) {
            log::warn!("failed to persist MOBI image resource {key}: {e}");
            return None;
        }
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
        let bytes: &[u8] = b"\xFF\xD8\xFFdata";
        let mut resources: HashMap<String, &[u8]> = HashMap::new();
        resources.insert("resource00000.jpg".into(), bytes);

        let html = r#"<p><img src="resource00000.jpg" alt="x"/></p>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0", &resources);
        assert!(
            out.contains("asset://localhost/"),
            "expected asset:// URL, got {out}"
        );
        assert!(
            !out.contains("\"resource00000.jpg\""),
            "original reference should have been replaced, got {out}"
        );
        // Persisted under the per-chapter key as a side effect of the
        // rewrite.
        assert!(storage.exists("bk/0/resource00000.jpg").unwrap());
    }

    #[test]
    fn rewrite_mobi_image_refs_skips_rewrite_when_resource_not_in_rawml() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        // Empty resources map: the chapter HTML references
        // `resource00000.jpg` but the MOBI rawml didn't yield a matching
        // entry (corrupt book, or a stale reference left over from a
        // different language split). The reference is left as-is so the
        // Reader shows a broken-image icon rather than a bogus
        // `asset://` URL pointing at nothing.
        let resources: HashMap<String, &[u8]> = HashMap::new();
        let html = r#"<p><img src="resource00000.jpg" alt="x"/></p>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0", &resources);
        assert!(out.contains("\"resource00000.jpg\""), "got {out}");
        assert!(!out.contains("asset://localhost"), "got {out}");
        // Nothing was persisted — the chapter doesn't own this image.
        assert!(!storage.exists("bk/0/resource00000.jpg").unwrap());
    }

    #[test]
    fn rewrite_mobi_image_refs_writes_only_images_referenced_by_chapter() {
        // Regression test for the per-chapter image duplication bug:
        // a book with dozens of images would bulk-write every one into
        // every chapter dir on every `get_chapter_content` call. The
        // fix persists only images the chapter HTML actually references.
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let img0: &[u8] = b"\xFF\xD8\xFFzero";
        let img1: &[u8] = b"\xFF\xD8\xFFone";
        let img2: &[u8] = b"\xFF\xD8\xFFtwo";
        let mut resources: HashMap<String, &[u8]> = HashMap::new();
        resources.insert("resource00000.jpg".into(), img0);
        resources.insert("resource00001.jpg".into(), img1);
        resources.insert("resource00002.jpg".into(), img2);

        let html = r#"<p><img src="resource00001.jpg"/></p>"#;
        let _ = rewrite_mobi_image_refs(html, &storage, "bk/5", &resources);

        assert!(
            !storage.exists("bk/5/resource00000.jpg").unwrap(),
            "unreferenced image must not be persisted"
        );
        assert!(
            storage.exists("bk/5/resource00001.jpg").unwrap(),
            "referenced image must be persisted"
        );
        assert!(
            !storage.exists("bk/5/resource00002.jpg").unwrap(),
            "unreferenced image must not be persisted"
        );
    }

    #[test]
    fn rewrite_mobi_image_refs_persists_each_image_once_even_when_referenced_twice() {
        // A chapter that references the same image twice should still
        // only call `put` once — the `exists` check is what makes this
        // idempotent and avoids redundant disk I/O.
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let bytes: &[u8] = b"\xFF\xD8\xFFtwice";
        let mut resources: HashMap<String, &[u8]> = HashMap::new();
        resources.insert("resource00001.jpg".into(), bytes);

        let html = r#"<img src="resource00001.jpg"/><img src="resource00001.jpg"/>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0", &resources);

        assert!(storage.exists("bk/0/resource00001.jpg").unwrap());
        // Both references rewritten to an asset URL.
        assert_eq!(out.matches("asset://localhost/").count(), 2);
    }

    #[test]
    fn rewrite_mobi_image_refs_leaves_non_image_refs_alone() {
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let resources: HashMap<String, &[u8]> = HashMap::new();
        let html = r#"<link href="flow00001.css"/><img src="resource00001.svg"/><img src="flow00004.svg"/>"#;
        let out = rewrite_mobi_image_refs(html, &storage, "bk/0", &resources);
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
        let bytes: &[u8] = b"data";
        let mut resources: HashMap<String, &[u8]> = HashMap::new();
        resources.insert("resource00000.css".into(), bytes);
        resources.insert("resource00000.svg".into(), bytes);
        resources.insert("resource00.jpg".into(), bytes);
        resources.insert("flow00000.jpg".into(), bytes);
        assert!(
            mobi_resource_to_asset_url("resource00000.css", &storage, "bk/0", &resources).is_none()
        );
        assert!(
            mobi_resource_to_asset_url("resource00000.svg", &storage, "bk/0", &resources).is_none()
        );
        assert!(
            mobi_resource_to_asset_url("resource00.jpg", &storage, "bk/0", &resources).is_none()
        );
        assert!(
            mobi_resource_to_asset_url("flow00000.jpg", &storage, "bk/0", &resources).is_none()
        );
    }

    #[test]
    fn get_chapter_content_only_persists_referenced_images_per_chapter() {
        // End-to-end version of the duplication regression test: drive
        // `get_chapter_content` over every MOBI chapter and confirm the
        // total image count in storage is bounded by the per-chapter
        // references, not by N_chapters × N_images.
        let Some(path) = fixture("alice.mobi") else {
            return;
        };
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let book_id = "bk";

        let chapter_count = get_chapter_list(path.to_str().unwrap())
            .expect("chapters")
            .len();
        let total_images = {
            let book = MobiBook::open(&path).expect("open MOBI");
            let rawml = book.rawml().expect("rawml");
            rawml.resources().filter(|p| p.kind.is_image()).count()
        };

        for ch in 0..chapter_count {
            let _ = get_chapter_content(path.to_str().unwrap(), ch, &storage, book_id)
                .expect("get_chapter_content");
        }

        let keys = storage.list(&format!("{book_id}/")).expect("list storage");
        let worst_case_amplified = chapter_count * total_images;
        assert!(
            keys.len() < worst_case_amplified,
            "after fix, total image writes ({}) should be strictly less than \
             the worst-case duplicated count ({})",
            keys.len(),
            worst_case_amplified
        );
    }

    /// End-to-end smoke test that drives the full MOBI pipeline the Reader
    /// exercises at runtime: metadata, cover, chapter list, sanitized HTML
    /// content, word counts, and full-text search. If any single step
    /// regresses this test fails with a pointed message rather than
    /// surfacing at import time in the desktop app.
    ///
    /// Both MOBI variants are covered: legacy Mobipocket (`alice-legacy.mobi`,
    /// file version 6) and KF8 / AZW3 (`alice.mobi`, file version 8). Run
    /// `scripts/fetch-mobi-test-corpus.sh` to populate the fixtures before
    /// running the test; without the fixtures the test is skipped.
    fn run_full_pipeline_smoke(fixture_name: &str, expected_file_version: usize) {
        use crate::search::search_chapters;
        use crate::storage::LocalStorage;

        let Some(path) = fixture(fixture_name) else {
            eprintln!(
                "skipping: {fixture_name} not present — run scripts/fetch-mobi-test-corpus.sh"
            );
            return;
        };
        let path_str = path.to_str().expect("fixture path is UTF-8");

        // 1. Open and sanity-check the file variant. Mismatched file
        //    versions almost always mean the fetch script pulled the
        //    wrong URL (KF8 vs legacy are both served under `.mobi`).
        let book = MobiBook::open(&path).expect("open MOBI");
        assert_eq!(
            book.file_version(),
            expected_file_version,
            "{fixture_name}: expected file version {expected_file_version}, got {}",
            book.file_version()
        );

        // 2. Metadata round-trip. Gutenberg ships Alice with title and
        //    author populated; an empty string means the EXTH record
        //    didn't decode and downstream imports would show the
        //    filename as the title.
        let meta = parse_mobi_metadata(path_str).expect("parse metadata");
        assert!(
            meta.title.to_lowercase().contains("alice"),
            "title missing 'alice': {:?}",
            meta.title
        );
        assert!(
            meta.author.to_lowercase().contains("carroll"),
            "author missing 'carroll': {:?}",
            meta.author
        );

        // 3. Cover extraction. Alice ships with a cover; a missing one
        //    here means EXTH traversal broke.
        let cover = extract_cover(path_str)
            .expect("cover result")
            .expect("alice ships with a cover");
        assert!(!cover.bytes.is_empty(), "cover bytes are empty");

        // 4. Chapter list. Both variants must produce at least one
        //    chapter; KF8 splits into multiple markup parts via SKEL/FRAG.
        let chapters = get_chapter_list(path_str).expect("chapter list");
        assert!(!chapters.is_empty(), "chapter list is empty");

        // 5. Chapter content is fragment-level sanitized HTML with the
        //    XML prologue and document wrappers stripped.
        let dir = tempdir().unwrap();
        let storage = LocalStorage::new(dir.path().to_path_buf()).unwrap();
        let book_id = "smoke-book";
        let html = get_chapter_content(path_str, 0, &storage, book_id).expect("chapter 0");
        assert!(!html.is_empty(), "chapter 0 is empty");
        assert!(
            !html.contains("<?xml"),
            "chapter 0 still has XML prologue: {html:.200}"
        );

        // 6. Word counts are populated — the Reader uses these to paint
        //    the progress bar. At least one chapter should be > 50
        //    words (Alice is a novel).
        let counts = get_chapter_word_counts(path_str).expect("word counts");
        assert_eq!(counts.len(), chapters.len(), "word counts ≠ chapters");
        assert!(
            counts.iter().any(|&c| c > 50),
            "no chapter with > 50 words: {counts:?}"
        );

        // 7. Search surface: "Alice" must match in at least one chapter.
        //    Uses the same aggregator the MOBI arm of `search_book_content`
        //    uses in production, so a regression there is caught here.
        let results = search_chapters(0..(chapters.len() as u32), "Alice", book_id, |idx| {
            get_chapter_content(path_str, idx as usize, &storage, book_id)
        })
        .expect("search");
        assert!(
            !results.is_empty(),
            "'Alice' not found in any chapter of {fixture_name}"
        );
    }

    #[test]
    fn mobi_kf8_pipeline_smoke() {
        run_full_pipeline_smoke("alice.mobi", 8);
    }

    #[test]
    fn mobi_legacy_pipeline_smoke() {
        run_full_pipeline_smoke("alice-legacy.mobi", 6);
    }
}
