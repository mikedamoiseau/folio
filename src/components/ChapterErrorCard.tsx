import { useTranslation } from "react-i18next";

interface ChapterErrorCardProps {
  /** The error detail to surface in the message. */
  error: string;
  /** Re-run the chapter load. */
  onRetry: () => void;
}

/**
 * Recoverable error card shown when a chapter fails to load in the reader.
 * Mirrors the page-load error card in PageViewer: a message plus a retry
 * button that re-invokes the load.
 */
export default function ChapterErrorCard({ error, onRetry }: ChapterErrorCardProps) {
  const { t } = useTranslation();

  return (
    <div className="max-w-[680px] mx-auto px-8 py-10 flex flex-col items-center gap-3 text-center">
      <p className="text-red-500 dark:text-red-400 text-sm max-w-sm">
        {t("reader.failedToLoadChapter", { error })}
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
      >
        {t("common.retry")}
      </button>
    </div>
  );
}
