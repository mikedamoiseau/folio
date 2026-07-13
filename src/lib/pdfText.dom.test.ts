// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { selectedOffsets, selectionOffsets, type Glyph } from "./pdfText";

// Finding B: `containsNode(span, true)` counts a zero-width edge touch as
// selected, so selecting "BC" among single-char spans A B C D could yield
// "ABCD". `selectedOffsets` requires POSITIVE-width overlap instead.
//
// jsdom caveat (verified): jsdom's `Range.compareBoundaryPoints` is unreliable
// when the two boundary points use different container granularities — a
// text-node character offset vs an element child-index. It reports
// `(textNode, 1)` as strictly BEFORE the equivalent `(element, 1)` instead of
// equal, which is the exact comparison the helper makes against
// `selectNodeContents` boundaries when a real selection carries text-node
// offsets. So these tests express the selection range using ELEMENT
// boundaries (like-for-like with `selectNodeContents`), which jsdom compares
// correctly. That exercises the helper's edge-exclusion predicate honestly;
// the text-node-offset path is exercised by the live WebKit webview, which
// implements the comparison per spec. See the report for the probe details.
describe("selectedOffsets (jsdom Range)", () => {
  function buildSpans(chars: string[]): HTMLElement[] {
    const container = document.createElement("div");
    const spans = chars.map((ch, i) => {
      const span = document.createElement("span");
      span.dataset.off = String(i);
      span.textContent = ch;
      container.appendChild(span);
      return span;
    });
    document.body.appendChild(container);
    return spans;
  }

  it("excludes boundary glyphs the range only touches at an edge", () => {
    const spans = buildSpans(["A", "B", "C", "D"]);
    const range = document.createRange();
    // From the END of A (child index 1) to the START of D (child index 0):
    // covers B, C with positive width and merely touches A and D at their
    // edges, so both boundary glyphs are excluded.
    range.setStart(spans[0], 1);
    range.setEnd(spans[3], 0);

    expect(selectedOffsets(range, spans)).toEqual([1, 2]);

    const glyphByOff = new Map<number, Glyph>(
      [0, 1, 2, 3].map((off) => [off, { off, x: 0, y: 0, w: 0.01, h: 0.01 }]),
    );
    const picked = selectedOffsets(range, spans).map((off) => glyphByOff.get(off)!);
    expect(selectionOffsets(picked)).toEqual({ startOffset: 1, endOffset: 3 });
  });

  it("includes only glyphs the range genuinely overlaps", () => {
    const spans = buildSpans(["A", "B", "C", "D"]);
    const range = document.createRange();
    // Start of A through the start of C: A and B overlap with positive width;
    // C is only touched at its start edge and is excluded.
    range.setStart(spans[0], 0);
    range.setEnd(spans[2], 0);
    expect(selectedOffsets(range, spans)).toEqual([0, 1]);
  });
});
