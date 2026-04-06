# Multi-Device Progress Sync — Design Spec

## Objective

Implement lightweight multi-device sync for reading progress, bookmarks, and highlights by reusing the existing remote backup provider configuration and OpenDAL transport layer.

This is a **local-first** feature with **remote state sync**. It works as a background feature for users who already configured remote backup, without syncing book files.

---

## Sync File Format

Remote path: `.folio-sync/books/{file_hash}.json`

```json
{
  "schema_version": 1,
  "book_hash": "abc123...",
  "device_id": "uuid-v4",
  "progress": {
    "chapter_index": 5,
    "scroll_position": 0.42,
    "updated_at": 1743763800
  },
  "bookmarks": [
    {
      "id": "uuid-1",
      "chapter_index": 3,
      "scroll_position": 0.65,
      "name": "My bookmark",
      "note": null,
      "created_at": 1743505200,
      "updated_at": 1743763800,
      "deleted_at": null
    }
  ],
  "highlights": [
    {
      "id": "uuid-2",
      "chapter_index": 2,
      "start_offset": 120,
      "end_offset": 200,
      "text": "The quoted text",
      "color": "#f6c445",
      "note": "Interesting point",
      "created_at": 1743501600,
      "updated_at": 1743765300,
      "deleted_at": null
    }
  ]
}
```

### Rules

- All timestamps are `i64` Unix seconds.
- `deleted_at` is nullable — `null` means active, non-null means soft-deleted.
- `book_id` is intentionally absent from sync items — it is device-local and resolved via `file_hash` lookup.
- `device_id` at top-level is useful for debugging and tracing, not used as merge authority.
- `updated_at` is the sole merge authority for progress and per-item bookmark/highlight conflict resolution.
- Unknown fields should be ignored when parsing future schema-compatible payloads.
- `schema_version` is checked on read. If the remote file has a `schema_version` higher than what this client understands, the file is treated as unreadable (same as malformed) and sync is skipped for that book. This allows future format evolution without breaking older clients.
- All formats (EPUB, PDF, CBZ, CBR) use the same `chapter_index` + `scroll_position` model uniformly. PDF and comic formats treat each page as a chapter.

---

## Data Model Changes

### Database migration

Minimal — most columns already exist:

- **Bookmarks**: Add `deleted_at INTEGER` column (nullable). `created_at` and `updated_at` already exist.
- **Highlights**: Add `deleted_at INTEGER` column (nullable). `created_at` and `updated_at` already exist.
- **Reading progress**: `last_read_at` already serves as the update timestamp. No schema change needed.
- **Settings**: No schema change needed (existing key-value table).

### Backfill

For existing rows where `updated_at` is unset:

```sql
UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;
UPDATE highlights SET updated_at = created_at WHERE updated_at = 0;
```

### Rust struct changes

Add `updated_at: i64` and `deleted_at: Option<i64>` to both `Bookmark` and `Highlight` structs in `models.rs`. All queries that read bookmarks/highlights must include these columns.

### Book lookup by file hash

`get_book_by_file_hash(conn, file_hash) -> Option<Book>` already exists in `db.rs`. No new function needed for resolving sync files to local books.

### Device identity

Reuse the same device identity model already introduced by backup, but persist and read it locally first.

`get_or_create_device_id()`:
- Reads `device_id` from local settings if present.
- Otherwise generates a UUID v4 and stores it locally.
- This same local `device_id` is used consistently when writing backup manifests and sync payloads.

Device identity never depends on a remote read. Startup and book-open work offline. The remote manifest may contain the same device ID, but local settings is the runtime authority.

### Settings

Two relevant settings (both key-value in existing settings table):

- `device_id` — auto-generated, not user-facing.
- `sync_enabled` — explicit user toggle, separate from backup. Default: `false` (opt-in). If the key is absent from the settings table, treat as `false`.

---

## Mutation Timestamp Discipline

`updated_at` is part of sync correctness, not just metadata. Every bookmark/highlight mutation must set it to current Unix seconds, with no exceptions.

| Operation | `created_at` | `updated_at` | `deleted_at` |
|-----------|-------------|-------------|-------------|
| Create | now | now | null |
| Edit (name, note) | unchanged | now | unchanged |
| Soft delete | unchanged | now | now |
| Restore (future) | unchanged | now | null |

### What changes in existing code

Currently:
- `add_bookmark` sets `created_at = now` but `updated_at` stays 0.
- `add_highlight` sets `created_at = now` but `updated_at` stays 0.
- `update_bookmark_name` bumps `updated_at` (already correct).
- `update_highlight_note` bumps `updated_at` (already correct).
- `remove_bookmark` / `remove_highlight` hard-delete rows.

Needs to change:
- Create operations: set `updated_at = created_at` at insert time.
- Delete operations: become soft deletes (`deleted_at = now`, `updated_at = now`).
- All UI-facing read queries: add `WHERE deleted_at IS NULL`.
- Sync/export queries: include soft-deleted rows.

### Out of scope

Highlight color edits — no command exists today. Not adding one as part of sync. If added later, it must follow the same timestamp rule.

---

## Sync Engine

### Module

New file: `src-tauri/src/sync.rs`

### Structs

Serializable sync-specific structs (separate from DB model structs to keep sync serialization isolated):

```rust
struct SyncProgress {
    chapter_index: u32,
    scroll_position: f64,
    updated_at: i64,
}

struct SyncBookmark {
    id: String,
    chapter_index: u32,
    scroll_position: f64,
    name: Option<String>,
    note: Option<String>,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

struct SyncHighlight {
    id: String,
    chapter_index: u32,
    start_offset: u32,
    end_offset: u32,
    text: String,
    color: String,
    note: Option<String>,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

struct BookSyncFile {
    schema_version: u32,
    book_hash: String,
    device_id: String,
    progress: Option<SyncProgress>,
    bookmarks: Vec<SyncBookmark>,
    highlights: Vec<SyncHighlight>,
}
```

### Error types

```rust
enum SyncError {
    Transport(String),
    Timeout,
    Malformed(String),
}
```

### Core functions

**Build payload from local state:**
`build_sync_payload(conn, book_id, file_hash, device_id) -> BookSyncFile`
- Queries all bookmarks for book (including soft-deleted).
- Queries all highlights for book (including soft-deleted).
- Queries reading progress.
- Assembles into `BookSyncFile`.

**Fetch remote sync file:**
`fetch_remote_sync(operator, file_hash) -> Result<Option<BookSyncFile>, SyncError>`
- `Ok(None)` — file absent (harmless).
- `Ok(Some(...))` — valid sync file.
- `Err(...)` — transport, timeout, or malformed data (loggable).

**Push sync file:**
`push_remote_sync(operator, file_hash, payload: &BookSyncFile) -> Result<(), SyncError>`

**Merge remote into local:**
`merge_remote_into_local(conn, book_id, local: &BookSyncFile, remote: &BookSyncFile) -> MergeResult`

### Merge rules

- **Progress:** Compare `updated_at`. Remote newer -> apply. Local newer -> keep. Equal timestamps + different content -> prefer remote for convergence. Equal timestamps + identical content -> skip (no-op).
- **Bookmarks:** Per-item by `id`. Only one side exists -> keep. Both sides -> newer `updated_at` wins. Equal timestamps + different payloads -> prefer remote for convergence. Equal timestamps + identical payloads -> skip (no-op).
- **Highlights:** Same rules as bookmarks.

These tie-break rules must be documented in code comments. The "prefer remote on equal timestamps" rule is a deterministic convergence choice, not a correctness guarantee.

`MergeResult` tracks what changed (counts of items updated, progress changed, etc.) for activity logging.

### Orchestration helpers

`sync_book_on_open(book_id)` and `sync_book_on_close(book_id)` should be thin orchestration helpers responsible for guard checks, timeout handling, and logging, while keeping merge/build logic in `sync.rs`.

### Pull-on-open strategy

Non-blocking. The reader opens immediately with local data. Sync pull runs concurrently:

1. Reader mount calls `get_reading_progress` and loads local bookmarks/highlights as it does today.
2. A separate async task fires `sync_book_on_open(book_id)` with a **5-second timeout** on the remote fetch.
3. If remote data arrives and merge produces changes:
   - Progress change: emit a `sync-progress-updated` Tauri event. The frontend applies it only if no local navigation or scroll interaction has occurred since mount — otherwise the remote progress update is ignored for that session.
   - Bookmark/highlight changes: applied to DB, emit a `sync-applied` Tauri event so the frontend can refresh.
4. If timeout or error: log to activity log, continue with local data.

The reader never waits for sync. Sync results arrive opportunistically.

### Push-on-close strategy

Fire-and-forget via background thread:

1. Reader unmount calls `save_reading_progress` (existing behavior).
2. After local save completes, spawns background thread: pull remote -> merge into local DB -> rebuild payload from merged state -> push to remote.
3. The pull-merge step before pushing ensures remote-only changes from other devices are preserved. Without it, a blind push would overwrite remote annotations that arrived while the reader was open, defeating per-entity convergence.
4. Push failures logged to activity log.
5. No retry queue in v1 — next book open/close will naturally re-sync.

A push can still be lost if the app exits during the in-flight background write. This is an accepted v1 limitation.

### Entry point guards

Every sync entry point checks both conditions before doing any work:

1. Remote backup provider is configured.
2. `sync_enabled == true`.

If either is false, sync is skipped silently. No error, no log.

---

## Soft Delete Behavior in Commands

### Delete operations become soft deletes

`remove_bookmark` changes from `DELETE FROM` to:

```sql
UPDATE bookmarks
SET deleted_at = ?1, updated_at = ?1
WHERE id = ?2 AND deleted_at IS NULL
```

`remove_highlight` — same pattern. Idempotent: repeated deletes on already-deleted rows are harmless.

Both return `Ok(())` as they do today.

### Read queries exclude soft-deleted rows

All UI-facing queries add `WHERE deleted_at IS NULL`:

- `get_bookmarks(book_id)`
- `get_highlights(book_id)`
- `get_chapter_highlights(book_id, chapter_index)`

### Sync queries include soft-deleted rows

`build_sync_payload` queries all rows regardless of `deleted_at` status. The sync file must contain tombstones so deletions propagate across devices.

### Backup queries unchanged

Backup export/restore semantics are a separate decision from sync. For v1, backup queries remain unchanged — they continue to export only active (non-deleted) rows. If a future version wants sync-aware backup, that is a deliberate product decision, not an automatic side-effect of adding soft delete.

### Book deletion cascade

When a book is deleted locally, FK cascade (`ON DELETE CASCADE`) hard-deletes its local bookmarks/highlights/progress. This is acceptable for v1 because book-file sync and cross-device book deletion semantics are out of scope.

### No restore/undelete in v1

The data model supports it (`deleted_at = NULL`, `updated_at = now`), but no UI or command is added.

---

## Settings UI

### Location

New toggle inside the existing "Remote Backup" section of `SettingsPanel.tsx`.

### Visibility rule

The sync toggle is always visible in the backup section. When no remote backup provider is configured, the toggle is **disabled** with helper text: "Configure a remote backup destination to enable sync."

### Label and description

**Toggle label:** "Sync reading progress across devices"

**Description text:** "Syncs reading progress, bookmarks, and highlights across devices using your configured remote backup destination. Does not sync book files."

### Behavior

- Toggle maps to `sync_enabled` setting in the backend key-value store.
- Default value: `false` (opt-in).
- If the `sync_enabled` key is absent from settings, treat as `false`.
- Changing the toggle calls `invoke("set_setting_value", { key: "sync_enabled", value: "true" | "false" })`.

### Sync status display

When `sync_enabled` is true, show beneath the toggle:

- **Success:** `Last successful sync: 2026-04-04 17:24`
- **Error more recent than last success:** Also show `Last sync error: timeout after 5s`
- **Never synced + error:** Show both `No successful sync yet` and `Last sync error: ...`
- **Never synced, no error:** `No successful sync yet`

Display rule: show the error line only if `last_sync_error_at > last_sync_success_at`.

"Successful sync" means any pull or push that completes without error, regardless of whether data changed. This answers "is sync functioning?", not "did data mutate?".

### Diagnostic settings keys

- `last_sync_success_at` (i64 Unix seconds)
- `last_sync_error_at` (i64 Unix seconds)
- `last_sync_error_message` (string)

These are display-only diagnostics. The activity log remains the detailed trace.

---

## Activity Log Integration

### New action types

| Action | Entity Type | When |
|--------|------------|------|
| `sync_pull_success` | `book` | Pull completed and merge applied at least one local change |
| `sync_pull_failed` | `book` | Remote fetch failed (timeout, transport, malformed) |
| `sync_push_success` | `book` | Push completed successfully |
| `sync_push_failed` | `book` | Push to remote failed |

### Fields per entry

Following the existing `ActivityEntry` shape:

- `entity_id` = `book_id` (local)
- `entity_name` = book title
- `detail` = short context string

### Error detail mapping

- `SyncError::Timeout` -> `"timeout after 5s"`
- `SyncError::Transport(msg)` -> `"transport error: {msg}"` (truncated to ~200 chars)
- `SyncError::Malformed(msg)` -> `"malformed remote data: {msg}"`

### Logging rules

- `sync_pull_success`: Only logged when merge actually applied at least one local change. No-op pulls are silent.
- `sync_push_success`: Logged on every successful push for v1 auditability.
- `sync_pull_failed` / `sync_push_failed`: Always logged.
- One entry per completed pull/push attempt, not per merged item.

The existing activity log prune (`max 1000 entries`) applies. Sync entries count toward that limit.

Note: if `sync_push_success` proves too noisy during testing (frequent open/close cycles filling the log), it is the first candidate to suppress or downgrade. This is a calibration decision, not a design change.

---

## Out of Scope for v1

- Syncing book files
- Conflict resolution UI
- Scheduled background sync while reading
- Deletion tombstone cleanup/GC
- Multi-user collaborative semantics
- Highlight color edit command
- Restore/undelete command
- Per-book sync toggle
- Manual "sync now" button
- Sync status indicator in reader header
- Retry queue for failed pushes
- Sync-aware backup/restore semantics

---

## Files Expected to Change

- `src-tauri/src/db.rs` — migration, backfill, soft-delete queries, sync-inclusive queries
- `src-tauri/src/models.rs` — add `updated_at`/`deleted_at` to Bookmark and Highlight structs
- `src-tauri/src/commands.rs` — soft-delete commands, sync entry points, setting helpers. Sync business logic (merge, build, fetch) stays in `sync.rs`; `commands.rs` only wires up the Tauri command surface.
- `src-tauri/src/sync.rs` (new) — sync structs, engine, merge logic, orchestration
- `src-tauri/src/lib.rs` — register new commands
- `src/components/SettingsPanel.tsx` — sync toggle + status display
- `src/screens/Reader.tsx` — listen for `sync-applied` and `sync-progress-updated` events
