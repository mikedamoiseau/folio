import { describe, it, expect } from "vitest";
import {
  wrapText,
  fitQuote,
  sanitizeQuoteForCard,
  defaultStyleForMode,
  MAX_QUOTE_CHARS,
  MAX_LINES,
  MAX_QUOTE_PX,
} from "./quoteCard";

describe("wrapText", () => {
  it("greedily wraps words onto lines within the char budget", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapText(text, 15);
    expect(lines.join(" ")).toBe(text);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(15);
    }
    // Greedy: first line packs as many words as fit.
    expect(lines[0]).toBe("the quick brown");
  });

  it("hard-splits a single word longer than the line budget", () => {
    const text = "supercalifragilisticexpialidocious";
    const lines = wrapText(text, 10);
    expect(lines.join("")).toBe(text);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it("returns an empty array for empty input", () => {
    expect(wrapText("", 20)).toEqual([]);
    expect(wrapText("   ", 20)).toEqual([]);
  });
});

describe("fitQuote", () => {
  it("picks the largest font size for a short quote and does not truncate", () => {
    const result = fitQuote("Short and sweet.");
    expect(result.fontSize).toBe(MAX_QUOTE_PX);
    expect(result.truncated).toBe(false);
    expect(result.lines.join(" ")).toBe("Short and sweet.");
  });

  it("shrinks the font size for a long quote", () => {
    const long = Array.from({ length: 3 }, () =>
      "This is a considerably longer quote that will need to wrap across several lines and should not fit at the largest font size available to the card layout engine."
    ).join(" ");
    const result = fitQuote(long);
    expect(result.fontSize).toBeLessThan(MAX_QUOTE_PX);
  });

  it("truncates a pathologically long quote at MAX_LINES with a trailing ellipsis", () => {
    const pathological = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const result = fitQuote(pathological);
    expect(result.truncated).toBe(true);
    expect(result.lines.length).toBe(MAX_LINES);
    expect(result.lines[result.lines.length - 1].endsWith("…")).toBe(true);
  });

  it("is deterministic given the same input", () => {
    const quote = "Same input, same output, every time.";
    expect(fitQuote(quote)).toEqual(fitQuote(quote));
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
