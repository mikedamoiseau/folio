import { describe, it, expect } from "vitest";
import { glyphToPx, selectionOffsets, highlightBands, type Glyph } from "./pdfText";

describe("glyphToPx", () => {
  it("scales a normalized glyph rect to the rendered image box", () => {
    const g: Glyph = { off: 0, x: 0.5, y: 0.5, w: 0.1, h: 0.02 };
    expect(glyphToPx(g, 1000, 1400)).toEqual({ left: 500, top: 700, width: 100, height: 28 });
  });

  it("scales independently for width and height", () => {
    const g: Glyph = { off: 3, x: 0.25, y: 0.75, w: 0.05, h: 0.01 };
    expect(glyphToPx(g, 800, 600)).toEqual({ left: 200, top: 450, width: 40, height: 6 });
  });
});

describe("selectionOffsets", () => {
  it("returns the min/max off as an exclusive-end range", () => {
    const glyphs: Glyph[] = [
      { off: 6, x: 0, y: 0, w: 0.01, h: 0.01 },
      { off: 5, x: 0, y: 0, w: 0.01, h: 0.01 },
      { off: 7, x: 0, y: 0, w: 0.01, h: 0.01 },
    ];
    expect(selectionOffsets(glyphs)).toEqual({ startOffset: 5, endOffset: 8 });
  });

  it("returns null for an empty selection", () => {
    expect(selectionOffsets([])).toBeNull();
  });

  it("handles a single-glyph selection", () => {
    const glyphs: Glyph[] = [{ off: 42, x: 0, y: 0, w: 0.01, h: 0.01 }];
    expect(selectionOffsets(glyphs)).toEqual({ startOffset: 42, endOffset: 43 });
  });
});

describe("highlightBands", () => {
  // One text row: five glyphs left-to-right at the same top/height.
  const oneRow: Glyph[] = [
    { off: 0, x: 0.1, y: 0.1, w: 0.05, h: 0.02 },
    { off: 1, x: 0.15, y: 0.1, w: 0.05, h: 0.02 },
    { off: 2, x: 0.2, y: 0.1, w: 0.05, h: 0.02 },
    { off: 3, x: 0.25, y: 0.1, w: 0.05, h: 0.02 },
    { off: 4, x: 0.3, y: 0.1, w: 0.05, h: 0.02 },
  ];

  it("merges a single text row covered by the offset range into one band", () => {
    const bands = highlightBands(oneRow, 0, 5, 1000, 1000);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ left: 100, top: 100, width: 250, height: 20 });
  });

  it("only includes glyphs whose off falls within [startOffset, endOffset)", () => {
    const bands = highlightBands(oneRow, 1, 3, 1000, 1000);
    expect(bands).toHaveLength(1);
    // Covers offs 1,2 only: left edge at glyph 1 (x=0.15), right edge at glyph 2's end (0.2+0.05=0.25)
    expect(bands[0]).toEqual({ left: 150, top: 100, width: 100, height: 20 });
  });

  it("groups glyphs on two distinct rows into two bands", () => {
    const twoRows: Glyph[] = [
      ...oneRow,
      { off: 5, x: 0.1, y: 0.2, w: 0.05, h: 0.02 },
      { off: 6, x: 0.15, y: 0.2, w: 0.05, h: 0.02 },
    ];
    const bands = highlightBands(twoRows, 0, 7, 1000, 1000);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({ left: 100, top: 100, width: 250, height: 20 });
    expect(bands[1]).toEqual({ left: 100, top: 200, width: 100, height: 20 });
  });

  it("skips zero-area glyphs (e.g. whitespace with a failed bounds lookup)", () => {
    const withDegenerate: Glyph[] = [
      { off: 0, x: 0.1, y: 0.1, w: 0.05, h: 0.02 },
      { off: 1, x: 0, y: 0, w: 0, h: 0 },
      { off: 2, x: 0.2, y: 0.1, w: 0.05, h: 0.02 },
    ];
    const bands = highlightBands(withDegenerate, 0, 3, 1000, 1000);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ left: 100, top: 100, width: 150, height: 20 });
  });

  it("returns an empty array when no glyphs fall in range", () => {
    expect(highlightBands(oneRow, 100, 200, 1000, 1000)).toEqual([]);
  });
});
