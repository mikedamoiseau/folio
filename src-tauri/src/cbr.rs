use base64::{engine::general_purpose, Engine as _};
use std::path::Path;

fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
}

fn mime_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// Collect sorted image entry names from a RAR archive.
fn collect_image_names(path: &str) -> Result<Vec<String>, String> {
    let archive = unrar::Archive::new(path)
        .open_for_listing()
        .map_err(|e| format!("Cannot open RAR archive: {e}"))?;

    let mut names: Vec<String> = archive
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.filename.to_string_lossy().to_string();
            if entry.is_directory() || name.starts_with("__MACOSX/") || !is_image(&name) {
                return None;
            }
            Some(name)
        })
        .collect();

    names.sort();
    Ok(names)
}

pub struct CbrMeta {
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

/// Extract ComicInfo.xml content from a RAR archive, if present.
fn extract_comic_info(path: &str) -> Option<String> {
    let archive = unrar::Archive::new(path).open_for_processing().ok()?;
    let mut cursor = archive;
    loop {
        let header = cursor.read_header().ok()?;
        match header {
            None => return None,
            Some(entry) => {
                let name = entry.entry().filename.to_string_lossy().to_string();
                if name == "ComicInfo.xml" || name.ends_with("/ComicInfo.xml") {
                    let (data, _) = entry.read().ok()?;
                    return String::from_utf8(data).ok();
                } else {
                    cursor = entry.skip().ok()?;
                }
            }
        }
    }
}

pub fn import_cbr(path: &str) -> Result<CbrMeta, String> {
    let images = collect_image_names(path)?;
    if images.is_empty() {
        return Err("CBR archive contains no supported image files".to_string());
    }
    let title = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let mut author = None;
    let mut year = None;
    let mut comic_title = None;
    let mut series = None;
    let mut volume = None;
    let mut language = None;
    let mut publisher = None;
    let mut summary = None;
    let mut genre = None;

    if let Some(xml) = extract_comic_info(path) {
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
        volume = crate::epub::extract_tag_text(&xml, "Volume").and_then(|v| v.parse::<u32>().ok());
        language = crate::epub::extract_tag_text(&xml, "LanguageISO").map(|s| s.to_string());
        publisher = crate::epub::extract_tag_text(&xml, "Publisher").map(|s| s.to_string());
        summary = crate::epub::extract_tag_text(&xml, "Summary").map(|s| s.to_string());
        genre = crate::epub::extract_tag_text(&xml, "Genre").map(|s| s.to_string());
    }

    Ok(CbrMeta {
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

pub fn get_page_count(path: &str) -> Result<u32, String> {
    let images = collect_image_names(path)?;
    Ok(images.len() as u32)
}

pub fn get_page_image(path: &str, page_index: u32) -> Result<String, String> {
    let images = collect_image_names(path)?;
    let target_name = images
        .get(page_index as usize)
        .ok_or_else(|| {
            format!(
                "Page index {page_index} out of range (total pages: {})",
                images.len()
            )
        })?
        .clone();

    // Open for processing — walk entries until we find the target, then .read() it
    let archive = unrar::Archive::new(path)
        .open_for_processing()
        .map_err(|e| format!("Cannot open RAR archive: {e}"))?;

    let mut cursor = archive;
    loop {
        let header = cursor
            .read_header()
            .map_err(|e| format!("Error reading RAR entry: {e}"))?;
        match header {
            None => return Err(format!("Page '{}' not found in archive", target_name)),
            Some(entry) => {
                let name = entry.entry().filename.to_string_lossy().to_string();
                if name == target_name {
                    let (data, _) = entry
                        .read()
                        .map_err(|e| format!("Cannot extract page: {e}"))?;
                    let mime = mime_for(&target_name);
                    let encoded = general_purpose::STANDARD.encode(&data);
                    return Ok(format!("data:{mime};base64,{encoded}"));
                } else {
                    cursor = entry
                        .skip()
                        .map_err(|e| format!("Error skipping RAR entry: {e}"))?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_image_accepts_common_formats() {
        assert!(is_image("page.jpg"));
        assert!(is_image("page.jpeg"));
        assert!(is_image("page.png"));
        assert!(is_image("page.webp"));
        assert!(is_image("page.gif"));
    }

    #[test]
    fn is_image_case_insensitive() {
        assert!(is_image("COVER.JPG"));
        assert!(is_image("Cover.PNG"));
    }

    #[test]
    fn is_image_rejects_non_images() {
        assert!(!is_image("readme.txt"));
        assert!(!is_image("data.xml"));
        assert!(!is_image(""));
    }

    #[test]
    fn mime_for_png() {
        assert_eq!(mime_for("page.png"), "image/png");
        assert_eq!(mime_for("page.PNG"), "image/png");
    }

    #[test]
    fn mime_for_webp() {
        assert_eq!(mime_for("page.webp"), "image/webp");
    }

    #[test]
    fn mime_for_gif() {
        assert_eq!(mime_for("page.gif"), "image/gif");
    }

    #[test]
    fn mime_for_jpeg_default() {
        assert_eq!(mime_for("page.jpg"), "image/jpeg");
        assert_eq!(mime_for("page.jpeg"), "image/jpeg");
        // Unknown extension defaults to jpeg
        assert_eq!(mime_for("page.bmp"), "image/jpeg");
    }
}
