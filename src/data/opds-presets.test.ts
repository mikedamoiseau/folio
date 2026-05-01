import { describe, it, expect } from "vitest";
import presets from "./opds-presets.json";
import { ALL_LANGUAGES, ALL_CATEGORIES } from "../types/opdsPreset";
import type { Preset, LanguageCode, Category } from "../types/opdsPreset";

const data = presets as Preset[];

describe("opds-presets.json", () => {
  it("has at least one entry", () => {
    expect(data.length).toBeGreaterThan(0);
  });

  it("every entry has all required fields and valid types", () => {
    for (const p of data) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.url).toBe("string");
      expect(p.url).toMatch(/^https?:\/\//);
      expect(typeof p.description).toBe("string");
      expect(Array.isArray(p.languages)).toBe(true);
      expect(p.languages.length).toBeGreaterThan(0);
      expect(Array.isArray(p.categories)).toBe(true);
      expect(p.categories.length).toBeGreaterThan(0);
    }
  });

  it("all ids are unique", () => {
    const ids = data.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all URLs parse via the URL constructor", () => {
    for (const p of data) {
      expect(() => new URL(p.url)).not.toThrow();
    }
  });

  it("ids are kebab-case ASCII", () => {
    for (const p of data) {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("every language is in the controlled vocab", () => {
    const allowed = new Set<LanguageCode>(ALL_LANGUAGES);
    for (const p of data) {
      for (const lang of p.languages) {
        expect(allowed.has(lang as LanguageCode)).toBe(true);
      }
    }
  });

  it("every category is in the controlled vocab", () => {
    const allowed = new Set<Category>(ALL_CATEGORIES);
    for (const p of data) {
      for (const cat of p.categories) {
        expect(allowed.has(cat as Category)).toBe(true);
      }
    }
  });

  it("contains the 5 default-eligible preset ids", () => {
    const ids = new Set(data.map((p) => p.id));
    for (const expected of [
      "project-gutenberg",
      "standard-ebooks-new",
      "internet-archive",
      "feedbooks",
      "wikisource-en",
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});
