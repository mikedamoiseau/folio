import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { BookGridItem } from "../types";
import { useFocusTrap } from "../lib/useFocusTrap";

interface BookPickerModalProps {
  /** Currently-selected book in the pane that's being changed. Hidden
   *  from the grid so the user can't pick the same book they're already
   *  reading on the other side. Pass `null` to show all books. */
  excludeBookId: string | null;
  onSelect: (bookId: string) => void;
  onClose: () => void;
}

/**
 * Modal book picker for the split-view companion pane. Shows the full
 * library as a cover grid with a search box that filters by title and
 * author. Click a card to pick that book for the companion pane.
 *
 * Intentionally minimal: no tag/series/format filters, no sorting
 * controls, no detail popups. Library.tsx already provides those for
 * the main library surface; split-view picking is a one-shot decision.
 */
export default function BookPickerModal({
  excludeBookId,
  onSelect,
  onClose,
}: BookPickerModalProps) {
  const { t } = useTranslation();
  const [books, setBooks] = useState<BookGridItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Trap Tab + Escape inside the dialog so a keyboard user cannot
  // reach the reader behind the modal while the picker is open.
  const dialogRef = useFocusTrap(onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lib = await invoke<BookGridItem[]>("get_library_grid");
        if (!cancelled) setBooks(lib);
      } catch (e) {
        if (!cancelled) {
          setError(typeof e === "string" ? e : (e as Error).message ?? "load failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-focus the search input on open so the user can type-to-filter
  // without reaching for the mouse. (useFocusTrap focuses the first
  // focusable element by default — the close button — so we override
  // it here for the better UX of starting in the search box.)
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return books.filter((b) => {
      if (b.id === excludeBookId) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
      );
    });
  }, [books, excludeBookId, query]);

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-50 animate-fade-in"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("reader.pickCompanionBook")}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-3xl max-h-[80vh] pointer-events-auto animate-fade-in flex flex-col"
        >
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between gap-3">
            <h2 className="font-serif text-base font-semibold text-ink">
              {t("reader.pickCompanionBook")}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 text-ink-muted hover:text-ink hover:bg-warm-subtle rounded-lg transition-colors"
              aria-label={t("common.close")}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path
                  d="M4 4l12 12M16 4L4 16"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="px-5 py-3 border-b border-warm-border">
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("reader.searchLibrary")}
              className="w-full px-3 py-1.5 text-sm bg-warm-subtle text-ink border border-warm-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <p className="text-sm text-ink-muted text-center py-8">
                {t("library.loading")}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-500 text-center py-8">{error}</p>
            )}
            {!loading && !error && filtered.length === 0 && (
              <p className="text-sm text-ink-muted text-center py-8">
                {t("reader.noBooksFound")}
              </p>
            )}
            {!loading && !error && filtered.length > 0 && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-4">
                {filtered.map((book) => {
                  const coverSrc = book.cover_path
                    ? convertFileSrc(book.cover_path)
                    : null;
                  return (
                    <li key={book.id}>
                      <button
                        onClick={() => onSelect(book.id)}
                        className="w-full text-left group focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-md transition-transform hover:-translate-y-0.5"
                      >
                        <div className="aspect-[2/3] rounded-md bg-warm-subtle border border-warm-border overflow-hidden mb-1.5 shadow-sm group-hover:shadow-md transition-shadow">
                          {coverSrc ? (
                            <img
                              src={coverSrc}
                              alt=""
                              className="w-full h-full object-cover"
                              draggable={false}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-ink-muted/60 px-2 text-center">
                              {book.format.toUpperCase()}
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-ink leading-tight line-clamp-2">
                          {book.title}
                        </p>
                        <p className="text-[10px] text-ink-muted leading-tight mt-0.5 line-clamp-1">
                          {book.author}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
