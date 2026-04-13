import { describe, it, expect } from "vitest";
import { calcGridLayout } from "./VirtualBookGrid";

describe("VirtualBookGrid", () => {
  describe("calcGridLayout", () => {
    const CARD_WIDTH = 160;
    const GAP = 20;

    it("calculates correct column count for wide container", () => {
      // 1000px container: (1000 + 20) / (160 + 20) = 5.66 → 5 columns
      const layout = calcGridLayout(1000);
      expect(layout.columnCount).toBe(5);
    });

    it("calculates correct column count for narrow container", () => {
      // 400px container: (400 + 20) / (160 + 20) = 2.33 → 2 columns
      const layout = calcGridLayout(400);
      expect(layout.columnCount).toBe(2);
    });

    it("returns at least 1 column for very narrow container", () => {
      const layout = calcGridLayout(100);
      expect(layout.columnCount).toBeGreaterThanOrEqual(1);
    });

    it("calculates correct row count", () => {
      const layout = calcGridLayout(1000);
      // 5 columns, 1000 items: ceil(1000/5) = 200 rows
      expect(layout.rowCount(1000)).toBe(200);
    });

    it("calculates correct row count with partial last row", () => {
      const layout = calcGridLayout(1000);
      // 5 columns, 7 items: ceil(7/5) = 2 rows
      expect(layout.rowCount(7)).toBe(2);
    });

    it("returns correct column and row sizes", () => {
      const layout = calcGridLayout(1000);
      expect(layout.columnWidth).toBe(CARD_WIDTH + GAP);
      expect(layout.rowHeight).toBeGreaterThan(0);
    });

    it("calculates padding for centering", () => {
      const layout = calcGridLayout(1000);
      // 5 columns × 180px = 900px, minus one trailing gap = 880px used
      // (1000 - 880) / 2 = 60px padding
      const totalGridWidth = layout.columnCount * (CARD_WIDTH + GAP) - GAP;
      const expectedPadding = Math.max(0, Math.floor((1000 - totalGridWidth) / 2));
      expect(layout.paddingLeft).toBe(expectedPadding);
    });
  });
});
