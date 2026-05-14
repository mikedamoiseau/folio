//! Image resize utilities shared across page-image readers.
//!
//! Comic-format pages (CBZ / CBR) ship the original image bytes from the
//! archive — a 4000×6000 px scan can easily weigh 5–10 MB even after
//! archive-level deflate. Sending that across IPC and decoding it in a
//! browser viewport that is at most 1600 px wide wastes memory, CPU, and
//! transfer time at every page turn.
//!
//! [`maybe_resize_to_jpeg`] is a single entry point that callers use to
//! optionally clamp page width to a viewport target. When the caller
//! passes `None`, or the source is already at or below the target,
//! bytes pass through untouched (keeping the original mime). When the
//! source is wider than the target, the image is decoded, downscaled
//! with Lanczos3, and re-encoded as JPEG quality 90 — the same encoder
//! settings the PDF render path already uses.

use crate::error::{FolioError, FolioResult};
use std::io::Cursor;

/// Re-encode quality used when a downscale happens. Matches PDF render path.
const JPEG_QUALITY: u8 = 90;

/// Clamp page image width to `target_width` when both are known and the
/// source is wider. Returns the (possibly transformed) bytes + mime.
///
/// Pass-through cases (returns input unchanged):
/// - `target_width` is `None` or `Some(0)`
/// - the source image width is already ≤ `target_width`
///
/// Resize case:
/// - decode, downscale to `(target_width, scaled_height)` via Lanczos3
/// - re-encode as JPEG quality 90; output mime is `image/jpeg`
pub fn maybe_resize_to_jpeg(
    bytes: Vec<u8>,
    current_mime: String,
    target_width: Option<u32>,
) -> FolioResult<(Vec<u8>, String)> {
    let Some(target) = target_width else {
        return Ok((bytes, current_mime));
    };
    if target == 0 {
        return Ok((bytes, current_mime));
    }

    // Cheap dimension probe — avoids a full decode when we're already
    // below the target width.
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| FolioError::invalid(format!("cannot probe image format: {e}")))?;
    let (src_w, src_h) = reader
        .into_dimensions()
        .map_err(|e| FolioError::invalid(format!("cannot read image dimensions: {e}")))?;
    if src_w <= target {
        return Ok((bytes, current_mime));
    }

    let img = image::load_from_memory(&bytes)
        .map_err(|e| FolioError::invalid(format!("image decode failed: {e}")))?;

    // Preserve aspect ratio. `resize_exact` lets us drop the alpha channel
    // cleanly via `to_rgb8` below; `resize` would keep the original color
    // space and complicate the JPEG encoder call.
    let target_h = (((src_h as u64) * (target as u64)) / (src_w as u64)).max(1) as u32;
    let resized = img.resize_exact(target, target_h, image::imageops::FilterType::Lanczos3);

    let mut out: Vec<u8> = Vec::new();
    let rgb = resized.to_rgb8();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .encode_image(&rgb)
        .map_err(|e| FolioError::internal(format!("JPEG re-encode failed: {e}")))?;

    Ok((out, "image/jpeg".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn encode_jpeg(w: u32, h: u32) -> Vec<u8> {
        let buf: ImageBuffer<Rgb<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([((x + y) % 256) as u8, 0, 0]));
        let mut out = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        encoder.encode_image(&buf).unwrap();
        out
    }

    fn encode_png(w: u32, h: u32) -> Vec<u8> {
        let buf: ImageBuffer<Rgb<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([0, ((x ^ y) % 256) as u8, 0]));
        let mut out = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        use image::ImageEncoder;
        encoder
            .write_image(buf.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn dims_of(bytes: &[u8]) -> (u32, u32) {
        image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap()
    }

    #[test]
    fn passthrough_when_target_is_none() {
        let src = encode_jpeg(1000, 1500);
        let (out, mime) = maybe_resize_to_jpeg(src.clone(), "image/jpeg".into(), None).unwrap();
        assert_eq!(out, src);
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn passthrough_when_target_is_zero() {
        let src = encode_jpeg(1000, 1500);
        let (out, mime) = maybe_resize_to_jpeg(src.clone(), "image/jpeg".into(), Some(0)).unwrap();
        assert_eq!(out, src);
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn passthrough_when_source_already_below_target() {
        let src = encode_jpeg(800, 1200);
        let (out, mime) =
            maybe_resize_to_jpeg(src.clone(), "image/jpeg".into(), Some(1000)).unwrap();
        assert_eq!(out, src, "bytes must be unchanged when source ≤ target");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn passthrough_when_source_equals_target_exactly() {
        let src = encode_jpeg(1000, 1500);
        let (out, _mime) =
            maybe_resize_to_jpeg(src.clone(), "image/jpeg".into(), Some(1000)).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn downscales_jpeg_and_preserves_aspect() {
        let src = encode_jpeg(2400, 3600);
        let (out, mime) = maybe_resize_to_jpeg(src, "image/jpeg".into(), Some(800)).unwrap();
        assert_eq!(mime, "image/jpeg");
        let (w, h) = dims_of(&out);
        assert_eq!(w, 800);
        // 2400×3600 → aspect 1.5; 800 wide → 1200 tall.
        assert_eq!(h, 1200);
    }

    #[test]
    fn downscaling_png_transcodes_to_jpeg() {
        let src = encode_png(2000, 1000);
        let (out, mime) = maybe_resize_to_jpeg(src, "image/png".into(), Some(500)).unwrap();
        assert_eq!(mime, "image/jpeg", "downscale always re-encodes as JPEG");
        let (w, _h) = dims_of(&out);
        assert_eq!(w, 500);
    }

    #[test]
    fn smaller_output_when_significantly_downscaled() {
        let src = encode_jpeg(3000, 4500);
        let src_len = src.len();
        let (out, _mime) = maybe_resize_to_jpeg(src, "image/jpeg".into(), Some(600)).unwrap();
        assert!(
            out.len() < src_len,
            "downscaled output should be smaller; src={src_len}B out={}B",
            out.len()
        );
    }

    #[test]
    fn invalid_bytes_return_invalid_error() {
        let result = maybe_resize_to_jpeg(b"not an image".to_vec(), "image/jpeg".into(), Some(500));
        assert!(matches!(result, Err(FolioError::InvalidInput { .. })));
    }
}
