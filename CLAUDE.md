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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **folio** (2220 symbols, 5010 relationships, 192 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/folio/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/folio/context` | Codebase overview, check index freshness |
| `gitnexus://repo/folio/clusters` | All functional areas |
| `gitnexus://repo/folio/processes` | All execution flows |
| `gitnexus://repo/folio/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
