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
    Ok(CbrMeta {
        title,
        page_count: images.len() as u32,
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
