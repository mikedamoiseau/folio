import { describe, it, expect } from "vitest";
import {
  initialComicExtractProgress,
  comicExtractProgressReducer,
  isComicExtractProgressVisible,
  comicExtractProgressPercent,
  type ComicExtractProgressState,
} from "./comicExtractProgress";

describe("initialComicExtractProgress", () => {
  it("starts unbound and hidden", () => {
    const s = initialComicExtractProgress();
    expect(s.bookId).toBeNull();
    expect(s.loaded).toBe(0);
    expect(s.total).toBe(0);
    expect(s.dismissed).toBe(false);
    expect(isComicExtractProgressVisible(s)).toBe(false);
  });
});

describe("reducer: reset", () => {
  it("binds to a book with fresh, un-dismissed counts", () => {
    let s = initialComicExtractProgress();
    s = comicExtractProgressReducer(s, { type: "dismiss" });
    s = comicExtractProgressReducer(s, { type: "reset", bookId: "book-a" });
    expect(s.bookId).toBe("book-a");
    expect(s.loaded).toBe(0);
    expect(s.total).toBe(0);
    expect(s.dismissed).toBe(false);
  });

  it("clears prior counts when switching books", () => {
    let s = initialComicExtractProgress();
    s = comicExtractProgressReducer(s, { type: "reset", bookId: "book-a" });
    s = comicExtractProgressReducer(s, { type: "progress", bookId: "book-a", loaded: 5, total: 10 });
    s = comicExtractProgressReducer(s, { type: "reset", bookId: "book-b" });
    expect(s.bookId).toBe("book-b");
    expect(s.loaded).toBe(0);
    expect(s.total).toBe(0);
  });
});

describe("reducer: progress", () => {
  const bound = (): ComicExtractProgressState =>
    comicExtractProgressReducer(initialComicExtractProgress(), { type: "reset", bookId: "book-a" });

  it("updates counts for the bound book", () => {
    const s = comicExtractProgressReducer(bound(), {
      type: "progress",
      bookId: "book-a",
      loaded: 34,
      total: 210,
    });
    expect(s.loaded).toBe(34);
    expect(s.total).toBe(210);
    expect(isComicExtractProgressVisible(s)).toBe(true);
  });

  it("ignores events for a different book", () => {
    const s = comicExtractProgressReducer(bound(), {
      type: "progress",
      bookId: "book-b",
      loaded: 99,
      total: 210,
    });
    expect(s.loaded).toBe(0);
    expect(s.total).toBe(0);
    expect(isComicExtractProgressVisible(s)).toBe(false);
  });

  it("ignores events before any book is bound", () => {
    const s = comicExtractProgressReducer(initialComicExtractProgress(), {
      type: "progress",
      bookId: "book-a",
      loaded: 5,
      total: 10,
    });
    expect(s.loaded).toBe(0);
    expect(s.total).toBe(0);
  });

  it("clamps loaded above total down to total", () => {
    const s = comicExtractProgressReducer(bound(), {
      type: "progress",
      bookId: "book-a",
      loaded: 500,
      total: 210,
    });
    expect(s.loaded).toBe(210);
    expect(s.total).toBe(210);
  });

  it("clamps negative loaded up to zero", () => {
    const s = comicExtractProgressReducer(bound(), {
      type: "progress",
      bookId: "book-a",
      loaded: -5,
      total: 210,
    });
    expect(s.loaded).toBe(0);
  });

  it("clamps a negative total to zero", () => {
    const s = comicExtractProgressReducer(bound(), {
      type: "progress",
      bookId: "book-a",
      loaded: 3,
      total: -1,
    });
    expect(s.total).toBe(0);
    expect(s.loaded).toBe(0);
  });
});

describe("visibility lifecycle", () => {
  const run = (
    steps: Parameters<typeof comicExtractProgressReducer>[1][],
  ): ComicExtractProgressState =>
    steps.reduce(comicExtractProgressReducer, initialComicExtractProgress());

  it("is visible mid-extraction", () => {
    const s = run([
      { type: "reset", bookId: "b" },
      { type: "progress", bookId: "b", loaded: 34, total: 210 },
    ]);
    expect(isComicExtractProgressVisible(s)).toBe(true);
  });

  it("auto-hides when extraction completes (loaded === total)", () => {
    const s = run([
      { type: "reset", bookId: "b" },
      { type: "progress", bookId: "b", loaded: 210, total: 210 },
    ]);
    expect(isComicExtractProgressVisible(s)).toBe(false);
  });

  it("hides once dismissed even mid-extraction", () => {
    const s = run([
      { type: "reset", bookId: "b" },
      { type: "progress", bookId: "b", loaded: 34, total: 210 },
      { type: "dismiss" },
    ]);
    expect(isComicExtractProgressVisible(s)).toBe(false);
  });

  it("stays dismissed across further progress events", () => {
    const s = run([
      { type: "reset", bookId: "b" },
      { type: "progress", bookId: "b", loaded: 34, total: 210 },
      { type: "dismiss" },
      { type: "progress", bookId: "b", loaded: 120, total: 210 },
    ]);
    expect(isComicExtractProgressVisible(s)).toBe(false);
    // counts still tracked underneath, just not shown
    expect(s.loaded).toBe(120);
  });

  it("re-shows for a new book after a prior dismiss", () => {
    const s = run([
      { type: "reset", bookId: "b" },
      { type: "dismiss" },
      { type: "reset", bookId: "c" },
      { type: "progress", bookId: "c", loaded: 1, total: 50 },
    ]);
    expect(isComicExtractProgressVisible(s)).toBe(true);
  });
});

describe("comicExtractProgressPercent", () => {
  it("returns 0 when total is zero", () => {
    expect(comicExtractProgressPercent(0, 0)).toBe(0);
  });
  it("rounds to whole percent", () => {
    expect(comicExtractProgressPercent(34, 210)).toBe(16);
  });
  it("clamps to 100", () => {
    expect(comicExtractProgressPercent(300, 210)).toBe(100);
  });
  it("never goes below 0", () => {
    expect(comicExtractProgressPercent(-10, 210)).toBe(0);
  });
});
