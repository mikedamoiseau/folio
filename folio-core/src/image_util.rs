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
//!
//! Animation-capable formats (GIF, WebP) bypass resize entirely so
//! multi-frame pages keep their frames. Images with alpha are
//! composited over a white background before JPEG encode because
//! JPEG has no alpha channel — a naive RGB drop would render
//! transparent regions as black.

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
/// - the source format is GIF or WebP (may carry animation frames)
///
/// Resize case:
/// - decode, downscale to `(target_width, scaled_height)` via Lanczos3
/// - if the decoded image has alpha, composite over white
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

    // GIF/WebP may carry multiple frames; `load_from_memory` decodes
    // only the first one, so resizing would silently drop animation.
    // Static comics in these formats are rare enough that paying the
    // full transfer cost is the right trade-off vs corrupting content.
    if matches!(
        reader.format(),
        Some(image::ImageFormat::Gif) | Some(image::ImageFormat::WebP)
    ) {
        return Ok((bytes, current_mime));
    }

    let (src_w, src_h) = reader
        .into_dimensions()
        .map_err(|e| FolioError::invalid(format!("cannot read image dimensions: {e}")))?;
    if src_w <= target {
        return Ok((bytes, current_mime));
    }

    let img = image::load_from_memory(&bytes)
        .map_err(|e| FolioError::invalid(format!("image decode failed: {e}")))?;

    let target_h = (((src_h as u64) * (target as u64)) / (src_w as u64)).max(1) as u32;
    let resized = img.resize_exact(target, target_h, image::imageops::FilterType::Lanczos3);

    // JPEG has no alpha; transparent pixels must be composited over a
    // known background or they decode as black in the encoder output.
    // White matches typical comic-page expectations.
    let rgb = if resized.color().has_alpha() {
        composite_over_white(&resized)
    } else {
        resized.to_rgb8()
    };

    let mut out: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .encode_image(&rgb)
        .map_err(|e| FolioError::internal(format!("JPEG re-encode failed: {e}")))?;

    Ok((out, "image/jpeg".to_string()))
}

fn composite_over_white(img: &image::DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let af = a as u32;
        let inv = 255 - af;
        let cr = ((r as u32 * af + 255 * inv) / 255) as u8;
        let cg = ((g as u32 * af + 255 * inv) / 255) as u8;
        let cb = ((b as u32 * af + 255 * inv) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([cr, cg, cb]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

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

    /// Fully transparent left half, opaque red right half.
    fn encode_png_with_transparency(w: u32, h: u32) -> Vec<u8> {
        let buf: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_fn(w, h, |x, _y| {
            if x < w / 2 {
                Rgba([0, 0, 0, 0])
            } else {
                Rgba([200, 30, 30, 255])
            }
        });
        let mut out = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        use image::ImageEncoder;
        encoder
            .write_image(buf.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn encode_gif(w: u32, h: u32) -> Vec<u8> {
        let buf: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([((x + y) % 256) as u8, 10, 20, 255]));
        let mut out = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
            let frame = image::Frame::new(buf);
            encoder.encode_frame(frame).unwrap();
        }
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

    #[test]
    fn transparent_png_resized_composites_over_white() {
        // 1000 wide → resize to 400 → transparent half must render white,
        // not black, in the resulting JPEG.
        let src = encode_png_with_transparency(1000, 400);
        let (out, mime) = maybe_resize_to_jpeg(src, "image/png".into(), Some(400)).unwrap();
        assert_eq!(mime, "image/jpeg");

        let decoded = image::load_from_memory(&out).unwrap().to_rgb8();
        let (w, h) = decoded.dimensions();
        assert_eq!(w, 400);

        // Sample well inside the (originally transparent) left quarter.
        let px = decoded.get_pixel(w / 8, h / 2).0;
        assert!(
            px[0] > 220 && px[1] > 220 && px[2] > 220,
            "transparent region should composite near white, got {px:?}"
        );
    }

    #[test]
    fn gif_passthrough_even_when_wider_than_target() {
        // Animation-capable formats must not be transcoded — resizing
        // would drop all but the first frame.
        let src = encode_gif(1200, 800);
        let (out, mime) = maybe_resize_to_jpeg(src.clone(), "image/gif".into(), Some(500)).unwrap();
        assert_eq!(out, src, "GIF bytes must be unchanged");
        assert_eq!(mime, "image/gif");
    }
}
