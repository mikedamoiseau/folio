# F-3-6 GDPR Data Export Endpoint — Design

**Status:** Approved (2026-05-30)

**Goal:** Provide an authenticated web endpoint that returns a timestamped ZIP
archive of the user's personal data: books metadata, reading progress,
bookmarks, highlights, activity log, and redacted settings.

## Background

The desktop app already exports library data via the `export_library` Tauri
command (`src-tauri/src/commands.rs:3593`), which gathers metadata into a JSON
object and writes a ZIP to a destination path. The embedded web server
(`src-tauri/src/web_server/`) has no equivalent endpoint.

GDPR data portability concerns the user's *personal* data. The export therefore
adds two fields the desktop export omits — `activity_log` and `settings` — while
never leaking credentials.

**Credential storage (verified):**
- The web PIN is stored in the OS keyring (`web_server/auth.rs`,
  `KEYRING_USER = "pin"`), **not** in the settings table.
- Backup secrets are stored in the OS keyring; `save_backup_config`
  (`commands.rs:3980`) persists only the secret-stripped ("clean") config to the
  `backup_config` setting.

So the settings table carries no live credentials. Redacting `backup_config`
is defense-in-depth (it holds remote endpoint/username, and pre-keyring DBs may
retain older secret-laden values).

## Scope

- **In:** Web endpoint only. No desktop command, no UI button (matches the
  backend-only pattern used for F-3-1).
- **Out:** Book content files (this is a personal-data export, not a full
  backup). Frontend changes.

## Architecture

Three layers.

### 1. Shared core builder — `folio-core/src/db.rs`

```rust
/// Build the common export metadata object shared by the desktop library
/// export and the web GDPR export. Contains: version, books, reading_progress,
/// bookmarks, highlights, collections, tags, book_tags.
pub fn build_core_export(conn: &Connection) -> Result<serde_json::Value>
```

- Extracts the gather-into-JSON logic currently inline in `export_library`
  (`commands.rs:3632`).
- `export_library` is refactored to call `build_core_export` for the metadata
  object, then continues to add book/cover files to the ZIP as today. Its output
  is **unchanged** (no `import_library_backup` round-trip risk).

```rust
/// Return all rows of the settings table as (key, value) pairs.
pub fn list_settings(conn: &Connection) -> Result<Vec<(String, String)>>
```

- New function; today only `get_setting(key)` exists.

### 2. GDPR export builder — web side

A helper (in `web_server/api.rs`, or a small `web_server` helper module if it
reads cleaner) that:

1. Calls `db::build_core_export(conn)` to get the core object.
2. Adds `activity_log`: `db::get_activity_log(conn, 100_000, 0, None)`.
3. Adds `settings`: a JSON object built from `db::list_settings(conn)`, with
   the redaction denylist applied.

**Redaction denylist:** `["backup_config", "enrichment_providers"]`. Keys in the
denylist are omitted from the exported `settings` object; all other settings are
exported verbatim. `enrichment_providers` stores per-provider config including
plaintext API keys in the settings table (unlike the web PIN and backup
credentials, which live in the OS keyring), so it must be redacted too.

### 3. Web endpoint — `web_server/api.rs`

- Route: `GET /api/data-export`, handler `data_export`.
- Registered in `routes()` (`api.rs:15`). **Not** added to the auth-middleware
  allowlist (`auth.rs:287`, currently `/api/auth` + `/api/health`), so the
  endpoint requires an authenticated session.
- Handler steps:
  1. `let conn = state.conn().map_err(folio_status)?;`
  2. Build the export `serde_json::Value` (layer 2).
  3. `serde_json::to_string_pretty` the value.
  4. Zip in-memory: `zip::ZipWriter::new(std::io::Cursor::new(Vec::new()))`,
     one entry `folio-export-YYYYMMDD.json` (Deflated), finish → `Vec<u8>`.
  5. Best-effort activity log:
     `ActivityEvent::LibraryExported { detail: "GDPR data export (web)" }`
     via the same `into_fields` → DB insert path the desktop uses. A logging
     failure is swallowed (`tracing::warn!`) and never fails the response —
     mirrors the F-3-1 login-audit best-effort pattern.
  6. Return the ZIP bytes with headers:
     - `Content-Type: application/zip`
     - `Content-Disposition: attachment; filename="folio-export-YYYYMMDD.zip"`

The date stamp is computed once (UTC `YYYYMMDD`) and used for both the inner
JSON filename and the outer ZIP filename.

## Data Flow

```
GET /api/data-export
  → auth_middleware (session required)
  → data_export handler
      → build_core_export(conn)              # books, progress, bookmarks, …
      → + get_activity_log(conn, …)          # activity_log
      → + list_settings(conn) - denylist     # settings (redacted)
      → JSON pretty-print → in-memory ZIP
      → log LibraryExported (best-effort)
  ← 200 application/zip  (folio-export-YYYYMMDD.zip)
```

## Error Handling

- DB / connection errors → `folio_status` → HTTP 500.
- Activity log read is capped at 100_000 rows (offset 0, no filter).
- Activity-log *write* for the export is best-effort: failure is logged via
  `tracing::warn!` and never propagated to the HTTP response.

## Testing

**folio-core (`db.rs`):**
- `build_core_export` returns an object containing the expected keys
  (`version`, `books`, `reading_progress`, `bookmarks`, `highlights`,
  `collections`, `tags`, `book_tags`).
- `list_settings` round-trips inserted settings.

**web (`api.rs`):**
- Redaction: an export built with a `backup_config` setting present omits
  `backup_config` from the `settings` object; a non-secret setting is retained.
- `GET /api/data-export` with a valid session → 200, `Content-Type:
  application/zip`, `Content-Disposition` attachment filename matches
  `folio-export-YYYYMMDD.zip`.
- The ZIP contains a single entry whose bytes parse as JSON and include the
  `activity_log` and `settings` sections.
- `GET /api/data-export` without authentication → 401.

## Decisions

- **HTTP method:** `GET` (not the report's `POST`). The export is an idempotent
  read; GET works as a plain browser link with the session cookie and needs no
  request body.
- **Settings:** included, with `backup_config` redacted.
- **Format:** timestamped ZIP wrapping a single JSON document.
- **Code reuse:** shared `build_core_export` consumed by both desktop export and
  the web endpoint.
- **Scope:** web endpoint only.
