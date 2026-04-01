# Provider Priority Order — Design Spec

**Date:** 2026-04-01
**Roadmap item:** User-configurable provider priority order (drag-to-reorder in Settings)

## Overview

Let users reorder enrichment providers in Settings via up/down arrow buttons. The order determines which provider is tried first during metadata scans (first match wins). Persisted in the settings DB table.

## Backend

### New setting: `enrichment_provider_order`

A JSON array of provider IDs stored in the existing `settings` table:

```json
["bnf", "google_books", "openlibrary", "comic_vine"]
```

- If missing or empty, the hardcoded default order is used: Google Books → OpenLibrary → Comic Vine → BnF
- Provider IDs not present in the saved order (e.g., a newly added provider) are appended at the end

### New command: `set_enrichment_provider_order`

```rust
#[tauri::command]
pub async fn set_enrichment_provider_order(
    order: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String>
```

- Validates that all IDs correspond to known providers
- Saves the order as JSON to `settings` table under key `enrichment_provider_order`
- Calls `registry.reorder(&order)` on the in-memory `ProviderRegistry` via `AppState`

### `ProviderRegistry::reorder`

New method on `ProviderRegistry`:

```rust
pub fn reorder(&mut self, order: &[String])
```

- Sorts the internal `providers: Vec<Box<dyn EnrichmentProvider>>` to match the given ID order
- Providers whose ID is not in `order` are appended at the end in their current relative order

### Startup: apply saved order

In `lib.rs` where `enrichment_providers` config is already loaded and applied, also:

1. Load `enrichment_provider_order` from settings
2. Call `registry.reorder()` with the saved order

This goes right after the existing `configure_provider` loop.

### `list_enrichment_providers` — no change

Already returns providers in Vec order. After `reorder()`, the Vec reflects the user's priority, so the frontend receives them in the correct order automatically.

## Frontend

### Arrow buttons on provider rows

Add ▲/▼ buttons to each provider row in `SettingsPanel.tsx`, to the left of the enable checkbox:

- ▲ disabled (opacity 30%) on the first provider
- ▼ disabled (opacity 30%) on the last provider
- Clicking swaps the provider with its neighbor in the list
- After swap, calls `set_enrichment_provider_order` with the new ID array, then reloads the provider list

### Label

A small muted label above the provider list: "Tried in order from top to bottom" (with i18n key `settings.enrichmentSourcesOrder`). The visual ordering communicates priority without needing explicit position numbers.

## Data Flow

```
User clicks ▲ on BnF →
frontend swaps BnF with provider above in local array →
calls invoke("set_enrichment_provider_order", { order: [...] }) →
backend saves JSON to settings table →
backend reorders in-memory ProviderRegistry →
frontend reloads provider list (now in new order) →
next enrichment scan tries providers in user-defined order
```

## Edge Cases

- **New provider added in code:** If the saved order doesn't include a new provider's ID, it appears at the end of the list. No migration needed.
- **Removed provider:** If the saved order references an ID that no longer exists, it's silently ignored during reorder.
- **No saved order:** Falls back to the hardcoded default (Google Books → OpenLibrary → Comic Vine → BnF). Identical to current behavior.

## Scope Boundaries

- No drag-and-drop (arrow buttons only — simpler, accessible, sufficient for 4 providers)
- No per-book or per-format provider order (global only)
- No changes to the enrichment scan logic itself (still first-match-wins)
- No changes to the `ProviderConfig` struct (order is separate from enable/key config)
