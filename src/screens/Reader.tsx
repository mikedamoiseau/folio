import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";

// ---- Types matching Rust backend ----

interface TocEntry {
  label: string;
  chapter_index: number;
  children: TocEntry[];
}

interface ReadingProgress {
  book_id: string;
  chapter_index: number;
  scroll_position: number;
  last_read_at: number;
}

interface BookInfo {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
}

// ---- Component ----

interface ReaderProps {
  onOpenSettings: () => void;
}

export default function Reader({ onOpenSettings }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { fontSize, setFontSize, fontFamily } = useTheme();

  const [, setBook] = useState<BookInfo | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [totalChapters, setTotalChapters] = useState(0);
  const [chapterHtml, setChapterHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const restoringScroll = useRef(false);

  // ---- Load book info, TOC, and saved progress on mount ----

  useEffect(() => {
    if (!bookId) return;

    let cancelled = false;

    async function init() {
      try {
        const [bookInfo, tocEntries] = await Promise.all([
          invoke<BookInfo>("get_book", { bookId }),
          invoke<TocEntry[]>("get_toc", { bookId }),
        ]);

        if (cancelled) return;

        setBook(bookInfo);
        setToc(tocEntries);
        setTotalChapters(bookInfo.total_chapters);

        // Restore reading progress
        try {
          const progress = await invoke<ReadingProgress | null>(
            "get_reading_progress",
            { bookId }
          );
          if (!cancelled && progress) {
            setChapterIndex(progress.chapter_index);
            restoringScroll.current = true;
          }
        } catch {
          // No saved progress — start at chapter 0
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // ---- Load chapter content when chapterIndex changes ----

  useEffect(() => {
    if (!bookId || loading) return;

    let cancelled = false;

    async function loadChapter() {
      try {
        const html = await invoke<string>("get_chapter_content", {
          bookId,
          chapterIndex,
        });
        if (!cancelled) {
          setChapterHtml(html);
          // Scroll to top unless restoring a saved position
          if (!restoringScroll.current && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setChapterHtml(
            `<p style="color: #ef4444;">Failed to load chapter: ${String(err)}</p>`
          );
        }
      }
    }

    loadChapter();
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterIndex, loading]);

  // ---- Restore scroll position after chapter HTML renders ----

  useEffect(() => {
    if (!restoringScroll.current || !chapterHtml || !bookId) return;

    async function restoreScroll() {
      try {
        const progress = await invoke<ReadingProgress | null>(
          "get_reading_progress",
          { bookId }
        );
        if (progress && scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          requestAnimationFrame(() => {
            container.scrollTop =
              progress.scroll_position * container.scrollHeight;
            restoringScroll.current = false;
          });
        }
      } catch {
        restoringScroll.current = false;
      }
    }

    restoreScroll();
  }, [chapterHtml, bookId]);

  // ---- Save reading progress ----

  const saveProgress = useCallback(
    async (scrollPos?: number) => {
      if (!bookId) return;
      try {
        await invoke("save_reading_progress", {
          bookId,
          chapterIndex,
          scrollPosition: scrollPos ?? scrollProgress,
        });
      } catch {
        // Silently fail — don't interrupt reading
      }
    },
    [bookId, chapterIndex, scrollProgress]
  );

  // Save progress when chapter changes
  useEffect(() => {
    if (!bookId || loading) return;
    saveProgress(0);
  }, [chapterIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Scroll tracking ----

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container || restoringScroll.current) return;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const maxScroll = scrollHeight - clientHeight;
      const progress = maxScroll > 0 ? scrollTop / maxScroll : 0;
      setScrollProgress(progress);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [chapterHtml]);

  // Save progress on unmount or when leaving
  useEffect(() => {
    return () => {
      saveProgress();
    };
  }, [saveProgress]);

  // ---- Navigation ----

  const goToChapter = useCallback(
    (index: number) => {
      if (index >= 0 && index < totalChapters) {
        setChapterIndex(index);
        setTocOpen(false);
      }
    },
    [totalChapters]
  );

  const prevChapter = useCallback(() => {
    goToChapter(chapterIndex - 1);
  }, [chapterIndex, goToChapter]);

  const nextChapter = useCallback(() => {
    goToChapter(chapterIndex + 1);
  }, [chapterIndex, goToChapter]);

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        prevChapter();
      } else if (e.key === "ArrowRight") {
        nextChapter();
      } else if (e.key === "Escape") {
        setTocOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevChapter, nextChapter]);

  // ---- Current chapter title ----

  const currentChapterTitle =
    toc.find((entry) => entry.chapter_index === chapterIndex)?.label ??
    `Chapter ${chapterIndex + 1}`;

  // ---- Font family CSS value ----

  const fontFamilyCss =
    fontFamily === "serif" ? "Georgia, serif" : "system-ui, sans-serif";

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 text-lg">Loading book...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <div className="text-red-500 text-lg">Failed to load book</div>
        <p className="text-gray-500 text-sm max-w-md text-center">{error}</p>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
        >
          Back to Library
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full relative">
      {/* TOC Sidebar */}
      {tocOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/30 z-10"
            onClick={() => setTocOpen(false)}
          />
          {/* Sidebar */}
          <aside className="fixed left-0 top-0 bottom-0 w-72 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 z-20 flex flex-col shadow-xl">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h2 className="font-semibold text-gray-800 dark:text-gray-200">
                Table of Contents
              </h2>
              <button
                onClick={() => setTocOpen(false)}
                className="p-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                aria-label="Close table of contents"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M15 5L5 15M5 5l10 10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <nav
              className="flex-1 overflow-y-auto py-2"
              aria-label="Table of contents"
            >
              {toc.map((entry) => (
                <TocItem
                  key={`${entry.chapter_index}-${entry.label}`}
                  entry={entry}
                  currentIndex={chapterIndex}
                  onSelect={goToChapter}
                  depth={0}
                />
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* Main reading area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
          <button
            onClick={() => navigate("/")}
            className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            aria-label="Back to library"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M12 4l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            onClick={() => setTocOpen(true)}
            className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            aria-label="Open table of contents"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M3 5h14M3 10h14M3 15h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <h1 className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
            {currentChapterTitle}
          </h1>

          {/* Font size controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setFontSize(fontSize - 2)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors disabled:opacity-30"
              aria-label="Decrease font size"
            >
              A-
            </button>
            <span className="text-xs text-gray-400 w-8 text-center tabular-nums">
              {fontSize}
            </span>
            <button
              onClick={() => setFontSize(fontSize + 2)}
              disabled={fontSize >= MAX_FONT_SIZE}
              className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors disabled:opacity-30"
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>

          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            aria-label="Open settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M16.2 12.3a1.3 1.3 0 00.26 1.43l.05.05a1.58 1.58 0 11-2.23 2.23l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.14a1.58 1.58 0 01-3.16 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.58 1.58 0 11-2.23-2.23l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.14a1.58 1.58 0 010-3.16h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.58 1.58 0 112.23-2.23l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.14a1.58 1.58 0 013.16 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.58 1.58 0 112.23 2.23l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.14a1.58 1.58 0 010 3.16h-.07a1.3 1.3 0 00-1.19.79z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </header>

        {/* Chapter content */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto scroll-smooth"
        >
          <div
            ref={contentRef}
            className="reader-content max-w-[680px] mx-auto px-6 py-8"
            style={{
              fontSize: `${fontSize}px`,
              lineHeight: 1.7,
              fontFamily: fontFamilyCss,
            }}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(chapterHtml) }}
          />

          {/* Chapter navigation at bottom of content */}
          <div className="max-w-[680px] mx-auto px-6 pb-8 flex items-center justify-between">
            <button
              onClick={prevChapter}
              disabled={chapterIndex <= 0}
              className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={nextChapter}
              disabled={chapterIndex >= totalChapters - 1}
              className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <footer className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-1.5 flex items-center gap-3">
          <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
            Chapter {chapterIndex + 1} / {totalChapters}
          </span>
          <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-150"
              style={{ width: `${scrollProgress * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-400 tabular-nums w-8 text-right">
            {Math.round(scrollProgress * 100)}%
          </span>
        </footer>
      </div>
    </div>
  );
}

// ---- TOC Item (recursive for nested entries) ----

function TocItem({
  entry,
  currentIndex,
  onSelect,
  depth,
}: {
  entry: TocEntry;
  currentIndex: number;
  onSelect: (index: number) => void;
  depth: number;
}) {
  const isActive = entry.chapter_index === currentIndex;

  return (
    <>
      <button
        onClick={() => onSelect(entry.chapter_index)}
        className={`w-full text-left px-4 py-2 text-sm transition-colors ${
          isActive
            ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium"
            : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        }`}
        style={{ paddingLeft: `${16 + depth * 16}px` }}
      >
        {entry.label}
      </button>
      {entry.children.map((child) => (
        <TocItem
          key={`${child.chapter_index}-${child.label}`}
          entry={child}
          currentIndex={currentIndex}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </>
  );
}
