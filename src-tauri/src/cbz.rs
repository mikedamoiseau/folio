use base64::{engine::general_purpose, Engine as _};
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
}

fn collect_image_names(archive: &mut ZipArchive<std::fs::File>) -> Vec<String> {
    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let file = archive.by_index(i).ok()?;
            let name = file.name().to_string();
            // Skip macOS resource forks, directory entries, and non-image files.
            if name.starts_with("__MACOSX/") || name.ends_with('/') || !is_image(&name) {
                return None;
            }
            Some(name)
        })
        .collect();
    names.sort();
    names
}

fn open_archive(path: &str) -> Result<ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
    ZipArchive::new(file).map_err(|e| format!("Not a valid ZIP/CBZ archive: {e}"))
}

#[derive(Debug)]
pub struct CbzMeta {
    pub title: String,
    pub page_count: u32,
    pub author: Option<String>,
    pub year: Option<u16>,
    pub series: Option<String>,
    pub volume: Option<u32>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub summary: Option<String>,
    pub genre: Option<String>,
}

/// Opens a CBZ archive and returns its title (filename stem) and page count.
/// Also parses ComicInfo.xml if present for additional metadata.
/// Returns an error if the file is not a valid ZIP or contains no supported images.
pub fn import_cbz(path: &str) -> Result<CbzMeta, String> {
    let mut archive = open_archive(path)?;
    let images = collect_image_names(&mut archive);
    if images.is_empty() {
        return Err("CBZ archive contains no supported image files".to_string());
    }
    let title = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Try to parse ComicInfo.xml for metadata
    let mut author = None;
    let mut year = None;
    let mut comic_title = None;
    let mut series = None;
    let mut volume = None;
    let mut language = None;
    let mut publisher = None;
    let mut summary = None;
    let mut genre = None;
    if let Ok(mut entry) = archive.by_name("ComicInfo.xml") {
        let mut xml = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut xml).is_ok() {
            if let Some(writer) = crate::epub::extract_tag_text(&xml, "Writer") {
                author = Some(writer.to_string());
            }
            if let Some(t) = crate::epub::extract_tag_text(&xml, "Title") {
                comic_title = Some(t.to_string());
            }
            if let Some(y) = crate::epub::extract_tag_text(&xml, "Year") {
                year = y.parse::<u16>().ok();
            }
            series = crate::epub::extract_tag_text(&xml, "Series").map(|s| s.to_string());
            volume =
                crate::epub::extract_tag_text(&xml, "Volume").and_then(|v| v.parse::<u32>().ok());
            language = crate::epub::extract_tag_text(&xml, "LanguageISO").map(|s| s.to_string());
            publisher = crate::epub::extract_tag_text(&xml, "Publisher").map(|s| s.to_string());
            summary = crate::epub::extract_tag_text(&xml, "Summary").map(|s| s.to_string());
            genre = crate::epub::extract_tag_text(&xml, "Genre").map(|s| s.to_string());
        }
    }

    Ok(CbzMeta {
        title: comic_title.unwrap_or(title),
        page_count: images.len() as u32,
        author,
        year,
        series,
        volume,
        language,
        publisher,
        summary,
        genre,
    })
}

/// Returns the number of image pages in a CBZ archive.
pub fn get_page_count(path: &str) -> Result<u32, String> {
    let mut archive = open_archive(path)?;
    let images = collect_image_names(&mut archive);
    Ok(images.len() as u32)
}

/// Extracts a single page image and returns it as a base64 data URI
/// (e.g. `data:image/jpeg;base64,...`).
pub fn get_page_image(path: &str, page_index: u32) -> Result<String, String> {
    let mut archive = open_archive(path)?;
    let images = collect_image_names(&mut archive);

    let name = images
        .get(page_index as usize)
        .ok_or_else(|| {
            format!(
                "Page index {page_index} out of range (total pages: {})",
                images.len()
            )
        })?
        .clone();

    let mut entry = archive
        .by_name(&name)
        .map_err(|e| format!("Cannot read page '{name}': {e}"))?;

    let mut data = Vec::new();
    entry
        .read_to_end(&mut data)
        .map_err(|e| format!("Cannot read image data: {e}"))?;

    let lower = name.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    };

    let encoded = general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn is_image_accepts_common_formats() {
        assert!(is_image("page01.jpg"));
        assert!(is_image("page02.jpeg"));
        assert!(is_image("page03.png"));
        assert!(is_image("page04.webp"));
        assert!(is_image("page05.gif"));
    }

    #[test]
    fn is_image_case_insensitive() {
        assert!(is_image("cover.JPG"));
        assert!(is_image("cover.PNG"));
        assert!(is_image("cover.Webp"));
    }

    #[test]
    fn is_image_rejects_non_images() {
        assert!(!is_image("readme.txt"));
        assert!(!is_image("metadata.xml"));
        assert!(!is_image("comic.cbz"));
        assert!(!is_image(""));
    }

    #[test]
    fn collect_image_names_filters_and_sorts() {
        // Create a temp CBZ with known contents
        let dir = tempfile::tempdir().unwrap();
        let cbz_path = dir.path().join("test.cbz");
        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();

            // Add images in unsorted order
            zip.start_file("page03.jpg", options).unwrap();
            zip.write_all(b"fake jpg 3").unwrap();
            zip.start_file("page01.jpg", options).unwrap();
            zip.write_all(b"fake jpg 1").unwrap();
            zip.start_file("page02.png", options).unwrap();
            zip.write_all(b"fake png 2").unwrap();

            // Add non-image and macOS junk
            zip.start_file("__MACOSX/.DS_Store", options).unwrap();
            zip.write_all(b"junk").unwrap();
            zip.start_file("metadata.xml", options).unwrap();
            zip.write_all(b"<xml/>").unwrap();

            zip.finish().unwrap();
        }

        let mut archive = open_archive(cbz_path.to_str().unwrap()).unwrap();
        let names = collect_image_names(&mut archive);

        assert_eq!(names, vec!["page01.jpg", "page02.png", "page03.jpg"]);
    }

    #[test]
    fn import_cbz_extracts_title_from_filename() {
        let dir = tempfile::tempdir().unwrap();
        let cbz_path = dir.path().join("My Comic Book.cbz");
        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("page01.jpg", options).unwrap();
            zip.write_all(b"fake").unwrap();
            zip.finish().unwrap();
        }

        let meta = import_cbz(cbz_path.to_str().unwrap()).unwrap();
        assert_eq!(meta.title, "My Comic Book");
        assert_eq!(meta.page_count, 1);
    }

    #[test]
    fn import_cbz_empty_archive_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cbz_path = dir.path().join("empty.cbz");
        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let zip = zip::ZipWriter::new(file);
            zip.finish().unwrap();
        }

        let result = import_cbz(cbz_path.to_str().unwrap());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no supported image files"));
    }

    #[test]
    fn get_page_image_returns_data_uri() {
        let dir = tempfile::tempdir().unwrap();
        let cbz_path = dir.path().join("test.cbz");
        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("page01.png", options).unwrap();
            zip.write_all(b"fake png data").unwrap();
            zip.finish().unwrap();
        }

        let uri = get_page_image(cbz_path.to_str().unwrap(), 0).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn get_page_image_out_of_range() {
        let dir = tempfile::tempdir().unwrap();
        let cbz_path = dir.path().join("test.cbz");
        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("page01.jpg", options).unwrap();
            zip.write_all(b"fake").unwrap();
            zip.finish().unwrap();
        }

        let result = get_page_image(cbz_path.to_str().unwrap(), 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("out of range"));
    }
}
