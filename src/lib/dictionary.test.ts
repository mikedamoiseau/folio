import { describe, it, expect } from "vitest";
import {
  extractLookupWord,
  groupSensesByPos,
  type DictionarySense,
} from "./dictionary";

describe("extractLookupWord", () => {
  it("accepts and lowercases a plain word", () => {
    expect(extractLookupWord("Cat")).toBe("cat");
    expect(extractLookupWord("  running  ")).toBe("running");
  });

  it("strips surrounding punctuation and quotes", () => {
    expect(extractLookupWord("(cat),")).toBe("cat");
    expect(extractLookupWord('"quiet"')).toBe("quiet");
    expect(extractLookupWord("—dash—")).toBe("dash");
  });

  it("strips a trailing possessive", () => {
    expect(extractLookupWord("dog's")).toBe("dog");
    expect(extractLookupWord("dogs'")).toBe("dogs");
    expect(extractLookupWord("cat’s")).toBe("cat"); // curly apostrophe
  });

  it("keeps inner hyphens and apostrophes", () => {
    expect(extractLookupWord("mother-in-law")).toBe("mother-in-law");
    expect(extractLookupWord("don't")).toBe("don't");
  });

  it("rejects multi-word selections", () => {
    expect(extractLookupWord("hello world")).toBeNull();
    expect(extractLookupWord("a\tb")).toBeNull();
  });

  it("rejects empty / whitespace-only selections", () => {
    expect(extractLookupWord("")).toBeNull();
    expect(extractLookupWord("   ")).toBeNull();
  });

  it("rejects single letters (too short after the first char)", () => {
    expect(extractLookupWord("a")).toBeNull();
    expect(extractLookupWord("I")).toBeNull();
  });

  it("accepts 2-letter words", () => {
    expect(extractLookupWord("go")).toBe("go");
    expect(extractLookupWord("Be")).toBe("be");
    expect(extractLookupWord("ax")).toBe("ax");
  });

  it("rejects non-Latin scripts", () => {
    expect(extractLookupWord("привет")).toBeNull();
    expect(extractLookupWord("日本語")).toBeNull();
    expect(extractLookupWord("café")).toBeNull(); // accented char is non-ASCII
  });

  it("rejects tokens with no letters", () => {
    expect(extractLookupWord("123")).toBeNull();
    expect(extractLookupWord("!!!")).toBeNull();
  });
});

describe("groupSensesByPos", () => {
  const sense = (pos: string, senseNum: number): DictionarySense => ({
    pos,
    senseNum,
    gloss: `${pos}${senseNum}`,
    examples: [],
    synonyms: [],
  });

  it("orders groups n, v, a, r regardless of input order", () => {
    const groups = groupSensesByPos([
      sense("r", 1),
      sense("a", 1),
      sense("v", 1),
      sense("n", 1),
    ]);
    expect(groups.map((g) => g.pos)).toEqual(["n", "v", "a", "r"]);
  });

  it("keeps sense order within a group and omits empty groups", () => {
    const groups = groupSensesByPos([sense("n", 1), sense("n", 2), sense("v", 1)]);
    expect(groups.map((g) => g.pos)).toEqual(["n", "v"]);
    expect(groups[0].senses.map((s) => s.senseNum)).toEqual([1, 2]);
  });

  it("appends unknown POS values after the known ones", () => {
    const groups = groupSensesByPos([sense("x", 1), sense("n", 1)]);
    expect(groups.map((g) => g.pos)).toEqual(["n", "x"]);
  });

  it("returns an empty array for no senses", () => {
    expect(groupSensesByPos([])).toEqual([]);
  });
});
