import { describe, it, expect } from "vitest";
import {
  loadPresets,
  filterPresets,
  isPresetAdded,
  availableLanguages,
  availableCategories,
} from "./opdsPresets";
import type { Preset } from "../types/opdsPreset";

const sample: Preset[] = [
  {
    id: "p1",
    name: "Project Gutenberg",
    url: "https://gutenberg.org/opds",
    languages: ["en", "multi"],
    categories: ["public-domain", "literature"],
    description: "Public domain ebooks",
  },
  {
    id: "p2",
    name: "Gallica",
    url: "https://gallica.bnf.fr/opds",
    languages: ["fr"],
    categories: ["public-domain", "academic"],
    description: "French national library",
  },
  {
    id: "p3",
    name: "O'Reilly",
    url: "https://opds.oreilly.com/opds/",
    languages: ["en"],
    categories: ["tech", "commercial"],
    description: "Tech books",
  },
];

describe("loadPresets", () => {
  it("returns a non-empty array", () => {
    expect(loadPresets().length).toBeGreaterThan(0);
  });
});

describe("filterPresets", () => {
  it("returns all presets when no filters set", () => {
    expect(filterPresets(sample, "", new Set(), new Set())).toHaveLength(3);
  });

  it("matches case-insensitive substring on name", () => {
    expect(filterPresets(sample, "gutenberg", new Set(), new Set())).toHaveLength(1);
    expect(filterPresets(sample, "GUTENBERG", new Set(), new Set())).toHaveLength(1);
  });

  it("matches case-insensitive substring on description", () => {
    expect(filterPresets(sample, "national library", new Set(), new Set())).toHaveLength(1);
  });

  it("filters by single language", () => {
    expect(
      filterPresets(sample, "", new Set(["fr"]), new Set()).map((p) => p.id),
    ).toEqual(["p2"]);
  });

  it("multi-language is OR within facet", () => {
    expect(
      filterPresets(sample, "", new Set(["fr", "en"]), new Set()).map((p) => p.id).sort(),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("filters by single category", () => {
    expect(
      filterPresets(sample, "", new Set(), new Set(["tech"])).map((p) => p.id),
    ).toEqual(["p3"]);
  });

  it("multi-category is OR within facet", () => {
    expect(
      filterPresets(sample, "", new Set(), new Set(["academic", "tech"])).map((p) => p.id).sort(),
    ).toEqual(["p2", "p3"]);
  });

  it("language and category combine with AND", () => {
    const out = filterPresets(sample, "", new Set(["fr"]), new Set(["public-domain"]));
    expect(out.map((p) => p.id)).toEqual(["p2"]);
  });

  it("search ANDs with facet filters", () => {
    expect(
      filterPresets(sample, "tech", new Set(["fr"]), new Set()),
    ).toHaveLength(0);
  });
});

describe("isPresetAdded", () => {
  const preset = sample[0];
  it("matches by preset id", () => {
    expect(
      isPresetAdded(preset, [{ name: "x", url: "https://x", presetId: "p1" }]),
    ).toBe(true);
  });

  it("does not match by URL alone", () => {
    expect(
      isPresetAdded(preset, [{ name: "x", url: preset.url, presetId: undefined }]),
    ).toBe(false);
    expect(
      isPresetAdded(preset, [{ name: "x", url: preset.url }]),
    ).toBe(false);
  });

  it("returns false when nothing matches", () => {
    expect(isPresetAdded(preset, [])).toBe(false);
    expect(
      isPresetAdded(preset, [{ name: "y", url: "https://y", presetId: "other" }]),
    ).toBe(false);
  });
});

describe("availableLanguages", () => {
  it("returns deduped, alphabetized list of languages present", () => {
    expect(availableLanguages(sample)).toEqual(["en", "fr", "multi"]);
  });
});

describe("availableCategories", () => {
  it("returns deduped, alphabetized list of categories present", () => {
    expect(availableCategories(sample)).toEqual([
      "academic",
      "commercial",
      "literature",
      "public-domain",
      "tech",
    ]);
  });
});
