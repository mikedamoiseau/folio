import { describe, it, expect } from "vitest";
import { computePrefetchRange, computeVisibleRange } from "./PageThumbnailStrip";

describe("computeVisibleRange", () => {
  const STRIDE = 84;

  it("returns an empty range when count is zero", () => {
    expect(computeVisibleRange(0, 800, STRIDE, 0, 4)).toEqual({ start: 0, end: 0 });
  });

  it("returns an empty range when viewport has no width", () => {
    expect(computeVisibleRange(0, 0, STRIDE, 100, 4)).toEqual({ start: 0, end: 0 });
  });

  it("returns an empty range when stride is zero", () => {
    expect(computeVisibleRange(0, 800, 0, 100, 4)).toEqual({ start: 0, end: 0 });
  });

  it("includes overscan tiles before and after the visible window", () => {
    // viewport 800px, stride 84 → ~10 tiles visible
    const { start, end } = computeVisibleRange(0, 800, STRIDE, 200, 4);
    expect(start).toBe(0); // clamped at 0 (would be -4)
    // ceil(800/84) = 10, plus overscan 4 = 14
    expect(end).toBe(14);
  });

  it("shifts with scrollLeft", () => {
    const { start, end } = computeVisibleRange(1000, 800, STRIDE, 200, 4);
    // floor(1000/84) - 4 = 11 - 4 = 7
    expect(start).toBe(7);
    // ceil((1000+800)/84) + 4 = 22 + 4 = 26
    expect(end).toBe(26);
  });

  it("clamps end at total count", () => {
    const { start, end } = computeVisibleRange(50_000, 800, STRIDE, 100, 4);
    expect(end).toBe(100);
    expect(start).toBeLessThanOrEqual(end);
  });

  it("clamps start at zero on negative scroll", () => {
    const { start } = computeVisibleRange(-50, 800, STRIDE, 200, 4);
    expect(start).toBe(0);
  });

  it("returns start <= end even at extreme scroll values", () => {
    const { start, end } = computeVisibleRange(9_999_999, 800, STRIDE, 50, 4);
    expect(start).toBeLessThanOrEqual(end);
    expect(end).toBe(50);
  });
});

describe("computePrefetchRange", () => {
  it("looks forward when direction is positive", () => {
    const range = computePrefetchRange({ start: 10, end: 20 }, 1, 16, 200);
    expect(range).toEqual({ start: 20, end: 36 });
  });

  it("looks backward when direction is negative", () => {
    const range = computePrefetchRange({ start: 40, end: 50 }, -1, 16, 200);
    expect(range).toEqual({ start: 24, end: 40 });
  });

  it("treats zero direction as forward (initial paint)", () => {
    const range = computePrefetchRange({ start: 0, end: 10 }, 0, 16, 200);
    expect(range.start).toBe(10);
    expect(range.end).toBe(26);
  });

  it("clamps forward range at total count", () => {
    const range = computePrefetchRange({ start: 90, end: 100 }, 1, 16, 100);
    expect(range).toEqual({ start: 100, end: 100 });
  });

  it("clamps backward range at zero", () => {
    const range = computePrefetchRange({ start: 5, end: 15 }, -1, 16, 200);
    expect(range).toEqual({ start: 0, end: 5 });
  });

  it("returns empty range when count is zero", () => {
    expect(computePrefetchRange({ start: 0, end: 0 }, 1, 16, 0)).toEqual({ start: 0, end: 0 });
  });

  it("returns empty range when ahead is zero", () => {
    expect(computePrefetchRange({ start: 10, end: 20 }, 1, 0, 200)).toEqual({ start: 0, end: 0 });
  });
});
