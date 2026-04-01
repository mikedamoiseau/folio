# BnF Enrichment Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BnF (Bibliothèque nationale de France) as a fourth enrichment provider for French book/BD metadata lookup via their public SRU API with Dublin Core responses.

**Architecture:** New provider module `bnf.rs` implementing `EnrichmentProvider` trait, registered after Comic Vine. Uses `reqwest::blocking` for HTTP. Parses Dublin Core XML using simple string extraction. Supports ISBN search and title+author search with document type filtering.

**Tech Stack:** Rust, reqwest (blocking + json), Dublin Core XML, BnF SRU API (CQL queries)

---

### Task 1: Create BnF provider with parse functions and tests

**Files:**
- Create: `src-tauri/src/providers/bnf.rs`

- [ ] **Step 1: Create the provider file**

Create `src-tauri/src/providers/bnf.rs`:

```rust
use super::{EnrichmentData, EnrichmentProvider, ProviderConfig};

const SRU_ENDPOINT: &str = "http://catalogue.bnf.fr/api/SRU";

#[derive(Default)]
pub struct BnfProvider {
    config: ProviderConfig,
}

impl BnfProvider {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EnrichmentProvider for BnfProvider {
    fn id(&self) -> &str {
        "bnf"
    }

    fn name(&self) -> &str {
        "BnF (Bibliothèque nationale de France)"
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    fn api_key_help(&self) -> &str {
        ""
    }

    fn search_by_isbn(&self, isbn: &str) -> Result<Vec<EnrichmentData>, String> {
        let query = format!("bib.isbn adj \"{}\"", isbn);
        let url = build_sru_url(&query, 3);
        fetch_and_parse(&url)
    }

    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String> {
        let mut query = format!("(bib.title all \"{}\")", cql_escape(title));
        if let Some(a) = author {
            if !a.is_empty() {
                query.push_str(&format!(" and (bib.author all \"{}\")", cql_escape(a)));
            }
        }
        query.push_str(" and (bib.doctype any \"a\")");
        let url = build_sru_url(&query, 5);
        fetch_and_parse(&url)
    }

    fn configure(&mut self, config: ProviderConfig) {
        self.config = config;
    }

    fn config(&self) -> &ProviderConfig {
        &self.config
    }
}

fn build_sru_url(query: &str, max_records: u32) -> String {
    let encoded = urlencoding(query);
    format!(
        "{}?version=1.2&operation=searchRetrieve&query={}&recordSchema=dublincore&maximumRecords={}",
        SRU_ENDPOINT, encoded, max_records
    )
}

fn fetch_and_parse(url: &str) -> Result<Vec<EnrichmentData>, String> {
    let resp =
        reqwest::blocking::get(url).map_err(|e| format!("BnF request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("BnF HTTP {}", resp.status()));
    }

    let body = resp.text().map_err(|e| format!("BnF response read error: {e}"))?;

    // Split on <srw:record> to get individual records
    let records: Vec<EnrichmentData> = body
        .split("<srw:record>")
        .skip(1) // first chunk is before any record
        .filter_map(parse_dc_record)
        .collect();

    Ok(records)
}

fn parse_dc_record(xml: &str) -> Option<EnrichmentData> {
    let title = extract_dc("dc:title", xml)?.to_string();
    if title.is_empty() {
        return None;
    }

    let author = extract_dc("dc:creator", xml)
        .unwrap_or("")
        .to_string();
    let description = extract_dc("dc:description", xml).map(|s| s.to_string());
    let publisher = extract_dc("dc:publisher", xml).map(|s| s.to_string());
    let language = extract_dc("dc:language", xml).map(|s| s.to_string());
    let publish_year = extract_dc("dc:date", xml).and_then(extract_year);

    // Find ISBN among dc:identifier elements (may have ARK, ISSN, ISBN, etc.)
    let isbn = extract_all_dc("dc:identifier", xml)
        .into_iter()
        .find(|id| looks_like_isbn(id))
        .map(|s| s.to_string());

    // Use ARK identifier as source_key if present
    let source_key = extract_all_dc("dc:identifier", xml)
        .into_iter()
        .find(|id| id.contains("ark:"))
        .map(|s| s.to_string());

    Some(EnrichmentData {
        title,
        author,
        description,
        genres: Vec::new(),
        rating: None,
        isbn,
        cover_url: None,
        language,
        publisher,
        publish_year,
        source: "bnf".to_string(),
        source_key,
    })
}

/// Extract first occurrence of a Dublin Core tag value.
fn extract_dc<'a>(tag: &str, xml: &'a str) -> Option<&'a str> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = xml.find(&open)?;
    let after_open = &xml[start..];
    let content_start = after_open.find('>')? + 1;
    let content = &after_open[content_start..];
    let end = content.find(&close)?;
    let text = content[..end].trim();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Extract all occurrences of a Dublin Core tag.
fn extract_all_dc<'a>(tag: &str, xml: &'a str) -> Vec<&'a str> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut results = Vec::new();
    let mut search_from = 0;
    while let Some(start) = xml[search_from..].find(&open) {
        let abs_start = search_from + start;
        let after_open = &xml[abs_start..];
        if let Some(content_start) = after_open.find('>') {
            let content = &after_open[content_start + 1..];
            if let Some(end) = content.find(&close) {
                let text = content[..end].trim();
                if !text.is_empty() {
                    results.push(text);
                }
                search_from = abs_start + content_start + 1 + end + close.len();
            } else {
                break;
            }
        } else {
            break;
        }
    }
    results
}

/// Check if a string looks like an ISBN (10 or 13 digits, possibly with hyphens).
fn looks_like_isbn(s: &str) -> bool {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.len() == 10 || digits.len() == 13
}

/// Extract a 4-digit year from a date string.
fn extract_year(date: &str) -> Option<u16> {
    // Try to find a 4-digit year pattern anywhere in the string
    date.split(|c: char| !c.is_ascii_digit())
        .find(|part| part.len() == 4)
        .and_then(|y| y.parse::<u16>().ok())
}

/// Escape special CQL characters in a query value.
fn cql_escape(s: &str) -> String {
    s.replace('"', "")
        .replace('\\', "")
}

fn urlencoding(s: &str) -> String {
    s.replace(' ', "%20")
        .replace('"', "%22")
        .replace('(', "%28")
        .replace(')', "%29")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RECORD: &str = r#"
        <srw:record>
            <srw:recordSchema>dublincore</srw:recordSchema>
            <srw:recordData>
                <oai_dc:dc>
                    <dc:title>Astérix le Gaulois</dc:title>
                    <dc:creator>René Goscinny</dc:creator>
                    <dc:description>Les aventures d'Astérix le Gaulois.</dc:description>
                    <dc:publisher>Dargaud</dc:publisher>
                    <dc:date>1961</dc:date>
                    <dc:language>fre</dc:language>
                    <dc:identifier>ark:/12148/cb30058120v</dc:identifier>
                    <dc:identifier>978-2-01-210103-6</dc:identifier>
                </oai_dc:dc>
            </srw:recordData>
        </srw:record>
    "#;

    #[test]
    fn parse_dc_record_complete() {
        let result = parse_dc_record(SAMPLE_RECORD).expect("should parse");
        assert_eq!(result.title, "Astérix le Gaulois");
        assert_eq!(result.author, "René Goscinny");
        assert_eq!(
            result.description.as_deref(),
            Some("Les aventures d'Astérix le Gaulois.")
        );
        assert_eq!(result.publisher.as_deref(), Some("Dargaud"));
        assert_eq!(result.publish_year, Some(1961));
        assert_eq!(result.language.as_deref(), Some("fre"));
        assert_eq!(result.isbn.as_deref(), Some("978-2-01-210103-6"));
        assert!(result.cover_url.is_none());
        assert_eq!(result.source, "bnf");
        assert_eq!(
            result.source_key.as_deref(),
            Some("ark:/12148/cb30058120v")
        );
    }

    #[test]
    fn parse_dc_record_minimal() {
        let xml = r#"
            <dc:title>Un livre</dc:title>
        "#;
        let result = parse_dc_record(xml).expect("should parse minimal");
        assert_eq!(result.title, "Un livre");
        assert_eq!(result.author, "");
        assert!(result.description.is_none());
        assert!(result.publisher.is_none());
        assert!(result.publish_year.is_none());
        assert!(result.isbn.is_none());
        assert_eq!(result.source, "bnf");
    }

    #[test]
    fn parse_dc_record_no_title_returns_none() {
        let xml = r#"
            <dc:creator>Someone</dc:creator>
            <dc:publisher>Publisher</dc:publisher>
        "#;
        assert!(parse_dc_record(xml).is_none());
    }

    #[test]
    fn extract_dc_single() {
        assert_eq!(
            extract_dc("dc:title", "<dc:title>Hello</dc:title>"),
            Some("Hello")
        );
    }

    #[test]
    fn extract_dc_with_attributes() {
        assert_eq!(
            extract_dc(
                "dc:language",
                "<dc:language xsi:type=\"dcterms:ISO639-2\">fre</dc:language>"
            ),
            Some("fre")
        );
    }

    #[test]
    fn extract_dc_missing() {
        assert_eq!(extract_dc("dc:title", "<dc:creator>Someone</dc:creator>"), None);
    }

    #[test]
    fn extract_all_dc_multiple() {
        let xml = r#"
            <dc:identifier>ark:/12148/abc</dc:identifier>
            <dc:identifier>978-2-01-210103-6</dc:identifier>
            <dc:identifier>ISSN 1234-5678</dc:identifier>
        "#;
        let ids = extract_all_dc("dc:identifier", xml);
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], "ark:/12148/abc");
        assert_eq!(ids[1], "978-2-01-210103-6");
        assert_eq!(ids[2], "ISSN 1234-5678");
    }

    #[test]
    fn looks_like_isbn_valid() {
        assert!(looks_like_isbn("978-2-01-210103-6"));
        assert!(looks_like_isbn("9782012101036"));
        assert!(!looks_like_isbn("2-01-210103-X")); // ISBN-10 with X check digit — rejected (digits+hyphens only)
        assert!(looks_like_isbn("0132350882")); // ISBN-10
    }

    #[test]
    fn looks_like_isbn_invalid() {
        assert!(!looks_like_isbn("ark:/12148/cb30058120v"));
        assert!(!looks_like_isbn("ISSN 1234-5678"));
        assert!(!looks_like_isbn("12345"));
        assert!(!looks_like_isbn(""));
    }

    #[test]
    fn extract_year_simple() {
        assert_eq!(extract_year("1961"), Some(1961));
    }

    #[test]
    fn extract_year_from_date() {
        assert_eq!(extract_year("1961-01-01"), Some(1961));
    }

    #[test]
    fn extract_year_from_text() {
        assert_eq!(extract_year("cop. 2015"), Some(2015));
    }

    #[test]
    fn extract_year_empty() {
        assert_eq!(extract_year(""), None);
    }

    #[test]
    fn extract_year_no_match() {
        assert_eq!(extract_year("unknown"), None);
    }

    #[test]
    fn cql_escape_removes_quotes() {
        assert_eq!(cql_escape("hello \"world\""), "hello world");
    }

    #[test]
    fn urlencoding_encodes_special() {
        assert_eq!(urlencoding("a b"), "a%20b");
        assert_eq!(urlencoding("\"test\""), "%22test%22");
        assert_eq!(urlencoding("(a)"), "%28a%29");
    }

    #[test]
    fn build_sru_url_format() {
        let url = build_sru_url("bib.isbn adj \"978-2-01-210103-6\"", 3);
        assert!(url.starts_with("http://catalogue.bnf.fr/api/SRU?"));
        assert!(url.contains("version=1.2"));
        assert!(url.contains("operation=searchRetrieve"));
        assert!(url.contains("recordSchema=dublincore"));
        assert!(url.contains("maximumRecords=3"));
    }

    #[test]
    fn provider_metadata() {
        let provider = BnfProvider::new();
        assert_eq!(provider.id(), "bnf");
        assert_eq!(provider.name(), "BnF (Bibliothèque nationale de France)");
        assert!(!provider.requires_api_key());
        assert!(provider.config().enabled); // enabled by default
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/providers/bnf.rs
git commit -m "feat(providers): add BnF provider module with Dublin Core parsing and tests"
```

---

### Task 2: Register BnF provider in the registry

**Files:**
- Modify: `src-tauri/src/providers/mod.rs`

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/providers/mod.rs`, add after `pub mod comic_vine;` (line 3):

```rust
pub mod bnf;
```

- [ ] **Step 2: Add BnF to the registry**

In `ProviderRegistry::new()`, add BnF after Comic Vine:

```rust
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(google_books::GoogleBooksProvider::new()),
                Box::new(openlibrary::OpenLibraryProvider::new()),
                Box::new(comic_vine::ComicVineProvider::new()),
                Box::new(bnf::BnfProvider::new()),
            ],
        }
    }
```

- [ ] **Step 3: Update tests**

Update `registry_lists_providers_in_order` to expect 4 providers:

```rust
    #[test]
    fn registry_lists_providers_in_order() {
        let reg = ProviderRegistry::new();
        let providers = reg.list_providers();
        assert_eq!(providers.len(), 4);
        assert_eq!(providers[0].id, "google_books");
        assert_eq!(providers[0].name, "Google Books");
        assert_eq!(providers[1].id, "openlibrary");
        assert_eq!(providers[1].name, "OpenLibrary");
        assert_eq!(providers[2].id, "comic_vine");
        assert_eq!(providers[2].name, "Comic Vine");
        assert_eq!(providers[3].id, "bnf");
        assert_eq!(providers[3].name, "BnF (Bibliothèque nationale de France)");
    }
```

Update `registry_get_enabled_providers` — BnF is enabled by default (no key needed), so initial count is 3:

```rust
    #[test]
    fn registry_get_enabled_providers() {
        let mut reg = ProviderRegistry::new();
        // Google Books + OpenLibrary + BnF enabled; Comic Vine disabled (needs API key)
        assert_eq!(reg.enabled_providers().len(), 3);
        reg.configure_provider(
            "google_books",
            ProviderConfig {
                enabled: false,
                api_key: None,
            },
        );
        let enabled = reg.enabled_providers();
        assert_eq!(enabled.len(), 2);
        assert_eq!(enabled[0], "openlibrary");
        assert_eq!(enabled[1], "bnf");
    }
```

- [ ] **Step 4: Verify it compiles and tests pass**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/providers/mod.rs
git commit -m "feat(providers): register BnF provider in enrichment registry"
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
git commit -m "fix: address CI issues from BnF provider"
```
