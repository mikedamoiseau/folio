import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import PageViewer from "../components/PageViewer";
import KeyboardShortcutsHelp from "../components/KeyboardShortcutsHelp";
import HighlightsPanel, { HIGHLIGHT_COLORS } from "../components/HighlightsPanel";
import BookmarksPanel from "../components/BookmarksPanel";
import BookmarkToast from "../components/BookmarkToast";
import LanguageSwitcher from "../components/LanguageSwitcher";
import { friendlyError, toFolioError } from "../lib/errors";
import { resolveBookmarkScrollTop } from "../lib/utils";

// ---- Types matching Rust backend ----

interface TocEntry {
  label: string;
  chapter_index: number;
  play_order: string;
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
  format: "epub" | "cbz" | "cbr" | "pdf" | "mobi";
}

// ---- Component ----

interface ReaderProps {
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { fontSize, setFontSize, fontFamily, scrollMode, typography, customCss, dualPage, setDualPage, mangaMode, setMangaMode, pageAnimation } = useTheme();

  const [bookTitle, setBookTitle] = useState("");
  const [bookFormat, setBookFormat] = useState<"epub" | "cbz" | "cbr" | "pdf" | "mobi">("epub");
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
  const [toastBookmarkId, setToastBookmarkId] = useState<string | null>(null);
  const [bookmarkRefreshKey, setBookmarkRefreshKey] = useState(0);
  const [saveIndicator, setSaveIndicator] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string; startOffset: number; endOffset: number } | null>(null);

  // Book search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ chapterIndex: number; snippet: string; matchOffset: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Do Not Disturb mode
  const [dndMode, setDndMode] = useState(false);
  const [dndShowControls, setDndShowControls] = useState(false);
  const [dndCursorHidden, setDndCursorHidden] = useState(false);
  const dndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chapterError, setChapterError] = useState<string | null>(null);
  const [missingFileDialog, setMissingFileDialog] = useState(false);

  // Continuous scroll mode state
  const [allChaptersHtml, setAllChaptersHtml] = useState<string[]>([]);
  const [allChaptersLoaded, setAllChaptersLoaded] = useState(false);
  const chapterDivRefs = useRef<(HTMLDivElement | null)[]>([]);
  // EPUB and MOBI are both chapter-HTML formats and share the Reader's
  // text-rendering path; PDF/CBZ/CBR go through PageViewer instead.
  const isHtmlBook = bookFormat === "epub" || bookFormat === "mobi";
  const isContinuous = scrollMode === "continuous" && isHtmlBook;

  // Time-to-finish state
  const [chapterWordCounts, setChapterWordCounts] = useState<number[]>([]);
  const READING_WPM = 250;

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chapterNavRef = useRef<HTMLDivElement>(null);
  const [bottomNavVisible, setBottomNavVisible] = useState(true);
  const sessionStartRef = useRef<number>(Math.floor(Date.now() / 1000));
  const startChapterRef = useRef<number>(0);
  const restoringScroll = useRef<number | null>(null);
  const savedScrollPosition = useRef<number | null>(null);
  const targetMatchOffset = useRef<number | null>(null);
  const userHasInteracted = useRef(false);

  const isFileNotFound = (err: unknown): boolean => {
    // Narrow: only the on-disk book file being absent should trigger the
    // "reconnect drive" recovery dialog. NotFound is used broadly in the
    // backend error system (missing EPUB entries, missing pages, missing
    // profiles, …) and must not trigger this flow.
    const { message } = toFolioError(err);
    return message.toLowerCase().includes("book file not found");
  };

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

        // `isHtmlBook` is derived from React state (`bookFormat`), which still
        // holds the previous render's value here — `setBookFormat` above is
        // asynchronous. Gate on the freshly-fetched format so we don't ask
        // the backend for a TOC on PDF/CBZ/CBR (which returns an error and
        // prevents the book from loading).
        if (bookInfo.format === "epub" || bookInfo.format === "mobi") {
          const tocEntries = await invoke<TocEntry[]>("get_toc", { bookId });
          if (!cancelled) setToc(tocEntries);
        } else if (!cancelled) {
          setToc([]);
        }

        if (bookInfo.format === "cbz" || bookInfo.format === "cbr") {
          try {
            await invoke("prepare_comic", { bookId });
          } catch (e) {
            console.warn("Cache preparation failed, falling back to direct read:", e);
          }
        }

        // Page count is only meaningful for fixed-layout (PDF) and image
        // (CBZ/CBR) formats. HTML-reflowable books (EPUB + MOBI) use scroll
        // progress instead, so skip the fetch and leave pageCount at 0.
        if (bookInfo.format === "pdf" || bookInfo.format === "cbz" || bookInfo.format === "cbr") {
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
          if (isFileNotFound(err)) {
            setMissingFileDialog(true);
          }
          setError(friendlyError(err, t));
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

  // ---- Fetch word counts for time-to-finish (HTML chapter formats) ----

  useEffect(() => {
    if (!bookId || loading || !isHtmlBook) return;
    invoke<number[]>("get_chapter_word_counts", { bookId })
      .then(setChapterWordCounts)
      .catch(() => {}); // word counts are best-effort
  }, [bookId, loading, isHtmlBook]);

  // ---- Load all chapters for continuous scroll mode ----

  useEffect(() => {
    if (!bookId || loading || !isContinuous) {
      setAllChaptersLoaded(false);
      setAllChaptersHtml([]);
      return;
    }

    let cancelled = false;

    async function loadAll() {
      try {
        const chapters = await invoke<string[]>("get_all_chapters", { bookId });
        if (!cancelled) {
          setAllChaptersHtml(chapters);
          setAllChaptersLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setChapterError(friendlyError(err, t));
      }
    }

    loadAll();
    return () => { cancelled = true; };
  }, [bookId, loading, isContinuous]);

  // ---- Scroll to saved chapter after all chapters load (continuous mode) ----

  useEffect(() => {
    if (!isContinuous || !allChaptersLoaded || restoringScroll.current === null) return;

    const targetChapter = restoringScroll.current;
    const scrollPos = savedScrollPosition.current;

    // Wait for DOM to render all chapter divs
    requestAnimationFrame(() => {
      const chapterDiv = chapterDivRefs.current[targetChapter];
      const container = scrollContainerRef.current;
      if (chapterDiv && container) {
        // Scroll to the target chapter div, then offset within it
        const chapterTop = chapterDiv.offsetTop;
        const chapterHeight = chapterDiv.offsetHeight;
        container.scrollTop = chapterTop + (scrollPos ?? 0) * chapterHeight;
      }
      savedScrollPosition.current = null;
      // Defer clearing restoringScroll until after the scroll event from the
      // programmatic scrollTop has been dispatched, so the continuous-scroll
      // listener sees restoringScroll !== null and skips setting userHasInteracted.
      requestAnimationFrame(() => {
        restoringScroll.current = null;
      });
    });
  }, [allChaptersLoaded, isContinuous]); // eslint-disable-line react-hooks/exhaustive-deps
  // Note: chapterIndex intentionally excluded — including it would re-fire
  // the restore effect when chapterIndex changes from scroll tracking.

  // ---- Track visible chapter in continuous scroll mode ----

  useEffect(() => {
    if (!isContinuous || !allChaptersLoaded) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    function updateVisibleChapter() {
      if (!container) return;
      // Don't mark as user-interacted during programmatic scroll restore —
      // that would suppress applying valid remote progress updates.
      if (restoringScroll.current === null) {
        userHasInteracted.current = true;
      }
      const containerTop = container.scrollTop;
      const containerMid = containerTop + container.clientHeight / 3;

      for (let i = chapterDivRefs.current.length - 1; i >= 0; i--) {
        const div = chapterDivRefs.current[i];
        if (div && div.offsetTop <= containerMid) {
          setChapterIndex(i);
          break;
        }
      }

      // Update scroll progress as book-global 0-1
      const maxScroll = container.scrollHeight - container.clientHeight;
      setScrollProgress(maxScroll > 0 ? container.scrollTop / maxScroll : 0);
    }

    container.addEventListener("scroll", updateVisibleChapter, { passive: true });
    return () => container.removeEventListener("scroll", updateVisibleChapter);
  }, [isContinuous, allChaptersLoaded]);

  // ---- Load chapter content when chapterIndex changes ----

  useEffect(() => {
    if (!bookId || loading || isContinuous) return;

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
          if (restoringScroll.current !== chapterIndex && targetMatchOffset.current === null && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (isFileNotFound(err)) {
            setMissingFileDialog(true);
          }
          setChapterError(friendlyError(err, t));
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
    if (isContinuous) return; // continuous mode has its own restore
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

  // ---- Scroll to search match after chapter loads ----
  useEffect(() => {
    if (targetMatchOffset.current === null || !chapterHtml || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    const offset = targetMatchOffset.current;
    targetMatchOffset.current = null;
    requestAnimationFrame(() => {
      const textLen = container.textContent?.length || 1;
      container.scrollTop = (offset / textLen) * container.scrollHeight;
    });
  }, [chapterHtml]);

  // ---- Save reading progress ----

  const getChapterScrollPosition = useCallback(() => {
    if (!isContinuous) return scrollProgress;
    const container = scrollContainerRef.current;
    const chapterDiv = chapterDivRefs.current[chapterIndex];
    if (!container || !chapterDiv) return 0;
    const posInChapter = container.scrollTop - chapterDiv.offsetTop;
    const chapterHeight = chapterDiv.offsetHeight;
    return chapterHeight > 0 ? Math.max(0, Math.min(1, posInChapter / chapterHeight)) : 0;
  }, [isContinuous, scrollProgress, chapterIndex]);

  const saveProgress = useCallback(
    async (scrollPos?: number) => {
      if (!bookId) return;
      try {
        await invoke("save_reading_progress", {
          bookId,
          chapterIndex,
          scrollPosition: scrollPos ?? getChapterScrollPosition(),
        });
        setSaveIndicator(true);
        setTimeout(() => setSaveIndicator(false), 1500);
      } catch {
        // Show brief error indicator — don't interrupt reading
        setSaveError(true);
        setTimeout(() => setSaveError(false), 2000);
      }
    },
    [bookId, chapterIndex, getChapterScrollPosition]
  );

  // Save progress on chapter change (paginated mode only — continuous tracks via scroll)
  useEffect(() => {
    if (!bookId || loading || isContinuous) return;
    saveProgress(0);
  }, [chapterIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Scroll tracking (paginated mode) ----

  useEffect(() => {
    if (isContinuous) return; // continuous mode has its own tracking
    const container = scrollContainerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container || restoringScroll.current === chapterIndex) return;
      userHasInteracted.current = true;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const maxScroll = scrollHeight - clientHeight;
      const progress = maxScroll > 0 ? scrollTop / maxScroll : 0;
      setScrollProgress(progress);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [chapterHtml, chapterIndex]);

  const bookIdRef = useRef(bookId);
  const chapterIndexRef = useRef(chapterIndex);
  useEffect(() => { bookIdRef.current = bookId; }, [bookId]);
  useEffect(() => { chapterIndexRef.current = chapterIndex; }, [chapterIndex]);

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

  // Push local changes to sync remote only on reader unmount (not on chapter change).
  // Chains after an explicit save_reading_progress to guarantee the final position
  // is in the DB before the sync payload is built.
  const getScrollPosRef = useRef(getChapterScrollPosition);
  useEffect(() => { getScrollPosRef.current = getChapterScrollPosition; }, [getChapterScrollPosition]);

  useEffect(() => {
    return () => {
      const id = bookIdRef.current;
      if (!id) return;
      invoke("save_reading_progress", {
        bookId: id,
        chapterIndex: chapterIndexRef.current,
        scrollPosition: getScrollPosRef.current(),
      })
        .catch(() => {})
        .finally(() => {
          invoke("sync_push_book", { bookId: id }).catch(() => {});
        });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const loadHighlightsRef = useRef(loadHighlights);
  useEffect(() => { loadHighlightsRef.current = loadHighlights; }, [loadHighlights]);

  useEffect(() => {
    loadHighlights();
  }, [loadHighlights]);

  // ---- Sync: pull on mount, listen for remote updates ----
  // Listeners are registered before the pull to avoid a race where the backend
  // emits events before the frontend is listening. Dependencies are only [bookId]
  // so this effect runs once per book, not on every chapter change.

  useEffect(() => {
    if (!bookId) return;

    // Listen for sync events targeting this book
    const unlistenApplied = listen<string>("sync-applied", (event) => {
      if (event.payload === bookId) {
        // Remote bookmarks/highlights were merged — refresh from DB
        loadHighlightsRef.current();
        setBookmarkRefreshKey((k) => k + 1);
      }
    });

    const unlistenProgress = listen<string>("sync-progress-updated", (event) => {
      if (event.payload === bookId && !userHasInteracted.current) {
        // Remote progress arrived and user hasn't navigated — apply it
        invoke<ReadingProgress | null>("get_reading_progress", { bookId })
          .then((progress) => {
            if (progress && progress.chapter_index !== chapterIndexRef.current) {
              console.info(`[sync] Applying remote reading position: chapter ${progress.chapter_index}`);
              setChapterIndex(progress.chapter_index);
              savedScrollPosition.current = progress.scroll_position;
              restoringScroll.current = progress.chapter_index;
            } else if (progress) {
              savedScrollPosition.current = progress.scroll_position;
              restoringScroll.current = progress.chapter_index;
            }
          })
          .catch(() => {});
      }
    });

    // Pull latest remote state on reader open (non-blocking)
    // Invoked AFTER listeners are registered so events are never missed.
    invoke("sync_pull_book", { bookId }).catch(() => {});

    return () => {
      unlistenApplied.then((fn) => fn());
      unlistenProgress.then((fn) => fn());
    };
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Apply search term highlighting on top of existing highlights
  const searchHighlightedHtml = useMemo(() => {
    if (!searchOpen || !searchQuery.trim() || !highlightedHtml) return highlightedHtml;
    const q = searchQuery.trim();
    // Escape regex special characters
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    // Only replace text outside of HTML tags
    let result = "";
    let inTag = false;
    let textRun = "";
    for (const ch of highlightedHtml) {
      if (ch === "<") {
        // Flush text run with replacements
        result += textRun.replace(regex, '<mark style="background-color:#93c5fd88;border-radius:2px;padding:1px 0">$1</mark>');
        textRun = "";
        inTag = true;
        result += ch;
      } else if (ch === ">") {
        inTag = false;
        result += ch;
      } else if (inTag) {
        result += ch;
      } else {
        textRun += ch;
      }
    }
    // Flush remaining text
    result += textRun.replace(regex, '<mark style="background-color:#93c5fd88;border-radius:2px;padding:1px 0">$1</mark>');
    return result;
  }, [highlightedHtml, searchOpen, searchQuery]);

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
        userHasInteracted.current = true;
        if (isContinuous) {
          // Scroll to the chapter div
          const chapterDiv = chapterDivRefs.current[index];
          const container = scrollContainerRef.current;
          if (chapterDiv && container) {
            container.scrollTop = chapterDiv.offsetTop;
          }
        } else {
          setChapterIndex(index);
        }
        setTocOpen(false);
      }
    },
    [totalChapters, isContinuous]
  );

  const navigateToBookmark = useCallback(
    (targetChapter: number, targetScrollPosition: number) => {
      setBookmarksOpen(false);
      const container = scrollContainerRef.current;

      if (isContinuous && container) {
        // Continuous mode: every chapter div is already mounted in the
        // single scroll container, so we can jump directly regardless of
        // whether this is a same-chapter or cross-chapter bookmark. The
        // ref-based restore effect only re-fires on
        // `[allChaptersLoaded, isContinuous]` changes, so it cannot be
        // relied on for subsequent bookmark clicks.
        if (targetChapter !== chapterIndex) setChapterIndex(targetChapter);
        const chapterDiv = chapterDivRefs.current[targetChapter];
        container.scrollTop = resolveBookmarkScrollTop(true, targetScrollPosition, {
          chapterOffsetTop: chapterDiv?.offsetTop ?? 0,
          chapterHeight: chapterDiv?.offsetHeight ?? 0,
          containerScrollHeight: container.scrollHeight,
        });
        return;
      }

      if (targetChapter !== chapterIndex) {
        // Paginated / single-chapter mode cross-chapter: switching chapters
        // reloads the HTML, so defer the scroll restore until after the
        // render via the ref-based handshake the load effect already
        // consumes.
        setChapterIndex(targetChapter);
        savedScrollPosition.current = targetScrollPosition;
        restoringScroll.current = targetChapter;
      } else if (container) {
        // Paginated same-chapter: positions are container-global.
        const chapterDiv = chapterDivRefs.current[targetChapter];
        container.scrollTop = resolveBookmarkScrollTop(false, targetScrollPosition, {
          chapterOffsetTop: chapterDiv?.offsetTop ?? 0,
          chapterHeight: chapterDiv?.offsetHeight ?? 0,
          containerScrollHeight: container.scrollHeight,
        });
      }
    },
    [chapterIndex, isContinuous]
  );

  const prevChapter = useCallback(() => {
    goToChapter(chapterIndex - 1);
  }, [chapterIndex, goToChapter]);

  const nextChapter = useCallback(() => {
    goToChapter(chapterIndex + 1);
  }, [chapterIndex, goToChapter]);

  // ---- Focus search input when search panel opens ----

  useEffect(() => {
    if (searchOpen) {
      // Wait for the DOM to render the input before focusing
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  // ---- Book search ----

  const executeSearch = useCallback(async (query: string) => {
    if (!bookId || !query.trim()) {
      setSearchResults([]);
      setActiveMatchIndex(-1);
      return;
    }
    setSearching(true);
    try {
      const results = await invoke<{ chapterIndex: number; snippet: string; matchOffset: number }[]>(
        "search_book_content", { bookId, query: query.trim() }
      );
      setSearchResults(results);
      setActiveMatchIndex(results.length > 0 ? 0 : -1);
    } catch {
      setSearchResults([]);
      setActiveMatchIndex(-1);
    } finally {
      setSearching(false);
    }
  }, [bookId]);

  const navigateToMatch = useCallback((index: number) => {
    if (index < 0 || index >= searchResults.length) return;
    const result = searchResults[index];
    setActiveMatchIndex(index);

    if (!isHtmlBook) {
      // PDF/CBZ/CBR: page-level navigation only
      goToChapter(result.chapterIndex);
      return;
    }

    // EPUB: store match offset for scroll-after-load
    targetMatchOffset.current = result.matchOffset;

    if (result.chapterIndex === chapterIndex && scrollContainerRef.current) {
      // Same chapter — scroll immediately
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (!container || targetMatchOffset.current === null) return;
        const textLen = container.textContent?.length || 1;
        container.scrollTop = (targetMatchOffset.current / textLen) * container.scrollHeight;
        targetMatchOffset.current = null;
      });
    } else {
      goToChapter(result.chapterIndex);
    }
  }, [searchResults, goToChapter, bookFormat, chapterIndex]);

  const prevMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const next = activeMatchIndex <= 0 ? searchResults.length - 1 : activeMatchIndex - 1;
    navigateToMatch(next);
  }, [searchResults, activeMatchIndex, navigateToMatch]);

  const nextMatch = useCallback(() => {
    if (searchResults.length === 0) return;
    const next = activeMatchIndex >= searchResults.length - 1 ? 0 : activeMatchIndex + 1;
    navigateToMatch(next);
  }, [searchResults, activeMatchIndex, navigateToMatch]);

  // ---- Keyboard shortcuts ----

  const addBookmarkAtCurrentPosition = useCallback(async () => {
    if (!bookId) return;
    try {
      // HTML-reflowable books (EPUB + MOBI) store a chapter-local scroll
      // fraction — `getChapterScrollPosition()` produces the same coordinate
      // system that `saveProgress` uses, so bookmarks and reading progress
      // round-trip consistently. In continuous mode `scrollProgress` would
      // be book-global, which mismatched the restore path and landed the
      // user far from the saved passage. Page-based books (PDF + CBZ + CBR)
      // store page-fraction.
      const bookmark = await invoke<{ id: string }>("add_bookmark", {
        bookId,
        chapterIndex,
        scrollPosition: isHtmlBook
          ? getChapterScrollPosition()
          : pageCount > 0 ? chapterIndex / pageCount : 0,
      });
      setToastBookmarkId(bookmark.id);
    } catch {
      // silently fail
    }
  }, [bookId, chapterIndex, getChapterScrollPosition, isHtmlBook, pageCount]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+F — open book search (HTML-reflowable books + PDF)
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && (isHtmlBook || bookFormat === "pdf")) {
        e.preventDefault();
        setSearchOpen(true);
        setSearchQuery("");
        setSearchResults([]);
        return;
      }

      // Close search panel from any context (including when input is focused)
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false); setSearchQuery(""); setSearchResults([]); setActiveMatchIndex(-1);
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Let SettingsPanel handle Escape and Tab when it is open
      if (settingsOpen && (e.key === "Escape" || e.key === "Tab")) return;

      // Don't navigate chapters when any panel is open
      if ((settingsOpen || tocOpen || bookmarksOpen) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;

      // For image-based formats (CBZ/CBR/PDF), PageViewer handles arrow keys.
      // HTML books (EPUB + MOBI) use chapter navigation here.
      if (!isHtmlBook && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;

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
  }, [prevChapter, nextChapter, addBookmarkAtCurrentPosition, showShortcuts, tocOpen, bookmarksOpen, dndMode, settingsOpen, navigate, bookFormat, isHtmlBook, searchOpen]);

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
    t("reader.chapterDefault", { number: chapterIndex + 1 });

  // ---- Font family CSS value ----

  const fontFamilyCss =
    fontFamily === "serif"
      ? '"Lora Variable", Georgia, serif'
      : fontFamily === "literata"
        ? '"Literata Variable", Georgia, serif'
        : fontFamily === "dyslexic"
          ? '"OpenDyslexic", sans-serif'
          : fontFamily.startsWith("custom:")
            ? `"CustomFont-${fontFamily.slice(7)}", serif`
            : '"DM Sans Variable", system-ui, sans-serif';

  const readerContentStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight: typography.lineHeight,
    fontFamily: fontFamilyCss,
  };

  // ---- Time-to-finish estimates ----

  const timeEstimate = useMemo(() => {
    if (chapterWordCounts.length === 0 || !isHtmlBook) return null;
    const currentChapterWords = chapterWordCounts[chapterIndex] ?? 0;
    // In continuous mode, scrollProgress is book-global; use chapter-local fraction instead
    const chapterProgress = isContinuous ? getChapterScrollPosition() : scrollProgress;
    const wordsLeftInChapter = Math.round(currentChapterWords * (1 - chapterProgress));
    const wordsLeftInBook = chapterWordCounts
      .slice(chapterIndex + 1)
      .reduce((sum, w) => sum + w, 0) + wordsLeftInChapter;

    if (wordsLeftInBook === 0) return null;

    const minsLeftChapter = Math.max(1, Math.round(wordsLeftInChapter / READING_WPM));
    const minsLeftBook = Math.max(1, Math.round(wordsLeftInBook / READING_WPM));

    const formatTime = (mins: number) => {
      if (mins < 60) return `${mins} min`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    return {
      chapter: formatTime(minsLeftChapter),
      book: formatTime(minsLeftBook),
    };
  }, [chapterWordCounts, chapterIndex, scrollProgress, isHtmlBook, isContinuous, getChapterScrollPosition]);

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-paper">
        <div className="text-sm text-ink-muted">{t("reader.loading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-4 p-8 bg-paper"
        role="alert"
        aria-live="assertive"
      >
        <h1 className="text-ink font-medium" id="reader-error-title">
          {t("reader.failedToLoad")}
        </h1>
        <p
          className="text-ink-muted text-sm max-w-md text-center"
          aria-describedby="reader-error-title"
        >
          {error}
        </p>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors text-sm font-medium"
        >
          {t("reader.backToLibrary")}
        </button>
        {missingFileDialog && (
          <>
            <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[80]" aria-hidden="true" />
            <div
              role="dialog"
              aria-label={t("reader.missingFileTitle")}
              aria-modal="true"
              className="fixed inset-0 z-[90] flex items-center justify-center p-4"
            >
              <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
                <h3 className="font-serif text-base font-semibold text-ink">
                  {t("reader.missingFileTitle")}
                </h3>
                <p className="text-sm text-ink-muted">
                  {t("reader.missingFileMessage")}
                </p>
                <div className="flex gap-3 justify-end pt-1">
                  <button
                    onClick={() => {
                      setMissingFileDialog(false);
                      navigate("/");
                    }}
                    className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await invoke("remove_book", { bookId });
                      } catch {
                        // Already gone or other error — navigate away regardless
                      }
                      navigate("/");
                    }}
                    className="px-4 py-2 text-sm bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors font-medium"
                  >
                    {t("reader.removeFromLibrary")}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
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
          refreshKey={bookmarkRefreshKey}
        />
      )}

      {/* Bookmark toast */}
      {toastBookmarkId && (
        <BookmarkToast
          bookmarkId={toastBookmarkId}
          onDismiss={() => {
            setToastBookmarkId(null);
            setBookmarkRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* Progress saved indicator */}
      {saveIndicator && (
        <div className="fixed bottom-16 right-4 z-50 text-xs text-gray-400 dark:text-gray-500 transition-opacity">
          {t("reader.progressSaved")}
        </div>
      )}

      {/* Progress save error indicator */}
      {saveError && (
        <div className="fixed bottom-16 right-4 z-50 text-xs text-amber-500 dark:text-amber-400 transition-opacity">
          {t("reader.progressNotSaved")}
        </div>
      )}

      {/* TOC Sidebar — slide-in animation */}
      {tocOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink/20 backdrop-blur-sm z-10 animate-fade-in"
            onClick={() => setTocOpen(false)}
          />
          {/* Sidebar */}
          <aside id="toc-sidebar" role="dialog" aria-modal="true" aria-label={t("reader.contents")} className="fixed left-0 top-0 bottom-0 w-72 bg-surface border-r border-warm-border z-20 flex flex-col shadow-[4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-left">
            <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
              <h2 className="font-serif text-base font-semibold text-ink">
                {t("reader.contents")}
              </h2>
              <button
                onClick={() => setTocOpen(false)}
                className="p-1 text-ink-muted hover:text-ink transition-colors rounded focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                aria-label={t("reader.closeToc")}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Book title */}
            {bookTitle && (
              <div className="px-5 py-3 border-b border-warm-border">
                <p className="font-serif text-sm font-medium text-ink leading-snug truncate" title={bookTitle}>{bookTitle}</p>
              </div>
            )}

            <nav
              className="flex-1 overflow-y-auto py-2"
              aria-label="Table of contents"
            >
              {toc.length > 0 ? toc.map((entry) => (
                <TocItem
                  key={`${entry.chapter_index}-${entry.label}`}
                  entry={entry}
                  currentIndex={chapterIndex}
                  onSelect={goToChapter}
                  depth={0}
                />
              )) : (
                <div className="px-5 py-2 space-y-3">
                  {Array.from({ length: 8 }, (_, i) => (
                    <div key={i} className="flex flex-col gap-1.5">
                      <div className="h-3 rounded bg-warm-subtle animate-shimmer" style={{ width: `${60 + (i * 7) % 30}%` }} />
                    </div>
                  ))}
                </div>
              )}
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
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label={t("reader.backToLibrary")}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            onClick={() => setTocOpen(true)}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label={t("reader.openToc")}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          <h1 className="flex-1 text-sm text-ink-muted truncate font-medium px-1">
            {currentChapterTitle}
          </h1>

          {/* Search button (HTML-reflowable books + PDF) */}
          {(isHtmlBook || bookFormat === "pdf") && (
            <button
              onClick={() => { setSearchOpen(true); setSearchQuery(""); setSearchResults([]); }}
              className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${searchOpen ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
              aria-label={t("reader.searchLabel")}
              title={t("reader.searchShortcut")}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {/* Highlights button */}
          <button
            onClick={() => setHighlightsOpen((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${highlightsOpen ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label={t("highlights.title")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Bookmarks button */}
          <button
            onClick={() => setBookmarksOpen((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${bookmarksOpen ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label={t("bookmarks.title")}
            title={t("bookmarks.title")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-3.5L5 21V5a2 2 0 012-2h10a2 2 0 012 2z" />
            </svg>
          </button>

          {/* Font size controls */}
          <div className="flex items-center gap-0.5 mr-1">
            <button
              onClick={() => setFontSize(fontSize - 2)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              aria-label={t("reader.decreaseFontSize")}
            >
              A−
            </button>
            <span className="text-xs text-ink-muted w-7 text-center tabular-nums">
              {fontSize}
            </span>
            <button
              onClick={() => setFontSize(fontSize + 2)}
              disabled={fontSize >= MAX_FONT_SIZE}
              className="px-2 py-1 text-xs text-ink-muted hover:text-ink hover:bg-warm-subtle rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              aria-label={t("reader.increaseFontSize")}
            >
              A+
            </button>
          </div>

          {/* Dual-page toggle — hidden in continuous scroll mode */}
          {!isContinuous && (
            <div className="flex items-center">
              <button
                onClick={() => setDualPage(!dualPage)}
                className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${dualPage ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
                aria-label={t("reader.toggleDualPage")}
                title={t("reader.dualPageSpread")}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="4" width="8" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="14" y="4" width="8" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              {dualPage && (
                <button
                  onClick={() => setMangaMode(!mangaMode)}
                  className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${mangaMode ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
                  aria-label={t("reader.toggleMangaMode")}
                  title={t("reader.mangaMode")}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M19 12H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M10 7l-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* DND toggle */}
          <button
            onClick={() => setDndMode((prev) => !prev)}
            className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${dndMode ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
            aria-label={t("reader.toggleFocusMode")}
            title={t("reader.focusMode")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 8v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Language switcher */}
          <LanguageSwitcher />

          {/* Keyboard shortcuts hint */}
          <button
            onClick={() => setShowShortcuts(true)}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 text-xs font-medium w-6 h-6 flex items-center justify-center"
            aria-label={t("shortcuts.title")}
            title={t("shortcuts.title")}
          >
            ?
          </button>

          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label={t("reader.openSettings")}
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

        {/* Book search panel */}
        {searchOpen && (isHtmlBook || bookFormat === "pdf") && (
          <div className="shrink-0 border-b border-warm-border bg-surface px-4 py-2 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="text-ink-muted shrink-0">
              <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.trim().length >= 2) {
                  executeSearch(e.target.value);
                } else {
                  setSearchResults([]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setSearchResults([]);
                  setActiveMatchIndex(-1);
                } else if (e.key === "Enter" && searchResults.length > 0) {
                  e.shiftKey ? prevMatch() : nextMatch();
                } else if (e.key === "Enter") {
                  executeSearch(searchQuery);
                }
              }}
              placeholder={t("reader.searchInBook")}
              className="flex-1 text-sm bg-transparent text-ink placeholder-ink-muted/50 focus:outline-none"
              autoFocus
            />
            {searching && <span className="text-xs text-ink-muted">{t("reader.searchingText")}</span>}
            {!searching && searchQuery.length > 0 && searchQuery.trim().length < 2 && (
              <span className="text-xs text-ink-muted/60">{t("reader.searchMinChars")}</span>
            )}
            {!searching && searchResults.length > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-ink-muted tabular-nums">
                  {t("reader.matchNav", { current: activeMatchIndex + 1, total: searchResults.length })}
                </span>
                <button type="button" onClick={prevMatch} className="p-0.5 text-ink-muted hover:text-ink transition-colors" aria-label={t("reader.prevMatch")} title={t("reader.searchNavHint")}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M12 15l-5-5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button type="button" onClick={nextMatch} className="p-0.5 text-ink-muted hover:text-ink transition-colors" aria-label={t("reader.nextMatch")} title={t("reader.searchNavHint")}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => { setSearchOpen(false); setSearchQuery(""); setSearchResults([]); setActiveMatchIndex(-1); }}
              className="p-1 text-ink-muted hover:text-ink transition-colors"
              aria-label={t("reader.closeSearch")}
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Search results dropdown */}
        {searchOpen && !searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
          <div className="shrink-0 border-b border-warm-border bg-surface/95 px-4 py-3">
            <p className="text-xs text-ink-muted text-center">{t("reader.noMatchesFor", { query: searchQuery.trim() })}</p>
          </div>
        )}
        {searchOpen && searchResults.length > 0 && (
          <div className="shrink-0 max-h-48 overflow-y-auto border-b border-warm-border bg-surface/95">
            {searchResults.map((result, i) => {
              const chapterTitle = bookFormat === "pdf"
                ? t("reader.pageNumber", { number: result.chapterIndex + 1 })
                : toc.find((e) => e.chapter_index === result.chapterIndex)?.label ?? t("reader.chapterDefault", { number: result.chapterIndex + 1 });
              return (
                <button
                  key={`${result.chapterIndex}-${result.matchOffset}-${i}`}
                  type="button"
                  onClick={() => {
                    navigateToMatch(i);
                    setSearchOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2 hover:bg-warm-subtle transition-colors border-b border-warm-border/50 last:border-b-0 ${i === activeMatchIndex ? "bg-accent-light" : ""}`}
                >
                  <span className="text-[11px] text-accent font-medium">{chapterTitle}</span>
                  <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">{result.snippet}</p>
                </button>
              );
            })}
            {searchResults.length >= 200 && (
              <div className="px-4 py-2 text-[11px] text-ink-muted/70 text-center bg-warm-subtle/50">
                {t("reader.resultsCapped")}
              </div>
            )}
          </div>
        )}

        {/* Screen reader announcement for chapter changes (#56) */}
        {isHtmlBook && (
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {t("reader.chapterOf", { current: chapterIndex + 1, total: totalChapters || 1 })}
          </div>
        )}

        {/* Screen reader announcement for search state */}
        {searchOpen && (
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {searching && t("reader.searchingText")}
            {!searching && searchResults.length > 0 && t("reader.matchNav", { current: activeMatchIndex + 1, total: searchResults.length })}
            {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && t("reader.noMatchesFor", { query: searchQuery.trim() })}
          </div>
        )}

        {/* Content area — chapter HTML (EPUB/MOBI) or page-based viewer */}
        {!isHtmlBook ? (
          pageCount > 0 ? (
            <PageViewer
              bookId={bookId!}
              format={bookFormat}
              totalPages={pageCount}
              initialPage={chapterIndex}
              onPageChange={(index) => setChapterIndex(index)}
              dualPage={dualPage}
              mangaMode={mangaMode}
              pageAnimation={pageAnimation}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-ink-muted">{t("reader.loadingPages")}</p>
            </div>
          )
        ) : (
          <>
            {/* Dynamic typography overrides — must target .reader-content p to beat index.css specificity */}
            <style>{`
              .reader-content p {
                margin-bottom: ${typography.paragraphSpacing}em;
                text-align: ${typography.textAlign};
                hyphens: ${typography.hyphenation ? "auto" : "manual"};
                -webkit-hyphens: ${typography.hyphenation ? "auto" : "manual"};
              }
            `}</style>
            {dualPage && !isContinuous && (
              <style>{`
                .reader-content {
                  columns: 2;
                  column-gap: 48px;
                  column-rule: 1px solid var(--warm-border, #e5e0d8);
                  ${mangaMode ? "direction: rtl;" : ""}
                }
                .reader-content > * {
                  ${mangaMode ? "direction: ltr;" : ""}
                }
              `}</style>
            )}
            {customCss && <style>{customCss}</style>}

            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto relative"
            >
              {/* Floating prev/next arrows — visible when bottom nav is scrolled out of view (paginated only) */}
              {!isContinuous && !bottomNavVisible && isHtmlBook && !dndMode && (
                <>
                  {chapterIndex > 0 && (
                    <button
                      onClick={prevChapter}
                      className="fixed left-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-surface/90 border border-warm-border shadow-md text-ink-muted hover:text-ink hover:bg-surface transition-all opacity-60 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                      aria-label={t("reader.previousChapter")}
                    >
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                        <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  {chapterIndex < totalChapters - 1 && (
                    <button
                      onClick={nextChapter}
                      className="fixed right-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-surface/90 border border-warm-border shadow-md text-ink-muted hover:text-ink hover:bg-surface transition-all opacity-60 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                      aria-label={t("reader.nextChapter")}
                    >
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                        <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </>
              )}
              {/* Highlight color popup */}
              {selectionPopup && (() => {
                const containerW = contentRef.current?.clientWidth ?? 600;
                const popupW = Math.min(200, containerW - 16);
                const popupH = 36;
                // Clamp X so popup doesn't overflow left/right edges (#61)
                const clampedX = Math.max(popupW / 2 + 8, Math.min(selectionPopup.x, containerW - popupW / 2 - 8));
                // Smart Y positioning (#61): check both top and bottom viewport edges
                const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
                const viewportH = scrollContainerRef.current?.clientHeight ?? window.innerHeight;
                const wouldClipTop = selectionPopup.y - popupH < scrollTop;
                const wouldClipBottom = selectionPopup.y + 32 + popupH > scrollTop + viewportH;
                // Prefer above; fall back to below if clipped; if both clip, show above
                const showBelow = wouldClipTop && !wouldClipBottom;
                const yOffset = showBelow ? 32 : -8;
                const transformY = showBelow ? "0%" : "-100%";
                return (
                <div
                  data-highlight-popup
                  className="absolute z-30 flex items-center gap-1 px-2 py-1.5 bg-ink/90 backdrop-blur-sm rounded-lg shadow-lg"
                  style={{
                    left: `${clampedX}px`,
                    top: `${selectionPopup.y + yOffset}px`,
                    transform: `translate(-50%, ${transformY})`,
                    maxWidth: `${containerW - 16}px`,
                  }}
                >
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => handleCreateHighlight(c.value)}
                      className="w-5 h-5 rounded-full hover:scale-125 transition-transform"
                      style={{ backgroundColor: c.value }}
                      aria-label={t("reader.highlightColor", { color: c.name })}
                    />
                  ))}
                  {/* Clear highlight — only show if selection overlaps existing highlights */}
                  {selectionPopup && highlights.some((h) => h.startOffset < selectionPopup.endOffset && h.endOffset > selectionPopup.startOffset) && (
                    <button
                      onClick={handleClearHighlight}
                      className="w-5 h-5 rounded-full hover:scale-125 transition-transform border border-white/40 flex items-center justify-center"
                      style={{ background: "repeating-conic-gradient(#ccc 0% 25%, transparent 0% 50%) 50% / 6px 6px" }}
                      aria-label={t("reader.clearHighlight")}
                      title={t("reader.clearHighlight")}
                    />
                  )}
                  <div className="w-px h-4 bg-white/20 mx-0.5" />
                  <button
                    onClick={() => { setSelectionPopup(null); window.getSelection()?.removeAllRanges(); }}
                    className="w-5 h-5 rounded-full hover:scale-125 transition-transform flex items-center justify-center text-white/60 hover:text-white"
                    aria-label={t("reader.dismiss")}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                );
              })()}

              {chapterError ? (
                <div className="max-w-[680px] mx-auto px-8 py-10">
                  <p className="text-red-500 text-sm">{t("reader.failedToLoadChapter", { error: chapterError })}</p>
                </div>
              ) : isContinuous ? (
                /* ── Continuous scroll: all chapters stacked ── */
                allChaptersLoaded ? (
                  <div ref={contentRef} className="max-w-[680px] mx-auto py-10" style={{ paddingLeft: `${typography.pageMargins}px`, paddingRight: `${typography.pageMargins}px` }}>
                    {allChaptersHtml.map((html, i) => {
                      const chapterTitle = toc.find((e) => e.chapter_index === i)?.label;
                      return (
                        <div
                          key={i}
                          ref={(el) => { chapterDivRefs.current[i] = el; }}
                          data-chapter-index={i}
                        >
                          {i > 0 && (
                            <div className="my-10 flex items-center gap-4">
                              <div className="flex-1 h-px bg-warm-border" />
                              <span className="text-xs text-ink-muted font-medium shrink-0">
                                {chapterTitle ?? t("reader.chapterDefault", { number: i + 1 })}
                              </span>
                              <div className="flex-1 h-px bg-warm-border" />
                            </div>
                          )}
                          <div
                            className="reader-content"
                            style={readerContentStyle}
                            dangerouslySetInnerHTML={{ __html: html }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                    <p className="text-sm text-ink-muted">{t("reader.loadingChapters", { count: totalChapters })}</p>
                  </div>
                )
              ) : !chapterHtml ? (
                /* ── Paginated: loading chapter ── */
                <div className="flex-1 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                </div>
              ) : (
                /* ── Paginated: single chapter ── */
                <div
                  ref={contentRef}
                  className="reader-content max-w-[680px] mx-auto py-10"
                  style={{ ...readerContentStyle, paddingLeft: `${typography.pageMargins}px`, paddingRight: `${typography.pageMargins}px` }}
                  dangerouslySetInnerHTML={{ __html: searchHighlightedHtml }}
                />
              )}

              {/* Chapter navigation (paginated only) */}
              {!isContinuous && (
                <div ref={chapterNavRef} className={`max-w-[680px] mx-auto px-8 pb-12 flex items-center justify-between gap-4 transition-opacity duration-300 ${dndMode && !dndShowControls ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
                  <button
                    onClick={prevChapter}
                    disabled={chapterIndex <= 0}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                      <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {t("common.previous")}
                  </button>
                  <span className="text-xs text-ink-muted tabular-nums">
                    {t("reader.chapterOf", { current: chapterIndex + 1, total: totalChapters })}
                  </span>
                  <button
                    onClick={nextChapter}
                    disabled={chapterIndex >= totalChapters - 1}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                  >
                    {t("common.next")}
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                      <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Progress bar */}
            <footer className={`shrink-0 border-t border-warm-border bg-surface px-5 py-2 flex items-center gap-3 transition-all duration-300 ${showFooter ? "opacity-100 max-h-20" : "opacity-0 max-h-0 overflow-hidden py-0 border-t-0"}`}>
              <span className="text-[11px] text-ink-muted tabular-nums whitespace-nowrap">
                {t("reader.chapterLabel", { current: chapterIndex + 1, total: totalChapters })}
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
              {timeEstimate && (
                <span className="text-[11px] text-ink-muted/70 whitespace-nowrap ml-1" title={t("reader.timeLeftTitle", { chapter: timeEstimate.chapter, book: timeEstimate.book })}>
                  {t("reader.timeLeft", { time: timeEstimate.book })}
                </span>
              )}
            </footer>
          </>
        )}
      {missingFileDialog && (
        <>
          <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[80]" aria-hidden="true" />
          <div
            role="dialog"
            aria-label={t("reader.missingFileTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("reader.missingFileTitle")}
              </h3>
              <p className="text-sm text-ink-muted">
                {t("reader.missingFileMessage")}
              </p>
              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => {
                    setMissingFileDialog(false);
                    navigate("/");
                  }}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await invoke("remove_book", { bookId });
                    } catch {
                      // Already gone or other error — navigate away regardless
                    }
                    navigate("/");
                  }}
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors font-medium"
                >
                  {t("reader.removeFromLibrary")}
                </button>
              </div>
            </div>
          </div>
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
        className={`w-full text-left py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
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
