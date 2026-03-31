# Backup Restore Picker — Design Spec

**Date:** 2026-03-31
**Roadmap item:** #11d — Backup Restore Picker

## Overview

Replace the current "Import from backup" file picker button with a unified "Restore from backup" modal that offers two restore options: selecting from auto-backups stored in the app data directory, or browsing for a manual backup file.

## Backend

### New command: `list_auto_backups`

```rust
#[tauri::command]
pub async fn list_auto_backups(state: State<'_, AppState>) -> Result<Vec<AutoBackup>, String>
```

Reads `{app_data}/backups/` directory. Parses filenames matching known prefixes (e.g., `pre-cleanup-{unix_timestamp}.zip`). Returns entries sorted newest-first.

### New type: `AutoBackup`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackup {
    pub path: String,
    pub label: String,
    pub timestamp: i64,
    pub size_bytes: u64,
}
```

- `path`: absolute path to the zip file
- `label`: human-readable type, parsed from filename prefix (e.g., "Pre-cleanup")
- `timestamp`: unix timestamp parsed from filename
- `size_bytes`: file size from `fs::metadata`

Unknown files in the backups directory are ignored. Only files matching known prefix patterns are returned.

### Restore

No new restore command needed. The existing `import_library_backup` command accepts an `archive_path` and works for both auto-backups and manual files.

## Frontend

### UI changes in SettingsPanel

The current "Import from backup" button in the Backup & Restore accordion is replaced with "Restore from backup". Clicking it opens a modal.

### Restore modal

**Auto-backups section:**
- Fetches `list_auto_backups` on modal open
- If backups exist: scrollable list (max-height ~200px), each entry showing:
  - Label + formatted date (e.g., "Pre-cleanup — Mar 31, 2026 4:30 PM")
  - File size (e.g., "12 KB")
  - "Restore" button
- If no backups exist: "No automatic backups yet."

**From file section:**
- "Choose file..." button opens the existing file picker for `.zip` files

**Restore flow (shared by both paths):**
1. User selects an auto-backup or picks a file
2. Confirmation dialog: "This will import books and metadata from the backup. Existing data will not be deleted. Continue?"
3. Calls `import_library_backup` with the selected path
4. Shows result using existing `settings.importedBooks` key ("Imported N books from backup.")
5. Dismiss

Date formatting uses the browser's `Intl.DateTimeFormat` for locale-aware display.

## Internationalization

New keys in EN + FR:

- Restore button label (replaces "Import from backup")
- Modal title ("Restore from Backup")
- "Automatic backups" section heading
- "No automatic backups yet." empty state
- "From file" section heading
- "Choose file..." button label
- Restore confirmation message

The existing `settings.importedBooks` and `settings.importFailed` keys are reused for result/error messages.

## Scope Boundaries

- No deletion of old auto-backups (future feature if needed)
- No preview of backup contents (future feature)
- `import_library_backup` merges data — it does not wipe the existing library
- Only files matching known filename prefixes appear in the auto-backup list
