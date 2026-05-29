# F-2-3 Observability Primitives — Design Spec

**Status:** Approved 2026-05-29
**Feature:** F-2-3 (Observability Primitives — Structured Logging)
**Follow-on to:** F-4-8 (IPC Response Metrics Middleware)

## Goal

Wire a real logging backend into the Folio backend so existing `log::` calls
— which currently emit into the void because no subscriber is initialized —
actually produce output. Add `tracing` spans on the highest-value operations,
and route output to stderr in development and a daily-rolling file in
production.

## Problem

- `log = "0.4.29"` is a workspace dependency and `log::warn!` / `log::error!`
  are used across `src-tauri/src/commands.rs` and `src-tauri/src/lib.rs`.
- **No logger backend is initialized anywhere** — every existing `log::` call
  is silently dropped.
- Ad-hoc debugging exists only via the `FOLIO_DEBUG_PAGES=1` env var
  (`folio-core/src/page_cache.rs`).
- Silent failures are undiagnosable; perf regressions (the motivation behind
  F-4-8) cannot be correlated with operation context.

## Decisions (locked during brainstorming)

1. **Bridge + selective spans**, not full migration. Add `tracing-subscriber`
   with the `tracing-log` bridge so existing `log::` calls light up with zero
   call-site churn. Add `#[instrument]` only on key ops. Leave existing
   `log::` calls as-is.
2. **Defer `trace_id` on `FolioError`.** Rely on `tracing` spans for
   per-operation correlation. Do not touch the contract-sensitive
   `{kind, message}` serialization in `folio-core/src/error.rs`. No consumer
   exists yet (F-1 noted no user-facing dashboard).
3. **Daily-rolling file in production** via `tracing-appender`; stderr in
   development.

## Architecture

### Dependency placement

- **folio-core** (library): add `tracing` (facade only — no subscriber).
  A library emits events and spans; it must never initialize a global
  subscriber. Used for `#[instrument]` on `enrich_book`.
- **src-tauri** (binary): owns subscriber initialization.
  - New module: `src-tauri/src/observability.rs`.
  - New deps: `tracing`, `tracing-subscriber` (features `env-filter`, `fmt`,
    `tracing-log`), `tracing-appender`.

### The `tracing-log` bridge

`tracing-subscriber`'s `tracing-log` feature installs a `log` → `tracing`
bridge. All existing `log::warn!` / `log::error!` records flow into the
`tracing` subscriber. No existing `log::` call site is rewritten.

## Components

### 1. `observability.rs`

```rust
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;

/// Build the filter directive string from an optional env value.
/// Pure + unit-testable. Default level is `info`.
pub fn resolve_filter(env: Option<String>) -> String {
    match env {
        Some(s) if !s.trim().is_empty() => s,
        _ => "info".to_string(),
    }
}

/// Initialize the global tracing subscriber.
///
/// - Dev (`cfg!(debug_assertions)`): human-readable `fmt` layer to stderr.
/// - Prod: non-blocking daily-rolling file at `{log_dir}/folio.log.<date>`.
///
/// Returns a `WorkerGuard` in the file case; the caller MUST keep it alive
/// for the lifetime of the app so the non-blocking writer flushes on exit.
/// Returns `None` when logging to stderr (no guard needed).
///
/// Idempotent: a second call is a no-op (the global default is already set).
pub fn init_tracing(log_dir: Option<PathBuf>) -> Option<WorkerGuard> {
    // EnvFilter from FOLIO_LOG (falls back to "info").
    // dev  -> fmt().with_writer(std::io::stderr)
    // prod -> tracing_appender::rolling::daily(log_dir, "folio.log")
    //         wrapped in non_blocking(), fmt layer over it.
    // Use try_init() so a double-init is a harmless no-op (returns None guard).
}
```

Filter source env var: **`FOLIO_LOG`** (e.g. `FOLIO_LOG=debug`,
`FOLIO_LOG=folio_core=debug,info`). Falls back to `info`.

Rolling file prefix: **`folio.log`**; `tracing-appender` appends the date,
producing `folio.log.2026-05-29`.

### 2. `WorkerGuard` lifetime

The guard returned by `init_tracing` is stored on `AppState`:

```rust
pub struct AppState {
    // ... existing fields ...
    _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}
```

Keeping it on `AppState` ties the flush worker to app lifetime. The field is
prefixed `_` because it is never read — held only for its `Drop`.

### 3. Initialization site

`lib.rs` `setup()` closure, after the app data directory is resolved:

```rust
let log_dir = app.path().app_data_dir().ok().map(|d| d.join("logs"));
let log_guard = observability::init_tracing(log_dir);
// ... pass log_guard into AppState construction ...
```

Logs emitted before `setup()` runs are negligible (plugin registration only).

### 4. Instrumentation targets (v1)

Add `#[tracing::instrument]` to:

| Function | Location | Notes |
|----------|----------|-------|
| `import_book` | `src-tauri/src/commands.rs:503` | `skip(state)`, `fields(path)`; skip byte buffers |
| `enrich_book_from_openlibrary` | `src-tauri/src/commands.rs:2741` | `skip(state)`, `fields(book_id)` |
| `enrich_book` | `folio-core/src/enrichment.rs:145` | `skip` non-`Debug`/large args |

`skip(...)` every argument that is large or not `Debug` (`State`, byte
vectors, connection handles). Add `fields(...)` for cheap identifiers
(`book_id`, `path`). Inside each, add at least one `tracing::info!` (entry
context) and let errors surface via existing `Result` returns.

## Data flow

```
log::warn! / tracing::info! / span
        │
        ▼
  tracing registry
        │
        ▼
    EnvFilter (FOLIO_LOG, default info)
        │
        ▼
  fmt layer ──► stderr        (dev,  cfg!(debug_assertions))
            └─► rolling file  (prod, {app_data_dir}/logs/folio.log.<date>)
```

## Cleanup (in scope)

Anticipated by the F-4-8 spec ("swappable to `tracing::warn!` when F-2-3
ships"):

- `src-tauri/src/ipc_metrics.rs:57` — `eprintln!` slow-call log →
  `tracing::warn!`.
- `src-tauri/src/commands.rs` lines 1134, 1171, 1175, 1182 — `eprintln!`
  warnings → `log::warn!`.

These are the only `eprintln!` sites in the backend (5 total; the 5th is
ipc_metrics).

## Error handling

- `init_tracing` uses `try_init()` so a duplicate init never panics — it
  returns without replacing the global subscriber (idempotent).
- If `app_data_dir()` resolution fails, `log_dir` is `None`; in production
  this falls back to stderr rather than failing startup. Logging must never
  block app launch.

## Testing

| Test | Type | Asserts |
|------|------|---------|
| `resolve_filter` default | unit | `None` / empty / whitespace → `"info"` |
| `resolve_filter` honors env | unit | `Some("debug")` → `"debug"` |
| `init_tracing` idempotent | unit | second call does not panic; returns without replacing global |
| instrumented fn smoke | unit/integration | calling an instrumented op on a fixture does not panic and returns the expected `Result` |

`tracing` internals (span propagation, layer formatting) are upstream and not
re-tested here. No new test-only dependency (e.g. `tracing-test`) is added —
keep the surface minimal.

## Out of scope (YAGNI)

- `trace_id` field on `FolioError`.
- axum / `web_server` HTTP-layer spans or tower tracing middleware.
- Full `log::` → `tracing::` source migration (the bridge covers it).
- Log shipping, remote aggregation, or a user-facing log viewer.
- Removing the `FOLIO_DEBUG_PAGES` env var (orthogonal; leave as-is).

## Verification commands

```bash
# Rust
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
# folio-core (separate test binary)
cargo test -p folio-core
# Frontend unaffected, but CI gate:
npm run type-check
```
