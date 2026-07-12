import { describe, it, expect } from "vitest";
import {
  wrapTextByWidth,
  truncateToWidth,
  fitQuote,
  sanitizeQuoteForCard,
  defaultStyleForMode,
  MAX_QUOTE_CHARS,
  MAX_LINES,
  MAX_QUOTE_PX,
} from "./quoteCard";

// Stub measurer: each char is 10px wide, so widths are trivial to reason about.
const measure10 = (s: string) => s.length * 10;

// A "wide glyph" stub: characters in the 'W' set measure double width, so a
// string of W's wraps earlier than an equal-length string of narrow chars.
const measureWide = (s: string) => {
  let total = 0;
  for (const ch of s) total += ch === "W" ? 20 : 10;
  return total;
};

describe("wrapTextByWidth", () => {
  it("greedily wraps words onto lines within the measured width", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapTextByWidth(text, 150, measure10);
    expect(lines.join(" ")).toBe(text);
    for (const line of lines) {
      expect(measure10(line)).toBeLessThanOrEqual(150);
    }
    // Greedy: first line packs as many words as fit within 150px (15 chars).
    expect(lines[0]).toBe("the quick brown");
  });

  it("hard-splits a single word wider than the line budget", () => {
    const text = "supercalifragilisticexpialidocious";
    const lines = wrapTextByWidth(text, 100, measure10);
    expect(lines.join("")).toBe(text);
    for (const line of lines) {
      expect(measure10(line)).toBeLessThanOrEqual(100);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it("wide-glyph stub breaks earlier than an equal-length narrow-glyph string", () => {
    const narrow = "aaaaaaaaaa aaaaaaaaaa"; // 10 + 10 chars
    const wide = "WWWWWWWWWW WWWWWWWWWW"; // same shape, but W's measure 2x
    const narrowLines = wrapTextByWidth(narrow, 150, measureWide);
    const wideLines = wrapTextByWidth(wide, 150, measureWide);
    expect(wideLines.length).toBeGreaterThan(narrowLines.length);
  });

  it("returns an empty array for empty input", () => {
    expect(wrapTextByWidth("", 200, measure10)).toEqual([]);
    expect(wrapTextByWidth("   ", 200, measure10)).toEqual([]);
  });
});

describe("truncateToWidth", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateToWidth("short", 200, measure10)).toBe("short");
  });

  it("ellipsizes text that doesn't fit, keeping the result within width", () => {
    const text = "a very long title that will not fit in the footer";
    const result = truncateToWidth(text, 100, measure10);
    expect(result.endsWith("…")).toBe(true);
    expect(measure10(result)).toBeLessThanOrEqual(100);
    expect(result.length).toBeLessThan(text.length);
  });

  it("returns an empty string unchanged", () => {
    expect(truncateToWidth("", 100, measure10)).toBe("");
  });
});

// fitQuote takes a measure *factory* (fontSize -> measure fn) since the loop
// tries multiple font sizes and text width depends on font size. This stub
// mirrors the old AVG_GLYPH_RATIO approximation (0.55 * fontSize per char) so
// existing size expectations still hold.
const stubMeasureAt = (fontSize: number) => (s: string) => s.length * fontSize * 0.55;

describe("fitQuote", () => {
  it("picks the largest font size for a short quote and does not truncate", () => {
    const result = fitQuote("Short and sweet.", stubMeasureAt);
    expect(result.fontSize).toBe(MAX_QUOTE_PX);
    expect(result.truncated).toBe(false);
    expect(result.lines.join(" ")).toBe("Short and sweet.");
  });

  it("shrinks the font size for a long quote", () => {
    const long = Array.from({ length: 3 }, () =>
      "This is a considerably longer quote that will need to wrap across several lines and should not fit at the largest font size available to the card layout engine."
    ).join(" ");
    const result = fitQuote(long, stubMeasureAt);
    expect(result.fontSize).toBeLessThan(MAX_QUOTE_PX);
  });

  it("truncates a pathologically long quote at MAX_LINES with a trailing ellipsis", () => {
    const pathological = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const result = fitQuote(pathological, stubMeasureAt);
    expect(result.truncated).toBe(true);
    expect(result.lines.length).toBe(MAX_LINES);
    expect(result.lines[result.lines.length - 1].endsWith("…")).toBe(true);
  });

  it("is deterministic given the same input", () => {
    const quote = "Same input, same output, every time.";
    expect(fitQuote(quote, stubMeasureAt)).toEqual(fitQuote(quote, stubMeasureAt));
  });
});

describe("sanitizeQuoteForCard", () => {
  it("collapses newlines and internal whitespace to single spaces", () => {
    expect(sanitizeQuoteForCard("line one\nline two\n\nline three")).toBe("line one line two line three");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeQuoteForCard("   padded on both sides   ")).toBe("padded on both sides");
  });

  it("hard-caps at MAX_QUOTE_CHARS", () => {
    const huge = "a".repeat(MAX_QUOTE_CHARS + 500);
    const result = sanitizeQuoteForCard(huge);
    expect(result.length).toBe(MAX_QUOTE_CHARS);
  });
});

describe("defaultStyleForMode", () => {
  it("maps light and system to the light card style", () => {
    expect(defaultStyleForMode("light")).toBe("light");
    expect(defaultStyleForMode("system")).toBe("light");
  });

  it("maps sepia to the sepia card style", () => {
    expect(defaultStyleForMode("sepia")).toBe("sepia");
  });

  it("maps dark to the dark card style", () => {
    expect(defaultStyleForMode("dark")).toBe("dark");
  });

  it("maps custom (and anything unrecognized) to light", () => {
    expect(defaultStyleForMode("custom")).toBe("light");
    expect(defaultStyleForMode("something-unknown")).toBe("light");
  });
});
