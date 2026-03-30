# Linked Books (Read Without Importing) — Design Spec

**Date:** 2026-03-30
**Roadmap item:** #11b
**Status:** Approved

## Goal

Allow importing books without copying them into the library folder. The book stays at its original location (external drive, NAS, network share) with full library features: progress tracking, bookmarks, highlights, metadata, collections.

## Scope

**In scope:**
- `is_imported` column in books table (1 = copied, 0 = linked)
- Settings toggle for default import mode (copy vs link)
- Skip file copy during import when link mode is active
- Linked book badge on BookCard (chain-link icon)
- Library filter: All / Imported / Linked
- Error toast with "Remove" action when linked file is unavailable
- "Copy to library" action in Edit Book dialog for linked books
- Remote backup: skip file upload for linked books
- Local backup (ZIP): skip linked book files in full export
- Translation keys in en.json and fr.json for all new strings

**Out of scope:**
- Per-import checkbox (may add later — for now, settings toggle only)
- Visual dimming of unavailable linked books (too slow for large libraries)
- URL import linking (always copies since file is downloaded)

## Data Model

**DB migration:** Add column to `books` table:
```sql
ALTER TABLE books ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 1;
```

All existing books default to `1` (imported/copied). Linked books get `0`.

**Book model:** Add `is_imported: bool` to the `Book` struct in `models.rs`. Serialized to frontend as `isImported`.

**Settings:** New `import_mode` key in the `settings` table:
- `"import"` (default) — copy file to library folder
- `"link"` — keep file at original location

## Import Flow Changes

The `import_book` command is modified at the file copy step:

1. Hash computation happens first (reads original file) — unchanged
2. Duplicate check via hash — unchanged
3. Format detection and validation — unchanged
4. **File copy decision:**
   - If `import_mode = "import"`: copy file to `{library_folder}/{book_id}.{ext}` as today
   - If `import_mode = "link"`: skip copy, set `file_path = original_path`
5. Metadata extraction, cover extraction — unchanged (cover always copied locally)
6. DB insert with `is_imported` set based on mode — new
7. Activity log — unchanged

**Applies to:** File picker, folder import, drag-and-drop.
**Does NOT apply to:** URL import (always copies since the file is downloaded).

**Cover extraction:** Always copies cover into `{app_data_dir}/covers/` regardless of import mode. Library grid must load fast even when external drive is disconnected.

## Backup Changes

**Remote backup (OpenDAL):**
- Metadata JSON (books.json): includes linked books (full metadata)
- File upload (`push_file_if_missing`): skip when `is_imported = false`
- No warning needed — linked books are intentionally external

**Local backup (ZIP export):**
- Metadata-only export: includes linked books normally
- Full backup (with files): skip linked book files, add summary note like "3 linked books excluded (files not in library)"

**Collection export (Markdown/JSON):** No change — metadata only.

## UI Changes

### Settings > Library
New "Import mode" control below the storage folder section:
- Two-button toggle: "Copy to library" (default) / "Link to original file"
- Description: "Copied books are self-contained. Linked books save disk space but require the original file to remain accessible."

### BookCard
- Small chain-link icon badge on linked books (`isImported = false`)
- Position: top-left area, near the format badge
- Tooltip: "Linked — file at original location"
- Only shown for linked books; imported books show nothing extra

### Library Filters
New filter dropdown alongside format/status/rating:
- Options: "All books" / "Imported" / "Linked"
- Default: "All books"

### Error Toast (unavailable linked book)
When user clicks a linked book whose file doesn't exist:
- Toast message: "File not available. Reconnect the drive or remove this book."
- "Remove" action button in the toast
- Clicking "Remove" triggers the existing delete confirmation flow

### Edit Book Dialog
For linked books (`isImported = false`):
- "Copy to library" button at the bottom of the dialog
- Clicking copies the file to the library folder, updates `file_path`, sets `is_imported = 1`
- Only visible when `isImported = false` and file is accessible
- If file is not accessible: button disabled with "File not available" tooltip

## Translation Keys

New keys added to both `en.json` and `fr.json`:

```
settings.importMode — "Import mode"
settings.importModeCopy — "Copy to library"
settings.importModeLink — "Link to original file"
settings.importModeHelp — "Copied books are self-contained. Linked books save disk space but require the original file to remain accessible."
library.allBooks — "All books"
library.imported — "Imported"
library.linked — "Linked"
library.filterBySource — "Filter by source"
bookCard.linkedBadge — "Linked — file at original location"
bookCard.fileNotAvailable — "File not available. Reconnect the drive or remove this book."
editor.copyToLibrary — "Copy to library"
editor.fileNotAvailable — "File not available"
backup.linkedBooksExcluded — "{{count}} linked books excluded (files not in library)"
```

## Edge Cases

| Case | Behavior |
|------|----------|
| File moved after linking | Error toast with remove option on next open |
| External drive ejected | Same — error toast, metadata preserved |
| Duplicate detection (same hash, different mode) | Hash dedup catches it regardless of mode, returns existing book |
| Switch import mode after books exist | Only affects future imports; existing books unchanged |
| "Copy to library" on a linked book | Copies file, updates file_path and is_imported, book becomes local |
| "Copy to library" when file unavailable | Button disabled with tooltip |
| Remote backup with linked books | Metadata backed up, files skipped |
| Full ZIP export with linked books | Files skipped, summary note shown |
| Delete a linked book | Removes DB record only (no file to delete from library folder) |
