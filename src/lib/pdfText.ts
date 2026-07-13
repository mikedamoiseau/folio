// Pure mapping helpers for the PDF text-selection layer (F-1-4, M3).
// No Tauri/DOM dependencies — see pdfText.test.ts for the Vitest coverage.
// `Glyph` mirrors folio-core's `Glyph` struct byte-for-byte (see
// `folio-core/src/pdf.rs`): `off` is the char ordinal into the page's
// `chars()`-built text; `x/y/w/h` are normalized (0..1) fractions of the
// page's rendered box, `y` already converted to top-down orientation.

export interface Glyph {
  off: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Scale a normalized glyph rect to pixels within a `boxW`x`boxH` box (the rendered page image). */
export function glyphToPx(g: Glyph, boxW: number, boxH: number): PxRect {
  return {
    left: g.x * boxW,
    top: g.y * boxH,
    width: g.w * boxW,
    height: g.h * boxH,
  };
}

/**
 * Reduce a set of selected glyphs to the `[startOffset, endOffset)` char
 * range they cover — the same offset space `add_highlight`'s
 * `startOffset`/`endOffset` params expect. `endOffset` is exclusive (one
 * past the max `off` seen). Returns `null` for an empty selection.
 */
export function selectionOffsets(
  selected: Glyph[],
): { startOffset: number; endOffset: number } | null {
  if (selected.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const g of selected) {
    if (g.off < min) min = g.off;
    if (g.off > max) max = g.off;
  }
  return { startOffset: min, endOffset: max + 1 };
}

// Two rects are treated as the same text row if their tops are within this
// fraction of the (shorter) row's glyph height — loose_bounds() rects on the
// same line can differ slightly (ascenders/descenders), so an exact-equality
// check would needlessly split one visual line into several bands.
const ROW_TOLERANCE_FACTOR = 0.5;

/**
 * Resolve the glyphs covering `[startOffset, endOffset)` into merged
 * pixel rect "bands" for rendering a highlight — one band per text row,
 * spanning that row's min-left..max-right and its top/height.
 */
export function highlightBands(
  glyphs: Glyph[],
  startOffset: number,
  endOffset: number,
  boxW: number,
  boxH: number,
): PxRect[] {
  const rects = glyphs
    .filter((g) => g.off >= startOffset && g.off < endOffset && g.w > 0 && g.h > 0)
    .map((g) => glyphToPx(g, boxW, boxH))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const rows: PxRect[][] = [];
  for (const rect of rects) {
    const row = rows[rows.length - 1];
    const rowAnchor = row?.[0];
    if (row && rowAnchor && Math.abs(rect.top - rowAnchor.top) <= rowAnchor.height * ROW_TOLERANCE_FACTOR) {
      row.push(rect);
    } else {
      rows.push([rect]);
    }
  }

  return rows.map((row) => {
    const left = Math.min(...row.map((r) => r.left));
    const right = Math.max(...row.map((r) => r.left + r.width));
    const top = Math.min(...row.map((r) => r.top));
    // Span to the lowest bottom edge in the row, not max(height) from the
    // topmost glyph — otherwise a glyph that sits lower (e.g. a descender)
    // has its bottom clipped by the band.
    const bottom = Math.max(...row.map((r) => r.top + r.height));
    return { left, top, width: right - left, height: bottom - top };
  });
}
