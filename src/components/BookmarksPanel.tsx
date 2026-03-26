import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Bookmark {
  id: string;
  book_id: string;
  chapter_index: number;
  scroll_position: number;
  note: string | null;
  created_at: number;
}

interface BookmarksPanelProps {
  bookId: string;
  currentChapterIndex: number;
  toc: Array<{ label: string; chapter_index: number }>;
  onClose: () => void;
  onNavigate: (chapterIndex: number, scrollPosition: number) => void;
}

export type { Bookmark };

export default function BookmarksPanel({
  bookId,
  currentChapterIndex,
  toc,
  onClose,
  onNavigate,
}: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const loadBookmarks = useCallback(async () => {
    try {
      const bms = await invoke<Bookmark[]>("get_bookmarks", { bookId });
      setBookmarks(bms);
    } catch {
      // non-fatal
    }
  }, [bookId]);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const handleDelete = async (bookmarkId: string) => {
    try {
      await invoke("remove_bookmark", { bookmarkId });
      await loadBookmarks();
    } catch {
      // ignore
    }
  };

  const chapterLabel = (chapterIndex: number) => {
    const entry = toc.find((e) => e.chapter_index === chapterIndex);
    return entry?.label ?? `Chapter ${chapterIndex + 1}`;
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  // Sort by chapter then scroll position
  const sorted = [...bookmarks].sort((a, b) => {
    if (a.chapter_index !== b.chapter_index)
      return a.chapter_index - b.chapter_index;
    return a.scroll_position - b.scroll_position;
  });

  // Group by chapter
  const grouped = sorted.reduce<Record<number, Bookmark[]>>((acc, bm) => {
    (acc[bm.chapter_index] ??= []).push(bm);
    return acc;
  }, {});

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/20 z-10 animate-fade-in"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-20 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-right">
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold text-ink">
            Bookmarks
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
            aria-label="Close bookmarks"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path
                d="M15 5L5 15M5 5l10 10"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {bookmarks.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-muted text-center">
              No bookmarks yet. Press <kbd className="px-1.5 py-0.5 bg-warm-subtle rounded text-xs font-mono">b</kbd> while reading to add one.
            </p>
          ) : (
            Object.entries(grouped).map(([chapterStr, chapterBookmarks]) => {
              const chapterIdx = Number(chapterStr);
              return (
                <div key={chapterStr}>
                  <div className="px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted text-left flex items-center gap-1.5">
                    {chapterIdx === currentChapterIndex && (
                      <span className="w-1 h-1 rounded-full bg-accent" />
                    )}
                    {chapterLabel(chapterIdx)}
                  </div>
                  {chapterBookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="group px-5 py-2.5 hover:bg-warm-subtle transition-colors cursor-pointer"
                      onClick={() =>
                        onNavigate(bm.chapter_index, bm.scroll_position)
                      }
                    >
                      <div className="flex items-center gap-2">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          className="text-accent shrink-0"
                        >
                          <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-ink leading-snug">
                            {Math.round(bm.scroll_position * 100)}% through
                          </p>
                          {bm.note && (
                            <p className="text-xs text-ink-muted mt-0.5 italic truncate">
                              {bm.note}
                            </p>
                          )}
                          <p className="text-[10px] text-ink-muted/60 mt-0.5">
                            {formatDate(bm.created_at)}
                          </p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(bm.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all shrink-0"
                          aria-label="Delete bookmark"
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 20 20"
                            fill="none"
                          >
                            <path
                              d="M15 5L5 15M5 5l10 10"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
