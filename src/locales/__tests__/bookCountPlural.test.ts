import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type i18n } from "i18next";
import en from "../en.json";
import fr from "../fr.json";

// Regression guard for "1 books": the library section headers and series-stack
// cards render a book count, and count === 1 must read "1 book" / "1 livre",
// not "1 books" / "1 livres". These keys use i18next's _one/_other plural
// suffixes; this verifies they resolve through i18next's real plural rules.
let i18n: i18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
});

describe("book-count pluralization", () => {
  it.each([
    ["seriesView.bookCount", 1, "1 book"],
    ["seriesView.bookCount", 2, "2 books"],
    ["library.booksCount", 1, "1 book"],
    ["library.booksCount", 9, "9 books"],
  ])("EN %s with count=%i → %s", async (key, count, expected) => {
    await i18n.changeLanguage("en");
    expect(i18n.t(key, { count })).toBe(expected);
  });

  it.each([
    ["seriesView.bookCount", 1, "1 livre"],
    ["seriesView.bookCount", 2, "2 livres"],
    ["library.booksCount", 1, "1 livre"],
    ["library.booksCount", 9, "9 livres"],
  ])("FR %s with count=%i → %s", async (key, count, expected) => {
    await i18n.changeLanguage("fr");
    expect(i18n.t(key, { count })).toBe(expected);
  });
});
