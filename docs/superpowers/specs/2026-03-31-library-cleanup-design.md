# Library Cleanup — Design Spec

**Date:** 2026-03-31
**Roadmap item:** #11c — Library Cleanup

## Overview

Two complementary features for handling books whose files no longer exist on disk:

1. **Bulk cleanup** — A "Check for missing files" action in Settings > Library that scans the entire library, removes broken entries, and cleans up associated data.
2. **Error-on-open removal** — When a user tries to open a book whose file is missing, show a dialog offering to remove it from the library instead of a dead-end error toast.

## Feature 1: Bulk Library Cleanup

### User Flow

1. User clicks "Check for missing files" button in Settings > Library
2. Confirmation dialog: "This will scan your library and remove any books whose files can no longer be found. This cannot be undone." — Cancel / Continue
3. Dialog transitions to progress state: "Scanning... X / Y books"
4. On completion:
   - Books removed: "Removed N books with missing files."
   - No issues: "All books are accounted for. No issues found."
5. User dismisses with "Done" button; library view refreshes

### Backend

**New Tauri command: `cleanup_library`**

```rust
#[tauri::command]
pub async fn cleanup_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String>
```

Logic:
1. Fetch all books via `db::list_books(&conn)`
2. Iterate each book, check `Path::new(&book.file_path).exists()`
3. Emit `cleanup-progress` event after each book: `{ current: u32, total: u32 }`
4. For each broken book:
   - `db::delete_book(&conn, &book.id)` — cascades to reading_progress, bookmarks, highlights, book_collections, book_tags
   - Delete cover directory: `{app_data_dir}/covers/{book_id}/`
   - Log activity with action `"book_removed_cleanup"`, entity_type `"book"`, entity_id, entity_name (title)
5. Return `CleanupResult { removed_count, removed_books }`

Register in `lib.rs` invoke_handler.

**New types in `models.rs`:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupResult {
    pub removed_count: u32,
    pub removed_books: Vec<CleanupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupEntry {
    pub id: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupProgress {
    pub current: u32,
    pub total: u32,
}
```

### Frontend

In `SettingsPanel.tsx`, inside the Library accordion, add a button after the "Change folder" button:

- Button text: translatable "Check for missing files"
- On click: open confirmation modal
- Modal listens to `cleanup-progress` Tauri events for progress display
- On completion: show result message, "Done" button refreshes library

## Feature 2: Error-on-Open Removal Dialog

### User Flow

1. User clicks on a book to read it
2. Backend returns "Book file not found" error from `validate_file_exists`
3. Instead of a toast, a dialog appears: "This book's file could not be found. It may have been moved or deleted."
   - Cancel — dismiss dialog, book stays in library
   - Remove from library — calls existing `remove_book` command, navigates back to library

### Implementation

- Frontend-only change — no new backend commands
- Detect "Book file not found" in the error string from invoke rejection (from `get_chapter_content`, `get_pdf_page`, `get_comic_page`, etc.)
- Show dialog instead of error toast
- On removal: call `remove_book`, navigate to library, refresh book list
- All strings translatable

## Internationalization

All new user-facing strings must go through the `t()` translation function. New keys needed:

- Cleanup button label
- Confirmation dialog title and message
- Progress text
- Result messages (removed N books / no issues found)
- Error-on-open dialog title, message, and button labels

Add keys to both `en.json` and `fr.json`.

## Scope Boundaries

- No background/async cleanup — the operation is blocking with a modal (file existence checks are fast)
- No intermediate review step — scan and remove is one atomic operation
- No new database schema changes — uses existing `delete_book` with cascading deletes
- Cover file cleanup is included (delete `{app_data_dir}/covers/{book_id}/` directory)
- Activity logging uses existing `log_activity` helper
