# OPDS Preset Picker — Design

**Status:** Draft
**Author:** Mike (with Claude)
**Date:** 2026-05-01

## Goal

Let users discover and add curated OPDS catalogs in one click, instead of needing to know URLs by heart and paste them into a free-form input. Ship a small expansion of the built-in default catalog list at the same time.

## Scope

In scope:

- Discovery: a browseable list of curated OPDS catalogs.
- Frictionless add: one click adds a preset to the user's catalog list.
- Curation: Folio vouches for legality / OPDS-conformance of listed feeds.
- Default expansion: 2 → 5 built-in defaults.
- Filters: free-text search + language multi-select + category multi-select.

Out of scope:

- Auto-localization of preset ordering by app language (filter only).
- Remote-fetched / signed preset manifests.
- Localization of preset `name` / `description` (English only for v1).
- Suggestion-flow that creates a GitHub issue (UI link only; no in-app form).
- E2E tests, visual regression.

## Architecture

```
src/
├── data/
│   └── opds-presets.json            ← curated, hand-edited, PR-reviewed
├── types/
│   └── opdsPreset.ts                ← Preset, LanguageCode, Category
├── components/
│   ├── CatalogBrowser.tsx           ← + "Browse presets" button
│   └── OpdsPresetPicker.tsx         ← new inline panel component
└── lib/
    └── opdsPresets.ts               ← pure helpers (filter / dedup / facets)

src-tauri/src/commands.rs
   ├── DEFAULT_CATALOGS              ← 2 → 5 entries, each with preset_id
   ├── struct OpdsCatalogSource      ← + preset_id: Option<String>
   └── fn add_opds_catalog(name, url, preset_id?: Option<String>)
```

No new Tauri commands. Existing `get_opds_catalogs`, `add_opds_catalog`, `remove_opds_catalog` keep their names; only `add_opds_catalog` gains an optional argument.

## Data model

### Preset (frontend)

```ts
export type LanguageCode =
  | 'en' | 'fr' | 'de' | 'es' | 'it' | 'pt'
  | 'ja' | 'zh' | 'ru' | 'pl' | 'nl' | 'sv'
  | 'fi' | 'da' | 'hu' | 'bg' | 'be' | 'multi';

export type Category =
  | 'public-domain' | 'literature' | 'tech' | 'academic'
  | 'fiction' | 'religion' | 'politics' | 'commercial';

export interface Preset {
  id: string;              // stable, kebab-case, e.g. "project-gutenberg"
  name: string;            // display name (English, v1)
  url: string;             // OPDS catalog root
  languages: LanguageCode[];
  categories: Category[];
  description: string;     // one-line, English (v1)
}
```

### OpdsCatalogSource (backend, persisted)

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCatalogSource {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}
```

### DEFAULT_CATALOGS (backend, hardcoded)

Shape changes from `&[(&str, &str)]` (name, url) to `&[(&str, &str, &str)]` (name, url, preset_id):

```rust
const DEFAULT_CATALOGS: &[(&str, &str, &str)] = &[
    ("Project Gutenberg",  "https://m.gutenberg.org/ebooks.opds/", "project-gutenberg"),
    ("Standard Ebooks",    "https://standardebooks.org/opds",      "standard-ebooks"),
    ("Internet Archive",   "https://bookserver.archive.org/catalog/", "internet-archive"),
    ("Feedbooks",          "https://www.feedbooks.com/catalog.atom",  "feedbooks"),
    ("Wikisource (English)", "https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml", "wikisource-en"),
];
```

`get_opds_catalogs` populates each default `OpdsCatalogSource` with its `preset_id`, so the picker can mark them as "Added".

`preset_id` is the link between a stored catalog entry and its origin preset. Existing serialized blobs (no `preset_id` field) deserialize with `None` thanks to `#[serde(default)]`. New writes serialize the field only when set, so a downgraded build still reads them.

### opds-presets.json (initial content)

The JSON file contains every preset. The "default" flag is not in the JSON — `DEFAULT_CATALOGS` in `src-tauri/src/commands.rs` references the preset `id`s that ship pre-installed. This keeps the source of truth for catalog metadata in one place (the JSON) while letting the Rust side own the install policy.

**Pre-installed defaults** (referenced by id from `DEFAULT_CATALOGS`):

| id | name | url | languages | categories |
|----|------|-----|-----------|------------|
| `project-gutenberg` | Project Gutenberg | `https://m.gutenberg.org/ebooks.opds/` | en, multi | public-domain, literature |
| `standard-ebooks` | Standard Ebooks | `https://standardebooks.org/opds` | en | public-domain, literature |
| `internet-archive` | Internet Archive | `https://bookserver.archive.org/catalog/` | en, multi | public-domain, academic |
| `feedbooks` | Feedbooks | `https://www.feedbooks.com/catalog.atom` | en, fr, de, es, it, multi | public-domain, fiction |
| `wikisource-en` | Wikisource (English) | `https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml` | en | public-domain, literature |

Picker-only (sample — full list in the JSON file):

| id | name | url | languages | categories |
|----|------|-----|-----------|------------|
| `gallica` | Gallica | `https://gallica.bnf.fr/opds` | fr | public-domain, literature, academic |
| `atramenta` | Atramenta | `https://www.atramenta.net/opds/catalog.atom` | fr | literature |
| `ebooks-libres-gratuits` | Ebooks libres et gratuits | `https://www.ebooksgratuits.com/` | fr | public-domain |
| `openedition` | OpenEdition | `https://opds.openedition.org/` | fr | academic |
| `manybooks` | ManyBooks | `http://srv.manybooks.net/opds/index.php` | en | public-domain |
| `arxiv` | arXiv | `http://arxiv.maplepop.com/catalog/` | en | academic |
| `oreilly` | O'Reilly | `http://opds.oreilly.com/opds/` | en | tech, commercial |
| `gitbook` | GitBook | `https://www.gitbook.com/api/opds/catalog.atom` | en | tech |
| `pragpub` | PragPub Magazine | `https://pragprog.com/magazines.opds` | en | tech |
| `mek-hu` | Hungarian Electronic Library | `https://bookserver.mek.oszk.hu` | hu | public-domain |
| `chitanka-bg` | Читанка | `https://chitanka.info/catalog.opds` | bg | public-domain, literature |
| `anarchist-library-en` | Anarchist Library | `https://theanarchistlibrary.org/opds` | en | politics |
| `mises` | Mises Institute | `https://mises.org/catalog/` | en | academic |
| `plough` | Plough Publishing | `https://www.plough.com/ploughCatalog_opds.xml` | en | religion |

**URL verification gate.** Before shipping the JSON, every URL must respond with a parseable OPDS feed (status 200, `Content-Type` containing `atom+xml` or `opds`). Entries that fail verification are omitted from v1 rather than shipped broken. Candidates known to need verification at design time and therefore not committed to the v1 list: Aozora Bunko (Japanese PD), Wolne Lektury (Polish PD), textos.info (Spanish PD), epublibre (Spanish PD). They can be added in follow-up PRs once URLs are confirmed.

The current `DEFAULT_CATALOGS` second entry (`Standard Ebooks (New Releases)` → `https://standardebooks.org/feeds/atom/new-releases`) is replaced by the full-catalog feed at `https://standardebooks.org/opds`. This must be verified during implementation; if the full feed is unavailable, the current "New Releases" URL is kept and the preset id `standard-ebooks-new` is used instead.

## Components

### `OpdsPresetPicker.tsx`

```ts
interface Props {
  currentCatalogs: OpdsCatalog[];   // for "Added" detection
  onClose: () => void;
  onAdded: () => void;              // triggers parent loadCatalogs()
}
```

Local state:

- `query: string` — search input.
- `selectedLanguages: Set<LanguageCode>` — filter facet.
- `selectedCategories: Set<Category>` — filter facet.
- `addingId: string | null` — row-level spinner during add.

Renders inline (replaces the catalog list region inside the existing `CatalogBrowser` modal). Header shows back arrow + close. Search input + two chip rows for filters. Body is rich-row list with badges (icon + name + description + language + category badges + Add button or "Added" badge).

### `lib/opdsPresets.ts`

```ts
export function loadPresets(): Preset[];
export function filterPresets(
  presets: Preset[],
  query: string,
  languages: Set<LanguageCode>,
  categories: Set<Category>,
): Preset[];
export function isPresetAdded(
  preset: Preset,
  catalogs: OpdsCatalog[],
): boolean;
export function availableLanguages(presets: Preset[]): LanguageCode[];
export function availableCategories(presets: Preset[]): Category[];
```

All pure. No React. Independently testable.

### `CatalogBrowser.tsx` modifications

Add state:
```ts
const [showPresetPicker, setShowPresetPicker] = useState(false);
```

Replace the single "+ Add custom OPDS catalog" affordance with two buttons in the same row:

```
[+ Browse presets]   [+ Add custom URL]
```

When `showPresetPicker === true` and no `feed`, no `unifiedResults`, no `unifiedLoading`, render `<OpdsPresetPicker />` in the body slot. Browsing a feed or running unified search still takes precedence over the picker (existing behavior preserved).

## Data flow

### Add a preset

1. User clicks `+ Add` on row N.
2. `setAddingId(N.id)` → row shows spinner.
3. `invoke("add_opds_catalog", { name: N.name, url: N.url, presetId: N.id })`.
4. On success: `props.onAdded()` → parent reruns `loadCatalogs()` → `currentCatalogs` updates → `isPresetAdded(N, currentCatalogs)` → row flips to disabled "Added".
5. `setAddingId(null)`.
6. On error: toast `friendlyError(err, t)`, `setAddingId(null)`, row stays clickable.

No optimistic UI. Round-trip is a local DB write; failure is rare.

### Filtering

- Empty filter set in a facet ⇒ no constraint from that facet.
- Multi-select within a facet ⇒ OR (`languages` intersected non-empty).
- Across facets ⇒ AND.
- Search ⇒ case-insensitive substring on `name` ∪ `description`, ANDed with facet result.
- Sort: alphabetical by `name` within filtered set.

### Available chips

`availableLanguages` / `availableCategories` return the union of codes across all presets. Codes that no preset uses are not shown — the chip row is data-driven.

## Error handling

| Source | Outcome |
|--------|---------|
| `add_opds_catalog` rejects URL (`is_user_addable_url` false) | Toast: existing `urlBlocked` translation key. Row resets. (Should not occur for vetted presets; defense in depth.) |
| `add_opds_catalog` DB error | Toast: generic `errors.unknown`. Row resets. |
| Preset JSON unavailable at runtime | Impossible — bundled at build time. Type system + JSON validation test catch malformed entries before they ship. |
| Catalog stored with `preset_id` referring to a removed preset | Benign. Catalog list renders by stored `name` + `url`. Picker simply doesn't mark anything added. |

No new `FolioError` variants. Reuses existing `friendlyError()` mapping.

## i18n

New keys under `catalog.presets.*` in `src/locales/<lang>.json`:

```
catalog.presets.browseButton          "Browse presets"
catalog.presets.title                 "Browse presets"
catalog.presets.searchPlaceholder     "Search presets…"
catalog.presets.languageFilter        "Language"
catalog.presets.categoryFilter        "Category"
catalog.presets.allLanguages          "All"
catalog.presets.allCategories         "All"
catalog.presets.added                 "Added"
catalog.presets.add                   "+ Add"
catalog.presets.addError              "Could not add catalog"
catalog.presets.empty                 "No presets match your filters"
catalog.presets.clearFilters          "Clear filters"
catalog.presets.suggest               "Don't see what you need? Suggest a catalog"
catalog.presets.lang.<code>           "<localized language name>"   # one per LanguageCode
catalog.presets.category.<key>        "<localized category name>"   # one per Category
```

Preset `name` and `description` stay in English for v1 (out of scope: localizing data content).

## Testing

### Vitest

- `src/lib/opdsPresets.test.ts` — `filterPresets` (empty / search-only / language-only / category-only / combined), `isPresetAdded` (id match true; URL-only match false), `availableLanguages` / `availableCategories` (deduped, only present codes).
- `src/data/opds-presets.test.ts` — every entry has required fields, all `id` unique, all `url` parse via `new URL()`, every `languages[]` code ∈ `LanguageCode`, every `categories[]` code ∈ `Category`.
- `src/components/OpdsPresetPicker.test.tsx` — render, search filters list, language chip toggle, category chip toggle, "Added" badge shown when `isPresetAdded` true, `+ Add` invokes `add_opds_catalog` with correct args, add error shows toast and re-enables row.

### Cargo test

- `add_opds_catalog` accepts `preset_id: Some("project-gutenberg")` and persists it.
- `add_opds_catalog` with `preset_id: None` round-trips (custom-URL path).
- Existing serialized blob without `preset_id` deserializes with `preset_id = None`.
- `DEFAULT_CATALOGS` length is 5 and each entry has a non-empty `preset_id`.

### Manual smoke test

1. Fresh install → 5 default catalogs visible.
2. "Browse presets" → search "Gallica" → 1 row → click "+ Add" → row flips to "Added".
3. Filter Language=FR → shows Gallica, Atramenta, ebooks libres et gratuits, OpenEdition.
4. Filter Category=tech → shows O'Reilly, GitBook, PragPub.
5. Filter Language=FR + Category=public-domain → shows Gallica, ebooks libres.
6. Remove Gallica from main list → reopen picker → Gallica is "+ Add" again.

## Notes / latent issues spotted during design

- `remove_opds_catalog` only operates on `opds_custom_catalogs`; removing a `DEFAULT_CATALOGS` entry is a no-op (re-appears next launch). Out of scope for this feature, but worth tracking — a "hidden defaults" list in settings would resolve it.

## Implementation phases

This single design ships as one feature branch. No multi-PR split: the work is small enough to land together. Default expansion, picker UI, filters, JSON shipping, schema migration of `OpdsCatalogSource` — all one branch.
