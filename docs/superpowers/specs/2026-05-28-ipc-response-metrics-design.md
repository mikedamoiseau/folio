# F-4-8: IPC Response Metrics Middleware

**Date:** 2026-05-28
**Status:** Design approved
**Research ID:** F-4-8

## Goal

Add lightweight per-command timing to Tauri IPC calls so slow commands are visible, diagnosable, and measurable — replacing guesswork with data.

## Current State

- 121 `#[tauri::command]` functions in `commands.rs` (6687 lines)
- No timing, middleware, or metrics infrastructure
- No structured logging — a few `eprintln` warnings only
- `AppState` holds DB pool, caches, enrichment registry, web server handle
- Manual debug via `FOLIO_DEBUG_PAGES` env var for page content only

## Approach

Standalone `ipc_metrics.rs` module with drop-guard timer pattern. Commands opt in incrementally by adding a one-liner at the top. Ring buffer in `AppState` stores the last 500 entries. A debug command exposes the buffer with per-command aggregates.

### Why this approach

- **Standalone module** keeps `commands.rs` growth in check (already 6687 lines)
- **Drop-guard** is idiomatic Rust — timing is automatic, works with early returns and `?` operator
- **Incremental opt-in** avoids a 121-command diff — start with ~15 hottest commands
- **No external deps** — uses only `std::time`, `std::collections::VecDeque`, `std::sync::Mutex`
- **eprintln for slow calls** matches existing codebase pattern; swappable to `tracing::warn!` when F-2-3 ships

## Data Model

### MetricEntry

```rust
#[derive(Clone, serde::Serialize)]
pub struct MetricEntry {
    pub command: &'static str,
    pub elapsed_ms: f64,
    pub timestamp: i64,  // Unix epoch milliseconds
    pub success: bool,
}
```

### Ring Buffer

`VecDeque<MetricEntry>` with 500-entry capacity. Oldest entries evicted on overflow via `pop_front()`. Protected by a single `Mutex`.

### CommandSummary (aggregated view)

```rust
#[derive(Clone, serde::Serialize)]
pub struct CommandSummary {
    pub command: String,
    pub count: u64,
    pub avg_ms: f64,
    pub max_ms: f64,
    pub p95_ms: f64,
    pub slow_count: u64,
}
```

Computed on-demand from the ring buffer — no separate tracking state.

### IpcMetricsResponse (debug command output)

```rust
#[derive(Clone, serde::Serialize)]
pub struct IpcMetricsResponse {
    pub summary: Vec<CommandSummary>,
    pub recent: Vec<MetricEntry>,  // last 20 entries
    pub total_entries: usize,
}
```

## Core API

### IpcMetrics struct

```rust
pub struct IpcMetrics {
    entries: Mutex<VecDeque<MetricEntry>>,
    capacity: usize,
    slow_threshold_ms: f64,
}
```

Methods:

| Method | Purpose |
|--------|---------|
| `new(capacity, slow_threshold_ms)` | Constructor. Production: `new(500, 500.0)` |
| `time(command: &'static str) -> TimingGuard` | Start timing. Returns drop-guard. |
| `entries() -> Vec<MetricEntry>` | Clone snapshot of ring buffer |
| `summary() -> Vec<CommandSummary>` | Per-command aggregates from buffer |
| `clear()` | Empty the ring buffer |

### TimingGuard

```rust
pub struct TimingGuard<'a> {
    metrics: &'a IpcMetrics,
    command: &'static str,
    start: Instant,
    error: bool,
}
```

- Created by `IpcMetrics::time()`. Starts `Instant::now()`.
- On drop: computes elapsed, pushes `MetricEntry` to ring buffer.
- If elapsed > slow threshold: `eprintln!("[ipc-metrics] slow: {} took {:.1}ms", command, elapsed_ms)`.
- Call `.mark_error()` before drop to flag the entry as `success: false`.

### Internal record method

`IpcMetrics::record(command, elapsed_ms, success)` — pushes entry, evicts oldest if at capacity, logs slow calls. Called by `TimingGuard::drop()`.

## AppState Change

```rust
pub struct AppState {
    // ... existing fields unchanged ...
    /// IPC command timing metrics (no lock ordering constraint — leaf lock).
    pub ipc_metrics: IpcMetrics,
}
```

Constructed during app setup with `IpcMetrics::new(500, 500.0)`.

Lock ordering note: `ipc_metrics` is a leaf lock — it never acquires another lock while held, so it can be taken in any order relative to existing locks.

## Debug Command

```rust
#[tauri::command]
pub async fn get_ipc_metrics(
    state: State<'_, AppState>,
) -> Result<IpcMetricsResponse, String>
```

Returns summary (sorted by `count` descending) and last 20 recent entries. Registered in `lib.rs` `invoke_handler`.

No `clear_ipc_metrics` command — the ring buffer self-evicts. Add later if needed.

## Usage Pattern

### Standard command (success path only)

```rust
#[tauri::command]
pub async fn get_chapter_content(
    state: State<'_, AppState>,
    book_id: String,
    chapter_index: usize,
) -> Result<ChapterContent, String> {
    let _t = state.ipc_metrics.time("get_chapter_content");
    // ... existing implementation unchanged ...
}
```

The `_t` guard records timing automatically when the function returns (success or error via `?`).

### Command with explicit error tracking

```rust
#[tauri::command]
pub async fn import_book(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Book, String> {
    let timer = state.ipc_metrics.time("import_book");
    match do_import(&state, &file_path).await {
        Ok(book) => Ok(book),
        Err(e) => {
            timer.mark_error();
            Err(e.to_string())
        }
    }
}
```

Note: for most commands, the simple `let _t` pattern is sufficient. The `?` operator causes the guard to drop with `success: true` — acceptable since we're tracking timing, not error rates. Use `mark_error()` only on commands where distinguishing error timing matters (e.g., import may fail fast vs succeed slow).

## Initial Instrumentation Set

15 commands selected for hot-path coverage:

| Category | Commands |
|----------|----------|
| Reader | `get_chapter_content`, `get_all_chapters`, `search_book_content`, `get_toc` |
| Import | `import_book`, `scan_folder_for_books`, `start_folder_import` |
| PDF/Comic | `get_pdf_page_bytes`, `get_comic_page_bytes`, `prepare_pdf`, `prepare_comic` |
| Library | `get_library`, `get_library_grid` |
| Enrichment | `enrich_book_from_openlibrary` |
| Backup | `run_backup` |

## Testing Plan

### Unit tests (in ipc_metrics.rs)

1. Ring buffer eviction — insert 501 entries, verify length is 500 and oldest is gone
2. Slow-call detection — entry with elapsed > threshold is flagged
3. Summary aggregation — multiple entries for same command produce correct count/avg/max/p95
4. TimingGuard drop records entry
5. `mark_error()` sets `success: false`
6. `clear()` empties buffer

### Integration test

1. `get_ipc_metrics` command returns valid `IpcMetricsResponse` (via existing Tauri test patterns or manual verification)

### CI verification

1. `cargo fmt --check` — new module formatted
2. `cargo clippy -- -D warnings` — no warnings
3. `cargo test` — new unit tests pass
4. `npm run type-check` — no frontend changes
5. `npm run test` — no frontend changes

## Scope Exclusions

- No frontend timing wrapper or UI dashboard
- No `tracing` crate (deferred to F-2-3)
- No configurable threshold/capacity (hardcoded, changeable later)
- No persistence — ring buffer resets on app restart
- No `clear_ipc_metrics` command
- No changes to existing command signatures or return types
- No web server metrics (desktop-only)
