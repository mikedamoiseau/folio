import { useTranslation } from "react-i18next";

interface ChapterLoadProgressProps {
  /** Total chapters being loaded (from the book metadata). */
  total: number;
  /**
   * Chapters loaded so far. When the chapters arrive as a single bulk call
   * (no intermediate progress), leave this `undefined` to render an
   * indeterminate bar instead of a misleading count.
   */
  loaded?: number;
}

/**
 * Loading indicator for continuous-scroll mode, shown while all chapters are
 * fetched. When per-chapter progress is available (`loaded` set), it shows a
 * "Loaded X / N" counter and a determinate bar; otherwise it shows the chapter
 * count with an indeterminate animated bar — never a faked count.
 */
export default function ChapterLoadProgress({ total, loaded }: ChapterLoadProgressProps) {
  const { t } = useTranslation();

  const determinate = loaded !== undefined && total > 0;
  const percent = determinate
    ? Math.min(100, Math.round((loaded! / total) * 100))
    : 0;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3" role="status" aria-live="polite">
      <p className="text-sm text-ink-muted">
        {determinate
          ? t("reader.loadedChapters", { loaded, total })
          : t("reader.loadingChapters", { count: total })}
      </p>
      <div className="w-48 max-w-[60vw] h-1 bg-warm-subtle rounded-full overflow-hidden">
        {determinate ? (
          <div
            className="h-full bg-accent transition-all duration-200"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-accent rounded-full animate-chapter-load-indeterminate" />
        )}
      </div>
    </div>
  );
}
