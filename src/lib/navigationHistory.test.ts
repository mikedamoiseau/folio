import { describe, it, expect } from "vitest";
import {
  emptyHistory,
  pushEntry,
  replaceCurrent,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  currentEntry,
  type NavigationHistory,
} from "./navigationHistory";

type ChapterMeta = { scroll: number };

describe("emptyHistory", () => {
  it("returns an empty history with no current entry", () => {
    const h = emptyHistory<ChapterMeta>();
    expect(h.entries).toEqual([]);
    expect(h.cursor).toBe(-1);
    expect(currentEntry(h)).toBeNull();
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });
});

describe("pushEntry", () => {
  it("appends the first entry and points the cursor at it", () => {
    const h = pushEntry(emptyHistory<ChapterMeta>(), { position: 3, meta: { scroll: 0 } });
    expect(h.entries).toHaveLength(1);
    expect(h.cursor).toBe(0);
    expect(currentEntry(h)).toEqual({ position: 3, meta: { scroll: 0 } });
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("appends successive entries at the head and advances the cursor", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 5, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 7, meta: { scroll: 0 } });
    expect(h.entries.map((e) => e.position)).toEqual([0, 5, 7]);
    expect(h.cursor).toBe(2);
    expect(currentEntry(h)?.position).toBe(7);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
  });

  it("truncates forward entries when pushing while not at the head", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0 });
    h = pushEntry(h, { position: 1 });
    h = pushEntry(h, { position: 2 });
    h = pushEntry(h, { position: 3 });
    // cursor at 3 (head). Go back twice.
    h = goBack(h).history;
    h = goBack(h).history;
    expect(h.cursor).toBe(1);
    expect(canGoForward(h)).toBe(true);
    // Pushing now must drop entries 2 and 3 and append the new entry.
    h = pushEntry(h, { position: 99 });
    expect(h.entries.map((e) => e.position)).toEqual([0, 1, 99]);
    expect(h.cursor).toBe(2);
    expect(canGoForward(h)).toBe(false);
  });

  it("truncates the forward branch on push, even when the new position matches the cursor", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0 });
    h = pushEntry(h, { position: 1 });
    h = pushEntry(h, { position: 2 });
    h = goBack(h).history;
    expect(canGoForward(h)).toBe(true);
    h = pushEntry(h, { position: 1, meta: { scroll: 50 } });
    // Push always grows: forward branch is gone, but the duplicate-position
    // entry at the cursor is preserved AND the new entry is appended.
    expect(h.entries.map((e) => e.position)).toEqual([0, 1, 1]);
    expect(h.cursor).toBe(2);
    expect(canGoForward(h)).toBe(false);
    expect(h.entries[2].meta).toEqual({ scroll: 50 });
  });

  it("treats same-chapter, different-scroll jumps as distinct entries (no position-only dedupe)", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 4, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 4, meta: { scroll: 0.8 } });
    expect(h.entries).toHaveLength(2);
    expect(h.cursor).toBe(1);
    expect(h.entries[0].meta).toEqual({ scroll: 0 });
    expect(h.entries[1].meta).toEqual({ scroll: 0.8 });
    // Back must reach the earlier in-chapter location.
    const { entry } = goBack(h);
    expect(entry).toEqual({ position: 4, meta: { scroll: 0 } });
  });

  it("treats different-chapter pushes as distinct entries", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 4 });
    h = pushEntry(h, { position: 5 });
    expect(h.entries).toHaveLength(2);
  });

  it("respects the maximum capacity by evicting the oldest entry", () => {
    let h = emptyHistory<ChapterMeta>(3);
    h = pushEntry(h, { position: 0 });
    h = pushEntry(h, { position: 1 });
    h = pushEntry(h, { position: 2 });
    h = pushEntry(h, { position: 3 });
    expect(h.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(h.cursor).toBe(2);
  });

  it("evicts oldest only when at the head; never drops entries we navigated back from", () => {
    let h = emptyHistory<ChapterMeta>(3);
    h = pushEntry(h, { position: 0 });
    h = pushEntry(h, { position: 1 });
    h = pushEntry(h, { position: 2 });
    // Go back twice → cursor at 0. New push must truncate forward (positions 1, 2),
    // then append. No eviction should be needed because length stays under cap.
    h = goBack(h).history;
    h = goBack(h).history;
    h = pushEntry(h, { position: 99 });
    expect(h.entries.map((e) => e.position)).toEqual([0, 99]);
    expect(h.cursor).toBe(1);
  });

  it("rejects a non-positive max capacity by falling back to a sane default", () => {
    expect(() => emptyHistory<ChapterMeta>(0)).toThrowError(/max/i);
    expect(() => emptyHistory<ChapterMeta>(-1)).toThrowError(/max/i);
  });
});

describe("goBack / goForward", () => {
  function build(): NavigationHistory<ChapterMeta> {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 1, meta: { scroll: 10 } });
    h = pushEntry(h, { position: 2, meta: { scroll: 20 } });
    return h;
  }

  it("goBack moves the cursor one step earlier and returns the previous entry", () => {
    const h0 = build();
    const { history: h1, entry } = goBack(h0);
    expect(h1.cursor).toBe(1);
    expect(entry).toEqual({ position: 1, meta: { scroll: 10 } });
    expect(canGoBack(h1)).toBe(true);
    expect(canGoForward(h1)).toBe(true);
  });

  it("goBack at the start is a no-op and returns null", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0 });
    const { history, entry } = goBack(h);
    expect(history).toEqual(h);
    expect(entry).toBeNull();
  });

  it("goBack on an empty history is a no-op", () => {
    const h = emptyHistory<ChapterMeta>();
    const { history, entry } = goBack(h);
    expect(history).toEqual(h);
    expect(entry).toBeNull();
  });

  it("goForward moves the cursor one step later and returns the next entry", () => {
    let h = build();
    h = goBack(h).history;
    h = goBack(h).history;
    const { history, entry } = goForward(h);
    expect(history.cursor).toBe(1);
    expect(entry).toEqual({ position: 1, meta: { scroll: 10 } });
  });

  it("goForward at the head is a no-op and returns null", () => {
    const h = build();
    const { history, entry } = goForward(h);
    expect(history).toEqual(h);
    expect(entry).toBeNull();
  });

  it("does not mutate the input history", () => {
    const h = build();
    const snapshot = JSON.stringify(h);
    goBack(h);
    goForward(h);
    pushEntry(h, { position: 99 });
    expect(JSON.stringify(h)).toBe(snapshot);
  });
});

describe("replaceCurrent", () => {
  it("rewrites the cursor entry without changing length, cursor, or the forward branch", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 1, meta: { scroll: 0 } });
    h = pushEntry(h, { position: 2, meta: { scroll: 0 } });
    h = goBack(h).history; // cursor = 1
    expect(canGoForward(h)).toBe(true);

    const replaced = replaceCurrent(h, { position: 7, meta: { scroll: 0.42 } });
    expect(replaced.entries).toHaveLength(3);
    expect(replaced.cursor).toBe(1);
    expect(replaced.entries[1]).toEqual({ position: 7, meta: { scroll: 0.42 } });
    // Forward branch must survive — back/forward stamping must not destroy it.
    expect(replaced.entries[2]).toEqual({ position: 2, meta: { scroll: 0 } });
    expect(canGoForward(replaced)).toBe(true);
  });

  it("is a no-op on an empty history", () => {
    const h = emptyHistory<ChapterMeta>();
    const result = replaceCurrent(h, { position: 5, meta: { scroll: 0 } });
    expect(result).toEqual(h);
  });

  it("does not mutate the input history", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0, meta: { scroll: 0 } });
    const snapshot = JSON.stringify(h);
    replaceCurrent(h, { position: 99, meta: { scroll: 0.9 } });
    expect(JSON.stringify(h)).toBe(snapshot);
  });
});

describe("canGoBack / canGoForward", () => {
  it("are false on an empty history", () => {
    const h = emptyHistory<ChapterMeta>();
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("canGoBack is false at cursor 0, true otherwise", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0 });
    expect(canGoBack(h)).toBe(false);
    h = pushEntry(h, { position: 1 });
    expect(canGoBack(h)).toBe(true);
  });

  it("canGoForward is true only when the cursor is below the last index", () => {
    let h = emptyHistory<ChapterMeta>();
    h = pushEntry(h, { position: 0 });
    h = pushEntry(h, { position: 1 });
    h = pushEntry(h, { position: 2 });
    expect(canGoForward(h)).toBe(false);
    h = goBack(h).history;
    expect(canGoForward(h)).toBe(true);
  });
});
