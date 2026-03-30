# Multi-Language Support — Design Spec

**Date:** 2026-03-29
**Status:** Approved

## Goal

Add multi-language support (i18n) to Folio, shipping with English and French. The architecture supports adding new languages by dropping in a JSON file.

## Scope

**In scope:**
- i18next + react-i18next infrastructure
- English and French translation files (~200-250 strings)
- Auto-detection of OS/browser locale on first launch
- Flag dropdown language switcher in library toolbar and reader header
- Incremental migration of all 17 components
- Error messages translated via frontend `friendlyError()` mapping

**Out of scope:**
- Backend (Rust) translation — backend stays English, frontend owns all user-facing text
- RTL language support (Arabic, Hebrew) — no layout changes needed for EN/FR
- Per-profile language setting — language is global (localStorage)
- Namespace splitting — single JSON file per language (sufficient for ~250 strings)

## Dependencies

| Package | Purpose |
|---------|---------|
| `i18next` | Core i18n framework |
| `react-i18next` | React bindings — `useTranslation()` hook |
| `i18next-browser-languagedetector` | Auto-detect OS/browser locale |

## Translation Files

```
src/locales/
  en.json    — English (default, fallback)
  fr.json    — French
```

Keys use dot-notation grouping by area:
- `common.*` — shared strings (OK, Cancel, Save, Delete, etc.)
- `library.*` — library screen, search, filters, sorting
- `reader.*` — reader controls, navigation, search, progress
- `settings.*` — all settings panel sections
- `collections.*` — sidebar, rules, collection management
- `catalog.*` — OPDS browsing, discovery
- `editor.*` — edit book dialog
- `bookmarks.*` — bookmark panel
- `highlights.*` — highlights panel
- `errors.*` — user-facing error messages
- `stats.*` — reading statistics
- `backup.*` — remote backup UI
- `profiles.*` — profile switching

**Adding a new language:** Create a new JSON file (e.g., `es.json`), copy the structure from `en.json`, translate all values, and register it in the i18next config. No code changes needed beyond the registration.

## Initialization

**File:** `src/i18n.ts`

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    fallbackLng: "en",
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "folio-language",
      caches: ["localStorage"],
    },
  });
```

Imported once in `main.tsx` before `<App />`.

## Language Switcher UI

**Location:** Library toolbar (between book icons and settings gear) and Reader header.

**Component:** Small button showing current flag emoji. Click opens dropdown:
- Each row: flag emoji + language name in native form
- Active language highlighted
- Closes on selection or click-outside

**Available languages:**

| Code | Flag | Label |
|------|------|-------|
| `en` | `GB` | English |
| `fr` | `FR` | Francais |

**Behavior:**
- Selection calls `i18next.changeLanguage(code)`
- All translated strings re-render instantly (no page reload)
- Choice persisted to `folio-language` in localStorage
- On launch: check localStorage first, then OS locale, then fallback to English

## Component Migration

Incremental, one batch at a time. Each batch replaces hardcoded strings with `t("key")` calls.

| Batch | Components | ~Strings |
|-------|-----------|----------|
| 1 | Infrastructure + Library.tsx, ImportButton.tsx, EmptyState.tsx, BookCard.tsx | ~50 |
| 2 | Reader.tsx, BookmarksPanel.tsx, HighlightsPanel.tsx | ~70 |
| 3 | SettingsPanel.tsx | ~60 |
| 4 | CollectionsSidebar.tsx, CatalogBrowser.tsx, EditBookDialog.tsx, ActivityLog.tsx, ProfileSwitcher.tsx, BookDetailModal.tsx, ReadingStats.tsx, KeyboardShortcutsHelp.tsx | ~50 |
| 5 | errors.ts (friendlyError mapping) | ~12 |

**Pattern in components:**
```tsx
import { useTranslation } from "react-i18next";

function MyComponent() {
  const { t } = useTranslation();
  return <button>{t("common.save")}</button>;
}
```

**Strings with variables** use interpolation:
```tsx
t("reader.pageOf", { current: 3, total: 50 })
// en.json: "reader.pageOf": "Page {{current}} / {{total}}"
// fr.json: "reader.pageOf": "Page {{current}} / {{total}}"
```

## Error Messages

`src/lib/errors.ts` — the `friendlyError()` function currently returns hardcoded English strings. After migration, it accepts a `t` function and returns translated messages:

```typescript
export function friendlyError(raw: string, t: TFunction): string {
  if (raw.includes("pdfium")) return t("errors.pdfium");
  // ...
  return t("errors.generic");
}
```

## Edge Cases

| Case | Behavior |
|------|----------|
| Unknown OS locale (e.g., Japanese) | Falls back to English |
| Missing translation key | i18next returns the English fallback |
| Partially migrated component | Unmigrated strings stay in English |
| Language changed mid-read | Reader UI updates instantly, book content unaffected |
| New language added by community | Drop JSON file + one line in i18n.ts config |
