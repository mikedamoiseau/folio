import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useDebounce } from "../hooks/useDebounce";
import { useFocusTrap } from "../lib/useFocusTrap";

interface HighlightSearchResult {
  highlightId: string;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  chapterIndex: number;
  text: string;
  color: string;
  note: string | null;
  createdAt: number;
}

interface HighlightSearchModalProps {
  onClose: () => void;
  onNavigate: (bookId: string) => void;
}

export default function HighlightSearchModal({
  onClose,
  onNavigate,
}: HighlightSearchModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HighlightSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 250);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    invoke<HighlightSearchResult[]>("search_highlights", {
      query: debouncedQuery,
      limit: 200,
    })
      .then((r) => {
        if (!cancelled) setResults(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const grouped = results.reduce<
    Record<string, { title: string; author: string; items: HighlightSearchResult[] }>
  >((acc, r) => {
    if (!acc[r.bookId]) {
      acc[r.bookId] = { title: r.bookTitle, author: r.bookAuthor, items: [] };
    }
    acc[r.bookId].items.push(r);
    return acc;
  }, {});

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        role="presentation"
      />
      <div
        ref={trapRef}
        className="relative z-10 w-full max-w-2xl max-h-[70vh] flex flex-col bg-surface rounded-xl shadow-2xl border border-warm-border overflow-hidden"
        role="dialog"
        aria-label={t("highlightSearch.title")}
      >
        <div className="p-4 border-b border-warm-border">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("highlightSearch.placeholder")}
              className="w-full pl-10 pr-4 py-2 bg-warm-subtle rounded-lg text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <p className="text-center text-ink-muted text-sm py-8">
              {t("highlightSearch.searching")}
            </p>
          )}
          {!loading && debouncedQuery.trim() && results.length === 0 && (
            <p className="text-center text-ink-muted text-sm py-8">
              {t("highlightSearch.noResults")}
            </p>
          )}
          {!loading && !debouncedQuery.trim() && (
            <p className="text-center text-ink-muted text-sm py-8">
              {t("highlightSearch.hint")}
            </p>
          )}
          {!loading &&
            Object.entries(grouped).map(([bookId, group]) => (
              <div key={bookId} className="mb-4">
                <button
                  type="button"
                  onClick={() => {
                    onNavigate(bookId);
                    onClose();
                  }}
                  className="text-left w-full mb-2 group"
                >
                  <h3 className="text-sm font-semibold text-ink group-hover:text-accent transition-colors">
                    {group.title}
                  </h3>
                  <p className="text-xs text-ink-muted">{group.author}</p>
                </button>
                <div className="space-y-2 ml-2 border-l-2 border-warm-border pl-3">
                  {group.items.map((h) => (
                    <button
                      key={h.highlightId}
                      type="button"
                      onClick={() => {
                        onNavigate(bookId);
                        onClose();
                      }}
                      className="text-left w-full p-2 rounded-lg hover:bg-warm-subtle transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className="mt-1 shrink-0 w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: h.color }}
                        />
                        <div className="min-w-0">
                          <p className="text-sm text-ink line-clamp-2">
                            {h.text}
                          </p>
                          {h.note && (
                            <p className="text-xs text-ink-muted italic mt-0.5 line-clamp-1">
                              {h.note}
                            </p>
                          )}
                          <p className="text-xs text-ink-muted mt-0.5">
                            {t("highlightSearch.chapter", { number: h.chapterIndex + 1 })}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>

        <div className="px-4 py-2 border-t border-warm-border text-xs text-ink-muted text-right">
          {results.length > 0 &&
            t("highlightSearch.resultCount", { count: results.length })}
        </div>
      </div>
    </div>
  );
}
