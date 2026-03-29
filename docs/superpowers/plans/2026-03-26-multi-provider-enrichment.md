# Multi-Provider Book Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded OpenLibrary enrichment with a provider-based architecture that tries multiple metadata sources (OpenLibrary, Google Books, and future providers) and stores per-provider settings (API keys, enable/disable).

**Architecture:** Introduce an `EnrichmentProvider` trait in a new `providers/` module. Each provider implements `search_by_isbn` and `search_by_title` returning a common `EnrichmentData` struct. The `enrich_book` orchestrator tries enabled providers in priority order, stopping at the first high-confidence match. Provider configuration (API keys, enabled state) is stored in the existing `settings` table as JSON. The frontend SettingsPanel gets a new "Enrichment Sources" section.

**Tech Stack:** Rust (reqwest, serde_json), React 19, TypeScript, Tauri IPC

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src-tauri/src/providers/mod.rs` | `EnrichmentData` struct, `EnrichmentProvider` trait, `ProviderRegistry` |
| `src-tauri/src/providers/openlibrary.rs` | OpenLibrary provider (extracted from current `openlibrary.rs`) |
| `src-tauri/src/providers/google_books.rs` | Google Books API provider |
| `src-tauri/src/enrichment.rs` | Updated orchestrator — uses `ProviderRegistry` instead of direct `openlibrary` calls |
| `src-tauri/src/commands.rs` | New command: `get_enrichment_providers` / `set_enrichment_provider_config` |
| `src-tauri/src/lib.rs` | Register new commands |
| `src/components/SettingsPanel.tsx` | "Enrichment Sources" UI section |
| `docs/ROADMAP.md` | Updated roadmap item #17 with future provider list |

---

### Task 1: Define the provider trait and common data types

**Files:**
- Create: `src-tauri/src/providers/mod.rs`

- [ ] **Step 1: Write tests for `EnrichmentData` construction**

Add to `src-tauri/src/providers/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrichment_data_default_is_empty() {
        let d = EnrichmentData::default();
        assert!(d.title.is_empty());
        assert!(d.author.is_empty());
        assert!(d.description.is_none());
        assert!(d.genres.is_empty());
        assert!(d.rating.is_none());
        assert!(d.isbn.is_none());
        assert!(d.cover_url.is_none());
        assert!(d.language.is_none());
        assert!(d.publisher.is_none());
        assert!(d.publish_year.is_none());
        assert!(d.source.is_empty());
    }

    #[test]
    fn provider_config_defaults() {
        let cfg = ProviderConfig::default();
        assert!(cfg.enabled);
        assert!(cfg.api_key.is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test providers::tests -- --nocapture`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement the types**

Create `src-tauri/src/providers/mod.rs`:

```rust
pub mod google_books;
pub mod openlibrary;

use serde::{Deserialize, Serialize};

/// Common metadata returned by any enrichment provider.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentData {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub rating: Option<f64>,
    pub isbn: Option<String>,
    pub cover_url: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub publish_year: Option<u16>,
    /// Identifier for the source (e.g., "openlibrary", "google_books")
    pub source: String,
    /// Provider-specific key for this result (e.g., OpenLibrary work key)
    pub source_key: Option<String>,
}

/// Per-provider configuration stored in the settings table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub enabled: bool,
    pub api_key: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: None,
        }
    }
}

/// Metadata about a provider (for UI display and registration).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Unique identifier: "openlibrary", "google_books", etc.
    pub id: String,
    /// Display name: "OpenLibrary", "Google Books", etc.
    pub name: String,
    /// Whether this provider requires an API key.
    pub requires_api_key: bool,
    /// Help text for the API key field (e.g., "Get a key at ...")
    pub api_key_help: String,
    /// Current config
    pub config: ProviderConfig,
}

/// Trait that all enrichment providers implement.
pub trait EnrichmentProvider: Send + Sync {
    /// Provider identifier (e.g., "openlibrary").
    fn id(&self) -> &str;

    /// Human-readable name (e.g., "OpenLibrary").
    fn name(&self) -> &str;

    /// Whether this provider requires an API key to function.
    fn requires_api_key(&self) -> bool;

    /// Help text shown next to the API key input.
    fn api_key_help(&self) -> &str;

    /// Search by ISBN. Returns results sorted by relevance.
    fn search_by_isbn(&self, isbn: &str) -> Result<Vec<EnrichmentData>, String>;

    /// Search by title and optional author. Returns results sorted by relevance.
    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String>;

    /// Update config (called when user changes settings).
    fn configure(&mut self, config: ProviderConfig);

    /// Get current config.
    fn config(&self) -> &ProviderConfig;
}
```

- [ ] **Step 4: Add `mod providers;` to `src-tauri/src/lib.rs`**

In `src-tauri/src/lib.rs`, add near the other module declarations:

```rust
mod providers;
```

- [ ] **Step 5: Create empty submodule files so compilation succeeds**

Create `src-tauri/src/providers/openlibrary.rs`:
```rust
// Will be implemented in Task 2
```

Create `src-tauri/src/providers/google_books.rs`:
```rust
// Will be implemented in Task 3
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test providers::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/providers/
git commit -m "feat(enrichment): define EnrichmentProvider trait and common types"
```

---

### Task 2: Implement OpenLibrary provider (extract from openlibrary.rs)

**Files:**
- Modify: `src-tauri/src/providers/openlibrary.rs`
- Keep: `src-tauri/src/openlibrary.rs` (unchanged — still used by `enrich_book_from_openlibrary` command in edit dialog)

The existing `openlibrary.rs` serves double duty: it's used by the edit dialog's manual OpenLibrary search AND by the enrichment scan. We keep the original module for the edit dialog (which is OpenLibrary-specific) and create a new provider that wraps the same API for the generic enrichment flow.

- [ ] **Step 1: Write tests**

Add to `src-tauri/src/providers/openlibrary.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_is_openlibrary() {
        let p = OpenLibraryProvider::new();
        assert_eq!(p.id(), "openlibrary");
    }

    #[test]
    fn provider_does_not_require_api_key() {
        let p = OpenLibraryProvider::new();
        assert!(!p.requires_api_key());
    }

    #[test]
    fn provider_default_config_is_enabled() {
        let p = OpenLibraryProvider::new();
        assert!(p.config().enabled);
    }

    #[test]
    fn parse_search_doc_extracts_fields() {
        let doc = serde_json::json!({
            "key": "/works/OL123W",
            "title": "Dune",
            "author_name": ["Frank Herbert"],
            "subject": ["Science Fiction", "Adventure"],
            "ratings_average": 4.2,
            "isbn": ["9780441013593"],
            "cover_i": 12345,
            "first_sentence": ["In the week before..."],
            "language": ["eng"]
        });
        let result = parse_search_doc(&doc);
        assert_eq!(result.title, "Dune");
        assert_eq!(result.author, "Frank Herbert");
        assert_eq!(result.source, "openlibrary");
        assert_eq!(result.source_key, Some("/works/OL123W".to_string()));
        assert_eq!(result.rating, Some(4.2));
        assert!(result.genres.contains(&"Science Fiction".to_string()));
        assert_eq!(result.language, Some("eng".to_string()));
    }

    #[test]
    fn parse_search_doc_handles_missing_fields() {
        let doc = serde_json::json!({
            "title": "Minimal Book"
        });
        let result = parse_search_doc(&doc);
        assert_eq!(result.title, "Minimal Book");
        assert_eq!(result.author, "");
        assert!(result.genres.is_empty());
        assert!(result.rating.is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test providers::openlibrary::tests -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement the provider**

Write `src-tauri/src/providers/openlibrary.rs`:

```rust
use super::{EnrichmentData, EnrichmentProvider, ProviderConfig};

pub struct OpenLibraryProvider {
    config: ProviderConfig,
}

impl OpenLibraryProvider {
    pub fn new() -> Self {
        Self {
            config: ProviderConfig::default(),
        }
    }
}

/// Parse a single search result document into EnrichmentData.
fn parse_search_doc(doc: &serde_json::Value) -> EnrichmentData {
    let title = doc["title"].as_str().unwrap_or("").to_string();
    let author = doc["author_name"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = doc["first_sentence"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let genres: Vec<String> = doc["subject"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .take(10)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let rating = doc["ratings_average"].as_f64();
    let isbn = doc["isbn"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cover_url = doc["cover_i"]
        .as_i64()
        .map(|id| format!("https://covers.openlibrary.org/b/id/{}-L.jpg", id));
    let language = doc["language"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let source_key = doc["key"].as_str().map(|s| s.to_string());

    EnrichmentData {
        title,
        author,
        description,
        genres,
        rating,
        isbn,
        cover_url,
        language,
        publisher: None,
        publish_year: None,
        source: "openlibrary".to_string(),
        source_key,
    }
}

fn urlencoding(s: &str) -> String {
    s.replace(' ', "+")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
}

impl EnrichmentProvider for OpenLibraryProvider {
    fn id(&self) -> &str {
        "openlibrary"
    }

    fn name(&self) -> &str {
        "OpenLibrary"
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn api_key_help(&self) -> &str {
        ""
    }

    fn search_by_isbn(&self, isbn: &str) -> Result<Vec<EnrichmentData>, String> {
        let url = format!(
            "https://openlibrary.org/search.json?isbn={}&limit=3&fields=key,title,author_name,first_sentence,subject,isbn,ratings_average,cover_i,language",
            isbn
        );
        let resp = reqwest::blocking::get(&url).map_err(|e| format!("OpenLibrary request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("OpenLibrary HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        let docs = json["docs"].as_array().ok_or("Unexpected response format")?;
        Ok(docs.iter().map(parse_search_doc).filter(|d| !d.title.is_empty()).collect())
    }

    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String> {
        let mut query = format!("title={}", urlencoding(title));
        if let Some(a) = author {
            if !a.is_empty() {
                query.push_str(&format!("&author={}", urlencoding(a)));
            }
        }
        let url = format!(
            "https://openlibrary.org/search.json?{}&limit=5&fields=key,title,author_name,first_sentence,subject,isbn,ratings_average,cover_i,language",
            query
        );
        let resp = reqwest::blocking::get(&url).map_err(|e| format!("OpenLibrary request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("OpenLibrary HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        let docs = json["docs"].as_array().ok_or("Unexpected response format")?;
        Ok(docs.iter().map(parse_search_doc).filter(|d| !d.title.is_empty()).collect())
    }

    fn configure(&mut self, config: ProviderConfig) {
        self.config = config;
    }

    fn config(&self) -> &ProviderConfig {
        &self.config
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test providers::openlibrary::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/providers/openlibrary.rs
git commit -m "feat(enrichment): implement OpenLibrary provider"
```

---

### Task 3: Implement Google Books provider

**Files:**
- Modify: `src-tauri/src/providers/google_books.rs`

Google Books API: `https://www.googleapis.com/books/v1/volumes?q=...`
- No API key required for basic searches (rate-limited to ~1000/day)
- With API key: higher rate limits
- Returns: `volumeInfo.title`, `volumeInfo.authors`, `volumeInfo.description`, `volumeInfo.categories`, `volumeInfo.language`, `volumeInfo.publisher`, `volumeInfo.publishedDate`, `volumeInfo.imageLinks.thumbnail`, `volumeInfo.industryIdentifiers`

- [ ] **Step 1: Write tests**

Add to `src-tauri/src/providers/google_books.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_is_google_books() {
        let p = GoogleBooksProvider::new();
        assert_eq!(p.id(), "google_books");
    }

    #[test]
    fn provider_does_not_require_api_key() {
        let p = GoogleBooksProvider::new();
        assert!(!p.requires_api_key());
    }

    #[test]
    fn parse_volume_extracts_fields() {
        let vol = serde_json::json!({
            "volumeInfo": {
                "title": "Aria Tome 30 Renaissance",
                "authors": ["Michel Weyland"],
                "description": "The 30th adventure...",
                "categories": ["Comics & Graphic Novels"],
                "language": "fr",
                "publisher": "Dupuis",
                "publishedDate": "2008-06-01",
                "imageLinks": {
                    "thumbnail": "http://books.google.com/books/content?id=abc123&printsec=frontcover&img=1&zoom=1"
                },
                "industryIdentifiers": [
                    { "type": "ISBN_13", "identifier": "9782800142876" }
                ]
            }
        });
        let result = parse_volume(&vol);
        assert_eq!(result.title, "Aria Tome 30 Renaissance");
        assert_eq!(result.author, "Michel Weyland");
        assert_eq!(result.description, Some("The 30th adventure...".to_string()));
        assert_eq!(result.language, Some("fr".to_string()));
        assert_eq!(result.publisher, Some("Dupuis".to_string()));
        assert_eq!(result.publish_year, Some(2008));
        assert_eq!(result.isbn, Some("9782800142876".to_string()));
        assert_eq!(result.source, "google_books");
        assert!(result.genres.contains(&"Comics & Graphic Novels".to_string()));
    }

    #[test]
    fn parse_volume_handles_missing_fields() {
        let vol = serde_json::json!({
            "volumeInfo": {
                "title": "Minimal"
            }
        });
        let result = parse_volume(&vol);
        assert_eq!(result.title, "Minimal");
        assert_eq!(result.author, "");
        assert!(result.publisher.is_none());
    }

    #[test]
    fn parse_year_from_date_string() {
        assert_eq!(extract_year("2008-06-01"), Some(2008));
        assert_eq!(extract_year("2008"), Some(2008));
        assert_eq!(extract_year(""), None);
        assert_eq!(extract_year("unknown"), None);
    }

    #[test]
    fn build_search_url_without_api_key() {
        let url = build_search_url("intitle:Dune+inauthor:Herbert", None);
        assert!(url.starts_with("https://www.googleapis.com/books/v1/volumes?q="));
        assert!(!url.contains("key="));
    }

    #[test]
    fn build_search_url_with_api_key() {
        let url = build_search_url("intitle:Dune", Some("mykey123"));
        assert!(url.contains("&key=mykey123"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test providers::google_books::tests -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement the provider**

Write `src-tauri/src/providers/google_books.rs`:

```rust
use super::{EnrichmentData, EnrichmentProvider, ProviderConfig};

pub struct GoogleBooksProvider {
    config: ProviderConfig,
}

impl GoogleBooksProvider {
    pub fn new() -> Self {
        Self {
            config: ProviderConfig::default(),
        }
    }
}

fn build_search_url(query: &str, api_key: Option<&str>) -> String {
    let mut url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&maxResults=5",
        query
    );
    if let Some(key) = api_key {
        url.push_str(&format!("&key={}", key));
    }
    url
}

fn extract_year(date_str: &str) -> Option<u16> {
    // Google Books dates are "YYYY", "YYYY-MM", or "YYYY-MM-DD"
    date_str.split('-').next()?.parse::<u16>().ok()
}

fn urlencoding(s: &str) -> String {
    s.replace(' ', "+")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
        .replace('"', "%22")
}

/// Parse a single volume item from the Google Books API response.
fn parse_volume(item: &serde_json::Value) -> EnrichmentData {
    let info = &item["volumeInfo"];
    let title = info["title"].as_str().unwrap_or("").to_string();
    let author = info["authors"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = info["description"]
        .as_str()
        .map(|s| s.to_string());
    let genres: Vec<String> = info["categories"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let language = info["language"]
        .as_str()
        .map(|s| s.to_string());
    let publisher = info["publisher"]
        .as_str()
        .map(|s| s.to_string());
    let publish_year = info["publishedDate"]
        .as_str()
        .and_then(extract_year);
    let cover_url = info["imageLinks"]["thumbnail"]
        .as_str()
        .map(|s| s.replace("http://", "https://"));
    // Prefer ISBN_13 over ISBN_10
    let isbn = info["industryIdentifiers"]
        .as_array()
        .and_then(|ids| {
            ids.iter()
                .find(|id| id["type"].as_str() == Some("ISBN_13"))
                .or_else(|| ids.iter().find(|id| id["type"].as_str() == Some("ISBN_10")))
                .and_then(|id| id["identifier"].as_str())
                .map(|s| s.to_string())
        });
    let source_key = item["id"].as_str().map(|s| s.to_string());

    EnrichmentData {
        title,
        author,
        description,
        genres,
        rating: None, // Google Books doesn't reliably expose ratings
        isbn,
        cover_url,
        language,
        publisher,
        publish_year,
        source: "google_books".to_string(),
        source_key,
    }
}

impl EnrichmentProvider for GoogleBooksProvider {
    fn id(&self) -> &str {
        "google_books"
    }

    fn name(&self) -> &str {
        "Google Books"
    }

    fn requires_api_key(&self) -> bool {
        false // Works without key, key gives higher rate limits
    }

    fn api_key_help(&self) -> &str {
        "Optional. Get a free key at https://console.cloud.google.com/apis/credentials for higher rate limits."
    }

    fn search_by_isbn(&self, isbn: &str) -> Result<Vec<EnrichmentData>, String> {
        let query = format!("isbn:{}", isbn);
        let api_key = self.config.api_key.as_deref();
        let url = build_search_url(&query, api_key);
        let resp = reqwest::blocking::get(&url)
            .map_err(|e| format!("Google Books request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Google Books HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        let items = json["items"].as_array();
        match items {
            Some(items) => Ok(items.iter().map(parse_volume).filter(|d| !d.title.is_empty()).collect()),
            None => Ok(Vec::new()), // "totalItems": 0, no "items" key
        }
    }

    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String> {
        let mut query = format!("intitle:{}", urlencoding(title));
        if let Some(a) = author {
            if !a.is_empty() {
                query.push_str(&format!("+inauthor:{}", urlencoding(a)));
            }
        }
        let api_key = self.config.api_key.as_deref();
        let url = build_search_url(&query, api_key);
        let resp = reqwest::blocking::get(&url)
            .map_err(|e| format!("Google Books request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Google Books HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        let items = json["items"].as_array();
        match items {
            Some(items) => Ok(items.iter().map(parse_volume).filter(|d| !d.title.is_empty()).collect()),
            None => Ok(Vec::new()),
        }
    }

    fn configure(&mut self, config: ProviderConfig) {
        self.config = config;
    }

    fn config(&self) -> &ProviderConfig {
        &self.config
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test providers::google_books::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/providers/google_books.rs
git commit -m "feat(enrichment): implement Google Books provider"
```

---

### Task 4: Add ProviderRegistry and wire into enrichment.rs

**Files:**
- Modify: `src-tauri/src/providers/mod.rs` — add `ProviderRegistry`
- Modify: `src-tauri/src/enrichment.rs` — replace direct `openlibrary` calls with provider-based flow

- [ ] **Step 1: Write tests for ProviderRegistry**

Add to `src-tauri/src/providers/mod.rs` tests:

```rust
#[test]
fn registry_lists_providers_in_order() {
    let reg = ProviderRegistry::new();
    let infos = reg.list_providers();
    assert!(infos.len() >= 2);
    assert_eq!(infos[0].id, "google_books"); // Google Books first (better intl coverage)
    assert_eq!(infos[1].id, "openlibrary");
}

#[test]
fn registry_get_enabled_providers() {
    let mut reg = ProviderRegistry::new();
    let enabled = reg.enabled_providers();
    assert!(enabled.len() >= 2);
    // Disable one
    reg.configure_provider("openlibrary", ProviderConfig { enabled: false, api_key: None });
    let enabled = reg.enabled_providers();
    assert_eq!(enabled.len(), 1);
    assert_eq!(enabled[0], "google_books");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test providers::tests::registry -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement ProviderRegistry**

Add to `src-tauri/src/providers/mod.rs`:

```rust
pub struct ProviderRegistry {
    providers: Vec<Box<dyn EnrichmentProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(google_books::GoogleBooksProvider::new()),
                Box::new(openlibrary::OpenLibraryProvider::new()),
            ],
        }
    }

    /// List all providers with their metadata and current config.
    pub fn list_providers(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().to_string(),
                name: p.name().to_string(),
                requires_api_key: p.requires_api_key(),
                api_key_help: p.api_key_help().to_string(),
                config: p.config().clone(),
            })
            .collect()
    }

    /// Get IDs of enabled providers in priority order.
    pub fn enabled_providers(&self) -> Vec<String> {
        self.providers
            .iter()
            .filter(|p| p.config().enabled)
            .map(|p| p.id().to_string())
            .collect()
    }

    /// Update a provider's config.
    pub fn configure_provider(&mut self, id: &str, config: ProviderConfig) {
        if let Some(p) = self.providers.iter_mut().find(|p| p.id() == id) {
            p.configure(config);
        }
    }

    /// Search by ISBN across all enabled providers. Returns first non-empty result.
    pub fn search_by_isbn(&self, isbn: &str) -> Vec<EnrichmentData> {
        for provider in &self.providers {
            if !provider.config().enabled {
                continue;
            }
            match provider.search_by_isbn(isbn) {
                Ok(results) if !results.is_empty() => return results,
                _ => continue,
            }
        }
        Vec::new()
    }

    /// Search by title across all enabled providers. Returns first non-empty result.
    pub fn search_by_title(&self, title: &str, author: Option<&str>) -> Vec<EnrichmentData> {
        for provider in &self.providers {
            if !provider.config().enabled {
                continue;
            }
            match provider.search_by_title(title, author) {
                Ok(results) if !results.is_empty() => return results,
                _ => continue,
            }
        }
        Vec::new()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test providers::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Update enrichment.rs to use ProviderRegistry**

Modify `src-tauri/src/enrichment.rs`:

Replace the `enrich_book` function body. The current function directly calls `openlibrary::lookup_isbn` and `openlibrary::search`. Change it to use `ProviderRegistry`:

```rust
use crate::providers::{EnrichmentData, ProviderConfig, ProviderRegistry};

#[derive(Debug, Clone)]
pub struct EnrichmentResult {
    pub data: EnrichmentData,
    pub confidence: f64,
    pub auto_apply: bool,
}

pub fn enrich_book(
    title: &str,
    author: &str,
    isbn: Option<&str>,
    registry: &ProviderRegistry,
) -> Option<EnrichmentResult> {
    // Tier 1: ISBN lookup
    if let Some(isbn) = isbn {
        let results = registry.search_by_isbn(isbn);
        if let Some(first) = results.into_iter().next() {
            if !first.title.is_empty() {
                return Some(EnrichmentResult {
                    data: first,
                    confidence: 0.95,
                    auto_apply: true,
                });
            }
        }
    }
    // Tier 2: Title + Author search
    let author_opt = if author.is_empty() || author == "Unknown Author" {
        None
    } else {
        Some(author)
    };
    let results = registry.search_by_title(title, author_opt);
    let first = results.into_iter().next()?;
    let sim = title_similarity(title, &first.title);
    if sim >= 0.85 {
        Some(EnrichmentResult {
            data: first,
            confidence: sim,
            auto_apply: true,
        })
    } else if sim >= 0.5 {
        Some(EnrichmentResult {
            data: first,
            confidence: sim,
            auto_apply: false,
        })
    } else {
        None
    }
}
```

Also keep the old `use crate::openlibrary` import — it's still used by `enrich_book_from_openlibrary` in commands.rs.

- [ ] **Step 6: Run full test suite**

Run: `cd src-tauri && cargo test`
Expected: Compilation errors in commands.rs where `enrich_book` is called — it now requires a `&ProviderRegistry` argument. This is expected, will be fixed in Task 5.

- [ ] **Step 7: Commit (WIP — will compile after Task 5)**

```bash
git add src-tauri/src/providers/mod.rs src-tauri/src/enrichment.rs
git commit -m "feat(enrichment): add ProviderRegistry and update enrichment orchestrator"
```

---

### Task 5: Wire registry into AppState and update commands

**Files:**
- Modify: `src-tauri/src/commands.rs` — add registry to AppState, update `scan_single_book`, add provider config commands
- Modify: `src-tauri/src/lib.rs` — initialize registry, register new commands

- [ ] **Step 1: Add ProviderRegistry to AppState**

In `src-tauri/src/commands.rs`, update `AppState`:

```rust
use crate::providers::{ProviderConfig, ProviderInfo, ProviderRegistry};

pub struct AppState {
    pub db: DbPool,
    pub profiles: std::sync::Mutex<std::collections::HashMap<String, DbPool>>,
    pub active_profile: std::sync::Mutex<String>,
    pub data_dir: std::path::PathBuf,
    pub epub_cache: std::sync::Mutex<std::collections::HashMap<String, crate::epub::CachedEpubArchive>>,
    pub enrichment_registry: std::sync::Mutex<ProviderRegistry>,
}
```

- [ ] **Step 2: Initialize registry in lib.rs with saved config**

In `src-tauri/src/lib.rs`, where `AppState` is constructed, initialize the registry and load any saved provider configs from the settings table:

```rust
let enrichment_registry = {
    let mut reg = providers::ProviderRegistry::new();
    // Load saved configs from DB
    if let Ok(conn) = db_pool.get() {
        if let Ok(Some(json)) = db::get_setting(&conn, "enrichment_providers") {
            if let Ok(configs) = serde_json::from_str::<std::collections::HashMap<String, providers::ProviderConfig>>(&json) {
                for (id, config) in configs {
                    reg.configure_provider(&id, config);
                }
            }
        }
    }
    std::sync::Mutex::new(reg)
};
```

Add `enrichment_registry` to the `AppState` construction.

- [ ] **Step 3: Update scan_single_book to use registry**

In `src-tauri/src/commands.rs`, update the `scan_single_book` function. Change the `std::thread::spawn` block to pass the registry:

```rust
// Build a snapshot of enabled providers for the background thread
let registry = {
    let reg = state.enrichment_registry.lock().map_err(|e| e.to_string())?;
    // We need to clone or recreate — since providers aren't Clone, recreate with same config
    let mut new_reg = crate::providers::ProviderRegistry::new();
    for info in reg.list_providers() {
        new_reg.configure_provider(&info.id, info.config.clone());
    }
    new_reg
};

let (tx, rx) = std::sync::mpsc::channel();
let t = lookup_title.to_string();
let a = lookup_author.to_string();
let i = lookup_isbn.map(|s| s.to_string());
std::thread::spawn(move || {
    let _ = tx.send(crate::enrichment::enrich_book(&t, &a, i.as_deref(), &registry));
});
```

Also update `db::update_book_enrichment` to store the new fields from `EnrichmentData`. The current function only stores description, genres, rating, isbn, openlibrary_key. We need to also store language, publisher, publish_year, and use `source_key` instead of hardcoded `openlibrary_key`:

```rust
// After getting enrichment result:
// Store provider-specific key
let source_key = if result.data.source == "openlibrary" {
    result.data.source_key.as_deref()
} else {
    None
};
db::update_book_enrichment(
    &conn, &book_id,
    result.data.description.as_deref(),
    genres_json.as_deref(),
    result.data.rating,
    result.data.isbn.as_deref().or(lookup_isbn),
    source_key,
).map_err(|e| e.to_string())?;

// Also update the new fields if present
let mut book = db::get_book(&conn, &book_id).map_err(|e| e.to_string())?
    .ok_or_else(|| "Book not found".to_string())?;
if let Some(lang) = &result.data.language {
    if book.language.is_none() { book.language = Some(lang.clone()); }
}
if let Some(pub_name) = &result.data.publisher {
    if book.publisher.is_none() { book.publisher = Some(pub_name.clone()); }
}
if let Some(year) = result.data.publish_year {
    if book.publish_year.is_none() { book.publish_year = Some(year); }
}
db::update_book(&conn, &book).map_err(|e| e.to_string())?;
```

- [ ] **Step 4: Add provider config commands**

Add two new Tauri commands in `commands.rs`:

```rust
#[tauri::command]
pub async fn get_enrichment_providers(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderInfo>, String> {
    let reg = state.enrichment_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.list_providers())
}

#[tauri::command]
pub async fn set_enrichment_provider_config(
    provider_id: String,
    enabled: bool,
    api_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = ProviderConfig {
        enabled,
        api_key: api_key.filter(|k| !k.is_empty()),
    };
    {
        let mut reg = state.enrichment_registry.lock().map_err(|e| e.to_string())?;
        reg.configure_provider(&provider_id, config);

        // Persist all configs to settings table
        let all_configs: std::collections::HashMap<String, ProviderConfig> = reg
            .list_providers()
            .into_iter()
            .map(|p| (p.id, p.config))
            .collect();
        let json = serde_json::to_string(&all_configs).map_err(|e| e.to_string())?;
        let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "enrichment_providers", &json).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

- [ ] **Step 5: Register new commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the `invoke_handler`:
```rust
commands::get_enrichment_providers,
commands::set_enrichment_provider_config,
```

- [ ] **Step 6: Run full test suite**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(enrichment): wire provider registry into AppState and commands"
```

---

### Task 6: Add "Enrichment Sources" UI in SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Read the current SettingsPanel metadata section**

Read `src/components/SettingsPanel.tsx` around lines 530-570 to find the existing "Metadata" section with auto-scan toggles.

- [ ] **Step 2: Add provider list UI below the auto-scan toggles**

After the existing auto-scan checkboxes, add an "Enrichment Sources" section:

```tsx
{/* Enrichment Sources */}
<div className="mt-3">
  <h4 className="text-xs font-medium text-ink-muted mb-2">Enrichment Sources</h4>
  {enrichmentProviders.map((provider) => (
    <div key={provider.id} className="flex items-start gap-2 py-2 border-b border-warm-border last:border-0">
      <input
        type="checkbox"
        checked={provider.config.enabled}
        onChange={async (e) => {
          const enabled = e.target.checked;
          await invoke("set_enrichment_provider_config", {
            providerId: provider.id,
            enabled,
            apiKey: provider.config.apiKey,
          }).catch(() => {});
          loadProviders();
        }}
        className="mt-0.5 accent-accent"
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-ink">{provider.name}</span>
        {provider.apiKeyHelp && (
          <div className="mt-1">
            <input
              type="text"
              value={provider.config.apiKey ?? ""}
              onChange={(e) => {
                // Update local state immediately
                setEnrichmentProviders((prev) =>
                  prev.map((p) =>
                    p.id === provider.id
                      ? { ...p, config: { ...p.config, apiKey: e.target.value } }
                      : p
                  )
                );
              }}
              onBlur={async (e) => {
                await invoke("set_enrichment_provider_config", {
                  providerId: provider.id,
                  enabled: provider.config.enabled,
                  apiKey: e.target.value || null,
                }).catch(() => {});
              }}
              placeholder="API key (optional)"
              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
            />
            <p className="text-[10px] text-ink-muted mt-0.5">{provider.apiKeyHelp}</p>
          </div>
        )}
      </div>
    </div>
  ))}
</div>
```

- [ ] **Step 3: Add state and loading**

Add state for the provider list:
```typescript
const [enrichmentProviders, setEnrichmentProviders] = useState<ProviderInfo[]>([]);
```

Add a `ProviderInfo` interface:
```typescript
interface ProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  apiKeyHelp: string;
  config: {
    enabled: boolean;
    apiKey: string | null;
  };
}
```

Load on mount alongside settings:
```typescript
const loadProviders = useCallback(async () => {
  try {
    const providers = await invoke<ProviderInfo[]>("get_enrichment_providers");
    setEnrichmentProviders(providers);
  } catch {}
}, []);

useEffect(() => { loadProviders(); }, [loadProviders]);
```

- [ ] **Step 4: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(ui): add Enrichment Sources section to settings with provider toggles and API key config"
```

---

### Task 7: Update roadmap

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Update item #17 with multi-provider info and future sources**

In `docs/ROADMAP.md`, update section 17 to reflect the new architecture and list potential future providers:

```markdown
### 17. Goodreads / OpenLibrary Integration — **Done** *(Multi-Provider)*
- ~~Pull richer metadata: descriptions, genres, ratings, cover art~~
- ~~Auto-match books by title+author via OpenLibrary search~~
- ~~One-click enrich from search results in edit dialog~~
- ~~New DB columns: description, genres, rating, isbn, openlibrary_key~~
- Goodreads sync not implemented (API deprecated/closed)
- ~~Auto-enrich on import via scan queue (ISBN lookup, title+author search, filename parsing)~~
- ~~Background scan queue with progress indicator and cancel~~
- ~~ComicInfo.xml parsing for CBZ metadata~~
- ~~Settings: auto-scan on import, auto-scan on startup~~
- ~~Per-book scan and "queue for next scan" actions~~
- ~~Multi-provider enrichment architecture (EnrichmentProvider trait)~~
- ~~Google Books API provider (free, good international/French coverage)~~
- ~~Provider settings: enable/disable, API keys, persisted in settings table~~

#### Future Enrichment Providers
| Provider | Coverage | API Key | Notes |
|----------|----------|---------|-------|
| Comic Vine | Comics (American, some European) | Free key required | comicvine.gamespot.com |
| Bédéthèque | Franco-Belgian BD (best for French comics) | N/A (scraping) | bedetheque.com — no public API, fragile |
| ISBNdb | Very comprehensive, all formats | Paid | isbndb.com |
| MangaUpdates | Manga | Free | mangaupdates.com |
| AniList | Manga/anime | Free (GraphQL) | anilist.co |
| WorldCat | Library catalog, international | Free | worldcat.org/webservices |
| Hardcover | Modern book social network | Free (GraphQL) | hardcover.app |
```

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: update roadmap with multi-provider enrichment and future provider list"
```

---

### Task 8: Run full CI checks

- [ ] **Step 1: Run Rust checks**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```
Expected: All pass.

- [ ] **Step 2: Run frontend checks**

```bash
npm run type-check && npm run test
```
Expected: All pass.

- [ ] **Step 3: Fix any failures**

If any check fails, fix and re-run.
