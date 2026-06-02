import { describe, it, expect } from "vitest";
import { calcColumns, chunkRows } from "./VirtualizedBookGrid";

describe("calcColumns", () => {
  it("fits as many 160px (+20 gap) cards as the width allows", () => {
    // (width + 20) / 180
    expect(calcColumns(160)).toBe(1); // 180/180 = 1
    expect(calcColumns(340)).toBe(2); // 360/180 = 2
    expect(calcColumns(520)).toBe(3); // 540/180 = 3
  });

  it("computes column counts for common widths", () => {
    expect(calcColumns(900)).toBe(5); // 920/180 = 5.1 → 5
    expect(calcColumns(1200)).toBe(6); // 1220/180 = 6.7 → 6
  });

  it("never returns less than one column", () => {
    expect(calcColumns(0)).toBe(1);
    expect(calcColumns(50)).toBe(1);
    expect(calcColumns(-100)).toBe(1);
  });
});

describe("chunkRows", () => {
  it("splits a flat list into rows of the given column count", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one row per item when columns is 1", () => {
    expect(chunkRows([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("returns an empty array for no items", () => {
    expect(chunkRows([], 4)).toEqual([]);
  });

  it("guards against a zero/negative column count", () => {
    expect(chunkRows([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});
