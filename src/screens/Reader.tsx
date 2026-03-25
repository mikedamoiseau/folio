import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import PageViewer from "../components/PageViewer";

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
  format: "epub" | "cbz" | "cbr" | "pdf";
}

// ---- Component ----

interface ReaderProps {
  onOpenSettings: () => void;
}

export default function Reader({ onOpenSettings }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { fontSize, setFontSize, fontFamily } = useTheme();

  const [bookTitle, setBookTitle] = useState("");
  const [bookFormat, setBookFormat] = useState<"epub" | "cbz" | "cbr" | "pdf">("epub");
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [totalChapters, setTotalChapters] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [chapterHtml, setChapterHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);

  const [chapterError, setChapterError] = useState<string | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const restoringScroll = useRef(false);
  const savedScrollPosition = useRef<number | null>(null);

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

        setBookTitle(bookInfo.title);
        setBookFormat(bookInfo.format);
        setToc(tocEntries);
        setTotalChapters(bookInfo.total_chapters);

        if (bookInfo.format !== "epub") {
          try {
            const command =
              bookInfo.format === "pdf"
                ? "get_pdf_page_count"
                : "get_comic_page_count";
            const count = await invoke<number>(command, { bookId });
            if (!cancelled) setPageCount(count);
          } catch {
            // page count unavailable
          }
        }

        try {
          const progress = await invoke<ReadingProgress | null>(
            "get_reading_progress",
            { bookId }
          );
          if (!cancelled && progress) {
            setChapterIndex(progress.chapter_index);
            savedScrollPosition.current = progress.scroll_position;
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
          setChapterError(null);
          if (!restoringScroll.current && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setChapterError(String(err));
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

    const scrollPos = savedScrollPosition.current;
    if (scrollPos !== null && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      requestAnimationFrame(() => {
        container.scrollTop = scrollPos * container.scrollHeight;
        restoringScroll.current = false;
        savedScrollPosition.current = null;
      });
    } else {
      restoringScroll.current = false;
      savedScrollPosition.current = null;
    }
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
    fontFamily === "serif"
      ? '"Lora", Georgia, serif'
      : '"DM Sans", system-ui, sans-serif';

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-paper">
        <div className="text-sm text-ink-muted">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 bg-paper">
        <div className="text-ink font-medium">Failed to load book</div>
        <p className="text-ink-muted text-sm max-w-md text-center">{error}</p>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors text-sm font-medium"
        >
          Back to Library
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full relative bg-paper">
      {/* TOC Sidebar — slide-in animation */}
      {tocOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink/20 z-10 animate-fade-in"
            onClick={() => setTocOpen(false)}
          />
          {/* Sidebar */}
          <aside className="fixed left-0 top-0 bottom-0 w-72 bg-surface border-r border-warm-border z-20 flex flex-col shadow-[4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-left">
            <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
              <h2 className="font-serif text-base font-semibold text-ink">
                Contents
              </h2>
              <button
                onClick={() => setTocOpen(false)}
                className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
                aria-label="Close table of contents"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Book title */}
            {bookTitle && (
              <div className="px-5 py-3 border-b border-warm-border">
                <p className="font-serif text-sm font-medium text-ink leading-snug truncate">{bookTitle}</p>
              </div>
            )}

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
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-warm-border bg-surface shrink-0">
          <button
            onClick={() => navigate("/")}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle"
            aria-label="Back to library"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            onClick={() => setTocOpen(true)}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle"
            aria-label="Open table of contents"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>

          <h1 className="flex-1 text-sm text-ink-muted truncate font-medium px-1">
            {currentChapterTitle}
          </h1>

          {/* Font size controls */}
          <div className="flex items-center gap-0.5 mr-1">
            <button
              onClick={() => setFontSize(fontSize - 2)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-30"
              aria-label="Decrease font size"
            >
              A−
            </button>
            <span className="text-xs text-ink-muted w-7 text-center tabular-nums">
              {fontSize}
            </span>
            <button
              onClick={() => setFontSize(fontSize + 2)}
              disabled={fontSize >= MAX_FONT_SIZE}
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-30"
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>

          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle"
            aria-label="Open settings"
          >
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
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

        {/* Content area — epub chapter reader or page-based viewer */}
        {bookFormat !== "epub" ? (
          pageCount > 0 ? (
            <PageViewer
              bookId={bookId!}
              format={bookFormat}
              totalPages={pageCount}
              initialPage={chapterIndex}
              onPageChange={(index) => setChapterIndex(index)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-ink-muted">Loading pages…</p>
            </div>
          )
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto"
            >
              {chapterError ? (
                <div className="max-w-[680px] mx-auto px-8 py-10">
                  <p className="text-red-500 text-sm">Failed to load chapter: {chapterError}</p>
                </div>
              ) : (
                <div
                  ref={contentRef}
                  className="reader-content max-w-[680px] mx-auto px-8 py-10"
                  style={{
                    fontSize: `${fontSize}px`,
                    lineHeight: 1.8,
                    fontFamily: fontFamilyCss,
                  }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(chapterHtml) }}
                />
              )}

              {/* Chapter navigation */}
              <div className="max-w-[680px] mx-auto px-8 pb-12 flex items-center justify-between gap-4">
                <button
                  onClick={prevChapter}
                  disabled={chapterIndex <= 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Previous
                </button>
                <span className="text-xs text-ink-muted tabular-nums">
                  {chapterIndex + 1} / {totalChapters}
                </span>
                <button
                  onClick={nextChapter}
                  disabled={chapterIndex >= totalChapters - 1}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Progress bar */}
            <footer className="shrink-0 border-t border-warm-border bg-surface px-5 py-2 flex items-center gap-3">
              <span className="text-[11px] text-ink-muted tabular-nums whitespace-nowrap">
                Ch. {chapterIndex + 1} / {totalChapters}
              </span>
              <div className="flex-1 h-[3px] bg-warm-subtle rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-200"
                  style={{ width: `${scrollProgress * 100}%` }}
                />
              </div>
              <span className="text-[11px] text-ink-muted tabular-nums w-8 text-right">
                {Math.round(scrollProgress * 100)}%
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

// ---- TOC Item (recursive) ----

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
        className={`w-full text-left py-2 text-sm transition-colors ${
          isActive
            ? "text-accent font-medium bg-accent-light"
            : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
        }`}
        style={{ paddingLeft: `${20 + depth * 14}px`, paddingRight: "16px" }}
      >
        {isActive && (
          <span className="inline-block w-1 h-1 rounded-full bg-accent mr-2 align-middle" />
        )}
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
