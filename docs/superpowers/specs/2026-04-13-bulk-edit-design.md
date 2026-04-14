# Bulk Edit Metadata — Design Spec

**Date:** 2026-04-13
**Status:** Approved

## Overview

Allow users to select multiple books and edit shared metadata fields in a single operation. Fields: Author, Series, Year, Language, Publisher.

## UX Flow

1. User enters bulk select mode (existing toggle in Library toolbar)
2. User checks desired books
3. User clicks "Edit" button in bulk action bar (new, alongside existing Delete/Add to Collection)
4. **Bulk Edit Dialog** opens as a modal
5. User modifies desired fields, clicks "Save"
6. All selected books are updated with the changed fields only

## Bulk Edit Dialog

### Field Display Logic

For each of the 5 fields, compute the value across all selected books:
- **All same** → pre-fill the field with that value
- **All empty/null** → show empty field with normal placeholder
- **Mixed** → show empty field with italic grey "Multiple values" placeholder

### Interaction

- Fields the user does not touch are **not written** — only explicitly changed fields are sent to the backend
- Clearing a pre-filled field to empty sets that field to null/empty on all selected books
- The dialog title shows the count: "Edit 5 Books"
- A "Save" button applies changes; "Cancel" discards

### Fields

| Field | Input Type | Placeholder | Validation |
|-------|-----------|-------------|------------|
| Author | text | "Author" or "Multiple values" | max 500 chars |
| Series | text | "Series" or "Multiple values" | max 500 chars |
| Year | number | "Year" or "Multiple values" | valid u16 (1000-2100) |
| Language | text | "Language" or "Multiple values" | max 50 chars |
| Publisher | text | "Publisher" or "Multiple values" | max 500 chars |

## Backend

### New Tauri Command: `bulk_update_metadata`

```
bulk_update_metadata(
  book_ids: Vec<String>,
  author: Option<String>,      // None = don't change, Some("") = clear
  series: Option<String>,
  publish_year: Option<u16>,   // None = don't change, Some(0) could mean clear
  language: Option<String>,
  publisher: Option<String>,
) -> Result<u32, String>       // returns count of books updated
```

### Implementation

- Single DB transaction wrapping all updates
- Only SET clauses for fields that are `Some(...)` — skip `None` fields
- Log one activity entry: "bulk_edited N books (fields: author, series)"
- Validate string lengths before writing
- Return count of books actually updated

### New DB Function: `bulk_update_metadata`

Build a dynamic UPDATE query based on which fields are provided. Execute once per book ID within a transaction. This avoids building a complex multi-row UPDATE and keeps the logic simple.

## Frontend

### Component: `BulkEditDialog`

New component at `src/components/BulkEditDialog.tsx`.

**Props:**
- `bookIds: string[]` — selected book IDs
- `books: BookGridItem[]` — selected books data (for computing shared values)
- `onClose: () => void`
- `onSave: () => void` — callback after successful save (triggers library reload)

**State:**
- For each field: track whether the user has modified it (dirty flag)
- Compute initial values from props: shared value or null (mixed)

### Integration in Library.tsx

- Add "Edit" button to the bulk action bar (appears when `selectMode && selectedIds.size > 0`)
- Wire `BulkEditDialog` with selected books data
- After save, reload library and exit select mode

## Scope Exclusions

- No tag editing (deferred)
- No volume editing (per-book value)
- No undo/history
- No enrichment provider integration (this is manual editing only)
- No web UI implementation (desktop only for now)
