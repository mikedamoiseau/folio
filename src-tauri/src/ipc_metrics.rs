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
        TimingGuard {
            metrics: self,
            command,
            start: Instant::now(),
            error: false,
        }
    }

    pub fn record(&self, command: &'static str, elapsed_ms: f64, success: bool) {
        if elapsed_ms > self.slow_threshold_ms {
            eprintln!("[ipc-metrics] slow: {} took {:.1}ms", command, elapsed_ms);
        }
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
        let mut guard = self.entries.lock().unwrap();
        if guard.len() >= self.capacity {
            guard.pop_front();
        }
        guard.push_back(entry);
    }

    pub fn entries(&self) -> Vec<MetricEntry> {
        self.entries.lock().unwrap().iter().cloned().collect()
    }

    pub fn summary(&self) -> Vec<CommandSummary> {
        let guard = self.entries.lock().unwrap();
        Self::compute_summary(&guard, self.slow_threshold_ms)
    }

    fn compute_summary(
        entries: &VecDeque<MetricEntry>,
        slow_threshold_ms: f64,
    ) -> Vec<CommandSummary> {
        use std::collections::HashMap;

        let mut map: HashMap<&'static str, Vec<f64>> = HashMap::new();
        for entry in entries {
            map.entry(entry.command).or_default().push(entry.elapsed_ms);
        }

        let mut summaries: Vec<CommandSummary> = map
            .into_iter()
            .map(|(command, mut times)| {
                let count = times.len() as u64;
                let avg_ms = times.iter().sum::<f64>() / times.len() as f64;
                let max_ms = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let slow_count = times.iter().filter(|&&t| t > slow_threshold_ms).count() as u64;

                times.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let p95_idx = ((count as f64 * 0.95).ceil() as usize).saturating_sub(1);
                let p95_ms = times.get(p95_idx).copied().unwrap_or(0.0);

                CommandSummary {
                    command: command.to_string(),
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

    pub fn response(&self) -> IpcMetricsResponse {
        let guard = self.entries.lock().unwrap();
        let total_entries = guard.len();
        let summary = Self::compute_summary(&guard, self.slow_threshold_ms);
        let recent: Vec<MetricEntry> = guard.iter().rev().take(20).cloned().collect();
        IpcMetricsResponse {
            summary,
            recent,
            total_entries,
        }
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

pub struct TimingGuard<'a> {
    metrics: &'a IpcMetrics,
    command: &'static str,
    start: Instant,
    error: bool,
}

impl<'a> TimingGuard<'a> {
    pub fn mark_error(&mut self) {
        self.error = true;
    }
}

impl<'a> Drop for TimingGuard<'a> {
    fn drop(&mut self) {
        let elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
        self.metrics.record(self.command, elapsed_ms, !self.error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn record_and_retrieve_entries() {
        let m = IpcMetrics::new(100, 500.0);
        m.record("cmd_a", 10.0, true);
        m.record("cmd_b", 20.0, false);
        let entries = m.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "cmd_a");
        assert!((entries[0].elapsed_ms - 10.0).abs() < f64::EPSILON);
        assert!(entries[0].success);
        assert_eq!(entries[1].command, "cmd_b");
        assert!((entries[1].elapsed_ms - 20.0).abs() < f64::EPSILON);
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
        // "a" (elapsed 1.0) should have been evicted
        assert!(!entries.iter().any(|e| e.command == "a"));
        assert_eq!(entries[0].command, "b");
        assert_eq!(entries[1].command, "c");
        assert_eq!(entries[2].command, "d");
    }

    #[test]
    fn clear_empties_buffer() {
        let m = IpcMetrics::new(100, 500.0);
        m.record("cmd", 10.0, true);
        m.record("cmd", 20.0, true);
        m.clear();
        assert!(m.entries().is_empty());
    }

    #[test]
    fn summary_aggregates_per_command() {
        let m = IpcMetrics::new(100, 100.0);
        m.record("fast", 10.0, true);
        m.record("fast", 20.0, true);
        m.record("fast", 30.0, true);
        m.record("slow", 200.0, true);

        let summaries = m.summary();
        // "fast" has count 3, "slow" has count 1; sorted by count desc
        let fast = summaries.iter().find(|s| s.command == "fast").unwrap();
        assert_eq!(fast.count, 3);
        assert!((fast.avg_ms - 20.0).abs() < f64::EPSILON);
        assert!((fast.max_ms - 30.0).abs() < f64::EPSILON);
        assert_eq!(fast.slow_count, 0);

        let slow = summaries.iter().find(|s| s.command == "slow").unwrap();
        assert_eq!(slow.count, 1);
        assert!((slow.avg_ms - 200.0).abs() < f64::EPSILON);
        assert!((slow.max_ms - 200.0).abs() < f64::EPSILON);
        assert_eq!(slow.slow_count, 1);

        // sorted by count descending
        assert_eq!(summaries[0].command, "fast");
    }

    #[test]
    fn p95_calculation() {
        let m = IpcMetrics::new(200, 500.0);
        for i in 1..=100 {
            m.record("cmd", i as f64, true);
        }
        let summaries = m.summary();
        let s = summaries.iter().find(|s| s.command == "cmd").unwrap();
        // p95 of 1..=100 should be between 95.0 and 96.0
        assert!(
            s.p95_ms >= 95.0 && s.p95_ms <= 96.0,
            "expected p95 in [95.0, 96.0], got {}",
            s.p95_ms
        );
    }

    #[test]
    fn timing_guard_records_on_drop() {
        let m = IpcMetrics::new(100, 500.0);
        {
            let _guard = m.time("guarded");
            thread::sleep(Duration::from_millis(5));
        }
        let entries = m.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "guarded");
        assert!(entries[0].elapsed_ms >= 4.0, "elapsed should be >= 4ms");
        assert!(entries[0].success);
    }

    #[test]
    fn timing_guard_mark_error() {
        let m = IpcMetrics::new(100, 500.0);
        {
            let mut guard = m.time("fail_cmd");
            guard.mark_error();
        }
        let entries = m.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "fail_cmd");
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
        // recent is newest-first (rev().take(20)), so first element is entry 29
        assert!(
            (resp.recent[0].elapsed_ms - 29.0).abs() < f64::EPSILON,
            "expected recent[0].elapsed_ms == 29.0, got {}",
            resp.recent[0].elapsed_ms
        );
    }
}
