# Design: fast skip-before-hash re-import for large remote-folder imports

> Brainstormed 2026-06-01. Backed by the investigation in
> `docs/backlog/2026-06-01-resumable-remote-import.md`.

## Problem

Re-importing a large folder (thousands of books) from a remote/network mount is
idempotent but **expensive**: dedup reads the full bytes of *every* file over the
network just to SHA-256 it and discover it is already in the library. Resuming a
5000-book remote set after an interruption re-streams all 5000 files. There is no
(path, size, mtime) fast-path, no path skip, no manifest.

## Verified current behavior (commands.rs)

- `import_book_inner` (~567): **Step 1** stats the file (`source_metadata`) for the
  size guard — so size + mtime are already in hand cheaply. **Step 3** opens the
  file and streams every byte through SHA-256, then `db::get_book_by_file_hash`;
  if present returns `ImportOutcome::Duplicate`. The full byte read is the cost.
- `run_import_task` (~4600): worker pool over a path queue; per-file `Err` logs a
  warning, increments `errors`, and continues. A true halt needs a hard failure
  (mount drop, crash, kill) or user `cancel_import`.
- `walk_folder_for_import` (~4529): top-level `read_dir`/`canonicalize` error
  bubbles up as an error event (clear diagnostic); nested unreadable dirs are
  skipped silently. So **mount-gone-at-scan is already surfaced cleanly**, not
  counted as "everything failed".
- `books` table (folio-core/src/db.rs ~101): `file_path` UNIQUE (storage key
  `{uuid}.ext` for copied books, original absolute path for linked books),
  `file_hash` with a UNIQUE index. **No size or mtime columns.** Copy mode does
  **not** store the original source path anywhere — it is lost after import.

## Chosen approach

**Option 1 only — fast skip-before-hash.** Defer Option 2 (manifest/checkpoint):
fast-skip already makes re-running the same folder a de-facto resume, and now a
cheap one; the directory walk itself does no byte reads, so re-scanning is fast
even on a remote mount. Manifest state/persistence/cleanup is not worth the
complexity (YAGNI). To resume, re-run the same folder.

### Skip semantics

On a `(source_path, size, mtime)` match: **skip with no byte read**, count as
`Duplicate`. Matching path + size + mtime is treated as "unchanged". The only way
this wrongly skips is an in-place edit that preserves *both* identical size and
mtime — near-impossible, since writes bump mtime. The content hash remains the
source of truth on every mismatch or path-miss.

## Data model

Additive migration in `folio-core/src/db.rs::run_schema` (same `ALTER TABLE … ADD
COLUMN` pattern as `file_hash`):

```sql
ALTER TABLE books ADD COLUMN source_path  TEXT;     -- literal import path string
ALTER TABLE books ADD COLUMN source_size  INTEGER;  -- bytes
ALTER TABLE books ADD COLUMN source_mtime INTEGER;  -- unix seconds
CREATE INDEX IF NOT EXISTS idx_books_source_path ON books(source_path);
```

- Recorded for **both** import modes at insert time. Copy mode previously lost the
  original path; it is now retained in `source_path` (distinct from `file_path`,
  which stays the storage key).
- `source_path` stores the **exact path string the folder walk produced** — no
  `canonicalize` (avoids an extra round trip, and re-runs of the same folder
  reproduce the identical string). Index is **non-unique** (a source could be both
  linked and copied across edge cases; never hard-fail an insert on it).
- `source_mtime` = `mtime.duration_since(UNIX_EPOCH).as_secs()` (seconds —
  robust against network-FS mtime resolution differences).
- Tied to book lifecycle: deleting a book removes the row, so no stale skips.

## Fast-path logic

New step in `import_book_inner`, **after** the Step 1 stat, **before** the Step 3
hash read. Reuses `source_metadata` (size + mtime) — **zero new round trips**:

```text
let size  = source_metadata.len();
let mtime = source_metadata.modified()? -> unix secs (best-effort; None on error)

if let Some(book) = db::get_book_by_source_path(&conn, &file_path) {
    if book.source_size == Some(size) && book.source_mtime == Some(mtime) {
        return Ok(ImportOutcome::Duplicate(book));   // skip — no byte read
    }
    // size or mtime differs -> file changed in place -> fall through to hash
}
// no source_path row (incl. legacy NULL rows, moved/renamed files) -> hash as today
```

When a file is later imported/inserted, write `source_path`, `source_size`,
`source_mtime` alongside the existing columns.

## Edge cases

- **In-place edit, identical size + mtime:** only false-skip path; accepted (writes
  bump mtime). Hash catches all other changes.
- **Moved / renamed file:** no `source_path` match → hashes → existing content
  dedup finds it. No duplicate, no wrong skip.
- **Alternate mount spelling** (`/Volumes/x` vs `/mnt/x`): path miss → hashes →
  dedups by content. Correct, just not fast. Acceptable.
- **Legacy rows (pre-migration):** `source_path` NULL → never path-match → hash
  path. Copied books have no recoverable original path, so they stay NULL until
  re-imported from source; linked books are **not** backfilled from `file_path`
  (YAGNI — they still dedup by hash, just without the fast skip on first re-run).
- **Link mode, source moved/deleted at re-run:** Step 1 stat fails → `Err` →
  counted as error (existing behavior). Mount fully gone → scan bubbles a clear
  error event (verified). No false "all skipped".
- **`modified()` unsupported / errors:** treat mtime as absent → no fast match →
  hash path. Never skip without a confirmed size+mtime match.
- **Existing `file_hash` UNIQUE index:** unchanged; remains the duplicate backstop
  for everything that reaches the hash.

## Consumers to update (grep before editing)

- `Book` struct (folio-core/src/models.rs:45) gains `source_path: Option<String>`,
  `source_size: Option<i64>`, `source_mtime: Option<i64>`. **Every `Book { … }`
  literal and every row mapper / SELECT / INSERT must be updated** — grep all
  construction sites and column lists across folio-core and src-tauri.
- New `db::get_book_by_source_path(conn, &str) -> Result<Option<Book>>`.
- Insert path(s) that create book rows must populate the three new columns.

## Testing

`cargo test -p folio-core` and `src-tauri/` `cargo test`:

- **Migration** idempotent; new columns present; `get_book_by_source_path`
  round-trips.
- **Fast skip:** create a temp file, read its real size + mtime, insert a book row
  carrying those values, re-import the same path → `Duplicate`, returning the
  existing book id, **without** a new row. (No mtime-setting needed — match the
  file's actual stat values.)
- **Changed file falls through:** insert a row with a deliberately-different
  `source_mtime` for the same path → re-import → hash path runs (identical content
  → still `Duplicate` by hash; new content → import/update).
- **Legacy NULL row:** `source_path` NULL → hash path still dedups, no panic.
- No new crate dependency (mtime read via `std::fs::Metadata::modified`).

## Out of scope

- Option 2 manifest/checkpoint (interrupted-scan resume).
- Backfilling `source_path` for existing copied/linked books.
- Any change to `run_import_task` error/continue semantics or `cancel_import`.

## Verification

Full local CI before push:
`cargo fmt --check && cargo clippy -- -D warnings && cargo test` (src-tauri/),
then `npm run type-check && npm run test` (root). MOBI untouched, but if any
shared parser code changes also run `cargo test -p folio-core --features mobi`.
