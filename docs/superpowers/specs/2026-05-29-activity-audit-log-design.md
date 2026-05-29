# F-2-2 Structured Activity Audit Log — Design Spec

**Status:** Approved 2026-05-29
**Feature:** F-2-2 (Structured Activity Audit Log with Export)

## Goal

Replace the loose, string-based `activity_log` write API with a typed
`ActivityEvent` enum in `folio-core`, eliminating hard-coded action strings
at the 27 call sites. Add a JSON export command and a user-triggerable prune
command. No database schema migration; no frontend contract change.

## Problem

- `activity_log` writes go through `log_activity(conn, action: &str,
  entity_type: &str, entity_id, entity_name, detail)` in
  `src-tauri/src/commands.rs:341`. Both `action` and `entity_type` are
  hard-coded string literals at **27 call sites** — typo-prone, no
  compile-time guarantee, no canonical list of valid events.
- No way to export the audit log (only `export_library` exists, which does
  not include activity).
- Pruning is implicit only: `db::prune_activity_log(conn, keep)` runs on every
  insert with a hard-coded 90-day cutoff. No manual, user-triggered prune.

## Decisions (locked during brainstorming)

1. **Typed enum, same columns.** `ActivityEvent` variants carry typed payload;
   a `fields()` method maps each variant to the exact existing
   `(action, entity_type, entity_id, entity_name, detail)` values. The
   `action`/`entity_type` strings are a **wire contract** with the frontend
   (`src/components/ActivityLog.tsx` keys `ACTION_ICONS`, `ACTION_LABEL_KEYS`,
   and the filter dropdown off the raw `action` string). Preserving them means
   **no schema migration and no frontend change.**
2. **JSON file export**, returning the written path (mirrors `export_library`).
3. **Manual prune by age + count** — generalize the existing db prune to take
   `max_age_days`, expose a command.
4. **Backend only.** No frontend buttons this round. (Commands are reachable
   by future UI / folio-server work; folio-server is a separate project and is
   out of scope here.)
5. **No serde derive on the enum.** Export serializes `ActivityEntry` rows, not
   the enum. The action-string contract lives in `fields()`; variant names
   (`BookImported`) would diverge from action strings (`book_imported`),
   creating a confusing second source of truth. YAGNI.
6. **Keep `detail` enrichment.** Several events build `detail` via `format!`
   (e.g. `"{format} by {author}"`). That string-building moves into the
   variant's `fields()` so current UI output is preserved byte-for-byte.

## Architecture

### New module: `folio-core/src/activity.rs`

```rust
/// Resolved columns for an activity_log row. Returned by ActivityEvent::fields.
pub struct ActivityFields {
    pub action: &'static str,
    pub entity_type: &'static str,
    pub entity_id: Option<String>,
    pub entity_name: Option<String>,
    pub detail: Option<String>,
}

/// Typed activity events. One variant per real call site action.
/// `fields()` is the single source of truth for the action/entity_type
/// wire contract consumed by src/components/ActivityLog.tsx.
pub enum ActivityEvent {
    // entity_type = "book"
    BookImported { id: String, title: String, format: String, author: String },
    BookDeleted { id: String, title: String },
    BookUpdated { id: String, title: String },
    BookEnriched { id: String, title: String },
    BookScanned { id: String, title: String },
    BookCompleted { id: String, title: String },
    BookRemovedCleanup { id: String, title: String },
    BulkEdit { count: usize },
    BulkDelete { count: usize },
    SyncPullSuccess { detail: Option<String> },
    SyncPullFailed { detail: Option<String> },
    SyncPushSuccess { detail: Option<String> },
    SyncPushFailed { detail: Option<String> },
    // entity_type = "collection"
    CollectionCreated { id: String, name: String },
    CollectionUpdated { id: String, name: String },
    CollectionDeleted { id: String, name: String },
    CollectionModified { id: String, name: String },
    // entity_type = "library"
    LibraryExported { detail: Option<String> },
    LibraryImported { detail: Option<String> },
    BackupCompleted { detail: Option<String> },
    BackupFailed { detail: Option<String> },
    // entity_type = "profile"
    ProfileSwitched { id: String, name: String },
    // entity_type = "system"
    WebServerModesChanged { detail: Option<String> },
}

impl ActivityEvent {
    pub fn fields(&self) -> ActivityFields { /* match self -> ActivityFields */ }
}
```

> **Authoritative variant list is derived from the live call sites, not this
> snippet.** Before implementation, re-enumerate every `log_activity(...)` call
> in `commands.rs` and confirm each maps to exactly one variant with the same
> `action`/`entity_type`/`entity_id`/`entity_name`/`detail` it produces today.
> Add a variant for any call site missed above. Do not invent events that have
> no call site.

### `log_event` in `commands.rs`

Replace the body of `log_activity` (or add `log_event` and route the old
signature through it) so call sites read:

```rust
log_event(&tx, ActivityEvent::BookImported {
    id: book.id.clone(),
    title: book.title.clone(),
    format: book.format.to_string(),
    author: book.author.clone(),
});
```

`log_event` resolves `fields()`, builds the `ActivityEntry` (id = new UUID,
timestamp = now), calls `db::insert_activity`, then `db::prune_activity_log`
with the existing defaults — identical side effects to today.

Migrate **all** call sites. After migration, `log_activity`'s free-string
signature is removed (no remaining caller).

### Export command

```rust
#[tauri::command]
pub async fn export_activity_log(
    dest_path: String,
    state: State<'_, AppState>,
) -> FolioResult<String>
```

- Reads all rows (no limit) via a new `db::get_all_activity` (or
  `get_activity_log` with a high limit — prefer an explicit unbounded helper to
  avoid magic numbers).
- Serializes `Vec<ActivityEntry>` to pretty JSON, writes to `dest_path`,
  returns `dest_path`.
- Mirrors `export_library`'s path-in / path-out shape.

### Prune command

Generalize the db helper:

```rust
// folio-core/src/db.rs — signature change
pub fn prune_activity_log(conn: &Connection, keep: u32, max_age_days: u32) -> Result<usize>
```

- Same DELETE, but `max_age_days` replaces the hard-coded `90`. Return the
  number of deleted rows (`conn.execute` already returns it).
- Update the auto-prune caller in `commands.rs` to pass `(1000, 90)`.
- Update the two existing prune tests for the new signature.

```rust
#[tauri::command]
pub async fn prune_activity_log(
    keep: Option<u32>,
    max_age_days: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<usize>
```

Defaults: `keep = 1000`, `max_age_days = 90`. Returns deleted-row count.

### Registration

Add `export_activity_log` and `prune_activity_log` to the `invoke_handler`
list in `src-tauri/src/lib.rs`. Declare `pub mod activity;` in
`folio-core/src/lib.rs`.

## Data flow

```
call site ── ActivityEvent::Variant{..} ──► log_event
                                               │ fields()
                                               ▼
                                         ActivityEntry ──► db::insert_activity
                                                           db::prune_activity_log(1000, 90)

export_activity_log(dest) ──► db::get_all_activity ──► serde_json ──► file ──► return path
prune_activity_log(keep, days) ──► db::prune_activity_log(keep, days) ──► deleted count
```

## Error handling

- `log_event` keeps current best-effort semantics: insert/prune errors are
  swallowed (`let _ =`) exactly as `log_activity` does today. Activity logging
  must never break the operation it records.
- `export_activity_log`: file create / write errors and serde errors surface
  as `FolioError` via `?`.
- `prune_activity_log` command: db errors surface via `?`.

## Testing

| Test | Location | Asserts |
|------|----------|---------|
| `fields()` contract | `folio-core/src/activity.rs` | table-driven over every variant: `action` + `entity_type` equal the exact legacy strings; entity_id/name/detail populated as expected |
| prune with age | `folio-core/src/db.rs` | new `max_age_days` param honored; rows newer than cutoff or within `keep` survive; returns deleted count (extend `test_activity_log_pruning` / `test_activity_log_age_pruning`) |
| export round-trip | `src-tauri` integration or db-level | insert N events, export to tempfile, parse JSON, assert N entries with matching fields |

No new test-only dependency. `tempfile` is already used for db fixtures.

## Verification commands

```bash
# Rust (folio binary)
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
# folio-core (separate test binary)
cargo test -p folio-core
# Frontend gate (unaffected, but CI runs it)
npm run type-check
```

## Out of scope (YAGNI)

- Database schema migration (columns unchanged).
- Frontend export/prune buttons.
- serde derive on `ActivityEvent`.
- folio-server canonical activity stream contract (separate project).
- Configurable retention setting / settings UI.
- New event types beyond existing call sites.
