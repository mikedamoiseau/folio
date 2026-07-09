import { describe, it, expect } from "vitest";
import {
  createChapterCache,
  getCachedChapter,
  setCachedChapter,
  evictOutsideWindow,
  adjacentChapterIndices,
  CACHE_WINDOW,
} from "./chapterCache";

describe("createChapterCache", () => {
  it("starts empty with no book bound", () => {
    const cache = createChapterCache();
    expect(cache.bookId).toBeNull();
    expect(cache.entries.size).toBe(0);
  });
});

describe("getCachedChapter / setCachedChapter", () => {
  it("returns undefined on a miss", () => {
    const cache = createChapterCache();
    expect(getCachedChapter(cache, "book-a", 0)).toBeUndefined();
  });

  it("returns stored HTML on a hit", () => {
    const cache = createChapterCache();
    setCachedChapter(cache, "book-a", 2, "<p>hi</p>");
    expect(getCachedChapter(cache, "book-a", 2)).toBe("<p>hi</p>");
  });

  it("binds the cache to the first book id it stores for", () => {
    const cache = createChapterCache();
    setCachedChapter(cache, "book-a", 1, "<p>a1</p>");
    expect(cache.bookId).toBe("book-a");
  });

  it("never serves one book's HTML for another id", () => {
    const cache = createChapterCache();
    setCachedChapter(cache, "book-a", 1, "<p>a1</p>");
    // Same index, different book — must be a miss, not book-a's HTML.
    expect(getCachedChapter(cache, "book-b", 1)).toBeUndefined();
  });

  it("resets and rebinds when a different book stores into it", () => {
    const cache = createChapterCache();
    setCachedChapter(cache, "book-a", 1, "<p>a1</p>");
    setCachedChapter(cache, "book-a", 2, "<p>a2</p>");
    setCachedChapter(cache, "book-b", 5, "<p>b5</p>");
    expect(cache.bookId).toBe("book-b");
    expect(cache.entries.size).toBe(1);
    expect(getCachedChapter(cache, "book-b", 5)).toBe("<p>b5</p>");
    // book-a entries are gone even if we ask with book-a again.
    expect(getCachedChapter(cache, "book-a", 1)).toBeUndefined();
  });
});

describe("evictOutsideWindow", () => {
  it("keeps entries within ±CACHE_WINDOW of the center and drops the rest", () => {
    const cache = createChapterCache();
    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      setCachedChapter(cache, "book-a", i, `<p>${i}</p>`);
    }
    evictOutsideWindow(cache, 3);
    // CACHE_WINDOW is 2, so [1,2,3,4,5] survive.
    expect([...cache.entries.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(CACHE_WINDOW).toBe(2);
  });

  it("honors an explicit radius", () => {
    const cache = createChapterCache();
    for (const i of [0, 1, 2, 3, 4]) {
      setCachedChapter(cache, "book-a", i, `<p>${i}</p>`);
    }
    evictOutsideWindow(cache, 2, 1);
    expect([...cache.entries.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("is a no-op when everything is inside the window", () => {
    const cache = createChapterCache();
    setCachedChapter(cache, "book-a", 4, "<p>4</p>");
    setCachedChapter(cache, "book-a", 5, "<p>5</p>");
    evictOutsideWindow(cache, 5);
    expect(cache.entries.size).toBe(2);
  });
});

describe("adjacentChapterIndices", () => {
  it("returns previous and next around the current chapter", () => {
    expect(adjacentChapterIndices(3, 10)).toEqual([2, 4]);
  });

  it("clamps at the first chapter (no negative index)", () => {
    expect(adjacentChapterIndices(0, 10)).toEqual([1]);
  });

  it("clamps at the last chapter (no out-of-range index)", () => {
    expect(adjacentChapterIndices(9, 10)).toEqual([8]);
  });

  it("returns nothing for a single-chapter book", () => {
    expect(adjacentChapterIndices(0, 1)).toEqual([]);
  });

  it("returns nothing when the total is unknown (0)", () => {
    expect(adjacentChapterIndices(0, 0)).toEqual([]);
  });
});
