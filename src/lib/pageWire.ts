/**
 * Wire format mirror for the binary page-image Tauri commands.
 *
 * The backend appends a single mime-tag byte at the **end** of the
 * payload (see `src-tauri/src/page_wire.rs`). Constants below must
 * stay in lockstep with the Rust counterparts; the test suite asserts
 * round-trip parity against fixtures the backend emits.
 *
 * The transport carries raw image bytes, not base64 — so we slice off
 * the tag, build a `Blob`, and hand the caller a `URL.createObjectURL`
 * that can be assigned straight to `<img src>`. The caller owns the
 * URL's lifetime and must call `URL.revokeObjectURL` once the image
 * no longer needs to display (component unmount, cache eviction).
 */
export const MIME_TAG_JPEG = 0;
export const MIME_TAG_PNG = 1;
export const MIME_TAG_WEBP = 2;
export const MIME_TAG_GIF = 3;

const TAG_TO_MIME: Record<number, string> = {
  [MIME_TAG_JPEG]: "image/jpeg",
  [MIME_TAG_PNG]: "image/png",
  [MIME_TAG_WEBP]: "image/webp",
  [MIME_TAG_GIF]: "image/gif",
};

/** Decode the tag byte into a content-type string. Unknown tags fall back to JPEG. */
export function mimeFromTag(tag: number): string {
  return TAG_TO_MIME[tag] ?? "image/jpeg";
}

/**
 * Parse a wire-format response into a Blob URL.
 *
 * @param payload - bytes returned by `get_*_page_bytes`. Last byte is the mime tag.
 * @returns object URL + the mime that was decoded (for logging / tests)
 *
 * Throws if the payload is empty — a zero-byte response can't carry a tag.
 */
export function blobUrlFromBytes(payload: ArrayBuffer): { url: string; mime: string } {
  if (payload.byteLength < 1) {
    throw new Error("Empty page-bytes payload — missing mime tag");
  }
  const bytes = new Uint8Array(payload);
  const tag = bytes[bytes.byteLength - 1];
  const mime = mimeFromTag(tag);
  // .slice copies; .subarray returns a view sharing the same buffer.
  // Blob accepts views, so subarray is the cheaper choice and keeps GC
  // happy when we're cycling through 5–10 MB pages on every page turn.
  const imageBytes = bytes.subarray(0, bytes.byteLength - 1);
  const url = URL.createObjectURL(new Blob([imageBytes], { type: mime }));
  return { url, mime };
}
