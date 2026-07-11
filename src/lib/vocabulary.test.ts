import { describe, it, expect } from "vitest";
import {
  extractContextSentence,
  formatDefinitionSnapshot,
  boxIntervalDays,
  vocabularyPosLabelKey,
} from "./vocabulary";
import type { DictionaryEntry } from "./dictionary";

describe("extractContextSentence", () => {
  it("returns just the sentence containing a mid-paragraph selection", () => {
    const text = "First sentence here. Second sentence has the word. Third sentence follows.";
    const start = text.indexOf("word");
    const end = start + "word".length;
    expect(extractContextSentence(text, start, end)).toBe("Second sentence has the word.");
  });

  it("handles a selection in the first sentence", () => {
    const text = "First sentence here. Second sentence follows. Third one too.";
    const start = text.indexOf("First");
    const end = start + "First".length;
    expect(extractContextSentence(text, start, end)).toBe("First sentence here.");
  });

  it("handles a selection in the last sentence", () => {
    const text = "First sentence here. Second sentence follows. Third one too.";
    const start = text.indexOf("Third");
    const end = start + "Third".length;
    expect(extractContextSentence(text, start, end)).toBe("Third one too.");
  });

  it("treats a newline / paragraph break as a boundary even without punctuation", () => {
    const text = "First paragraph no punctuation\n\nSecond paragraph has the target word here\n\nThird paragraph.";
    const start = text.indexOf("target");
    const end = start + "target".length;
    expect(extractContextSentence(text, start, end)).toBe(
      "Second paragraph has the target word here",
    );
  });

  it("returns the whole text (capped) when there is no punctuation at all", () => {
    // Use a unique marker at the selection offsets (rather than a uniform
    // filler character) so the assertion below actually proves the window
    // is centered on the selection — with an "a".repeat() fixture, any
    // window at all would trivially contain the selected slice.
    const marker = "MARKER1";
    const start = 250;
    const end = start + marker.length;
    const text = "a".repeat(start) + marker + "a".repeat(500 - end);
    const result = extractContextSentence(text, start, end);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.length).toBeGreaterThan(0);
    // The selection itself must still be inside the returned window.
    expect(result).toContain(marker);
  });

  it("returns '' for empty chapter text", () => {
    expect(extractContextSentence("", 0, 0)).toBe("");
  });

  it("returns '' for out-of-range offsets", () => {
    const text = "Some short sentence.";
    expect(extractContextSentence(text, -1, 5)).toBe("");
    expect(extractContextSentence(text, 5, 1000)).toBe("");
    expect(extractContextSentence(text, 10, 5)).toBe("");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    const text = "Before.   This   sentence   has  \t extra   whitespace   inside.   After.";
    const start = text.indexOf("extra");
    const end = start + "extra".length;
    expect(extractContextSentence(text, start, end)).toBe("This sentence has extra whitespace inside.");
  });

  it("keeps a window around the selection when the sentence is longer than the cap", () => {
    const before = "word ".repeat(100); // 500 chars, no sentence-ending punctuation before the target
    const text = `${before}TARGET${" filler".repeat(100)}.`;
    const start = text.indexOf("TARGET");
    const end = start + "TARGET".length;
    const result = extractContextSentence(text, start, end);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContain("TARGET");
  });
});

describe("formatDefinitionSnapshot", () => {
  const baseEntry: DictionaryEntry = {
    word: "cat",
    matchedWord: "cat",
    senses: [
      {
        pos: "n",
        senseNum: 1,
        gloss: "feline mammal",
        examples: ["the cat sat on the mat"],
        synonyms: ["feline", "kitty", "puss", "tomcat"],
      },
      {
        pos: "v",
        senseNum: 1,
        gloss: "to cat around",
        examples: [],
        synonyms: [],
      },
    ],
  };

  it("includes the primary sense gloss and up to 3 synonyms", () => {
    const result = formatDefinitionSnapshot(baseEntry);
    expect(result).toContain("feline mammal");
    expect(result).toContain("feline");
    expect(result).toContain("kitty");
    expect(result).toContain("puss");
    expect(result).not.toContain("tomcat"); // capped at 3 synonyms
  });

  it("renders just the gloss when there are no synonyms", () => {
    const entry: DictionaryEntry = {
      ...baseEntry,
      senses: [{ pos: "n", senseNum: 1, gloss: "a thing", examples: [], synonyms: [] }],
    };
    expect(formatDefinitionSnapshot(entry)).toBe("a thing");
  });

  it("handles a primary sense with no example gracefully (examples are not part of the snapshot)", () => {
    const entry: DictionaryEntry = {
      ...baseEntry,
      senses: [{ pos: "n", senseNum: 1, gloss: "no example here", examples: [], synonyms: ["syn"] }],
    };
    const result = formatDefinitionSnapshot(entry);
    expect(result).toContain("no example here");
    expect(result).toContain("syn");
  });

  it("returns '' when the entry has no senses", () => {
    const entry: DictionaryEntry = { word: "x", matchedWord: "x", senses: [] };
    expect(formatDefinitionSnapshot(entry)).toBe("");
  });
});

describe("boxIntervalDays", () => {
  it("maps boxes 1..5 to the locked interval schedule", () => {
    expect(boxIntervalDays(1)).toBe(1);
    expect(boxIntervalDays(2)).toBe(3);
    expect(boxIntervalDays(3)).toBe(7);
    expect(boxIntervalDays(4)).toBe(14);
    expect(boxIntervalDays(5)).toBe(30);
  });

  it("clamps out-of-range boxes to the nearest valid one", () => {
    expect(boxIntervalDays(0)).toBe(1);
    expect(boxIntervalDays(6)).toBe(30);
  });
});

describe("vocabularyPosLabelKey", () => {
  it("returns the reader dictionary POS label key for known POS values", () => {
    expect(vocabularyPosLabelKey("n")).toBe("reader.dictionary.posNoun");
    expect(vocabularyPosLabelKey("v")).toBe("reader.dictionary.posVerb");
  });

  it("returns null for null or unknown POS", () => {
    expect(vocabularyPosLabelKey(null)).toBeNull();
    expect(vocabularyPosLabelKey("xyz")).toBeNull();
  });
});
