import { describe, it, expect } from "vitest";
import { secsReadOn, computeDailyGoalProgress, parseDailyGoalMinutes } from "./dailyGoal";

describe("parseDailyGoalMinutes", () => {
  it("accepts a plain positive integer", () => {
    expect(parseDailyGoalMinutes("30")).toBe(30);
  });

  it("accepts exponent notation that is a safe integer (2e2 -> 200)", () => {
    expect(parseDailyGoalMinutes("2e2")).toBe(200);
  });

  it("rejects fractional input rather than truncating (1.5 -> null)", () => {
    expect(parseDailyGoalMinutes("1.5")).toBeNull();
  });

  it("rejects an unsafe integer that would reload as a different value", () => {
    // Number("1e21") is an integer but not safe; String() -> "1e+21" -> parses back as 1.
    expect(parseDailyGoalMinutes("1000000000000000000000")).toBeNull();
  });

  it("rejects zero, negatives, blank, and null", () => {
    expect(parseDailyGoalMinutes("0")).toBeNull();
    expect(parseDailyGoalMinutes("-5")).toBeNull();
    expect(parseDailyGoalMinutes("  ")).toBeNull();
    expect(parseDailyGoalMinutes(null)).toBeNull();
  });
});

describe("secsReadOn", () => {
  it("returns the seconds for a matching date", () => {
    const series: [string, number][] = [
      ["2026-07-10", 600],
      ["2026-07-11", 900],
      ["2026-07-12", 1200],
    ];
    expect(secsReadOn(series, "2026-07-11")).toBe(900);
  });

  it("returns 0 when the date is missing from the series", () => {
    const series: [string, number][] = [
      ["2026-07-10", 600],
      ["2026-07-11", 900],
    ];
    expect(secsReadOn(series, "2026-07-12")).toBe(0);
  });

  it("returns 0 for an empty series", () => {
    expect(secsReadOn([], "2026-07-12")).toBe(0);
  });
});

describe("computeDailyGoalProgress", () => {
  it("reports below-goal progress", () => {
    const result = computeDailyGoalProgress(600, 30); // 10 min of 30
    expect(result).toEqual({ minutesRead: 10, goalMinutes: 30, pct: 1 / 3, metGoal: false });
  });

  it("is not met one second short of the goal boundary", () => {
    const result = computeDailyGoalProgress(30 * 60 - 1, 30);
    expect(result.metGoal).toBe(false);
    expect(result.pct).toBeLessThan(1);
  });

  it("is met exactly at the goal boundary", () => {
    const result = computeDailyGoalProgress(30 * 60, 30);
    expect(result.metGoal).toBe(true);
    expect(result.pct).toBe(1);
  });

  it("clamps pct to 1 when over goal", () => {
    const result = computeDailyGoalProgress(60 * 60, 30);
    expect(result.pct).toBe(1);
    expect(result.metGoal).toBe(true);
    expect(result.minutesRead).toBe(60);
  });

  it("floors minutes read (1770s -> 29 min, not met at goal 30)", () => {
    const result = computeDailyGoalProgress(1770, 30);
    expect(result.minutesRead).toBe(29);
    expect(result.metGoal).toBe(false);
  });
});
