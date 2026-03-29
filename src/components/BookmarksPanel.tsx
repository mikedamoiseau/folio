import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface Bookmark {
  id: string;
  book_id: string;
  chapter_index: number;
  scroll_position: number;
  name: string | null;
  note: string | null;
  created_at: number;
}

interface BookmarksPanelProps {
  bookId: string;
  currentChapterIndex: number;
  toc: Array<{ label: string; chapter_index: number }>;
  onClose: () => void;
  onNavigate: (chapterIndex: number, scrollPosition: number) => void;
  refreshKey?: number;
}

export type { Bookmark };

export default function BookmarksPanel({
  bookId,
  currentChapterIndex,
  toc,
  onClose,
  onNavigate,
  refreshKey,
}: BookmarksPanelProps) {
  const { t } = useTranslation();
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
  }, [loadBookmarks, refreshKey]);

  const handleDelete = async (bookmarkId: string) => {
    try {
      await invoke("remove_bookmark", { bookmarkId });
      await loadBookmarks();
    } catch {
      // ignore
    }
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditing = (bookmark: Bookmark) => {
    setEditingId(bookmark.id);
    setEditValue(bookmark.name ?? "");
  };

  const saveEdit = async (bookmarkId: string) => {
    const trimmed = editValue.trim();
    try {
      await invoke("update_bookmark", {
        bookmarkId,
        name: trimmed || null,
      });
      await loadBookmarks();
    } catch {
      // non-fatal
    }
    setEditingId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const chapterLabel = (chapterIndex: number) => {
    const entry = toc.find((e) => e.chapter_index === chapterIndex);
    return entry?.label ?? t("reader.chapterDefault", { number: chapterIndex + 1 });
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
            {t("bookmarks.title")}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
            aria-label={t("bookmarks.closeLabel")}
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
            <p className="px-5 py-8 text-sm text-ink-muted text-center" dangerouslySetInnerHTML={{ __html: t("bookmarks.empty") }} />
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
                        editingId !== bm.id &&
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
                          {editingId === bm.id ? (
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  saveEdit(bm.id);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelEdit();
                                }
                              }}
                              onBlur={() => saveEdit(bm.id)}
                              maxLength={100}
                              placeholder={t("bookmarks.namePlaceholder")}
                              className="text-sm text-ink bg-transparent border-b border-accent outline-none w-full py-0.5"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <>
                              <p
                                className="text-sm text-ink leading-snug hover:text-accent transition-colors cursor-text"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditing(bm);
                                }}
                                title={t("bookmarks.clickToEditName")}
                              >
                                {bm.name || t("bookmarks.percentThrough", { percent: Math.round(bm.scroll_position * 100) })}
                              </p>
                              {bm.name && (
                                <p className="text-xs text-ink-muted mt-0.5">
                                  {t("bookmarks.percentThrough", { percent: Math.round(bm.scroll_position * 100) })}
                                </p>
                              )}
                              {bm.note && (
                                <p className="text-xs text-ink-muted mt-0.5 italic truncate">
                                  {bm.note}
                                </p>
                              )}
                            </>
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
                          aria-label={t("bookmarks.deleteLabel")}
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
