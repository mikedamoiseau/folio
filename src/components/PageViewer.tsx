import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
}

export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
}: PageViewerProps) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [imageData, setImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (index: number) => {
      setLoading(true);
      setError(null);
      try {
        const command = format === "pdf" ? "get_pdf_page" : "get_comic_page";
        const data = await invoke<string>(command, {
          bookId,
          pageIndex: index,
        });
        setImageData(data);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [bookId, format]
  );

  useEffect(() => {
    loadPage(pageIndex);
  }, [pageIndex, loadPage]);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalPages) return;
      setPageIndex(index);
      onPageChange?.(index);
    },
    [totalPages, onPageChange]
  );

  const prevPage = useCallback(() => goTo(pageIndex - 1), [pageIndex, goTo]);
  const nextPage = useCallback(() => goTo(pageIndex + 1), [pageIndex, goTo]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") prevPage();
      else if (e.key === "ArrowRight") nextPage();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevPage, nextPage]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-paper">
      {/* Page image area */}
      <div className="flex-1 flex items-center justify-center overflow-hidden px-4 py-4">
        {loading ? (
          <div className="text-sm text-ink-muted">Loading page…</div>
        ) : error ? (
          <div className="text-sm text-red-500 text-center max-w-sm">
            Failed to load page: {error}
          </div>
        ) : imageData ? (
          <img
            src={imageData}
            alt={`Page ${pageIndex + 1} of ${totalPages}`}
            className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
            draggable={false}
          />
        ) : null}
      </div>

      {/* Navigation bar */}
      <div className="shrink-0 border-t border-warm-border bg-surface px-5 py-3 flex items-center gap-3">
        <button
          onClick={prevPage}
          disabled={pageIndex <= 0}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path
              d="M12 4l-6 6 6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Prev
        </button>

        <span className="flex-1 text-center text-xs text-ink-muted tabular-nums">
          Page {pageIndex + 1} / {totalPages}
        </span>

        <button
          onClick={nextPage}
          disabled={pageIndex >= totalPages - 1}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          Next
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path
              d="M8 4l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
