import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { computeReadingPace, getDayOfYear } from "../lib/utils";
import { friendlyError } from "../lib/errors";
import { useToast } from "./Toast";

const GOAL_SETTING_KEY = "yearly_reading_goal";
// A 20x20 viewBox (matching the app's icon convention) with strokeWidth 2 —
// the repo's SVG stroke-consistency audit caps strokeWidth at 1.5/2 outside
// spinners, so the ring is scaled down rather than drawn at strokeWidth 8 on
// a 100-unit viewBox.
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface ReadingGoalRingProps {
  /** Books finished during the current calendar year (F-1-3). */
  finishedThisYear: number;
}

/**
 * Yearly reading goal: an SVG progress ring (finished/goal) with a pace
 * indicator underneath, editable inline from an empty-state prompt or the
 * "Edit" affordance next to the ring (F-1-3). The goal itself is a plain
 * settings-table value (`yearly_reading_goal`), same mechanism as every
 * other single-value setting — no dedicated command needed.
 */
export default function ReadingGoalRing({ finishedThisYear }: ReadingGoalRingProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [goal, setGoal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const parsedInput = parseInt(inputValue, 10);
  const inputIsValid = Number.isFinite(parsedInput) && parsedInput >= 1;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await invoke<string | null>("get_setting_value", { key: GOAL_SETTING_KEY });
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
      await invoke("set_setting_value", { key: GOAL_SETTING_KEY, value: String(parsedInput) });
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
        <label htmlFor="reading-goal-input" className="text-xs text-ink-muted mb-2 block">
          {t("stats.goal.inputLabel")}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="reading-goal-input"
            type="number"
            min={1}
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
        <p className="text-sm font-medium text-ink">{t("stats.goal.setGoal")}</p>
        <p className="text-xs text-ink-muted mt-1">{t("stats.goal.setGoalHint")}</p>
      </button>
    );
  }

  const currentYear = new Date().getFullYear();
  const completed = finishedThisYear >= goal;
  const pct = Math.min(1, finishedThisYear / goal);
  const dashOffset = RING_CIRCUMFERENCE * (1 - pct);
  const pace = computeReadingPace(finishedThisYear, goal, getDayOfYear(new Date()));

  const paceLabel =
    pace.status === "onTrack"
      ? t("stats.goal.onTrack")
      : pace.status === "ahead"
        ? t("stats.goal.aheadOfSchedule", { count: pace.count })
        : t("stats.goal.behindSchedule", { count: pace.count });

  return (
    <div>
      <div className="flex items-center gap-4">
        <div
          className="relative w-24 h-24 shrink-0"
          role="img"
          aria-label={t("stats.goal.ringAriaLabel", {
            finished: finishedThisYear,
            goal,
            percent: Math.round(pct * 100),
          })}
        >
          <svg viewBox="0 0 20 20" className="w-24 h-24 -rotate-90">
            <circle
              cx="10"
              cy="10"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-warm-border"
            />
            <circle
              cx="10"
              cy="10"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              className={completed ? "text-accent" : "text-accent/80"}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {completed && (
              <span aria-hidden="true" className="text-sm leading-none mb-0.5">
                ✨
              </span>
            )}
            <span className="text-sm font-semibold text-ink tabular-nums">
              {finishedThisYear} / {goal}
            </span>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
              {t("stats.goal.title", { year: currentYear })}
            </h3>
            <button
              type="button"
              onClick={startEditing}
              className="text-[11px] text-ink-muted hover:text-accent transition-colors shrink-0"
            >
              {t("common.edit")}
            </button>
          </div>
          <p className={`text-sm mt-1.5 ${completed ? "text-accent font-medium" : "text-ink-muted"}`}>
            {completed ? t("stats.goal.completed") : paceLabel}
          </p>
        </div>
      </div>
    </div>
  );
}
