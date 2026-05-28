# F-4-8: IPC Response Metrics Middleware — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-command timing to Tauri IPC calls with a ring buffer, per-command aggregates, slow-call logging, and a debug query command.

**Architecture:** New `ipc_metrics.rs` module in `src-tauri/src/` with `IpcMetrics` struct (ring buffer + drop-guard timer). Added to `AppState`. Commands opt in with a one-liner. New `get_ipc_metrics` Tauri command exposes the buffer.

**Tech Stack:** Rust std (`Instant`, `VecDeque`, `Mutex`, `SystemTime`), serde (already in deps)

**Spec:** `docs/superpowers/specs/2026-05-28-ipc-response-metrics-design.md`

---

### Task 1: Create IpcMetrics Module with Unit Tests

**Files:**
- Create: `src-tauri/src/ipc_metrics.rs`

- [ ] **Step 1: Write the failing tests for MetricEntry and ring buffer**

Create `src-tauri/src/ipc_metrics.rs` with types, an empty `IpcMetrics` struct, and tests:

```rust
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize)]
pub struct MetricEntry {
    pub command: &'static str,
    pub elapsed_ms: f64,
    pub timestamp: i64,
    pub success: bool,
}

#[derive(Clone, Serialize)]
pub struct CommandSummary {
    pub command: String,
    pub count: u64,
    pub avg_ms: f64,
    pub max_ms: f64,
    pub p95_ms: f64,
    pub slow_count: u64,
}

#[derive(Serialize)]
pub struct IpcMetricsResponse {
    pub summary: Vec<CommandSummary>,
    pub recent: Vec<MetricEntry>,
    pub total_entries: usize,
}

pub struct IpcMetrics {
    entries: Mutex<VecDeque<MetricEntry>>,
    capacity: usize,
    slow_threshold_ms: f64,
}

impl IpcMetrics {
    pub fn new(capacity: usize, slow_threshold_ms: f64) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
            slow_threshold_ms,
        }
    }

    pub fn time(&self, command: &'static str) -> TimingGuard<'_> {
        todo!()
    }

    pub fn record(&self, command: &'static str, elapsed_ms: f64, success: bool) {
        todo!()
    }

    pub fn entries(&self) -> Vec<MetricEntry> {
        todo!()
    }

    pub fn summary(&self) -> Vec<CommandSummary> {
        todo!()
    }

    pub fn response(&self) -> IpcMetricsResponse {
        todo!()
    }

    pub fn clear(&self) {
        todo!()
    }
}

pub struct TimingGuard<'a> {
    metrics: &'a IpcMetrics,
    command: &'static str,
    start: Instant,
    error: bool,
}

impl TimingGuard<'_> {
    pub fn mark_error(&mut self) {
        self.error = true;
    }
}

impl Drop for TimingGuard<'_> {
    fn drop(&mut self) {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_retrieve_entries() {
        let m = IpcMetrics::new(500, 500.0);
        m.record("test_cmd", 42.0, true);
        m.record("test_cmd", 99.0, false);
        let entries = m.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "test_cmd");
        assert!((entries[0].elapsed_ms - 42.0).abs() < f64::EPSILON);
        assert!(entries[0].success);
        assert!(!entries[1].success);
    }

    #[test]
    fn ring_buffer_evicts_oldest() {
        let m = IpcMetrics::new(3, 500.0);
        m.record("a", 1.0, true);
        m.record("b", 2.0, true);
        m.record("c", 3.0, true);
        m.record("d", 4.0, true);
        let entries = m.entries();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].command, "b");
        assert_eq!(entries[2].command, "d");
    }

    #[test]
    fn clear_empties_buffer() {
        let m = IpcMetrics::new(500, 500.0);
        m.record("x", 10.0, true);
        m.record("y", 20.0, true);
        m.clear();
        assert!(m.entries().is_empty());
    }

    #[test]
    fn summary_aggregates_per_command() {
        let m = IpcMetrics::new(500, 100.0);
        m.record("fast", 10.0, true);
        m.record("fast", 20.0, true);
        m.record("fast", 30.0, true);
        m.record("slow", 200.0, true);
        let summaries = m.summary();
        let fast = summaries.iter().find(|s| s.command == "fast").unwrap();
        assert_eq!(fast.count, 3);
        assert!((fast.avg_ms - 20.0).abs() < f64::EPSILON);
        assert!((fast.max_ms - 30.0).abs() < f64::EPSILON);
        assert_eq!(fast.slow_count, 0);
        let slow = summaries.iter().find(|s| s.command == "slow").unwrap();
        assert_eq!(slow.count, 1);
        assert_eq!(slow.slow_count, 1);
    }

    #[test]
    fn p95_calculation() {
        let m = IpcMetrics::new(500, 1000.0);
        for i in 1..=100 {
            m.record("cmd", i as f64, true);
        }
        let summaries = m.summary();
        let s = summaries.iter().find(|s| s.command == "cmd").unwrap();
        assert_eq!(s.count, 100);
        assert!(s.p95_ms >= 95.0);
        assert!(s.p95_ms <= 96.0);
    }

    #[test]
    fn timing_guard_records_on_drop() {
        let m = IpcMetrics::new(500, 500.0);
        {
            let _t = m.time("guarded");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let entries = m.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "guarded");
        assert!(entries[0].elapsed_ms >= 4.0);
        assert!(entries[0].success);
    }

    #[test]
    fn timing_guard_mark_error() {
        let m = IpcMetrics::new(500, 500.0);
        {
            let mut t = m.time("fail_cmd");
            t.mark_error();
        }
        let entries = m.entries();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].success);
    }

    #[test]
    fn response_returns_last_20_recent() {
        let m = IpcMetrics::new(500, 500.0);
        for i in 0..30 {
            m.record("cmd", i as f64, true);
        }
        let resp = m.response();
        assert_eq!(resp.recent.len(), 20);
        assert_eq!(resp.total_entries, 30);
        assert!((resp.recent[0].elapsed_ms - 10.0).abs() < f64::EPSILON);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd src-tauri && cargo test --lib ipc_metrics -- --nocapture 2>&1 | tail -20
```
Expected: Failures from `todo!()` panics on all 7 tests.

- [ ] **Step 3: Implement IpcMetrics methods**

Replace the `todo!()` bodies in `src-tauri/src/ipc_metrics.rs`:

For `record`:
```rust
pub fn record(&self, command: &'static str, elapsed_ms: f64, success: bool) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let entry = MetricEntry {
        command,
        elapsed_ms,
        timestamp,
        success,
    };

    if elapsed_ms > self.slow_threshold_ms {
        eprintln!(
            "[ipc-metrics] slow: {} took {:.1}ms",
            command, elapsed_ms
        );
    }

    let mut entries = self.entries.lock().unwrap();
    if entries.len() >= self.capacity {
        entries.pop_front();
    }
    entries.push_back(entry);
}
```

For `time`:
```rust
pub fn time(&self, command: &'static str) -> TimingGuard<'_> {
    TimingGuard {
        metrics: self,
        command,
        start: Instant::now(),
        error: false,
    }
}
```

For `TimingGuard::drop`:
```rust
impl Drop for TimingGuard<'_> {
    fn drop(&mut self) {
        let elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
        self.metrics.record(self.command, elapsed_ms, !self.error);
    }
}
```

For `entries`:
```rust
pub fn entries(&self) -> Vec<MetricEntry> {
    self.entries.lock().unwrap().iter().cloned().collect()
}
```

For `clear`:
```rust
pub fn clear(&self) {
    self.entries.lock().unwrap().clear();
}
```

For `summary`:
```rust
pub fn summary(&self) -> Vec<CommandSummary> {
    let entries = self.entries.lock().unwrap();
    let mut grouped: std::collections::HashMap<&str, Vec<f64>> =
        std::collections::HashMap::new();
    for entry in entries.iter() {
        grouped.entry(entry.command).or_default().push(entry.elapsed_ms);
    }

    let threshold = self.slow_threshold_ms;
    let mut summaries: Vec<CommandSummary> = grouped
        .into_iter()
        .map(|(cmd, mut times)| {
            let count = times.len() as u64;
            let avg_ms = times.iter().sum::<f64>() / count as f64;
            let max_ms = times.iter().cloned().fold(0.0_f64, f64::max);
            let slow_count = times.iter().filter(|&&t| t > threshold).count() as u64;
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p95_idx = ((count as f64 * 0.95).ceil() as usize).saturating_sub(1);
            let p95_ms = times.get(p95_idx).copied().unwrap_or(0.0);
            CommandSummary {
                command: cmd.to_string(),
                count,
                avg_ms,
                max_ms,
                p95_ms,
                slow_count,
            }
        })
        .collect();
    summaries.sort_by(|a, b| b.count.cmp(&a.count));
    summaries
}
```

For `response`:
```rust
pub fn response(&self) -> IpcMetricsResponse {
    let entries = self.entries.lock().unwrap();
    let total_entries = entries.len();
    let recent: Vec<MetricEntry> = entries.iter().rev().take(20).cloned().collect();

    let mut grouped: std::collections::HashMap<&str, Vec<f64>> =
        std::collections::HashMap::new();
    for entry in entries.iter() {
        grouped.entry(entry.command).or_default().push(entry.elapsed_ms);
    }

    let threshold = self.slow_threshold_ms;
    let mut summary: Vec<CommandSummary> = grouped
        .into_iter()
        .map(|(cmd, mut times)| {
            let count = times.len() as u64;
            let avg_ms = times.iter().sum::<f64>() / count as f64;
            let max_ms = times.iter().cloned().fold(0.0_f64, f64::max);
            let slow_count = times.iter().filter(|&&t| t > threshold).count() as u64;
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p95_idx = ((count as f64 * 0.95).ceil() as usize).saturating_sub(1);
            let p95_ms = times.get(p95_idx).copied().unwrap_or(0.0);
            CommandSummary {
                command: cmd.to_string(),
                count,
                avg_ms,
                max_ms,
                p95_ms,
                slow_count,
            }
        })
        .collect();
    summary.sort_by(|a, b| b.count.cmp(&a.count));

    IpcMetricsResponse {
        summary,
        recent,
        total_entries,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd src-tauri && cargo test --lib ipc_metrics -- --nocapture 2>&1 | tail -20
```
Expected: All 7 tests pass.

- [ ] **Step 5: Run clippy**

Run:
```bash
cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -10
```
Expected: No warnings (module not yet imported — clippy may not see it yet, that's fine).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc_metrics.rs
git commit -m "feat: add ipc_metrics module with ring buffer, timing guard, and aggregates"
```

---

### Task 2: Wire IpcMetrics into AppState

**Files:**
- Modify: `src-tauri/src/lib.rs` (module declaration + AppState construction)
- Modify: `src-tauri/src/commands.rs` (AppState struct + import)

- [ ] **Step 1: Add module declaration in lib.rs**

In `src-tauri/src/lib.rs`, add `pub mod ipc_metrics;` after line 4 (`pub mod commands;`):

```rust
pub mod commands;
pub mod ipc_metrics;
```

- [ ] **Step 2: Add IpcMetrics field to AppState**

In `src-tauri/src/commands.rs`, add the import at the top (after line 17, `use crate::pdf;`):

```rust
use crate::ipc_metrics::IpcMetrics;
```

Then add the field to `AppState` (after the `web_server_handle` field at line 188):

```rust
    /// IPC command timing metrics (leaf lock — no ordering constraint).
    pub ipc_metrics: IpcMetrics,
```

- [ ] **Step 3: Construct IpcMetrics in app setup**

In `src-tauri/src/lib.rs`, inside the `app.manage(AppState { ... })` block (after `web_server_handle: std::sync::Mutex::new(None),` at line 152), add:

```rust
                ipc_metrics: crate::ipc_metrics::IpcMetrics::new(500, 500.0),
```

- [ ] **Step 4: Verify it compiles**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -10
```
Expected: Compiles with no errors.

- [ ] **Step 5: Run existing tests**

Run:
```bash
cd src-tauri && cargo test 2>&1 | tail -10
```
Expected: All tests pass (existing + new ipc_metrics tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat: wire IpcMetrics into AppState"
```

---

### Task 3: Add get_ipc_metrics Tauri Command

**Files:**
- Modify: `src-tauri/src/commands.rs` (new command function)
- Modify: `src-tauri/src/lib.rs` (register in invoke_handler)

- [ ] **Step 1: Add the command in commands.rs**

Add the command at the end of `commands.rs`, before the `#[cfg(test)]` block (before line 5872):

```rust
#[tauri::command]
pub async fn get_ipc_metrics(
    state: State<'_, AppState>,
) -> Result<crate::ipc_metrics::IpcMetricsResponse, String> {
    Ok(state.ipc_metrics.response())
}
```

- [ ] **Step 2: Register in invoke_handler**

In `src-tauri/src/lib.rs`, add `commands::get_ipc_metrics,` to the `invoke_handler` list. Place it after `commands::set_autostart_enabled,` (the last current entry, around line 369):

```rust
            commands::set_autostart_enabled,
            commands::get_ipc_metrics,
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -10
```
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add get_ipc_metrics Tauri command"
```

---

### Task 4: Instrument Initial 15 Commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add timing one-liners to 15 commands)

Each command gets one line added as the first statement in the function body:
```rust
let _t = state.ipc_metrics.time("command_name");
```

- [ ] **Step 1: Instrument reader commands**

Add the timing line as the first statement in each function body:

`get_chapter_content` (line 1432, after the opening `{`):
```rust
    let _t = state.ipc_metrics.time("get_chapter_content");
```

`get_all_chapters` (find the opening `{` of the function):
```rust
    let _t = state.ipc_metrics.time("get_all_chapters");
```

`search_book_content` (first line of body):
```rust
    let _t = state.ipc_metrics.time("search_book_content");
```

`get_toc` (first line of body):
```rust
    let _t = state.ipc_metrics.time("get_toc");
```

- [ ] **Step 2: Instrument import commands**

`import_book` (line 504, after the opening `{`):
```rust
    let _t = state.ipc_metrics.time("import_book");
```

`scan_folder_for_books` (first line of body):
```rust
    let _t = state.ipc_metrics.time("scan_folder_for_books");
```

`start_folder_import` (first line of body):
```rust
    let _t = state.ipc_metrics.time("start_folder_import");
```

- [ ] **Step 3: Instrument PDF/comic commands**

`get_pdf_page_bytes` (first line of body):
```rust
    let _t = state.ipc_metrics.time("get_pdf_page_bytes");
```

`get_comic_page_bytes` (first line of body):
```rust
    let _t = state.ipc_metrics.time("get_comic_page_bytes");
```

`prepare_pdf` (first line of body):
```rust
    let _t = state.ipc_metrics.time("prepare_pdf");
```

`prepare_comic` (first line of body):
```rust
    let _t = state.ipc_metrics.time("prepare_comic");
```

- [ ] **Step 4: Instrument library and other commands**

`get_library` (line 1087, first line of body):
```rust
    let _t = state.ipc_metrics.time("get_library");
```

`get_library_grid` (first line of body):
```rust
    let _t = state.ipc_metrics.time("get_library_grid");
```

`enrich_book_from_openlibrary` (first line of body):
```rust
    let _t = state.ipc_metrics.time("enrich_book_from_openlibrary");
```

`run_backup` (first line of body):
```rust
    let _t = state.ipc_metrics.time("run_backup");
```

- [ ] **Step 5: Verify it compiles and tests pass**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -10
```
Expected: Compiles with no errors. Each command already has `state: State<'_, AppState>` so `state.ipc_metrics` is accessible.

Run:
```bash
cd src-tauri && cargo test 2>&1 | tail -10
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: instrument 15 hot-path commands with IPC timing"
```

---

### Task 5: Full CI Verification

**Files:** None (verification only)

- [ ] **Step 1: Rust formatting check**

Run:
```bash
cd src-tauri && cargo fmt --check 2>&1 | tail -10
```
Expected: No formatting issues. If any, run `cargo fmt` and recommit.

- [ ] **Step 2: Clippy**

Run:
```bash
cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -20
```
Expected: No warnings.

- [ ] **Step 3: Rust tests**

Run:
```bash
cd src-tauri && cargo test 2>&1 | tail -20
```
Expected: All tests pass including new ipc_metrics tests.

- [ ] **Step 4: Frontend type-check (no-op sanity)**

Run:
```bash
npm run type-check 2>&1 | tail -5
```
Expected: Passes — no frontend changes.

- [ ] **Step 5: Frontend tests (no-op sanity)**

Run:
```bash
npm run test 2>&1 | tail -5
```
Expected: Passes — no frontend changes.

- [ ] **Step 6: Fix any issues and commit if needed**

If any earlier steps required fixes, commit them now. Otherwise skip.
