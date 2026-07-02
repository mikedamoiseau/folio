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
```

Lint and formatting are checked workspace-wide from the repo root (CI-enforced). Running them scoped to `src-tauri/` only covers the `folio` crate, not `folio-core`; omitting `--all-targets` skips test/example targets:
```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --workspace --all-targets --features mobi -- -D warnings  # libmobi-gated paths
cargo fmt --all --check
```

The toolchain is pinned in `rust-toolchain.toml` (currently `1.96.0`); CI uses the same version via `dtolnay/rust-toolchain@1.96.0`, so local and CI rustfmt/clippy never drift. Bump both together.

Running `cargo test` from `src-tauri/` only exercises the `folio` crate — `folio-core` has its own test binary that is not compiled by that invocation. For MOBI changes always also run (from the workspace root):
```bash
cargo test -p folio-core --features mobi
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
pub async fn get_library(state: State<'_, AppState>) -> FolioResult<Vec<Book>>
```

Commands are registered in `src-tauri/src/lib.rs` via `invoke_handler`. Every new command must be added there.

### Backend Layers

The backend is two crates: **`folio`** (`src-tauri/src/`) — the Tauri shell, IPC commands, and web server — and **`folio-core`** (`folio-core/src/`) — parsing, DB, and models, with no Tauri dependency.

- **commands.rs** (`src-tauri/src/`) — Tauri command handlers (the API surface). Route to format-specific parsers and DB functions.
- **lib.rs** (`src-tauri/src/`) — App setup; registers commands in `invoke_handler`.
- **db.rs** (`folio-core/src/`) — All SQLite CRUD operations. Functions receive `&Connection` from an r2d2 pool, never manage connection lifecycle.
- **models.rs** (`folio-core/src/`) — Shared structs: `Book`, `ReadingProgress`, `Bookmark`, `Collection`, `BookFormat`, etc.
- **epub.rs / pdf.rs / cbz.rs / cbr.rs / mobi/** (`folio-core/src/`) — Format-specific parsing. Each extracts metadata, content, and cover images.

### Frontend Layers

- **screens/** — `Library.tsx` (book grid, collections, import) and `Reader.tsx` (reading view for all formats).
- **components/** — Reusable UI: `BookCard`, `CollectionsSidebar`, `SettingsPanel`, `ImportButton`, etc.
- **context/ThemeContext.tsx** — Light/dark mode, font size, font family. Persisted to localStorage.

### State Management

- **Frontend:** React hooks + Context (ThemeContext). No external state library.
- **Backend:** `AppState` holds a `DbPool` (r2d2 connection pool to SQLite).
- **Database:** SQLite at the platform app data directory (`library.db`). Schema auto-migrates on startup via `folio-core/src/db.rs::run_schema()`.

### Book Storage

Books are copied into an app-managed library folder (default `~/Documents/folio/`). The `file_path` in the DB points to the library-internal copy. Covers are extracted to `{app_data_dir}/covers/{book_id}/`.

## Adding Common Things

**New Tauri command:** Define in `src-tauri/src/commands.rs` (return `FolioResult<T>`) → register in `src-tauri/src/lib.rs` `invoke_handler` → call via `invoke()` in React.

**New book format:** Create module in `folio-core/src/` (e.g., `fb2.rs`; declare it in `folio-core/src/lib.rs`) → add `BookFormat` enum variant in `folio-core/src/models.rs` → add extension + match arms in `import_book` in `src-tauri/src/commands.rs` → list the extension in `supported_import_extensions()`.

**Database schema change:** Add migration SQL to `folio-core/src/db.rs::run_schema()` (additive — use `CREATE TABLE IF NOT EXISTS` / guarded `ALTER TABLE` patterns).

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
- `cargo clippy --workspace --all-targets -- -D warnings` (+ `--features mobi`), `cargo fmt --all --check`, `cargo test` (Ubuntu)
- `npm run type-check`
- Pdfium binaries downloaded from `bblanchon/pdfium-binaries` in CI
- Release workflow (`release.yml`) builds platform binaries on tag push

**Before pushing:** Always run the full CI check suite locally. A pre-push git hook enforces this:
`cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` (from repo root — both cover folio-core), then `cargo test` (in `src-tauri/`), then `npm run type-check && npm run test` (in root). When touching MOBI code also run `cargo test -p folio-core --features mobi` from the workspace root — `src-tauri/`'s `cargo test` does not compile folio-core's test binary.
