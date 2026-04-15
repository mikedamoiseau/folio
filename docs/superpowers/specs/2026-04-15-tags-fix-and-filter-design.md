# Tags: Fix Saving + Library Filter

## Problem

1. **Tags don't save in EditBookDialog.** The tag input only commits on Enter key press with no visual cue. Users type tags and click Save, expecting them to persist — but `handleSave` doesn't process pending tag input. Delimiter-separated tags (comma or space) aren't split into individual tags.

2. **No way to filter the library by tags.** The library toolbar has filters for format, status, rating, and source, but no tag filter. Tags can only be used via automated collection rules.

## Solution

### 1. Tag Input Fix (EditBookDialog)

Fix the tag input in `src/components/EditBookDialog.tsx` to use chip-on-comma behavior:

- **Comma commits:** Typing a comma immediately commits the text before it as a tag chip (calls `add_tag_to_book`).
- **Enter commits:** Pressing Enter commits current text as a tag (existing behavior, already works).
- **Save commits leftovers:** Clicking the "Save" button commits any pending text in the tag input before saving metadata.
- **Chips are visual:** Tags appear as removable pills above the input (existing rendering, just never gets populated because tags aren't committed).
- **Normalization:** Tags are lowercase-trimmed. Duplicates are silently ignored. (Both already handled by `handleAddTag`.)
- **Autocomplete:** Existing suggestion dropdown continues to work (type to filter known tags, click to select).

**No backend changes.** `add_tag_to_book` and `remove_tag_from_book` commands already work correctly.

### 2. Eager Tag Loading

Load tag data alongside the book library so client-side filtering is possible.

**New backend function** in `db.rs`:
```rust
pub fn list_all_book_tags(conn: &Connection) -> Result<Vec<(String, String)>>
// SELECT book_id, tag_id FROM book_tags
```

**New Tauri command** in `commands.rs`:
```rust
#[tauri::command]
pub async fn get_all_book_tags(state: State<'_, AppState>) -> Result<Vec<BookTagAssoc>, String>
```

Returns flat `{ book_id, tag_id }` pairs. Registered in `lib.rs` invoke_handler.

**Frontend** in `Library.tsx`:
- `loadBooks` also calls `get_all_tags` and `get_all_book_tags`.
- Builds a `Map<string, Set<string>>` (bookId -> set of tagIds) for O(1) lookups.
- Stores `allTags: Tag[]` in state for the filter component.
- Reloads alongside books (on mount, after import, after edit save, etc.).

### 3. Tag Filter Component (Library Toolbar)

New component: `src/components/TagFilter.tsx`

**Props:**
- `allTags: { id: string; name: string }[]`
- `bookTagMap: Map<string, Set<string>>` (bookId -> tagIds)
- `selectedTagIds: string[]`
- `onChangeSelectedTagIds: (ids: string[]) => void`

**Resting state:** A button styled like the existing filter dropdowns. Shows "Tags" when empty. Shows selected tags as chips with X buttons when active. Truncates with "+N" if too many.

**Open state (dropdown):**
- Search input at top with placeholder "Filter tags..."
- Scrollable list of matching tags, each showing a book count
- Selected tags show a checkmark
- Click to toggle selection
- Click outside or Escape to close

**Filtering logic:**
- AND semantics: a book must have ALL selected tags to pass.
- Integrates into the existing `filtered` useMemo chain in `Library.tsx` as an additional `.filter()` step.
- Uses the `bookTagMap` for lookups.

**Persistence:** Selected tag IDs saved to `localStorage` key `folio-library-filter-tags` (JSON array). Restored on mount. Invalid IDs (deleted tags) silently ignored.

**Styling:** Consistent with existing design system — `bg-warm-subtle`, `border-warm-border`, `text-ink-muted`, accent highlights for selected state. No new CSS classes needed.

## Files Changed

| File | Change |
|------|--------|
| `src/components/EditBookDialog.tsx` | Fix tag input: chip-on-comma, save commits pending |
| `src/components/TagFilter.tsx` | **New file** — searchable multi-select tag combobox |
| `src/screens/Library.tsx` | Load tags eagerly, add TagFilter to toolbar, add filter step |
| `src-tauri/src/db.rs` | Add `list_all_book_tags()` |
| `src-tauri/src/commands.rs` | Add `get_all_book_tags` command |
| `src-tauri/src/lib.rs` | Register `get_all_book_tags` in invoke_handler |
| `src/locales/en.json` | Add i18n keys for tag filter UI |
| `src/locales/fr.json` | Add French translations for tag filter UI |

## Out of Scope

- Tag management (rename, delete, merge) — separate feature
- Auto-tagging from EPUB subjects on import — separate feature
- Tag colors or icons — not needed now
