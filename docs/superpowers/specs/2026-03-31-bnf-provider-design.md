# BnF Enrichment Provider — Design Spec

**Date:** 2026-03-31
**Roadmap item:** #17c — BnF (Bibliothèque nationale de France) Enrichment Provider

## Overview

Add BnF as a fourth enrichment provider for metadata lookup, registered after Comic Vine. BnF's SRU API provides highly accurate metadata for French publications — books, BD, and more — via the national catalog. No API key required.

## Provider Implementation

New file: `src-tauri/src/providers/bnf.rs`

Implements the `EnrichmentProvider` trait following the same pattern as existing providers.

### Configuration

- `id`: `"bnf"`
- `name`: `"BnF (Bibliothèque nationale de France)"`
- `requires_api_key`: `false`
- `api_key_help`: `""`
- Enabled by default (no key required)

### API Details

- **Endpoint:** `https://catalogue.bnf.fr/api/SRU`
- **Protocol:** SRU (Search/Retrieve via URL) with CQL query language
- **Auth:** None required — fully public
- **Response format:** Dublin Core XML (`recordSchema=dublincore`)
- **HTTP client:** `reqwest::blocking` (same as other providers)

### Search Logic

**`search_by_isbn`:**
```
https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.isbn adj "{isbn}"&recordSchema=dublincore&maximumRecords=3
```

**`search_by_title`:**
```
https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=(bib.title all "{title}") and (bib.author all "{author}") and (bib.doctype any "a")&recordSchema=dublincore&maximumRecords=5
```
If no author provided, omit the `bib.author` clause. The `bib.doctype any "a"` filter restricts to printed text/digital books.

### Field Mapping from Dublin Core

| DC element | EnrichmentData field |
|-----------|---------------------|
| `dc:title` | `title` |
| `dc:creator` | `author` |
| `dc:description` | `description` |
| `dc:publisher` | `publisher` |
| `dc:date` | `publish_year` (parse 4-digit year) |
| `dc:language` | `language` |
| `dc:identifier` containing ISBN | `isbn` |
| — | `cover_url: None` (BnF provides no cover images) |
| — | `source: "bnf"`, `source_key`: record ARK identifier from `dc:identifier` |

### XML Parsing

Dublin Core responses are flat XML. Use simple string-based tag extraction (same `extract_tag_text` pattern from `epub.rs`) to pull `dc:*` elements from each `<srw:record>` in the response. No need for a full XML parser.

Multiple `dc:identifier` elements may be present (ARK, ISBN, ISSN, etc.). Filter for the one containing an ISBN pattern.

### Registration

Added last in `ProviderRegistry::new()` in `src-tauri/src/providers/mod.rs`, after Comic Vine.

## Scope Boundaries

- Dublin Core format only (not UNIMARC) — simpler parsing, covers key fields
- No cover images (BnF doesn't provide them in search results)
- No genre extraction (Dublin Core `dc:subject` could be used but is inconsistent — skip for now)
- No series/volume extraction (not reliably available in Dublin Core)
