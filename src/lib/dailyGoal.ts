/**
 * Pure logic for the daily reading-minutes goal (F-5-2).
 */

export interface DailyGoalProgress {
  minutesRead: number;
  goalMinutes: number;
  pct: number;
  metGoal: boolean;
}

/**
 * Parse a stored or user-entered daily goal into a safe positive integer of
 * minutes, or `null` if it isn't one. Shared by save and load so both agree:
 * `Number.isSafeInteger` rejects values that would serialize in exponent
 * notation (e.g. 1e21) and reload as a different number, and non-integers
 * (e.g. "1.5") are rejected outright rather than silently truncated.
 */
export function parseDailyGoalMinutes(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Seconds read on `todayKey` (local YYYY-MM-DD) from the 365-day series; missing day -> 0. */
export function secsReadOn(dailyReadingYear: [string, number][], todayKey: string): number {
  const entry = dailyReadingYear.find(([date]) => date === todayKey);
  return entry ? entry[1] : 0;
}

/** Progress toward a daily-minutes goal. goalMinutes assumed >= 1. */
export function computeDailyGoalProgress(secsRead: number, goalMinutes: number): DailyGoalProgress {
  const minutesRead = Math.floor(secsRead / 60);
  const pct = goalMinutes > 0 ? Math.min(1, secsRead / (goalMinutes * 60)) : 0;
  return { minutesRead, goalMinutes, pct, metGoal: secsRead >= goalMinutes * 60 };
}
