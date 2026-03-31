# Comic Vine Enrichment Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Comic Vine as a third enrichment provider for comics/BD metadata lookup, searching volumes then issues.

**Architecture:** New provider module `comic_vine.rs` implementing `EnrichmentProvider` trait, registered after OpenLibrary in the provider registry. Uses `reqwest::blocking` for HTTP, same as existing providers. Two-tier search: volumes first, then issues if no volume match.

**Tech Stack:** Rust, reqwest (blocking + json), serde_json, Comic Vine REST API

---

### Task 1: Create Comic Vine provider with parse functions and tests

**Files:**
- Create: `src-tauri/src/providers/comic_vine.rs`

- [ ] **Step 1: Create the provider file with struct, trait impl, and helper functions**

Create `src-tauri/src/providers/comic_vine.rs`:

```rust
use super::{EnrichmentData, EnrichmentProvider, ProviderConfig};

const BASE_URL: &str = "https://comicvine.gamespot.com/api";
const USER_AGENT: &str = "Folio/1.0 (Desktop eBook Reader)";

#[derive(Default)]
pub struct ComicVineProvider {
    config: ProviderConfig,
}

impl ComicVineProvider {
    pub fn new() -> Self {
        Self {
            config: ProviderConfig {
                enabled: false,
                api_key: None,
            },
        }
    }
}

impl EnrichmentProvider for ComicVineProvider {
    fn id(&self) -> &str {
        "comic_vine"
    }

    fn name(&self) -> &str {
        "Comic Vine"
    }

    fn requires_api_key(&self) -> bool {
        true
    }

    fn api_key_help(&self) -> &str {
        "Free key from comicvine.gamespot.com/api"
    }

    fn search_by_isbn(&self, _isbn: &str) -> Result<Vec<EnrichmentData>, String> {
        // Comic Vine has no ISBN field
        Ok(Vec::new())
    }

    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String> {
        let api_key = self
            .config
            .api_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| "Comic Vine requires an API key".to_string())?;

        let query = match author {
            Some(a) if !a.is_empty() => format!("{} {}", title, a),
            _ => title.to_string(),
        };
        let encoded = urlencoding(&query);

        // Tier 1: search volumes
        let url = format!(
            "{}/search/?api_key={}&format=json&resources=volume&query={}&limit=5",
            BASE_URL, api_key, encoded
        );
        let results = fetch_and_parse(&url, parse_volume)?;
        if !results.is_empty() {
            return Ok(results);
        }

        // Tier 2: search issues
        let url = format!(
            "{}/search/?api_key={}&format=json&resources=issue&query={}&limit=5",
            BASE_URL, api_key, encoded
        );
        fetch_and_parse(&url, parse_issue)
    }

    fn configure(&mut self, config: ProviderConfig) {
        self.config = config;
    }

    fn config(&self) -> &ProviderConfig {
        &self.config
    }
}

fn fetch_and_parse(
    url: &str,
    parser: fn(&serde_json::Value) -> Option<EnrichmentData>,
) -> Result<Vec<EnrichmentData>, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|e| format!("Comic Vine request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Comic Vine HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;

    let results = match json["results"].as_array() {
        Some(arr) => arr,
        None => return Ok(Vec::new()),
    };

    Ok(results.iter().filter_map(parser).collect())
}

fn parse_volume(item: &serde_json::Value) -> Option<EnrichmentData> {
    let name = item["name"].as_str().unwrap_or("").to_string();
    if name.is_empty() {
        return None;
    }

    let description = item["deck"].as_str().map(|s| s.to_string());
    let cover_url = item["image"]["medium_url"].as_str().map(|s| s.to_string());
    let publisher = item["publisher"]["name"].as_str().map(|s| s.to_string());
    let publish_year = item["start_year"]
        .as_str()
        .and_then(|s| s.parse::<u16>().ok());
    let source_key = item["id"].as_u64().map(|id| id.to_string());

    Some(EnrichmentData {
        title: name.clone(),
        author: String::new(),
        description,
        genres: Vec::new(),
        rating: None,
        isbn: None,
        cover_url,
        language: None,
        publisher,
        publish_year,
        source: "comic_vine".to_string(),
        source_key,
    })
}

fn parse_issue(item: &serde_json::Value) -> Option<EnrichmentData> {
    let volume_name = item["volume"]["name"].as_str().unwrap_or("");
    let issue_number = item["issue_number"].as_str().unwrap_or("");

    // Use explicit name if present, otherwise build from volume + issue number
    let title = match item["name"].as_str() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ if !volume_name.is_empty() && !issue_number.is_empty() => {
            format!("{} #{}", volume_name, issue_number)
        }
        _ if !volume_name.is_empty() => volume_name.to_string(),
        _ => return None,
    };

    let description = item["deck"].as_str().map(|s| s.to_string());
    let cover_url = item["image"]["medium_url"].as_str().map(|s| s.to_string());
    let publish_year = item["cover_date"]
        .as_str()
        .and_then(|s| s.split('-').next())
        .and_then(|y| y.parse::<u16>().ok());
    let volume_num = issue_number.parse::<u32>().ok();
    let source_key = item["id"].as_u64().map(|id| id.to_string());

    Some(EnrichmentData {
        title,
        author: String::new(),
        description,
        genres: Vec::new(),
        rating: None,
        isbn: None,
        cover_url,
        language: None,
        publisher: None,
        publish_year,
        source: "comic_vine".to_string(),
        source_key,
    })
}

fn urlencoding(s: &str) -> String {
    s.replace(' ', "+")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_volume_complete() {
        let item = serde_json::json!({
            "id": 12345,
            "name": "Astérix",
            "deck": "A series of French comic books.",
            "image": {
                "medium_url": "https://comicvine.gamespot.com/a/uploads/scale_medium/asterix.jpg"
            },
            "publisher": {
                "name": "Dargaud"
            },
            "start_year": "1959"
        });

        let result = parse_volume(&item).expect("should parse");
        assert_eq!(result.title, "Astérix");
        assert_eq!(result.description.as_deref(), Some("A series of French comic books."));
        assert_eq!(result.publisher.as_deref(), Some("Dargaud"));
        assert_eq!(result.publish_year, Some(1959));
        assert!(result.cover_url.is_some());
        assert_eq!(result.source, "comic_vine");
        assert_eq!(result.source_key.as_deref(), Some("12345"));
    }

    #[test]
    fn parse_volume_minimal() {
        let item = serde_json::json!({
            "name": "Tintin"
        });

        let result = parse_volume(&item).expect("should parse minimal");
        assert_eq!(result.title, "Tintin");
        assert!(result.description.is_none());
        assert!(result.publisher.is_none());
        assert!(result.publish_year.is_none());
        assert!(result.cover_url.is_none());
        assert_eq!(result.source, "comic_vine");
    }

    #[test]
    fn parse_volume_empty_name_returns_none() {
        let item = serde_json::json!({
            "name": "",
            "deck": "Some description"
        });
        assert!(parse_volume(&item).is_none());
    }

    #[test]
    fn parse_issue_with_name() {
        let item = serde_json::json!({
            "id": 67890,
            "name": "The Blue Lotus",
            "volume": { "name": "Tintin" },
            "issue_number": "5",
            "deck": "Tintin travels to China.",
            "image": {
                "medium_url": "https://comicvine.gamespot.com/a/uploads/scale_medium/blue_lotus.jpg"
            },
            "cover_date": "1936-01-01"
        });

        let result = parse_issue(&item).expect("should parse");
        assert_eq!(result.title, "The Blue Lotus");
        assert_eq!(result.description.as_deref(), Some("Tintin travels to China."));
        assert_eq!(result.publish_year, Some(1936));
        assert!(result.cover_url.is_some());
        assert_eq!(result.source, "comic_vine");
        assert_eq!(result.source_key.as_deref(), Some("67890"));
    }

    #[test]
    fn parse_issue_builds_title_from_volume_and_number() {
        let item = serde_json::json!({
            "id": 11111,
            "name": null,
            "volume": { "name": "Astérix" },
            "issue_number": "42",
            "cover_date": "2023-10-26"
        });

        let result = parse_issue(&item).expect("should parse");
        assert_eq!(result.title, "Astérix #42");
        assert_eq!(result.publish_year, Some(2023));
    }

    #[test]
    fn parse_issue_no_volume_no_name_returns_none() {
        let item = serde_json::json!({
            "name": null,
            "volume": { "name": "" },
            "issue_number": ""
        });
        assert!(parse_issue(&item).is_none());
    }

    #[test]
    fn provider_metadata() {
        let provider = ComicVineProvider::new();
        assert_eq!(provider.id(), "comic_vine");
        assert_eq!(provider.name(), "Comic Vine");
        assert!(provider.requires_api_key());
        assert!(!provider.config().enabled); // disabled by default (needs API key)
    }

    #[test]
    fn search_by_isbn_returns_empty() {
        let provider = ComicVineProvider::new();
        let result = provider.search_by_isbn("9781234567890").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn search_by_title_without_key_returns_error() {
        let provider = ComicVineProvider::new();
        let result = provider.search_by_title("Astérix", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key"));
    }

    #[test]
    fn urlencoding_spaces_and_special() {
        assert_eq!(urlencoding("hello world"), "hello+world");
        assert_eq!(urlencoding("a&b=c#d"), "a%26b%3Dc%23d");
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Will fail because `comic_vine` module is not yet declared in `mod.rs`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/providers/comic_vine.rs
git commit -m "feat(providers): add Comic Vine provider module with parse functions and tests"
```

---

### Task 2: Register Comic Vine provider in the registry

**Files:**
- Modify: `src-tauri/src/providers/mod.rs`

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/providers/mod.rs`, add after line 2 (`pub mod openlibrary;`):

```rust
pub mod comic_vine;
```

- [ ] **Step 2: Add Comic Vine to the registry**

In the `ProviderRegistry::new()` function (line 82-88), add Comic Vine after OpenLibrary:

```rust
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(google_books::GoogleBooksProvider::new()),
                Box::new(openlibrary::OpenLibraryProvider::new()),
                Box::new(comic_vine::ComicVineProvider::new()),
            ],
        }
    }
```

- [ ] **Step 3: Update tests that check provider count**

In the test `registry_lists_providers_in_order` (around line 205-213), update to expect 3 providers:

```rust
    #[test]
    fn registry_lists_providers_in_order() {
        let reg = ProviderRegistry::new();
        let providers = reg.list_providers();
        assert_eq!(providers.len(), 3);
        assert_eq!(providers[0].id, "google_books");
        assert_eq!(providers[0].name, "Google Books");
        assert_eq!(providers[1].id, "openlibrary");
        assert_eq!(providers[1].name, "OpenLibrary");
        assert_eq!(providers[2].id, "comic_vine");
        assert_eq!(providers[2].name, "Comic Vine");
    }
```

In the test `registry_get_enabled_providers` (around line 216-229), update to account for Comic Vine being disabled by default (no API key):

```rust
    #[test]
    fn registry_get_enabled_providers() {
        let mut reg = ProviderRegistry::new();
        // Comic Vine is disabled by default (needs API key), so only 2 enabled
        assert_eq!(reg.enabled_providers().len(), 2);
        reg.configure_provider(
            "google_books",
            ProviderConfig {
                enabled: false,
                api_key: None,
            },
        );
        let enabled = reg.enabled_providers();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0], "openlibrary");
    }
```

- [ ] **Step 4: Verify it compiles and tests pass**

Run: `cd src-tauri && cargo test`
Expected: All tests pass (including new Comic Vine tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/providers/mod.rs
git commit -m "feat(providers): register Comic Vine provider in enrichment registry"
```

---

### Task 3: Run full CI checks

**Files:** None (verification only)

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

- [ ] **Step 3: Fix any issues found**

If any failures, fix and re-run.

- [ ] **Step 4: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix: address CI issues from Comic Vine provider"
```
