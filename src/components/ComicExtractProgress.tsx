import { useTranslation } from "react-i18next";
import { comicExtractProgressPercent } from "../lib/comicExtractProgress";

interface ComicExtractProgressProps {
  /** Pages extracted so far. */
  loaded: number;
  /** Total pages being extracted in the background. */
  total: number;
  /**
   * i18n key for the "{{loaded}} / {{total}}" label. Defaults to the comic
   * extraction label (F-4-1); the PDF prerender bar (F-4-5) passes its own
   * "caching pages" key so the shared bar reads correctly per format.
   */
  labelKey?: string;
  /** Fired when the user dismisses the bar. */
  onDismiss: () => void;
}

/**
 * Non-blocking, dismissible background page-prerender bar. Floats over the
 * page viewer while the backend prepares the remaining pages in the
 * background — it never gates reading or navigation (which the backend serves
 * on demand). Shared by the progressive comic-open feature (F-4-1) and the
 * PDF background prerender (F-4-5), differing only in the label. Visibility is
 * owned by the caller via `isComicExtractProgressVisible`; this component only
 * renders the chrome.
 */
export default function ComicExtractProgress({
  loaded,
  total,
  labelKey = "reader.preparingPagesProgress",
  onDismiss,
}: ComicExtractProgressProps) {
  const { t } = useTranslation();
  const percent = comicExtractProgressPercent(loaded, total);

  return (
    <div
      className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 rounded-full border border-warm-border bg-surface/95 px-4 py-2 shadow-md backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
      <span className="text-xs text-ink-muted tabular-nums whitespace-nowrap">
        {t(labelKey, { loaded, total })}
      </span>
      <div className="h-1 w-20 overflow-hidden rounded-full bg-warm-subtle">
        <div
          className="h-full bg-accent transition-all duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 p-1 text-ink-muted transition-colors hover:text-ink"
        aria-label={t("reader.dismiss")}
        title={t("reader.dismiss")}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
          <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
