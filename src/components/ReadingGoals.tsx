import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { toDateKey } from "../lib/utils";
import { secsReadOn, computeDailyGoalProgress } from "../lib/dailyGoal";
import { friendlyError } from "../lib/errors";
import { useToast } from "./Toast";
import ReadingGoalRing from "./ReadingGoalRing";

const DAILY_GOAL_SETTING_KEY = "daily_reading_minutes_goal";

interface ReadingGoalsProps {
  /** Books finished during the current calendar year (F-1-3). */
  finishedThisYear: number;
  /** Rolling 365-day [date, seconds] series (F-5-4), reused to derive today's minutes. */
  dailyReadingYear: [string, number][];
}

/**
 * Shared "Reading goals" card: the annual books-finished ring on top, a
 * divider, and the daily reading-minutes bar below (F-5-2). Both goals are
 * frontend-only settings-table values read/written independently, but they
 * render inside one card per the F-5-2 design's "one coherent surface"
 * constraint.
 */
export default function ReadingGoals({ finishedThisYear, dailyReadingYear }: ReadingGoalsProps) {
  const { t } = useTranslation();

  return (
    <div className="bg-warm-subtle rounded-xl px-4 py-4 space-y-4">
      <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">
        {t("stats.dailyGoal.sectionTitle")}
      </h3>
      <ReadingGoalRing finishedThisYear={finishedThisYear} />
      <div className="border-t border-warm-border" />
      <DailyGoalBar dailyReadingYear={dailyReadingYear} />
    </div>
  );
}

function DailyGoalBar({ dailyReadingYear }: { dailyReadingYear: [string, number][] }) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [goal, setGoal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const parsedInput = Number(inputValue);
  const inputIsValid = Number.isInteger(parsedInput) && parsedInput >= 1;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await invoke<string | null>("get_setting_value", { key: DAILY_GOAL_SETTING_KEY });
        const parsed = value ? parseInt(value, 10) : NaN;
        if (!cancelled) setGoal(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      } catch {
        // No goal set yet (or the read failed) — fall back to the empty state.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startEditing = () => {
    setInputValue(goal ? String(goal) : "");
    setEditing(true);
  };

  const saveGoal = async () => {
    if (!inputIsValid) return;
    try {
      await invoke("set_setting_value", { key: DAILY_GOAL_SETTING_KEY, value: String(parsedInput) });
      setGoal(parsedInput);
      setEditing(false);
    } catch (err) {
      // Keep the editor open so the user can retry.
      addToast(friendlyError(err, t), "error");
    }
  };

  if (!loaded) return null;

  if (editing) {
    return (
      <div>
        <label htmlFor="daily-goal-input" className="text-xs text-ink-muted mb-2 block">
          {t("stats.dailyGoal.inputLabel")}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="daily-goal-input"
            type="number"
            min={1}
            step={1}
            autoFocus
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && inputIsValid) saveGoal();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-invalid={!inputIsValid}
            className={`w-20 bg-surface border rounded-lg px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 ${
              inputIsValid ? "border-warm-border focus:ring-accent" : "border-red-500 focus:ring-red-500"
            }`}
          />
          <button
            type="button"
            onClick={saveGoal}
            disabled={!inputIsValid}
            className="px-3 py-1.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent"
          >
            {t("common.save")}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink transition-colors"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (goal == null) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="w-full hover:bg-warm-border/40 rounded-xl px-4 py-5 text-center transition-colors"
      >
        <p className="text-sm font-medium text-ink">{t("stats.dailyGoal.setGoal")}</p>
        <p className="text-xs text-ink-muted mt-1">{t("stats.dailyGoal.setGoalHint")}</p>
      </button>
    );
  }

  const secsRead = secsReadOn(dailyReadingYear, toDateKey(new Date()));
  const progress = computeDailyGoalProgress(secsRead, goal);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          {t("stats.dailyGoal.today")}
        </h4>
        <button
          type="button"
          onClick={startEditing}
          className="text-[11px] text-ink-muted hover:text-accent transition-colors shrink-0"
        >
          {t("common.edit")}
        </button>
      </div>
      <div
        className="mt-2"
        role="img"
        aria-label={t("stats.dailyGoal.barAriaLabel", {
          minutes: progress.minutesRead,
          goal: progress.goalMinutes,
          percent: Math.round(progress.pct * 100),
        })}
      >
        <div className="bg-warm-border rounded-full h-2 overflow-hidden">
          <div
            className={`h-full rounded-full ${progress.metGoal ? "bg-accent" : "bg-accent/80"}`}
            style={{ width: `${progress.pct * 100}%` }}
          />
        </div>
        <p className="text-sm mt-1.5 text-ink-muted">
          {t("stats.dailyGoal.progress", { minutes: progress.minutesRead, goal: progress.goalMinutes })}
        </p>
        {progress.metGoal && (
          <p className="text-sm mt-1 text-accent font-medium">
            {t("stats.dailyGoal.met")} <span aria-hidden="true">✨</span>
          </p>
        )}
      </div>
    </div>
  );
}
