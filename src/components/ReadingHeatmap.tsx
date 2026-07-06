import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, toDateKey } from "../lib/utils";
import { buildHeatmapWeeks, getHeatmapMonthLabels, type HeatmapDay } from "../lib/utils";

interface ReadingHeatmapProps {
  dailyReadingYear: [string, number][];
}

// Bucket 0 (no reading) uses the same subtle fill as StatCard so an "empty"
// cell still reads as part of the grid; buckets 1-4 step up accent opacity —
// the same token the 30-day bar chart uses, so colors stay correct across
// the light/sepia/dark themes automatically.
const BUCKET_CLASSES = [
  "bg-warm-subtle",
  "bg-accent/25",
  "bg-accent/50",
  "bg-accent/75",
  "bg-accent",
];

/**
 * GitHub-style contribution heatmap: 52-53 weeks x 7 days covering the last
 * 365 days, cell intensity = minutes read that day (F-5-4). Complements the
 * existing 30-day bar chart above it rather than replacing it.
 */
export default function ReadingHeatmap({ dailyReadingYear }: ReadingHeatmapProps) {
  const { t, i18n } = useTranslation();
  // Keyed on the day, not the Date instance, so the grid doesn't rebuild on
  // every render — only when the day actually rolls over.
  const todayKey = toDateKey(new Date());

  const weeks = useMemo(
    () => buildHeatmapWeeks(dailyReadingYear, new Date(`${todayKey}T00:00:00`)),
    [dailyReadingYear, todayKey],
  );
  const monthLabels = useMemo(() => getHeatmapMonthLabels(weeks), [weeks]);

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short" }),
    [i18n.language],
  );
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }),
    [i18n.language],
  );

  const cellLabel = (day: HeatmapDay) => {
    const date = dayFormatter.format(new Date(`${day.date}T00:00:00`));
    return day.seconds > 0
      ? t("stats.heatmapTooltip", { date, duration: formatDuration(day.seconds) })
      : t("stats.heatmapTooltipEmpty", { date });
  };

  return (
    <div>
      <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3">
        {t("stats.last365Days")}
      </h3>
      <div className="overflow-x-auto">
        <div
          className="inline-flex flex-col gap-1"
          role="img"
          aria-label={t("stats.heatmapAriaLabel")}
        >
          <div className="flex gap-0.5" aria-hidden="true">
            {weeks.map((_, i) => (
              <div key={i} className="w-[8px] text-[9px] leading-none text-ink-muted overflow-visible whitespace-nowrap">
                {monthLabels[i] != null ? monthFormatter.format(new Date(2020, monthLabels[i]!, 1)) : ""}
              </div>
            ))}
          </div>
          <div className="flex gap-0.5">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-0.5">
                {week.map((day) => {
                  if (!day.inRange) {
                    return <div key={day.date} className="w-[8px] h-[8px]" />;
                  }
                  return (
                    <div
                      key={day.date}
                      title={cellLabel(day)}
                      className={`w-[8px] h-[8px] rounded-[1px] ${BUCKET_CLASSES[day.bucket]}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
