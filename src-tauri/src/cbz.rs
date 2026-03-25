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

pub struct CbzMeta {
    pub title: String,
    pub page_count: u32,
}

/// Opens a CBZ archive and returns its title (filename stem) and page count.
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
    Ok(CbzMeta {
        title,
        page_count: images.len() as u32,
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
