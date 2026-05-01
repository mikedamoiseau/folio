# OPDS Preset Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated, filterable OPDS-catalog picker to the CatalogBrowser modal so users can browse + one-click-add catalogs without typing URLs, plus expand the built-in default catalog list from 2 to 5 entries.

**Architecture:** Pure-frontend approach (Approach 1 from spec). Curated presets live in `src/data/opds-presets.json`, validated by TS types and a Vitest schema test. Backend changes are minimal: `OpdsCatalogSource` gets an optional `preset_id` field for "Added" detection, and `DEFAULT_CATALOGS` expands to 5 entries that reference preset ids. The picker is an inline panel inside `CatalogBrowser` that swaps in over the catalog list region when activated.

**Tech Stack:** Tauri v2 (Rust), React 19, TypeScript, Tailwind CSS v4, react-i18next, Vitest + @testing-library/react, cargo test.

**Spec:** `docs/superpowers/specs/2026-05-01-opds-preset-picker-design.md`

**Branch:** Create a new branch off `main` (e.g. `feat/opds-preset-picker`) before starting Task 1. The spec doc already lives on `feat/opds-trust-user-catalogs`; do not implement on that branch.

---

## File Map

**Create:**
- `src/types/opdsPreset.ts` — `LanguageCode`, `Category`, `Preset` types.
- `src/data/opds-presets.json` — curated catalog list.
- `src/data/opds-presets.test.ts` — JSON shape + uniqueness validation.
- `src/lib/opdsPresets.ts` — pure filter/dedup/facet helpers.
- `src/lib/opdsPresets.test.ts` — helper unit tests.
- `src/components/OpdsPresetPicker.tsx` — inline picker panel.
- `src/components/OpdsPresetPicker.test.tsx` — RTL component tests.

**Modify:**
- `src-tauri/src/commands.rs` — `OpdsCatalogSource` struct, `DEFAULT_CATALOGS` const, `add_opds_catalog` signature, `get_opds_catalogs` to populate preset_id for defaults; add tests in the existing `mod tests`.
- `src/components/CatalogBrowser.tsx` — add Browse-presets button, render picker.
- `src/locales/en.json` — new `catalog.presets.*` keys.
- `src/locales/fr.json` — same keys, French translations.

---

## Task 1: Add preset_id field to OpdsCatalogSource (backend)

**Files:**
- Modify: `src-tauri/src/commands.rs` (struct around line 2563)
- Test: same file, inside `#[cfg(test)] mod tests` (around line 4938)

- [ ] **Step 1: Write failing test (round-trip + back-compat)**

Add to the `mod tests` block in `src-tauri/src/commands.rs`:

```rust
#[test]
fn opds_catalog_source_preset_id_roundtrip() {
    let src = OpdsCatalogSource {
        name: "Project Gutenberg".to_string(),
        url: "https://m.gutenberg.org/ebooks.opds/".to_string(),
        preset_id: Some("project-gutenberg".to_string()),
    };
    let json = serde_json::to_string(&src).unwrap();
    let parsed: OpdsCatalogSource = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.preset_id.as_deref(), Some("project-gutenberg"));
}

#[test]
fn opds_catalog_source_legacy_blob_deserializes_with_none_preset_id() {
    // Older builds wrote {name, url} only — must still parse.
    let legacy = r#"{"name":"Custom","url":"https://example.com/opds"}"#;
    let parsed: OpdsCatalogSource = serde_json::from_str(legacy).unwrap();
    assert_eq!(parsed.name, "Custom");
    assert!(parsed.preset_id.is_none());
}

#[test]
fn opds_catalog_source_serializes_camel_case_preset_id() {
    // The TS frontend reads `presetId`, not `preset_id`.
    let src = OpdsCatalogSource {
        name: "x".to_string(),
        url: "https://x".to_string(),
        preset_id: Some("x".to_string()),
    };
    let json = serde_json::to_string(&src).unwrap();
    assert!(json.contains("\"presetId\""), "expected camelCase: {json}");
}

#[test]
fn opds_catalog_source_omits_preset_id_when_none() {
    let src = OpdsCatalogSource {
        name: "x".to_string(),
        url: "https://x".to_string(),
        preset_id: None,
    };
    let json = serde_json::to_string(&src).unwrap();
    assert!(!json.contains("preset"), "expected no preset key: {json}");
}
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run: `cd src-tauri && cargo test opds_catalog_source -- --nocapture`
Expected: compile error — `OpdsCatalogSource` has no field `preset_id`.

- [ ] **Step 3: Add the field**

In `src-tauri/src/commands.rs`, replace the struct (around line 2563):

```rust
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCatalogSource {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}
```

- [ ] **Step 4: Fix every `OpdsCatalogSource { name, url }` literal in this file**

In `src-tauri/src/commands.rs`, run:

```bash
grep -n "OpdsCatalogSource {" /Users/mike/Documents/www/folio/src-tauri/src/commands.rs
```

For every match that constructs the struct without `preset_id`, append `preset_id: None,`. There is at least one in `add_opds_catalog`. Tests will catch any missed.

- [ ] **Step 5: Run tests, verify pass**

Run: `cd src-tauri && cargo test opds_catalog_source -- --nocapture`
Expected: PASS (4 tests).

Run: `cd src-tauri && cargo build`
Expected: clean build, no warnings about the new field.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(opds): add preset_id to OpdsCatalogSource

Optional field links a stored catalog entry to its origin preset.
Back-compat with existing serialized blobs via #[serde(default)];
omitted on serialize when None so older builds keep round-tripping."
```

---

## Task 2: Plumb preset_id through add_opds_catalog (backend)

**Files:**
- Modify: `src-tauri/src/commands.rs::add_opds_catalog` (around line 2641)
- Test: same file, `mod tests`

- [ ] **Step 1: Write failing test**

Append to `mod tests` in `src-tauri/src/commands.rs`:

```rust
#[test]
fn add_opds_catalog_persists_preset_id() {
    use crate::test_helpers::test_app_state;
    let state = test_app_state();
    tauri::async_runtime::block_on(async {
        add_opds_catalog(
            "Project Gutenberg".to_string(),
            "https://m.gutenberg.org/ebooks.opds/".to_string(),
            Some("project-gutenberg".to_string()),
            tauri::State::from(&state),
        )
        .await
        .unwrap();
        let cats = get_opds_catalogs(tauri::State::from(&state)).await.unwrap();
        let custom = cats.iter().find(|c| c.url.contains("gutenberg") && c.preset_id.is_some());
        assert_eq!(
            custom.unwrap().preset_id.as_deref(),
            Some("project-gutenberg")
        );
    });
}

#[test]
fn add_opds_catalog_with_no_preset_id_persists_none() {
    use crate::test_helpers::test_app_state;
    let state = test_app_state();
    tauri::async_runtime::block_on(async {
        add_opds_catalog(
            "Custom".to_string(),
            "https://example.com/opds".to_string(),
            None,
            tauri::State::from(&state),
        )
        .await
        .unwrap();
        let cats = get_opds_catalogs(tauri::State::from(&state)).await.unwrap();
        let custom = cats.iter().find(|c| c.url == "https://example.com/opds").unwrap();
        assert!(custom.preset_id.is_none());
    });
}
```

If `crate::test_helpers::test_app_state` does not exist, replace those two blocks with the simpler shape used by other DB-touching tests in the file (search for `tempfile::tempdir` usage in `mod tests`). The test is correct as long as it: (a) creates a temp DB, (b) calls `add_opds_catalog` with and without `preset_id`, (c) asserts persistence via `get_opds_catalogs`. If no helper exists at all, write inline:

```rust
fn temp_state() -> AppState {
    let tmp = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
    let mut pools = std::collections::HashMap::new();
    let shared = std::sync::Arc::new(std::sync::Mutex::new(pool.clone()));
    AppState {
        profile_state: std::sync::Mutex::new(crate::ProfileState {
            active: "default".to_string(),
            pools,
            default_pool: pool,
        }),
        shared_active_pool: shared,
        data_dir: tmp.path().to_path_buf(),
    }
}
```

(Confirm field names/visibility against the actual `AppState` definition in `lib.rs` before pasting.)

- [ ] **Step 2: Run failing test**

Run: `cd src-tauri && cargo test add_opds_catalog_persists -- --nocapture`
Expected: compile error — `add_opds_catalog` takes 3 args, not 4.

- [ ] **Step 3: Update `add_opds_catalog` signature + body**

Replace the function in `src-tauri/src/commands.rs` (around line 2638):

```rust
#[tauri::command]
pub async fn add_opds_catalog(
    name: String,
    url: String,
    preset_id: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    if !opds::is_user_addable_url(&url) {
        return Err(FolioError::invalid(
            "Invalid catalog URL — only http:// or https:// URLs are accepted.",
        ));
    }
    let conn = state.active_db()?.get()?;
    let custom_json =
        db::get_setting(&conn, "opds_custom_catalogs")?.unwrap_or_else(|| "[]".to_string());
    let mut custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();
    custom.push(OpdsCatalogSource { name, url, preset_id });
    let json = serde_json::to_string(&custom)?;
    Ok(db::set_setting(&conn, "opds_custom_catalogs", &json)?)
}
```

Tauri infers args from the JS payload via name, so the JS side will pass `presetId` (camelCase auto-mapped to `preset_id`). No invoke_handler change needed.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd src-tauri && cargo test add_opds_catalog -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(opds): accept optional preset_id in add_opds_catalog

Persists the preset id alongside name+url so the picker can mark
catalogs as Added without URL-string matching."
```

---

## Task 3: Expand DEFAULT_CATALOGS to 5 with preset ids (backend)

**Files:**
- Modify: `src-tauri/src/commands.rs::DEFAULT_CATALOGS` (around line 2570) and `get_opds_catalogs` (around line 2618)
- Test: same file, `mod tests`

- [ ] **Step 1: Write failing tests**

Append to `mod tests`:

```rust
#[test]
fn default_catalogs_has_five_entries_each_with_preset_id() {
    assert_eq!(DEFAULT_CATALOGS.len(), 5);
    for (name, url, preset_id) in DEFAULT_CATALOGS {
        assert!(!name.is_empty(), "default catalog has empty name");
        assert!(
            url.starts_with("http://") || url.starts_with("https://"),
            "url must be http(s): {url}"
        );
        assert!(!preset_id.is_empty(), "preset_id must be set for {name}");
    }
    let ids: Vec<&str> = DEFAULT_CATALOGS.iter().map(|(_, _, id)| *id).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "preset_ids must be unique");
}

#[test]
fn default_catalogs_include_expected_preset_ids() {
    let ids: std::collections::HashSet<&str> =
        DEFAULT_CATALOGS.iter().map(|(_, _, id)| *id).collect();
    for expected in &[
        "project-gutenberg",
        "standard-ebooks",
        "internet-archive",
        "feedbooks",
        "wikisource-en",
    ] {
        assert!(ids.contains(expected), "missing default preset_id: {expected}");
    }
}

#[test]
fn get_opds_catalogs_populates_preset_id_for_defaults() {
    use crate::test_helpers::test_app_state; // or inline temp_state(); see Task 2 Step 1
    let state = test_app_state();
    let cats = tauri::async_runtime::block_on(async {
        get_opds_catalogs(tauri::State::from(&state)).await.unwrap()
    });
    let gutenberg = cats
        .iter()
        .find(|c| c.url == "https://m.gutenberg.org/ebooks.opds/")
        .expect("default Project Gutenberg missing");
    assert_eq!(gutenberg.preset_id.as_deref(), Some("project-gutenberg"));
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd src-tauri && cargo test default_catalogs -- --nocapture`
Expected: compile error — `DEFAULT_CATALOGS` is a 2-tuple, not a 3-tuple.

- [ ] **Step 3: Replace DEFAULT_CATALOGS const**

In `src-tauri/src/commands.rs` (around line 2570):

```rust
const DEFAULT_CATALOGS: &[(&str, &str, &str)] = &[
    (
        "Project Gutenberg",
        "https://m.gutenberg.org/ebooks.opds/",
        "project-gutenberg",
    ),
    (
        "Standard Ebooks",
        "https://standardebooks.org/opds",
        "standard-ebooks",
    ),
    (
        "Internet Archive",
        "https://bookserver.archive.org/catalog/",
        "internet-archive",
    ),
    (
        "Feedbooks",
        "https://www.feedbooks.com/catalog.atom",
        "feedbooks",
    ),
    (
        "Wikisource (English)",
        "https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml",
        "wikisource-en",
    ),
];
```

- [ ] **Step 4: Update `get_opds_catalogs` to emit preset_id**

In `src-tauri/src/commands.rs` (around line 2618), replace the body of `get_opds_catalogs`:

```rust
#[tauri::command]
pub async fn get_opds_catalogs(state: State<'_, AppState>) -> FolioResult<Vec<OpdsCatalogSource>> {
    let conn = state.active_db()?.get()?;
    let custom_json =
        db::get_setting(&conn, "opds_custom_catalogs")?.unwrap_or_else(|| "[]".to_string());
    let custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();

    let mut result: Vec<OpdsCatalogSource> = DEFAULT_CATALOGS
        .iter()
        .map(|(name, url, preset_id)| OpdsCatalogSource {
            name: name.to_string(),
            url: url.to_string(),
            preset_id: Some(preset_id.to_string()),
        })
        .collect();
    result.extend(custom);
    Ok(result)
}
```

- [ ] **Step 5: Update the two `trusted_hosts_from_*` helpers if they pattern-match the tuple**

Run:
```bash
grep -n "DEFAULT_CATALOGS" /Users/mike/Documents/www/folio/src-tauri/src/commands.rs
```

The other site is `trusted_hosts_from_db` — it destructures `(_, url)`. Update to `(_, url, _)`:

```rust
fn trusted_hosts_from_db(conn: &rusqlite::Connection) -> Vec<String> {
    let mut hosts: Vec<String> = DEFAULT_CATALOGS
        .iter()
        .filter_map(|(_, url, _)| opds::host_port_from_url(url))
        .collect();
    // ... rest unchanged
}
```

- [ ] **Step 6: Run all backend tests**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: all PASS.

- [ ] **Step 7: Run clippy/fmt**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(opds): expand defaults to 5 catalogs with preset ids

Adds Internet Archive, Feedbooks, Wikisource (English) to the
out-of-box list, and replaces the Standard Ebooks 'New Releases' feed
with the full catalog. Each entry now carries its preset id so the
upcoming picker can mark them as Added."
```

---

## Task 4: Frontend types module

**Files:**
- Create: `src/types/opdsPreset.ts`

- [ ] **Step 1: Create the types file**

Write `src/types/opdsPreset.ts`:

```ts
export type LanguageCode =
  | "en"
  | "fr"
  | "de"
  | "es"
  | "it"
  | "pt"
  | "ja"
  | "zh"
  | "ru"
  | "pl"
  | "nl"
  | "sv"
  | "fi"
  | "da"
  | "hu"
  | "bg"
  | "be"
  | "multi";

export type Category =
  | "public-domain"
  | "literature"
  | "tech"
  | "academic"
  | "fiction"
  | "religion"
  | "politics"
  | "commercial";

export interface Preset {
  id: string;
  name: string;
  url: string;
  languages: LanguageCode[];
  categories: Category[];
  description: string;
}

export const ALL_LANGUAGES: readonly LanguageCode[] = [
  "en", "fr", "de", "es", "it", "pt", "ja", "zh", "ru",
  "pl", "nl", "sv", "fi", "da", "hu", "bg", "be", "multi",
] as const;

export const ALL_CATEGORIES: readonly Category[] = [
  "public-domain", "literature", "tech", "academic",
  "fiction", "religion", "politics", "commercial",
] as const;
```

- [ ] **Step 2: Verify type-check passes**

Run: `pnpm run type-check`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/types/opdsPreset.ts
git commit -m "feat(opds): add Preset, LanguageCode, Category types"
```

---

## Task 5: Ship opds-presets.json + schema validation test

**Files:**
- Create: `src/data/opds-presets.json`
- Create: `src/data/opds-presets.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/data/opds-presets.test.ts`:

```ts
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
      "standard-ebooks",
      "internet-archive",
      "feedbooks",
      "wikisource-en",
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm run test src/data/opds-presets.test.ts`
Expected: FAIL — JSON file does not exist.

- [ ] **Step 3: Create the JSON**

Write `src/data/opds-presets.json`:

```json
[
  {
    "id": "project-gutenberg",
    "name": "Project Gutenberg",
    "url": "https://m.gutenberg.org/ebooks.opds/",
    "languages": ["en", "multi"],
    "categories": ["public-domain", "literature"],
    "description": "Public domain ebooks, 70k+ titles."
  },
  {
    "id": "standard-ebooks",
    "name": "Standard Ebooks",
    "url": "https://standardebooks.org/opds",
    "languages": ["en"],
    "categories": ["public-domain", "literature"],
    "description": "Curated, beautifully typeset public domain books."
  },
  {
    "id": "internet-archive",
    "name": "Internet Archive",
    "url": "https://bookserver.archive.org/catalog/",
    "languages": ["en", "multi"],
    "categories": ["public-domain", "academic"],
    "description": "Massive open-access library of books and documents."
  },
  {
    "id": "feedbooks",
    "name": "Feedbooks",
    "url": "https://www.feedbooks.com/catalog.atom",
    "languages": ["en", "fr", "de", "es", "it", "multi"],
    "categories": ["public-domain", "fiction"],
    "description": "Free public domain titles in multiple languages."
  },
  {
    "id": "wikisource-en",
    "name": "Wikisource (English)",
    "url": "https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml",
    "languages": ["en"],
    "categories": ["public-domain", "literature"],
    "description": "English-language Wikisource texts ready for export."
  },
  {
    "id": "gallica",
    "name": "Gallica",
    "url": "https://gallica.bnf.fr/opds",
    "languages": ["fr"],
    "categories": ["public-domain", "literature", "academic"],
    "description": "Bibliothèque nationale de France digital library."
  },
  {
    "id": "atramenta",
    "name": "Atramenta",
    "url": "https://www.atramenta.net/opds/catalog.atom",
    "languages": ["fr"],
    "categories": ["literature"],
    "description": "Free French literature, classic and contemporary."
  },
  {
    "id": "ebooks-libres-gratuits",
    "name": "Ebooks libres et gratuits",
    "url": "https://www.ebooksgratuits.com/",
    "languages": ["fr"],
    "categories": ["public-domain"],
    "description": "Free French public domain ebooks."
  },
  {
    "id": "openedition",
    "name": "OpenEdition",
    "url": "https://opds.openedition.org/",
    "languages": ["fr"],
    "categories": ["academic"],
    "description": "French academic books and journals in humanities."
  },
  {
    "id": "manybooks",
    "name": "ManyBooks",
    "url": "http://srv.manybooks.net/opds/index.php",
    "languages": ["en"],
    "categories": ["public-domain"],
    "description": "Public domain ebooks, mirrors and originals."
  },
  {
    "id": "arxiv",
    "name": "arXiv",
    "url": "http://arxiv.maplepop.com/catalog/",
    "languages": ["en"],
    "categories": ["academic"],
    "description": "Academic preprints in physics, math, and CS."
  },
  {
    "id": "oreilly",
    "name": "O'Reilly",
    "url": "http://opds.oreilly.com/opds/",
    "languages": ["en"],
    "categories": ["tech", "commercial"],
    "description": "Technology and professional reference books."
  },
  {
    "id": "gitbook",
    "name": "GitBook",
    "url": "https://www.gitbook.com/api/opds/catalog.atom",
    "languages": ["en"],
    "categories": ["tech"],
    "description": "Technical documentation and books."
  },
  {
    "id": "pragpub",
    "name": "PragPub Magazine",
    "url": "https://pragprog.com/magazines.opds",
    "languages": ["en"],
    "categories": ["tech"],
    "description": "Pragmatic Programmers technical magazine archive."
  },
  {
    "id": "mek-hu",
    "name": "Hungarian Electronic Library",
    "url": "https://bookserver.mek.oszk.hu",
    "languages": ["hu"],
    "categories": ["public-domain"],
    "description": "Hungarian National Library electronic collection."
  },
  {
    "id": "chitanka-bg",
    "name": "Читанка",
    "url": "https://chitanka.info/catalog.opds",
    "languages": ["bg"],
    "categories": ["public-domain", "literature"],
    "description": "Bulgarian free books and literature."
  },
  {
    "id": "anarchist-library-en",
    "name": "Anarchist Library",
    "url": "https://theanarchistlibrary.org/opds",
    "languages": ["en"],
    "categories": ["politics"],
    "description": "Anarchist political theory and history texts."
  },
  {
    "id": "mises",
    "name": "Mises Institute",
    "url": "https://mises.org/catalog/",
    "languages": ["en"],
    "categories": ["academic"],
    "description": "Austrian economics and libertarian theory."
  },
  {
    "id": "plough",
    "name": "Plough Publishing",
    "url": "https://www.plough.com/ploughCatalog_opds.xml",
    "languages": ["en"],
    "categories": ["religion"],
    "description": "Christian thought, fiction, and biography."
  }
]
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm run test src/data/opds-presets.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify each URL responds (manual gate before merge — not required to pass test)**

Run for each URL in the JSON:
```bash
for u in $(jq -r '.[].url' src/data/opds-presets.json); do
  echo -n "$u "
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" --max-time 10 "$u" || echo "FAIL"
done
```

Expected: each line shows a 2xx/3xx status and a content-type containing `xml` or `atom`. Remove any entry that fails this gate from `opds-presets.json` and update the JSON test if it referenced one of the 5 defaults (those must stay).

- [ ] **Step 6: Commit**

```bash
git add src/data/opds-presets.json src/data/opds-presets.test.ts
git commit -m "feat(opds): ship curated preset catalog list

19 verified OPDS feeds across English, French, Hungarian, Bulgarian.
Schema-validated by Vitest (id uniqueness, URL parses, controlled
vocab for languages and categories)."
```

---

## Task 6: Pure helpers — filter / dedup / facets

**Files:**
- Create: `src/lib/opdsPresets.ts`
- Create: `src/lib/opdsPresets.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/opdsPresets.test.ts`:

```ts
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
    // FR AND public-domain → only Gallica.
    const out = filterPresets(sample, "", new Set(["fr"]), new Set(["public-domain"]));
    expect(out.map((p) => p.id)).toEqual(["p2"]);
  });

  it("search ANDs with facet filters", () => {
    // search 'tech' + lang FR → empty (Gallica isn't tech, O'Reilly isn't FR).
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm run test src/lib/opdsPresets.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/lib/opdsPresets.ts`**

```ts
import presetsJson from "../data/opds-presets.json";
import type { Preset, LanguageCode, Category } from "../types/opdsPreset";

interface OpdsCatalogLike {
  url: string;
  presetId?: string | null;
}

export function loadPresets(): Preset[] {
  return presetsJson as Preset[];
}

export function filterPresets(
  presets: Preset[],
  query: string,
  languages: Set<LanguageCode>,
  categories: Set<Category>,
): Preset[] {
  const q = query.trim().toLowerCase();
  return presets.filter((p) => {
    if (q.length > 0) {
      const hay = `${p.name}\n${p.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (languages.size > 0) {
      const hit = p.languages.some((l) => languages.has(l));
      if (!hit) return false;
    }
    if (categories.size > 0) {
      const hit = p.categories.some((c) => categories.has(c));
      if (!hit) return false;
    }
    return true;
  });
}

export function isPresetAdded(
  preset: Preset,
  catalogs: OpdsCatalogLike[],
): boolean {
  return catalogs.some((c) => c.presetId === preset.id);
}

export function availableLanguages(presets: Preset[]): LanguageCode[] {
  const set = new Set<LanguageCode>();
  for (const p of presets) for (const l of p.languages) set.add(l);
  return Array.from(set).sort();
}

export function availableCategories(presets: Preset[]): Category[] {
  const set = new Set<Category>();
  for (const p of presets) for (const c of p.categories) set.add(c);
  return Array.from(set).sort();
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm run test src/lib/opdsPresets.test.ts`
Expected: PASS (15 assertions across the describe blocks).

- [ ] **Step 5: Run full FE suite**

Run: `pnpm run test 2>&1 | tail -5`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/opdsPresets.ts src/lib/opdsPresets.test.ts
git commit -m "feat(opds): add pure preset filter and facet helpers

filterPresets, isPresetAdded, availableLanguages, availableCategories.
Pure functions, no React dependencies, fully unit-tested."
```

---

## Task 7: Add i18n keys (en + fr)

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Read both files to find the `catalog` block**

Run:
```bash
grep -n "catalog" /Users/mike/Documents/www/folio/src/locales/en.json | head
grep -n "catalog" /Users/mike/Documents/www/folio/src/locales/fr.json | head
```

The English `catalog` block ends with `"downloadFailed": "..."` (around line 459).

- [ ] **Step 2: Append `presets` sub-object inside the existing `catalog` object in `src/locales/en.json`**

Find the line `"downloadFailed": "Failed to download \"{{title}}\": {{error}}"` and add the `presets` block after it (still inside `"catalog": { … }`):

```json
    "downloadFailed": "Failed to download \"{{title}}\": {{error}}",
    "presets": {
      "browseButton": "Browse presets",
      "title": "Browse presets",
      "searchPlaceholder": "Search presets…",
      "languageFilter": "Language",
      "categoryFilter": "Category",
      "allLanguages": "All",
      "allCategories": "All",
      "added": "Added",
      "add": "+ Add",
      "addError": "Could not add catalog",
      "empty": "No presets match your filters",
      "clearFilters": "Clear filters",
      "suggest": "Don't see what you need? Suggest a catalog",
      "lang": {
        "en": "English",
        "fr": "French",
        "de": "German",
        "es": "Spanish",
        "it": "Italian",
        "pt": "Portuguese",
        "ja": "Japanese",
        "zh": "Chinese",
        "ru": "Russian",
        "pl": "Polish",
        "nl": "Dutch",
        "sv": "Swedish",
        "fi": "Finnish",
        "da": "Danish",
        "hu": "Hungarian",
        "bg": "Bulgarian",
        "be": "Belarusian",
        "multi": "Multilingual"
      },
      "category": {
        "public-domain": "Public domain",
        "literature": "Literature",
        "tech": "Technology",
        "academic": "Academic",
        "fiction": "Fiction",
        "religion": "Religion",
        "politics": "Politics",
        "commercial": "Commercial"
      }
    }
```

Take care to add the trailing comma on the previous line (`"downloadFailed": "...",`) and not to leave an extra trailing comma after the new `presets` block.

- [ ] **Step 3: Same edit in `src/locales/fr.json` with French strings**

Append the same structure inside the `catalog` object, with French translations:

```json
    "presets": {
      "browseButton": "Parcourir les presets",
      "title": "Parcourir les presets",
      "searchPlaceholder": "Rechercher des presets…",
      "languageFilter": "Langue",
      "categoryFilter": "Catégorie",
      "allLanguages": "Toutes",
      "allCategories": "Toutes",
      "added": "Ajouté",
      "add": "+ Ajouter",
      "addError": "Impossible d'ajouter le catalogue",
      "empty": "Aucun preset ne correspond à vos filtres",
      "clearFilters": "Effacer les filtres",
      "suggest": "Vous ne trouvez pas ? Suggérer un catalogue",
      "lang": {
        "en": "Anglais",
        "fr": "Français",
        "de": "Allemand",
        "es": "Espagnol",
        "it": "Italien",
        "pt": "Portugais",
        "ja": "Japonais",
        "zh": "Chinois",
        "ru": "Russe",
        "pl": "Polonais",
        "nl": "Néerlandais",
        "sv": "Suédois",
        "fi": "Finnois",
        "da": "Danois",
        "hu": "Hongrois",
        "bg": "Bulgare",
        "be": "Biélorusse",
        "multi": "Multilingue"
      },
      "category": {
        "public-domain": "Domaine public",
        "literature": "Littérature",
        "tech": "Technologie",
        "academic": "Universitaire",
        "fiction": "Fiction",
        "religion": "Religion",
        "politics": "Politique",
        "commercial": "Commercial"
      }
    }
```

- [ ] **Step 4: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json'))" && node -e "JSON.parse(require('fs').readFileSync('src/locales/fr.json'))"`
Expected: no output (valid JSON).

- [ ] **Step 5: Run type-check + tests (i18n consumers may have shape checks)**

Run: `pnpm run type-check && pnpm run test 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "i18n(opds): add catalog.presets.* keys for en + fr"
```

---

## Task 8: OpdsPresetPicker component

**Files:**
- Create: `src/components/OpdsPresetPicker.tsx`
- Create: `src/components/OpdsPresetPicker.test.tsx`

- [ ] **Step 1: Write the test**

Create `src/components/OpdsPresetPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OpdsPresetPicker from "./OpdsPresetPicker";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
  }),
}));

vi.mock("../data/opds-presets.json", () => ({
  default: [
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
  ],
}));

import { invoke } from "@tauri-apps/api/core";

describe("OpdsPresetPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const props = {
    currentCatalogs: [],
    onClose: vi.fn(),
    onAdded: vi.fn(),
  };

  it("renders all presets when no filters set", () => {
    render(<OpdsPresetPicker {...props} />);
    expect(screen.getByText("Project Gutenberg")).toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("filters by search query", () => {
    render(<OpdsPresetPicker {...props} />);
    const input = screen.getByPlaceholderText("catalog.presets.searchPlaceholder");
    fireEvent.change(input, { target: { value: "gallica" } });
    expect(screen.queryByText("Project Gutenberg")).not.toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("shows Added badge for already-added presets", () => {
    render(
      <OpdsPresetPicker
        {...props}
        currentCatalogs={[
          { name: "Project Gutenberg", url: "https://gutenberg.org/opds", presetId: "p1" },
        ]}
      />,
    );
    // Disabled "Added" badge instead of "+ Add" on Gutenberg row.
    const gutenbergRow = screen.getByText("Project Gutenberg").closest("[data-preset-id]");
    expect(gutenbergRow).toHaveAttribute("data-preset-id", "p1");
    // The Add button on Gutenberg should be absent; the Added label should be present.
    const addedBadges = screen.getAllByText("catalog.presets.added");
    expect(addedBadges.length).toBeGreaterThan(0);
  });

  it("invokes add_opds_catalog with name, url, presetId on Add click", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    render(<OpdsPresetPicker {...props} />);

    // Find the row for Gallica and click its "+ Add" button.
    const gallicaRow = screen.getByText("Gallica").closest("[data-preset-id='p2']");
    expect(gallicaRow).not.toBeNull();
    const addBtn = gallicaRow!.querySelector("button[data-action='add']");
    expect(addBtn).not.toBeNull();
    fireEvent.click(addBtn as HTMLElement);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_opds_catalog", {
        name: "Gallica",
        url: "https://gallica.bnf.fr/opds",
        presetId: "p2",
      });
    });
    expect(props.onAdded).toHaveBeenCalled();
  });

  it("toggles language filter chip", () => {
    render(<OpdsPresetPicker {...props} />);
    // Click "fr" chip → only Gallica visible.
    const frChip = screen.getByRole("button", { name: /catalog\.presets\.lang\.fr/ });
    fireEvent.click(frChip);
    expect(screen.queryByText("Project Gutenberg")).not.toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("shows empty state when no presets match", () => {
    render(<OpdsPresetPicker {...props} />);
    fireEvent.change(screen.getByPlaceholderText("catalog.presets.searchPlaceholder"), {
      target: { value: "zzznotamatch" },
    });
    expect(screen.getByText("catalog.presets.empty")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify fail**

Run: `pnpm run test src/components/OpdsPresetPicker.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/OpdsPresetPicker.tsx`:

```tsx
import { useMemo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  loadPresets,
  filterPresets,
  isPresetAdded,
  availableLanguages,
  availableCategories,
} from "../lib/opdsPresets";
import type { LanguageCode, Category, Preset } from "../types/opdsPreset";

interface OpdsCatalog {
  name: string;
  url: string;
  presetId?: string | null;
}

interface Props {
  currentCatalogs: OpdsCatalog[];
  onClose: () => void;
  onAdded: () => void;
}

export default function OpdsPresetPicker({
  currentCatalogs,
  onClose,
  onAdded,
}: Props) {
  const { t } = useTranslation();
  const presets = useMemo(() => loadPresets(), []);
  const langs = useMemo(() => availableLanguages(presets), [presets]);
  const cats = useMemo(() => availableCategories(presets), [presets]);

  const [query, setQuery] = useState("");
  const [selectedLangs, setSelectedLangs] = useState<Set<LanguageCode>>(new Set());
  const [selectedCats, setSelectedCats] = useState<Set<Category>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterPresets(presets, query, selectedLangs, selectedCats),
    [presets, query, selectedLangs, selectedCats],
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => a.name.localeCompare(b.name)),
    [filtered],
  );

  const toggleLang = useCallback((l: LanguageCode) => {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  }, []);

  const toggleCat = useCallback((c: Category) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setQuery("");
    setSelectedLangs(new Set());
    setSelectedCats(new Set());
  }, []);

  const handleAdd = useCallback(
    async (p: Preset) => {
      setAddingId(p.id);
      setErrorId(null);
      try {
        await invoke("add_opds_catalog", {
          name: p.name,
          url: p.url,
          presetId: p.id,
        });
        onAdded();
      } catch {
        setErrorId(p.id);
      } finally {
        setAddingId(null);
      }
    },
    [onAdded],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-warm-border flex items-center gap-2 shrink-0">
        <button
          onClick={onClose}
          className="p-1 text-ink-muted hover:text-ink rounded"
          aria-label={t("common.back")}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M12 5l-7 5 7 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h3 className="font-serif text-sm font-semibold text-ink">{t("catalog.presets.title")}</h3>
      </div>

      {/* Filters */}
      <div className="px-5 py-3 border-b border-warm-border space-y-2 shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("catalog.presets.searchPlaceholder")}
          className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
        />
        {langs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-ink-muted self-center mr-1">
              {t("catalog.presets.languageFilter")}:
            </span>
            {langs.map((l) => {
              const active = selectedLangs.has(l);
              return (
                <button
                  key={l}
                  type="button"
                  aria-label={t(`catalog.presets.lang.${l}`)}
                  onClick={() => toggleLang(l)}
                  className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "bg-warm-subtle text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`catalog.presets.lang.${l}`)}
                </button>
              );
            })}
          </div>
        )}
        {cats.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-ink-muted self-center mr-1">
              {t("catalog.presets.categoryFilter")}:
            </span>
            {cats.map((c) => {
              const active = selectedCats.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={t(`catalog.presets.category.${c}`)}
                  onClick={() => toggleCat(c)}
                  className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "bg-warm-subtle text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`catalog.presets.category.${c}`)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-sm text-ink-muted">{t("catalog.presets.empty")}</p>
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-accent hover:underline"
            >
              {t("catalog.presets.clearFilters")}
            </button>
          </div>
        ) : (
          sorted.map((p) => {
            const added = isPresetAdded(p, currentCatalogs);
            const adding = addingId === p.id;
            const failed = errorId === p.id;
            return (
              <div
                key={p.id}
                data-preset-id={p.id}
                className="flex items-start gap-3 px-5 py-3 border-b border-warm-border/50"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink leading-snug">{p.name}</p>
                      <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{p.description}</p>
                    </div>
                    {added ? (
                      <span className="text-[11px] text-ink-muted shrink-0 px-2 py-0.5">
                        ✓ {t("catalog.presets.added")}
                      </span>
                    ) : adding ? (
                      <span className="text-[11px] text-ink-muted shrink-0 px-2 py-0.5">…</span>
                    ) : (
                      <button
                        type="button"
                        data-action="add"
                        onClick={() => handleAdd(p)}
                        className="text-[11px] font-medium text-accent bg-accent-light hover:bg-accent hover:text-white px-2 py-0.5 rounded transition-colors shrink-0"
                      >
                        {t("catalog.presets.add")}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {p.languages.map((l) => (
                      <span
                        key={l}
                        className="text-[10px] px-1.5 py-0 rounded-full bg-warm-subtle text-ink-muted"
                      >
                        {t(`catalog.presets.lang.${l}`)}
                      </span>
                    ))}
                    {p.categories.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] px-1.5 py-0 rounded-full bg-accent-light/60 text-accent"
                      >
                        {t(`catalog.presets.category.${c}`)}
                      </span>
                    ))}
                  </div>
                  {failed && (
                    <p className="text-[11px] text-red-500 mt-1">
                      {t("catalog.presets.addError")}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm run test src/components/OpdsPresetPicker.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Run type-check**

Run: `pnpm run type-check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/OpdsPresetPicker.tsx src/components/OpdsPresetPicker.test.tsx
git commit -m "feat(opds): add inline preset-picker panel

Search + language + category filters, rich rows with badges,
disabled Added state when preset id already in user's catalogs."
```

---

## Task 9: CatalogBrowser integration

**Files:**
- Modify: `src/components/CatalogBrowser.tsx`

- [ ] **Step 1: Read the relevant region**

Run:
```bash
grep -n "showAddCatalog\|addCustomCatalog\|loadCatalogs" /Users/mike/Documents/www/folio/src/components/CatalogBrowser.tsx
```

Expected: locations of the existing "Add custom OPDS catalog" toggle, the form fragment, and `loadCatalogs`.

- [ ] **Step 2: Update the `OpdsCatalog` interface**

In `src/components/CatalogBrowser.tsx` near the top (around line 8-11), add the optional `presetId` field:

```tsx
interface OpdsCatalog {
  name: string;
  url: string;
  presetId?: string | null;
}
```

- [ ] **Step 3: Add picker state + import**

Add the import near the top of the file (after the existing imports):

```tsx
import OpdsPresetPicker from "./OpdsPresetPicker";
```

Inside `CatalogBrowser`, near the existing `showAddCatalog` state:

```tsx
const [showPresetPicker, setShowPresetPicker] = useState(false);
```

- [ ] **Step 4: Add the Browse-presets button alongside the Add-custom-URL button**

Locate the button row that currently shows the "Add custom OPDS catalog" toggle. Replace just that single-button row with two buttons. Search for `addCustomCatalog` to find it. The result should look like:

```tsx
<div className="px-5 py-2 border-b border-warm-border flex gap-2 shrink-0">
  <button
    type="button"
    onClick={() => {
      setShowPresetPicker(true);
      setShowAddCatalog(false);
    }}
    className="flex-1 text-xs font-medium text-accent hover:bg-accent-light/50 rounded-lg px-3 py-1.5 transition-colors"
  >
    {t("catalog.presets.browseButton")}
  </button>
  <button
    type="button"
    onClick={() => {
      setShowAddCatalog((v) => !v);
      setShowPresetPicker(false);
    }}
    className="flex-1 text-xs font-medium text-accent hover:bg-accent-light/50 rounded-lg px-3 py-1.5 transition-colors"
  >
    {t("catalog.addCustomCatalog")}
  </button>
</div>
```

(Keep the existing `showAddCatalog` form fragment that currently sits below this button row — only the button itself moves into the two-button layout.)

- [ ] **Step 5: Render the picker in the body slot**

Find the catalog-list rendering region — it sits inside the `if (!feed)` branch around line 191. The body currently renders `unifiedResults` if present, otherwise the catalog list. Insert a third condition: if `showPresetPicker && !unifiedResults && !unifiedLoading`, render the picker.

The body slot wrapper currently looks like `<div className="flex-1 overflow-y-auto py-2 relative">`. Inside that wrapper, before the existing `{unifiedLoading ? … : unifiedResults ? … : <catalog list>}` ladder, gate on the picker:

```tsx
{showPresetPicker && !unifiedLoading && !unifiedResults ? (
  <OpdsPresetPicker
    currentCatalogs={catalogs}
    onClose={() => setShowPresetPicker(false)}
    onAdded={async () => {
      await loadCatalogs();
    }}
  />
) : unifiedLoading ? (
  /* … existing unified-loading branch … */
) : unifiedResults ? (
  /* … existing unified-results branch … */
) : (
  /* … existing catalog list … */
)}
```

The existing structure uses a JSX expression with three clauses. Add the picker as a fourth clause at the top of the chain.

- [ ] **Step 6: Type-check + run all tests**

Run: `pnpm run type-check && pnpm run test 2>&1 | tail -10`
Expected: clean type-check, all tests PASS.

- [ ] **Step 7: Manual smoke (foreground)**

Run: `pnpm tauri dev`
Manually:
1. Open `Catalogs` modal.
2. Click "Browse presets" — picker renders inline (catalog list area replaced).
3. Type `gallica` in search → only Gallica row visible.
4. Clear search; click `fr` chip → only French presets visible.
5. Click `+ Add` on Gallica → row flips to "Added". Close modal, reopen — Gallica appears in the catalog list.
6. Reopen picker → Gallica is "Added" still.
7. Click back arrow → returns to catalog list view.

If anything misbehaves, fix and re-run before committing.

- [ ] **Step 8: Commit**

```bash
git add src/components/CatalogBrowser.tsx
git commit -m "feat(opds): wire OpdsPresetPicker into CatalogBrowser

Browse-presets button alongside the existing Add-custom-URL button.
Picker swaps in over the catalog list region; close returns to list."
```

---

## Task 10: Final CI gate + manual checklist

**Files:** none (verification only)

- [ ] **Step 1: Run full CI suite locally**

Run from project root:
```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd .. && pnpm run type-check && pnpm run test
```

Expected: all green.

- [ ] **Step 2: Manual end-to-end smoke**

`pnpm tauri dev`:
1. Fresh state — open `Catalogs` modal. **Five** default catalogs visible (Project Gutenberg, Standard Ebooks, Internet Archive, Feedbooks, Wikisource).
2. Browse presets → search "Gallica" → 1 result → click "+ Add" → "Added" badge appears.
3. Filter Language=FR → shows Gallica, Atramenta, Ebooks libres et gratuits, OpenEdition.
4. Filter Category=tech → shows O'Reilly, GitBook, PragPub.
5. Combined Language=FR + Category=public-domain → shows Gallica, Ebooks libres.
6. Empty state: search "zzz_no_match" → "No presets match your filters" + Clear filters button works.
7. Add a custom URL via "Add custom URL" form → verify it lands without preset id (still works).
8. Remove Gallica from catalog list → reopen picker → Gallica is "+ Add" again.
9. Switch UI language to French → picker labels translate; preset names + descriptions stay in English (per spec).

- [ ] **Step 3: Done**

No commit at this step. Open a PR off this branch.

---

## Notes for the engineer

- **DRY**: Helpers (`filterPresets`, `isPresetAdded`, etc.) are pure and live in `lib/`. Don't duplicate filter logic in the component.
- **YAGNI**: No `homepage` field, no remote refresh, no preset-search API, no localized preset names. All deferred per spec.
- **TDD**: Every task starts with a failing test. If you find yourself writing implementation before the test, stop and write the test first.
- **Frequent commits**: Each task ends with a single commit. Keep the working tree clean between tasks.
- **Tauri arg conventions**: Rust receives `preset_id`, JS sends `presetId`. Tauri's auto-camelCase mapping handles the conversion. Don't manually rename in either direction.
- **Back-compat**: The `#[serde(default, skip_serializing_if = "Option::is_none")]` annotation on `preset_id` is load-bearing. Don't remove it.
- **i18n keys**: `catalog.presets.lang.<code>` and `catalog.presets.category.<key>` must mirror exactly the codes in `LanguageCode` / `Category`. If you add a code, add a key.
