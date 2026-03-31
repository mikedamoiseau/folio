# Comic Vine Enrichment Provider — Design Spec

**Date:** 2026-03-31
**Roadmap item:** #17b — Comic Vine Enrichment Provider

## Overview

Add Comic Vine as a third enrichment provider for metadata lookup, registered after Google Books and OpenLibrary. Comic Vine is the most comprehensive free public API for comics metadata, with good coverage of American comics, European BD, and manga.

## Provider Implementation

New file: `src-tauri/src/providers/comic_vine.rs`

Implements the `EnrichmentProvider` trait following the same pattern as `google_books.rs` and `openlibrary.rs`.

### Configuration

- `id`: `"comic_vine"`
- `name`: `"Comic Vine"`
- `requires_api_key`: `true`
- `api_key_help`: `"Free key from comicvine.gamespot.com/api"`

### API Details

- **Base URL:** `https://comicvine.gamespot.com/api`
- **Auth:** API key as query parameter `api_key=KEY`
- **Format:** JSON via `format=json`
- **Required:** `User-Agent` header (Comic Vine blocks requests without one)
- **HTTP client:** `ureq` (already a dependency)

### Search Logic

**`search_by_isbn`:** Returns empty `Vec`. Comic Vine has no ISBN field.

**`search_by_title`:** Two-tier search:
1. Search volumes: `GET /search/?api_key=KEY&format=json&resources=volume&query=TITLE&limit=5`
   - If author provided, include in query: `"TITLE AUTHOR"`
2. If no results from volumes, search issues: `GET /search/?api_key=KEY&format=json&resources=issue&query=TITLE&limit=5`
3. Parse and return results as `Vec<EnrichmentData>`

### Field Mapping

**From volume results:**
| Comic Vine field | EnrichmentData field |
|-----------------|---------------------|
| `name` | `title`, `series` |
| `deck` | `description` |
| `image.medium_url` | `cover_url` |
| `publisher.name` | `publisher` |
| `start_year` | `publish_year` |
| — | `source: "comic_vine"` |
| `id` | `source_key` |

**From issue results:**
| Comic Vine field | EnrichmentData field |
|-----------------|---------------------|
| `volume.name + " #" + issue_number` (or `name` if present) | `title` |
| `volume.name` | `series` |
| `issue_number` | `volume` (parsed as u32) |
| `deck` | `description` |
| `image.medium_url` | `cover_url` |
| `cover_date` | `publish_year` (parse year) |
| — | `source: "comic_vine"` |
| `id` | `source_key` |

### Registration

Added last in `ProviderRegistry::new()` in `src-tauri/src/providers/mod.rs`, after OpenLibrary.

## Scope Boundaries

- No ISBN search (Comic Vine doesn't support it)
- No fetching detailed volume/issue info beyond search results (YAGNI — search results contain enough metadata)
- No new UI changes — existing Enrichment Sources UI in Settings handles display automatically
- No new i18n keys — provider name and help text come from backend
