// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getVolatilePosition,
  setVolatilePosition,
  clearAllVolatilePositions,
} from "../volatileResume";

describe("volatileResume", () => {
  beforeEach(() => {
    clearAllVolatilePositions();
  });

  it("returns undefined for a book with no volatile position", () => {
    expect(getVolatilePosition("book-1")).toBeUndefined();
  });

  it("round-trips a position that was set", () => {
    setVolatilePosition("book-1", { chapterIndex: 3, scrollPosition: 0.42 });
    expect(getVolatilePosition("book-1")).toEqual({ chapterIndex: 3, scrollPosition: 0.42 });
  });

  it("keeps positions for different books independent", () => {
    setVolatilePosition("book-1", { chapterIndex: 1, scrollPosition: 0 });
    setVolatilePosition("book-2", { chapterIndex: 9, scrollPosition: 0.9 });
    expect(getVolatilePosition("book-1")).toEqual({ chapterIndex: 1, scrollPosition: 0 });
    expect(getVolatilePosition("book-2")).toEqual({ chapterIndex: 9, scrollPosition: 0.9 });
  });

  it("overwrites a book's position on a later set", () => {
    setVolatilePosition("book-1", { chapterIndex: 1, scrollPosition: 0 });
    setVolatilePosition("book-1", { chapterIndex: 5, scrollPosition: 0.75 });
    expect(getVolatilePosition("book-1")).toEqual({ chapterIndex: 5, scrollPosition: 0.75 });
  });

  it("clearAllVolatilePositions empties the store", () => {
    setVolatilePosition("book-1", { chapterIndex: 1, scrollPosition: 0 });
    setVolatilePosition("book-2", { chapterIndex: 2, scrollPosition: 0 });
    clearAllVolatilePositions();
    expect(getVolatilePosition("book-1")).toBeUndefined();
    expect(getVolatilePosition("book-2")).toBeUndefined();
  });

  it("never touches localStorage or any persistent store — the whole point of D-5", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    setVolatilePosition("book-1", { chapterIndex: 1, scrollPosition: 0.5 });
    getVolatilePosition("book-1");
    clearAllVolatilePositions();
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
    getItemSpy.mockRestore();
  });
});
