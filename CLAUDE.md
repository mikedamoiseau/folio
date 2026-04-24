# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install                  # Install frontend dependencies
npm run tauri dev            # Full dev environment (Rust + React with HMR on port 1420)
npm run tauri build          # Production build for current platform
npm run type-check           # TypeScript type checking only
npm run build                # Frontend build (type-check + Vite)
```

Rust-only commands (run from `src-tauri/`):
```bash
cargo test                   # Run Rust unit tests
cargo clippy -- -D warnings  # Lint Rust code (CI-enforced)
cargo fmt --check            # Check Rust formatting (CI-enforced)
```

Frontend tests (run from project root):
```bash
npm run test                 # Run Vitest (once)
npm run test:watch           # Run Vitest (watch mode)
```

Rust tests use `tempfile` for DB fixtures. Frontend pure logic lives in `src/lib/utils.ts` for testability.

MOBI tests require a public-domain test corpus under `src-tauri/test-fixtures/` (gitignored). Populate once with `./scripts/fetch-mobi-test-corpus.sh`. Fixture-gated tests skip with a clear message when fixtures are absent, so fresh clones stay green without the corpus.

## Architecture

**Tauri v2 desktop app** (branded "Folio") — Rust backend + React 19 frontend communicating via IPC. Frontend uses Tailwind CSS v4, react-router-dom for routing, and DOMPurify for HTML sanitization.

### Frontend → Backend Communication

All data flows through Tauri's `invoke()` IPC bridge:

```typescript
// Frontend
const books = await invoke<Book[]>("get_library");
```

```rust
// Backend (src-tauri/src/commands.rs)
#[tauri::command]
pub async fn get_library(state: State<'_, AppState>) -> Result<Vec<Book>, String>
```

Commands are registered in `src-tauri/src/lib.rs` via `invoke_handler`. Every new command must be added there.

### Backend Layers

- **commands.rs** — Tauri command handlers (the API surface). Route to format-specific parsers and DB functions.
- **db.rs** — All SQLite CRUD operations. Functions receive `&Connection` from an r2d2 pool, never manage connection lifecycle.
- **models.rs** — Shared structs: `Book`, `ReadingProgress`, `Bookmark`, `Collection`, etc.
- **epub.rs / pdf.rs / cbz.rs / cbr.rs** — Format-specific parsing. Each extracts metadata, content, and cover images.

### Frontend Layers

- **screens/** — `Library.tsx` (book grid, collections, import) and `Reader.tsx` (reading view for all formats).
- **components/** — Reusable UI: `BookCard`, `CollectionsSidebar`, `SettingsPanel`, `ImportButton`, etc.
- **context/ThemeContext.tsx** — Light/dark mode, font size, font family. Persisted to localStorage.

### State Management

- **Frontend:** React hooks + Context (ThemeContext). No external state library.
- **Backend:** `AppState` holds a `DbPool` (r2d2 connection pool to SQLite).
- **Database:** SQLite at the platform app data directory (`library.db`). Schema auto-migrates on startup via `db.rs::run_schema()`.

### Book Storage

Books are copied into an app-managed library folder (default `~/Documents/folio/`). The `file_path` in the DB points to the library-internal copy. Covers are extracted to `{app_data_dir}/covers/{book_id}/`.

## Adding Common Things

**New Tauri command:** Define in `commands.rs` → register in `lib.rs` `invoke_handler` → call via `invoke()` in React.

**New book format:** Create module (e.g., `mobi.rs`) → add `BookFormat` enum variant in `models.rs` → add match arm in `import_book` in `commands.rs`.

**Database schema change:** Add migration SQL to `db.rs::run_schema()` (additive — use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` patterns).

## Format Support

| Format | Parser | Content Type |
|--------|--------|-------------|
| EPUB | zip + quick-xml + ammonia | Sanitized HTML chapters |
| PDF | pdfium-render | Base64-encoded page images |
| CBZ | zip | Sorted image files |
| CBR | unrar | Sorted image files |

PDF support requires pdfium binaries bundled in `src-tauri/resources/`. The `scripts/download-pdfium.sh` script fetches them. Run `./scripts/download-pdfium.sh` before first `npm run tauri dev` — PDF import/rendering won't work without it.

### macOS Tahoe C++ Header Fix

On macOS Tahoe (26.x), the Xcode Command Line Tools have a broken C++ header search path — clang can't find `<new>` and other standard headers, which breaks compilation of `unrar_sys` (and potentially other native crates). The fix is:

```bash
export CPLUS_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1"
```

This is added to Mike's `~/.zshrc`. If builds fail with `fatal error: 'new' file not found`, ensure this env var is set.

## Coding Principles

**Think first.** State assumptions before coding. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so. If something is unclear, stop and ask.

**Simplicity over cleverness.** Write the minimum code that solves the problem. No speculative features, no abstractions for single-use code, no "just in case" error handling. If 200 lines could be 50, rewrite it.

**Surgical changes only.** Every changed line should trace directly to what was asked. Don't improve adjacent code, comments, or formatting. Don't refactor things that aren't broken. Match existing style. If you notice unrelated issues, mention them — don't fix them silently.

**Verify before claiming done.** Transform tasks into verifiable goals: "fix the bug" means write a test that reproduces it, then make it pass. Run the actual commands (`cargo test`, `npm run test`, `npm run type-check`) and confirm output before saying something works. Evidence before assertions.

## Security

- EPUB HTML is sanitized server-side (ammonia) and client-side (DOMPurify)
- CSP configured in `tauri.conf.json`
- Asset protocol scoped to `$APPDATA/**`
- File deduplication uses SHA-256 hash (`file_hash` column in `books` table)

## CI

GitHub Actions runs on push to main and PRs:
- `cargo clippy -- -D warnings`, `cargo fmt --check`, `cargo test` (Ubuntu)
- `npm run type-check`
- Pdfium binaries downloaded from `bblanchon/pdfium-binaries` in CI
- Release workflow (`release.yml`) builds platform binaries on tag push

**Before pushing:** Always run the full CI check suite locally. A pre-push git hook enforces this:
`cargo fmt --check && cargo clippy -- -D warnings && cargo test` (in `src-tauri/`) then `npm run type-check && npm run test` (in root).
