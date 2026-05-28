# F-1-6: Smart Collection Auto-Suggestions

## Summary

Add a "Suggest Collections" button to CollectionsSidebar that analyzes library patterns and offers 2-8 rule-based collection templates as rich cards. Users can accept (create immediately), edit (pre-fill collection editor), or dismiss each suggestion. Suggestions are computed fresh on each click, deduplicated against existing automated collections.

## Approach

Backend-only heuristics (Approach A). Single Tauri command runs all heuristic queries in Rust, returns ranked `CollectionSuggestion` list. Frontend renders cards and delegates to existing `create_collection` on accept.

## Data Model

New struct in `folio-core/src/models.rs`:

```rust
pub struct CollectionSuggestion {
    pub name: String,
    pub icon: String,
    pub color: String,
    pub rules: Vec<NewRuleInput>,
    pub matched_book_count: usize,
    pub heuristic_type: String, // "author" | "series" | "reading_status" | "format"
}
```

No new DB tables. Suggestions are ephemeral — computed on demand, never persisted.

## Heuristic Engine

New function in `folio-core/src/db.rs`:

```rust
pub fn get_collection_suggestions(
    conn: &Connection,
    existing_collections: &[Collection],
) -> Result<Vec<CollectionSuggestion>>
```

### Author Heuristic

Authors with 3+ books:

```sql
SELECT author, COUNT(*) as cnt FROM books
WHERE author IS NOT NULL AND author != ''
GROUP BY author HAVING cnt >= 3
ORDER BY cnt DESC LIMIT 5
```

Generates suggestion with name "Books by {author}", rule `{field: "author", operator: "equals", value: author}`.

### Series Heuristic

Series with 2+ books:

```sql
SELECT series, COUNT(*) as cnt FROM books
WHERE series IS NOT NULL AND series != ''
GROUP BY series HAVING cnt >= 2
ORDER BY cnt DESC LIMIT 5
```

Generates suggestion with name "{series} series", rule `{field: "series", operator: "equals", value: series}`.

### Reading Status Heuristic

Two fixed suggestions when thresholds met:

- **"Unread books"** — books with no reading_progress entry. Show if count >= 3. Rule: `{field: "reading_progress", operator: "equals", value: "unread"}`.
- **"Finished books"** — `chapter_index >= total_chapters - 1`. Show if count >= 2. Rule: `{field: "reading_progress", operator: "equals", value: "finished"}`. Named "Finished books" (not "this year") because the rule type captures all-time completions.

### Format Heuristic

Non-dominant formats with 3+ books:

```sql
SELECT format, COUNT(*) as cnt FROM books
GROUP BY format HAVING cnt >= 3
ORDER BY cnt DESC
```

Skip any format representing >80% of library. Generates suggestion with name "{Format} Books", rule `{field: "format", operator: "equals", value: format}`.

## Deduplication

Before returning suggestions, filter out any whose rules match an existing automated collection's rules. Comparison: for each suggestion, check if any existing automated collection has a rule with the same `(field, operator, value)` tuple. If match found, skip that suggestion.

## Ranking

Return max 8 suggestions, sorted by `matched_book_count` descending.

## Backend Command

New Tauri command in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn get_collection_suggestions(
    state: State<'_, AppState>,
) -> FolioResult<Vec<CollectionSuggestion>>
```

Flow:
1. Get connection from pool
2. Fetch existing automated collections via `list_collections`
3. Call `db::get_collection_suggestions(conn, &existing_collections)`
4. Return filtered, ranked list

Register in `lib.rs` invoke_handler. No activity logging — read-only operation.

## Frontend UI

In `CollectionsSidebar.tsx`:

### State

- `suggestions: CollectionSuggestion[]` — current suggestion list
- `showSuggestions: boolean` — whether suggestion section is visible
- `loadingSuggestions: boolean` — loading spinner state

### Button

"Suggest Collections" button below collection list, always visible. On click:
1. Set `loadingSuggestions = true`
2. Call `invoke("get_collection_suggestions")`
3. Populate `suggestions`, set `showSuggestions = true`
4. Set `loadingSuggestions = false`

### Suggestion Cards

Rich cards in a "Suggested" section below existing collections, visually distinct with subtle background tint. Each card shows:
- Icon + name
- "{N} books match - {heuristic_type} rule" subtitle
- Three action buttons:
  - **Add** — calls existing `create_collection` with suggestion's name/icon/color/rules as automated collection. Removes card from state. Refreshes collection list.
  - **Edit** — opens existing collection creation/edit form pre-filled with suggestion data (name, rules, icon, color). User can tweak before saving.
  - **Dismiss** — removes card from local state. Not persisted; suggestion reappears next click unless collection was created (dedup handles it).

### Edge Cases

- Loading state: spinner on button while computing
- Empty state: "No suggestions — your library is well-organized!" when no suggestions returned
- No new components needed — cards are JSX within CollectionsSidebar

## Testing

### Rust Unit Tests (folio-core/src/db.rs)

- `test_suggest_author_collections` — 4 books by same author → suggestion returned
- `test_suggest_series_collections` — 3 books in same series → suggestion returned
- `test_suggest_reading_status` — books with/without reading_progress → "unread" and "finished books" suggestions
- `test_suggest_format` — mix of formats → non-dominant format suggested
- `test_dedup_existing_collections` — existing automated collection with author rule → that author skipped
- `test_no_suggestions_small_library` — 1-2 books → empty result
- `test_suggestion_limit` — many patterns → max 8 returned

### Manual Integration Test

Via `npm run tauri dev`: click button, verify cards appear, accept one, verify collection created with correct rules and appears in sidebar.

## Files Changed

| File | Change |
|------|--------|
| `folio-core/src/models.rs` | Add `CollectionSuggestion` struct |
| `folio-core/src/db.rs` | Add `get_collection_suggestions` function + tests |
| `src-tauri/src/commands.rs` | Add `get_collection_suggestions` command |
| `src-tauri/src/lib.rs` | Register command in invoke_handler |
| `src/components/CollectionsSidebar.tsx` | Add button, suggestion cards, accept/edit/dismiss logic |
