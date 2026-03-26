import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import PageViewer from "../components/PageViewer";
import KeyboardShortcutsHelp from "../components/KeyboardShortcutsHelp";
import HighlightsPanel, { HIGHLIGHT_COLORS } from "../components/HighlightsPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import { friendlyError } from "../lib/errors";

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
  settingsOpen?: boolean;
}

export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkToast, setBookmarkToast] = useState(false);
  const [saveIndicator, setSaveIndicator] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string; startOffset: number; endOffset: number } | null>(null);

  // Do Not Disturb mode
  const [dndMode, setDndMode] = useState(false);
  const [dndShowControls, setDndShowControls] = useState(false);
  const [dndCursorHidden, setDndCursorHidden] = useState(false);
  const dndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chapterError, setChapterError] = useState<string | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chapterNavRef = useRef<HTMLDivElement>(null);
  const [bottomNavVisible, setBottomNavVisible] = useState(true);
  const sessionStartRef = useRef<number>(Math.floor(Date.now() / 1000));
  const startChapterRef = useRef<number>(0);
  const restoringScroll = useRef<number | null>(null);
  const savedScrollPosition = useRef<number | null>(null);

  // ---- Load book info, TOC, and saved progress on mount ----

  useEffect(() => {
    if (!bookId) return;

    let cancelled = false;

    async function init() {
      try {
        const bookInfo = await invoke<BookInfo>("get_book", { bookId });

        if (cancelled) return;

        setBookTitle(bookInfo.title);
        setBookFormat(bookInfo.format);
        setTotalChapters(bookInfo.total_chapters);

        if (bookInfo.format === "epub") {
          const tocEntries = await invoke<TocEntry[]>("get_toc", { bookId });
          if (!cancelled) setToc(tocEntries);
        }

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
            restoringScroll.current = progress.chapter_index;
          }
        } catch {
          // No saved progress — start at chapter 0
        }
      } catch (err) {
        if (!cancelled) {
          setError(friendlyError(String(err)));
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
          if (restoringScroll.current !== chapterIndex && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setChapterError(friendlyError(String(err)));
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
    if (restoringScroll.current !== chapterIndex || !chapterHtml || !bookId) return;

    const scrollPos = savedScrollPosition.current;
    if (scrollPos !== null && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      requestAnimationFrame(() => {
        container.scrollTop = scrollPos * container.scrollHeight;
        restoringScroll.current = null;
        savedScrollPosition.current = null;
      });
    } else {
      restoringScroll.current = null;
      savedScrollPosition.current = null;
    }
  }, [chapterHtml, bookId, chapterIndex]);

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
        setSaveIndicator(true);
        setTimeout(() => setSaveIndicator(false), 1500);
      } catch {
        // Show brief error indicator — don't interrupt reading
        setSaveError(true);
        setTimeout(() => setSaveError(false), 2000);
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
      if (!container || restoringScroll.current === chapterIndex) return;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const maxScroll = scrollHeight - clientHeight;
      const progress = maxScroll > 0 ? scrollTop / maxScroll : 0;
      setScrollProgress(progress);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [chapterHtml, chapterIndex]);

  useEffect(() => {
    startChapterRef.current = chapterIndex;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      saveProgress();
      // Record reading session on unmount
      const now = Math.floor(Date.now() / 1000);
      const duration = now - sessionStartRef.current;
      if (bookId && duration >= 10) {
        invoke("record_reading_session", {
          bookId,
          startedAt: sessionStartRef.current,
          durationSecs: duration,
          pagesRead: Math.abs(chapterIndex - startChapterRef.current) + 1,
        }).catch(() => {});
      }
    };
  }, [saveProgress, bookId, chapterIndex]);

  // Text selection handler for highlights
  useEffect(() => {
    function handleMouseUp() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !contentRef.current) {
        return;
      }
      const text = selection.toString().trim();
      if (!text || text.length < 3) return;

      const range = selection.getRangeAt(0);
      if (!contentRef.current.contains(range.commonAncestorContainer)) return;

      const rect = range.getBoundingClientRect();
      const containerRect = scrollContainerRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      // Compute text offset relative to the reader-content div
      const preRange = document.createRange();
      preRange.selectNodeContents(contentRef.current);
      preRange.setEnd(range.startContainer, range.startOffset);
      const startOffset = preRange.toString().length;
      const endOffset = startOffset + text.length;

      const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
      setSelectionPopup({
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top - containerRect.top + scrollTop - 8,
        text,
        startOffset,
        endOffset,
      });
    }

    function handleMouseDown(e: MouseEvent) {
      // Dismiss popup when clicking outside it
      const target = e.target as HTMLElement;
      if (!target.closest('[data-highlight-popup]')) {
        setSelectionPopup(null);
      }
    }

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [chapterHtml]);

  // ---- Highlights ----
  interface ChapterHighlight { id: string; startOffset: number; endOffset: number; color: string }
  const [highlights, setHighlights] = useState<ChapterHighlight[]>([]);

  const loadHighlights = useCallback(async () => {
    if (!bookId) return;
    try {
      const all = await invoke<Array<{ id: string; chapterIndex: number; startOffset: number; endOffset: number; color: string }>>("get_highlights", { bookId });
      setHighlights(all.filter((h) => h.chapterIndex === chapterIndex));
    } catch {
      // ignore
    }
  }, [bookId, chapterIndex]);

  useEffect(() => {
    loadHighlights();
  }, [loadHighlights]);

  // Inject highlight <mark> tags into the sanitized HTML string.
  // This survives React re-renders (unlike DOM manipulation).
  const highlightedHtml = useMemo(() => {
    const html = chapterHtml;
    if (highlights.length === 0) return html;

    // Walk the HTML string, tracking text offset (skip inside tags).
    // Build a map: textOffset -> htmlIndex for insertion points.
    const textToHtml: number[] = []; // textToHtml[textOffset] = htmlIndex
    let inTag = false;
    let textOffset = 0;
    for (let i = 0; i < html.length; i++) {
      if (html[i] === "<") { inTag = true; continue; }
      if (html[i] === ">") { inTag = false; continue; }
      if (!inTag) {
        textToHtml[textOffset] = i;
        textOffset++;
      }
    }
    textToHtml[textOffset] = html.length; // sentinel

    // Sort highlights by startOffset (stable for insertion)
    const sorted = [...highlights].sort((a, b) => a.startOffset - b.startOffset);

    // Build result by inserting <mark> and </mark> at the right HTML positions
    type Insertion = { htmlIdx: number; tag: string; priority: number };
    const insertions: Insertion[] = [];
    for (const hl of sorted) {
      const startIdx = textToHtml[hl.startOffset];
      const endIdx = textToHtml[hl.endOffset];
      if (startIdx == null || endIdx == null) continue;
      insertions.push({
        htmlIdx: startIdx,
        tag: `<mark style="background-color:${hl.color}44;border-radius:2px;padding:1px 0">`,
        priority: 0,
      });
      insertions.push({
        htmlIdx: endIdx,
        tag: "</mark>",
        priority: 1,
      });
    }

    // Sort by position (descending) so we insert from end to start without shifting indices
    insertions.sort((a, b) => b.htmlIdx - a.htmlIdx || b.priority - a.priority);

    let result = html;
    for (const ins of insertions) {
      result = result.slice(0, ins.htmlIdx) + ins.tag + result.slice(ins.htmlIdx);
    }
    return result;
  }, [chapterHtml, highlights]);

  const handleCreateHighlight = useCallback(async (color: string) => {
    if (!bookId || !selectionPopup) return;
    try {
      await invoke("add_highlight", {
        bookId,
        chapterIndex,
        text: selectionPopup.text,
        color,
        note: null,
        startOffset: selectionPopup.startOffset,
        endOffset: selectionPopup.endOffset,
      });
      setSelectionPopup(null);
      window.getSelection()?.removeAllRanges();
      await loadHighlights();
    } catch (err) {
      console.error("Failed to create highlight:", err);
    }
  }, [bookId, chapterIndex, selectionPopup, loadHighlights]);

  const handleClearHighlight = useCallback(async () => {
    if (!bookId || !selectionPopup) return;
    // Find highlights that overlap the selected range
    const overlapping = highlights.filter(
      (h) => h.startOffset < selectionPopup.endOffset && h.endOffset > selectionPopup.startOffset
    );
    try {
      for (const h of overlapping) {
        await invoke("remove_highlight", { highlightId: h.id });
      }
      setSelectionPopup(null);
      window.getSelection()?.removeAllRanges();
      await loadHighlights();
    } catch (err) {
      console.error("Failed to clear highlight:", err);
    }
  }, [bookId, selectionPopup, highlights, loadHighlights]);

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

  const navigateToBookmark = useCallback(
    (targetChapter: number, targetScrollPosition: number) => {
      setBookmarksOpen(false);
      if (targetChapter !== chapterIndex) {
        setChapterIndex(targetChapter);
        savedScrollPosition.current = targetScrollPosition;
        restoringScroll.current = targetChapter;
      } else if (scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        container.scrollTop = targetScrollPosition * container.scrollHeight;
      }
    },
    [chapterIndex]
  );

  const prevChapter = useCallback(() => {
    goToChapter(chapterIndex - 1);
  }, [chapterIndex, goToChapter]);

  const nextChapter = useCallback(() => {
    goToChapter(chapterIndex + 1);
  }, [chapterIndex, goToChapter]);

  // ---- Keyboard shortcuts ----

  const addBookmarkAtCurrentPosition = useCallback(async () => {
    if (!bookId) return;
    try {
      await invoke("add_bookmark", {
        bookId,
        chapterIndex,
        scrollPosition: scrollProgress,
      });
      setBookmarkToast(true);
      setTimeout(() => setBookmarkToast(false), 1500);
    } catch {
      // silently fail
    }
  }, [bookId, chapterIndex, scrollProgress]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Let SettingsPanel handle Escape and Tab when it is open
      if (settingsOpen && (e.key === "Escape" || e.key === "Tab")) return;

      // Don't navigate chapters when any panel is open
      if ((settingsOpen || tocOpen || bookmarksOpen) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;

      if (e.key === "ArrowLeft") {
        prevChapter();
      } else if (e.key === "ArrowRight") {
        nextChapter();
      } else if (e.key === "t" && !e.metaKey && !e.ctrlKey) {
        setTocOpen((prev) => !prev);
      } else if (e.key === "b" && !e.metaKey && !e.ctrlKey) {
        addBookmarkAtCurrentPosition();
      } else if (e.key === "d" && !e.metaKey && !e.ctrlKey) {
        setDndMode((prev) => !prev);
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setShowShortcuts((prev) => !prev);
      } else if (e.key === "Escape") {
        if (dndMode) { setDndMode(false); return; }
        if (showShortcuts) setShowShortcuts(false);
        else if (bookmarksOpen) setBookmarksOpen(false);
        else if (tocOpen) setTocOpen(false);
        else navigate("/");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevChapter, nextChapter, addBookmarkAtCurrentPosition, showShortcuts, tocOpen, bookmarksOpen, dndMode, settingsOpen, navigate]);

  // ---- TOC focus trap ----

  useEffect(() => {
    if (!tocOpen) return;
    const sidebar = document.getElementById("toc-sidebar");
    if (!sidebar) return;

    const focusable = sidebar.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    function trapFocus(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    first?.focus();
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [tocOpen]);

  // ---- Track bottom nav visibility for floating arrows ----

  useEffect(() => {
    const el = chapterNavRef.current;
    const container = scrollContainerRef.current;
    if (!el || !container) return;

    const observer = new IntersectionObserver(
      ([entry]) => setBottomNavVisible(entry.isIntersecting),
      { root: container, threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [chapterHtml]);

  // ---- DND mode: auto-hide cursor & reveal controls on edge hover ----

  useEffect(() => {
    if (!dndMode) {
      setDndCursorHidden(false);
      setDndShowControls(false);
      if (dndTimerRef.current) clearTimeout(dndTimerRef.current);
      return;
    }

    function handleMouseMove(e: MouseEvent) {
      setDndCursorHidden(false);
      // Show controls when mouse is near top or bottom edge (48px)
      const nearEdge = e.clientY < 48 || e.clientY > window.innerHeight - 48;
      setDndShowControls(nearEdge);

      if (dndTimerRef.current) clearTimeout(dndTimerRef.current);
      dndTimerRef.current = setTimeout(() => {
        setDndCursorHidden(true);
        setDndShowControls(false);
      }, 2000);
    }

    document.addEventListener("mousemove", handleMouseMove);
    // Start the hide timer immediately
    dndTimerRef.current = setTimeout(() => {
      setDndCursorHidden(true);
    }, 2000);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      if (dndTimerRef.current) clearTimeout(dndTimerRef.current);
    };
  }, [dndMode]);

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

  const showHeader = !dndMode || dndShowControls;
  const showFooter = !dndMode || dndShowControls;

  return (
    <div className={`flex h-full relative bg-paper ${dndCursorHidden ? "cursor-none" : ""}`}>
      {/* Keyboard shortcuts help */}
      {showShortcuts && (
        <KeyboardShortcutsHelp context="reader" onClose={() => setShowShortcuts(false)} />
      )}

      {/* Highlights Panel */}
      {highlightsOpen && (
        <HighlightsPanel
          bookId={bookId!}
          onClose={() => setHighlightsOpen(false)}
          onGoToChapter={(index) => { goToChapter(index); setHighlightsOpen(false); }}
        />
      )}

      {/* Bookmarks Panel */}
      {bookmarksOpen && (
        <BookmarksPanel
          bookId={bookId!}
          currentChapterIndex={chapterIndex}
          toc={toc}
          onClose={() => setBookmarksOpen(false)}
          onNavigate={navigateToBookmark}
        />
      )}

      {/* Bookmark toast */}
      {bookmarkToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-ink/90 text-white text-sm rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          Bookmark saved
        </div>
      )}

      {/* Progress saved indicator */}
      {saveIndicator && (
        <div className="fixed bottom-4 right-4 z-50 text-xs text-gray-400 dark:text-gray-500 transition-opacity">
          Progress saved
        </div>
      )}

      {/* Progress save error indicator */}
      {saveError && (
        <div className="fixed bottom-4 right-4 z-50 text-xs text-amber-500 dark:text-amber-400 transition-opacity">
          Progress not saved
        </div>
      )}

      {/* TOC Sidebar — slide-in animation */}
      {tocOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink/20 z-10 animate-fade-in"
            onClick={() => setTocOpen(false)}
          />
          {/* Sidebar */}
          <aside id="toc-sidebar" role="dialog" aria-modal="true" aria-label="Table of Contents" className="fixed left-0 top-0 bottom-0 w-72 bg-surface border-r border-warm-border z-20 flex flex-col shadow-[4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-left">
            <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
              <h2 className="font-serif text-base font-semibold text-ink">
                Contents
              </h2>
              <button
                onClick={() => setTocOpen(false)}
                className="p-1 text-ink-muted hover:text-ink transition-colors rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
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
        <header className={`flex items-center gap-2 px-4 py-2.5 border-b border-warm-border bg-surface shrink-0 transition-all duration-300 ${showHeader ? "opacity-100 max-h-20" : "opacity-0 max-h-0 overflow-hidden py-0 border-b-0"}`}>
          <button
            onClick={() => navigate("/")}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            aria-label="Back to library"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            onClick={() => setTocOpen(true)}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            aria-label="Open table of contents"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>

          <h1 className="flex-1 text-sm text-ink-muted truncate font-medium px-1">
            {currentChapterTitle}
          </h1>

          {/* Highlights button */}
          <button
            onClick={() => setHighlightsOpen((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${highlightsOpen ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label="Highlights"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Bookmarks button */}
          <button
            onClick={() => setBookmarksOpen((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${bookmarksOpen ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label="Bookmarks"
            title="Bookmarks"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-3.5L5 21V5a2 2 0 012-2h10a2 2 0 012 2z" />
            </svg>
          </button>

          {/* Font size controls */}
          <div className="flex items-center gap-0.5 mr-1">
            <button
              onClick={() => setFontSize(fontSize - 2)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
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
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              aria-label="Increase font size"
            >
              A+
            </button>
          </div>

          {/* DND toggle */}
          <button
            onClick={() => setDndMode((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${dndMode ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label="Toggle focus mode"
            title="Focus mode (d)"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 8v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
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
              className="flex-1 overflow-y-auto relative"
            >
              {/* Floating prev/next arrows — visible when bottom nav is scrolled out of view */}
              {!bottomNavVisible && bookFormat === "epub" && !dndMode && (
                <>
                  {chapterIndex > 0 && (
                    <button
                      onClick={prevChapter}
                      className="fixed left-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-surface/90 border border-warm-border shadow-md text-ink-muted hover:text-ink hover:bg-surface transition-all opacity-60 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                      aria-label="Previous chapter"
                    >
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                        <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  {chapterIndex < totalChapters - 1 && (
                    <button
                      onClick={nextChapter}
                      className="fixed right-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-surface/90 border border-warm-border shadow-md text-ink-muted hover:text-ink hover:bg-surface transition-all opacity-60 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                      aria-label="Next chapter"
                    >
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                        <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </>
              )}
              {/* Highlight color popup */}
              {selectionPopup && (
                <div
                  data-highlight-popup
                  className="absolute z-30 flex items-center gap-1 px-2 py-1.5 bg-ink/90 backdrop-blur-sm rounded-lg shadow-lg"
                  style={{
                    left: `${selectionPopup.x}px`,
                    top: `${selectionPopup.y}px`,
                    transform: "translate(-50%, -100%)",
                  }}
                >
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => handleCreateHighlight(c.value)}
                      className="w-5 h-5 rounded-full hover:scale-125 transition-transform"
                      style={{ backgroundColor: c.value }}
                      aria-label={`Highlight ${c.name}`}
                    />
                  ))}
                  {/* Clear highlight — only show if selection overlaps existing highlights */}
                  {selectionPopup && highlights.some((h) => h.startOffset < selectionPopup.endOffset && h.endOffset > selectionPopup.startOffset) && (
                    <button
                      onClick={handleClearHighlight}
                      className="w-5 h-5 rounded-full hover:scale-125 transition-transform border border-white/40 flex items-center justify-center"
                      style={{ background: "repeating-conic-gradient(#ccc 0% 25%, transparent 0% 50%) 50% / 6px 6px" }}
                      aria-label="Clear highlight"
                      title="Remove highlight"
                    />
                  )}
                  <div className="w-px h-4 bg-white/20 mx-0.5" />
                  <button
                    onClick={() => { setSelectionPopup(null); window.getSelection()?.removeAllRanges(); }}
                    className="w-5 h-5 rounded-full hover:scale-125 transition-transform flex items-center justify-center text-white/60 hover:text-white"
                    aria-label="Dismiss"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}

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
                  dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                />
              )}

              {/* Chapter navigation */}
              <div ref={chapterNavRef} className={`max-w-[680px] mx-auto px-8 pb-12 flex items-center justify-between gap-4 transition-opacity duration-300 ${dndMode && !dndShowControls ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
                <button
                  onClick={prevChapter}
                  disabled={chapterIndex <= 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
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
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  Next
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Progress bar */}
            <footer className={`shrink-0 border-t border-warm-border bg-surface px-5 py-2 flex items-center gap-3 transition-all duration-300 ${showFooter ? "opacity-100 max-h-20" : "opacity-0 max-h-0 overflow-hidden py-0 border-t-0"}`}>
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
        className={`w-full text-left py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset ${
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
