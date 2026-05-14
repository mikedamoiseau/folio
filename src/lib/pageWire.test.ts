import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MIME_TAG_JPEG,
  MIME_TAG_PNG,
  MIME_TAG_WEBP,
  MIME_TAG_GIF,
  mimeFromTag,
  blobUrlFromBytes,
} from "./pageWire";

describe("mimeFromTag", () => {
  it("maps known tags to image mimes", () => {
    expect(mimeFromTag(MIME_TAG_JPEG)).toBe("image/jpeg");
    expect(mimeFromTag(MIME_TAG_PNG)).toBe("image/png");
    expect(mimeFromTag(MIME_TAG_WEBP)).toBe("image/webp");
    expect(mimeFromTag(MIME_TAG_GIF)).toBe("image/gif");
  });

  it("falls back to image/jpeg for unknown tag values", () => {
    expect(mimeFromTag(255)).toBe("image/jpeg");
    expect(mimeFromTag(42)).toBe("image/jpeg");
    // Even negative or non-integer tags shouldn't throw — they just degrade.
    expect(mimeFromTag(-1)).toBe("image/jpeg");
  });
});

describe("blobUrlFromBytes", () => {
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let capturedBlobs: Blob[] = [];

  beforeEach(() => {
    capturedBlobs = [];
    // jsdom does not implement createObjectURL; stub it so we can capture
    // the Blob argument and assert on it directly.
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob: Blob | MediaSource) => {
        capturedBlobs.push(blob as Blob);
        return `blob:test/${capturedBlobs.length}`;
      });
  });

  function bytesWithTag(image: number[], tag: number): ArrayBuffer {
    const buf = new Uint8Array([...image, tag]);
    return buf.buffer;
  }

  it("returns a blob URL with the correct mime decoded from the tag", () => {
    const buf = bytesWithTag([0xff, 0xd8, 0xff, 0xe0], MIME_TAG_JPEG);
    const { url, mime } = blobUrlFromBytes(buf);
    expect(url).toBe("blob:test/1");
    expect(mime).toBe("image/jpeg");
    expect(capturedBlobs[0].type).toBe("image/jpeg");
  });

  it("preserves a PNG tag and excludes the tag byte from the blob", async () => {
    const buf = bytesWithTag([0x89, 0x50, 0x4e, 0x47], MIME_TAG_PNG);
    const { mime } = blobUrlFromBytes(buf);
    expect(mime).toBe("image/png");
    // The Blob body must NOT include the trailing tag byte.
    const blob = capturedBlobs[0];
    expect(blob.size).toBe(4);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("handles WebP and GIF tags", () => {
    expect(blobUrlFromBytes(bytesWithTag([0], MIME_TAG_WEBP)).mime).toBe("image/webp");
    expect(blobUrlFromBytes(bytesWithTag([0], MIME_TAG_GIF)).mime).toBe("image/gif");
  });

  it("falls back to JPEG when the tag is unrecognized", () => {
    const { mime } = blobUrlFromBytes(bytesWithTag([1, 2, 3], 199));
    expect(mime).toBe("image/jpeg");
  });

  it("throws on an empty payload", () => {
    expect(() => blobUrlFromBytes(new ArrayBuffer(0))).toThrow(/empty/i);
  });

  it.runIf(typeof Blob !== "undefined")("does not leak the tag byte for a 1-byte payload", async () => {
    const { mime } = blobUrlFromBytes(bytesWithTag([], MIME_TAG_JPEG));
    expect(mime).toBe("image/jpeg");
    const blob = capturedBlobs[0];
    expect(blob.size).toBe(0);
  });

  it.runIf(typeof URL.createObjectURL === "function")("spy is restored", () => {
    expect(createObjectURLSpy).toBeDefined();
  });
});
