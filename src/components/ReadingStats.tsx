import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ReadingStatsData {
  totalReadingTimeSecs: number;
  totalSessions: number;
  totalPagesRead: number;
  booksFinished: number;
  currentStreakDays: number;
  longestStreakDays: number;
  dailyReading: [string, number][];
}

interface ReadingStatsProps {
  onClose: () => void;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export default function ReadingStats({ onClose }: ReadingStatsProps) {
  const [stats, setStats] = useState<ReadingStatsData | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const data = await invoke<ReadingStatsData>("get_reading_stats");
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const maxDaily = stats?.dailyReading.reduce((max, [, secs]) => Math.max(max, secs), 0) ?? 0;

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-lg pointer-events-auto animate-fade-in max-h-[80vh] overflow-y-auto">
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
            <h2 className="font-serif text-base font-semibold text-ink">Reading Stats</h2>
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {!stats ? (
            <div className="px-5 py-8 text-center text-sm text-ink-muted">Loading…</div>
          ) : (
            <div className="px-5 py-4 space-y-5">
              {/* Stat cards */}
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Time Reading" value={formatDuration(stats.totalReadingTimeSecs)} />
                <StatCard label="Sessions" value={stats.totalSessions.toString()} />
                <StatCard label="Pages Read" value={stats.totalPagesRead.toString()} />
                <StatCard label="Books Finished" value={stats.booksFinished.toString()} />
                <StatCard label="Current Streak" value={`${stats.currentStreakDays} day${stats.currentStreakDays !== 1 ? "s" : ""}`} />
                <StatCard label="Longest Streak" value={`${stats.longestStreakDays} day${stats.longestStreakDays !== 1 ? "s" : ""}`} />
              </div>

              {/* Daily reading chart */}
              {stats.dailyReading.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">Last 30 Days</h3>
                  <div className="flex items-end gap-0.5 h-20">
                    {stats.dailyReading.map(([date, secs]) => {
                      const height = maxDaily > 0 ? Math.max(4, (secs / maxDaily) * 100) : 4;
                      return (
                        <div
                          key={date}
                          className="flex-1 bg-accent/70 hover:bg-accent rounded-t transition-colors"
                          style={{ height: `${height}%` }}
                          title={`${date}: ${formatDuration(secs)}`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-warm-subtle rounded-xl px-3 py-2.5 text-center">
      <p className="text-lg font-semibold text-ink tabular-nums">{value}</p>
      <p className="text-[10px] text-ink-muted uppercase tracking-wide mt-0.5">{label}</p>
    </div>
  );
}
