# F-2-3 Observability Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize a real `tracing` subscriber so existing `log::` calls emit, instrument key ops with spans, and route output to stderr in dev / daily-rolling file in prod.

**Architecture:** `folio-core` (library) gains the `tracing` facade for `#[instrument]` only. `src-tauri` (binary) owns subscriber init in a new `observability` module, using `tracing-subscriber` with the `tracing-log` bridge (so existing `log::` calls light up with zero churn) and `tracing-appender` for prod file rotation. The `WorkerGuard` lives on `AppState` to keep the non-blocking writer alive.

**Tech Stack:** Rust, `tracing` 0.1, `tracing-subscriber` 0.3 (`env-filter` + `tracing-log` features), `tracing-appender` 0.2, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-05-29-observability-primitives-design.md`

---

## File Structure

- `Cargo.toml` (workspace root) — add `tracing` to `[workspace.dependencies]`.
- `folio-core/Cargo.toml` — add `tracing` dependency.
- `src-tauri/Cargo.toml` — add `tracing`, `tracing-subscriber`, `tracing-appender`.
- `src-tauri/src/observability.rs` — **NEW**: `resolve_filter` + `init_tracing` + tests.
- `src-tauri/src/lib.rs` — declare `mod observability`; init subscriber in `setup()`; pass guard into `AppState`.
- `src-tauri/src/commands.rs` — add `_log_guard` field to `AppState`; instrument `import_book` + `enrich_book_from_openlibrary`; migrate 4 `eprintln!` sites.
- `src-tauri/src/ipc_metrics.rs` — migrate 1 `eprintln!` to `tracing::warn!`.
- `folio-core/src/enrichment.rs` — instrument `enrich_book`.

---

### Task 1: Add tracing dependencies

**Files:**
- Modify: `Cargo.toml` (workspace `[workspace.dependencies]`, after line 32 `log = "0.4.29"`)
- Modify: `folio-core/Cargo.toml` (`[dependencies]`)
- Modify: `src-tauri/Cargo.toml` (`[dependencies]`)

- [ ] **Step 1: Add tracing to workspace dependencies**

In `Cargo.toml`, in the `[workspace.dependencies]` block, immediately after the line `log = "0.4.29"`, add:

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "tracing-log"] }
tracing-appender = "0.2"
```

- [ ] **Step 2: Add tracing to folio-core**

In `folio-core/Cargo.toml`, in `[dependencies]`, after the `log = { workspace = true }` line (the `# page_cache.rs` group), add:

```toml
# Observability spans (#F-2-3) — facade only, no subscriber init in the library
tracing = { workspace = true }
```

- [ ] **Step 3: Add tracing crates to src-tauri**

In `src-tauri/Cargo.toml`, in `[dependencies]`, after the `folio-core = { path = "../folio-core" }` line, add:

```toml
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
tracing-appender = { workspace = true }
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds successfully (new deps downloaded, no code using them yet).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock folio-core/Cargo.toml src-tauri/Cargo.toml
git commit -m "build: add tracing, tracing-subscriber, tracing-appender deps"
```

---

### Task 2: observability module (resolve_filter + init_tracing)

**Files:**
- Create: `src-tauri/src/observability.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/observability.rs` with ONLY the test module first (so it fails to compile — functions not defined yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_filter_defaults_to_info() {
        assert_eq!(resolve_filter(None), "info");
        assert_eq!(resolve_filter(Some(String::new())), "info");
        assert_eq!(resolve_filter(Some("   ".to_string())), "info");
    }

    #[test]
    fn resolve_filter_honors_env() {
        assert_eq!(resolve_filter(Some("debug".to_string())), "debug");
        assert_eq!(
            resolve_filter(Some("folio_core=debug,info".to_string())),
            "folio_core=debug,info"
        );
    }

    #[test]
    fn init_tracing_does_not_panic_and_is_idempotent() {
        // First call may win the global default; a second call must be a
        // harmless no-op. Neither may panic. (Tests run in debug, so this
        // exercises the stderr branch and returns None.)
        let first = init_tracing(None);
        let second = init_tracing(None);
        assert!(first.is_none());
        assert!(second.is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib observability`
Expected: FAIL — `cannot find function 'resolve_filter'` / `init_tracing` not found.

- [ ] **Step 3: Write the implementation**

Prepend the implementation above the test module in `src-tauri/src/observability.rs`:

```rust
//! Tracing subscriber initialization for the Folio backend (F-2-3).
//!
//! The library crate (`folio-core`) only emits events/spans; this module —
//! living in the binary — owns the single global subscriber. The
//! `tracing-log` bridge (enabled via the `tracing-subscriber` feature) routes
//! existing `log::` records into the same subscriber, so no `log::` call site
//! needs rewriting.

use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

/// Build the env-filter directive string. Pure and unit-testable.
/// Falls back to `info` when the env value is absent or blank.
pub fn resolve_filter(env: Option<String>) -> String {
    match env {
        Some(s) if !s.trim().is_empty() => s,
        _ => "info".to_string(),
    }
}

/// Initialize the global tracing subscriber.
///
/// - Dev (`cfg!(debug_assertions)`): human-readable `fmt` layer to stderr;
///   returns `None` (no flush worker needed).
/// - Prod: non-blocking daily-rolling file at `{log_dir}/folio.log.<date>`;
///   returns the `WorkerGuard`, which the caller MUST keep alive for the
///   lifetime of the app so buffered records flush.
///
/// Uses `try_init()` so a duplicate initialization never panics — the first
/// caller wins the global default and later calls are no-ops.
pub fn init_tracing(log_dir: Option<PathBuf>) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_new(resolve_filter(std::env::var("FOLIO_LOG").ok()))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    match (cfg!(debug_assertions), log_dir) {
        (false, Some(dir)) => {
            let _ = std::fs::create_dir_all(&dir);
            let appender = tracing_appender::rolling::daily(&dir, "folio.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(appender);
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
                .try_init();
            Some(guard)
        }
        _ => {
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt::layer().with_writer(std::io::stderr))
                .try_init();
            None
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib observability`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Lint and format**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo fmt`
Expected: no warnings; formatting applied.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/observability.rs
git commit -m "feat(observability): add tracing subscriber init module"
```

---

### Task 3: Wire subscriber into app startup

**Files:**
- Modify: `src-tauri/src/lib.rs` (module decl near line 3; `setup()` near line 90; `AppState` construction near line 154)
- Modify: `src-tauri/src/commands.rs` (`AppState` struct near line 188 — after the `ipc_metrics` field)

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, in the module declaration block at the top (after `pub mod ipc_metrics;`), add:

```rust
pub mod observability;
```

- [ ] **Step 2: Add the guard field to AppState**

In `src-tauri/src/commands.rs`, inside `pub struct AppState { ... }`, immediately after the `pub ipc_metrics: IpcMetrics,` field, add:

```rust
    /// Keeps the non-blocking tracing file writer alive for the app's
    /// lifetime so buffered log records flush on shutdown. Held only for
    /// its `Drop`; never read. `None` when logging to stderr (dev).
    pub _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
```

- [ ] **Step 3: Initialize tracing in setup()**

In `src-tauri/src/lib.rs`, in the `setup()` closure, immediately after the existing line `let data_dir = app.path().app_data_dir()?;` (near line 90), add:

```rust
            // Initialize structured logging as early as the data dir allows.
            // Dev logs to stderr; prod writes a daily-rolling file under logs/.
            let log_guard = observability::init_tracing(Some(data_dir.join("logs")));
```

- [ ] **Step 4: Pass the guard into AppState**

In `src-tauri/src/lib.rs`, in the `app.manage(AppState { ... })` block, immediately after the `ipc_metrics: crate::ipc_metrics::IpcMetrics::new(500, 500.0),` line, add:

```rust
                _log_guard: log_guard,
```

- [ ] **Step 5: Verify it compiles and existing tests pass**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds and all tests pass. If the build reports another `AppState { ... }` constructor (e.g. in a test helper) missing `_log_guard`, add `_log_guard: None,` to that site.

- [ ] **Step 6: Lint and format**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo fmt`
Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(observability): init tracing at startup, hold guard on AppState"
```

---

### Task 4: Migrate eprintln! sites

**Files:**
- Modify: `src-tauri/src/ipc_metrics.rs:57`
- Modify: `src-tauri/src/commands.rs` (lines 1134, 1171, 1175, 1182)

- [ ] **Step 1: Migrate the ipc_metrics slow-call log**

In `src-tauri/src/ipc_metrics.rs`, replace line 57:

```rust
            eprintln!("[ipc-metrics] slow: {} took {:.1}ms", command, elapsed_ms);
```

with:

```rust
            tracing::warn!(command, elapsed_ms, "ipc slow call");
```

- [ ] **Step 2: Migrate the commands.rs warnings**

In `src-tauri/src/commands.rs`, the three identical lines (1171, 1175, 1182):

```rust
                eprintln!("Warning: could not delete library file '{}': {}", path, e);
```

become (preserve indentation at each site):

```rust
                log::warn!("could not delete library file '{}': {}", path, e);
```

And the multi-line `eprintln!` at line 1134 — read the exact block first:

Run: `sed -n '1130,1140p' src-tauri/src/commands.rs`

Then replace the `eprintln!(` macro call with `log::warn!(` keeping the identical format string and arguments. Do not change the message text or arguments — only the macro name.

- [ ] **Step 3: Verify no eprintln! remain in backend src**

Run: `grep -rn "eprintln!" src-tauri/src --include="*.rs"`
Expected: no output (zero matches).

- [ ] **Step 4: Build, test, lint, format**

Run: `cd src-tauri && cargo build && cargo test && cargo clippy -- -D warnings && cargo fmt`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc_metrics.rs src-tauri/src/commands.rs
git commit -m "refactor(observability): route eprintln warnings through tracing/log"
```

---

### Task 5: Instrument key operations

**Files:**
- Modify: `folio-core/src/enrichment.rs:145` (`enrich_book`)
- Modify: `src-tauri/src/commands.rs:503` (`import_book`)
- Modify: `src-tauri/src/commands.rs:2741` (`enrich_book_from_openlibrary`)

- [ ] **Step 1: Instrument folio-core enrich_book**

In `folio-core/src/enrichment.rs`, directly above `pub fn enrich_book(` (line 145), add the attribute (note `registry` is not `Debug`, so skip it):

```rust
#[tracing::instrument(skip(registry))]
```

Then, as the first statement inside the function body (before `let mut all_tried = Vec::new();`), add:

```rust
    tracing::info!("enriching book");
```

- [ ] **Step 2: Instrument import_book**

In `src-tauri/src/commands.rs`, the `import_book` command currently reads:

```rust
#[tauri::command]
pub async fn import_book(
    file_path: String,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("import_book");
```

Change it to (add the `#[tracing::instrument]` BELOW `#[tauri::command]`; skip the non-`Debug` `state` and `_app`):

```rust
#[tauri::command]
#[tracing::instrument(skip(state, _app))]
pub async fn import_book(
    file_path: String,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("import_book");
    tracing::info!("importing book");
```

- [ ] **Step 3: Instrument enrich_book_from_openlibrary**

In `src-tauri/src/commands.rs`, the command currently reads:

```rust
#[tauri::command]
pub async fn enrich_book_from_openlibrary(
    book_id: String,
    openlibrary_key: String,
    state: State<'_, AppState>,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("enrich_book_from_openlibrary");
```

Change it to:

```rust
#[tauri::command]
#[tracing::instrument(skip(state))]
pub async fn enrich_book_from_openlibrary(
    book_id: String,
    openlibrary_key: String,
    state: State<'_, AppState>,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("enrich_book_from_openlibrary");
    tracing::info!("enriching book from openlibrary");
```

- [ ] **Step 4: Build and test (smoke — instrument must not break call paths)**

Run from workspace root:

```bash
cargo test -p folio-core
cd src-tauri && cargo build && cargo test
```

Expected: all pass. The `#[tracing::instrument]` macros compile and existing tests covering these call paths still pass (no panic, same return behavior).

- [ ] **Step 5: Lint and format both crates**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check`
Run from root: `cargo clippy -p folio-core -- -D warnings`
Expected: no warnings.

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/enrichment.rs src-tauri/src/commands.rs
git commit -m "feat(observability): instrument import_book, enrich_book ops"
```

---

## Final Verification

Run the full local CI suite (per CLAUDE.md pre-push gate):

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd .. && cargo test -p folio-core
npm run type-check && npm run test
```

Expected: all green. Frontend is unaffected by this change but the type-check / test gates are part of the required pre-push suite.

Manual smoke (optional, dev): run `FOLIO_LOG=debug npm run tauri dev`, import a book, and confirm structured log lines (including the bridged `log::` warnings) appear on stderr.
