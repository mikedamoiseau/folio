import React, { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import BookCard, { type BookCardData } from "../components/BookCard";
import BulkEditDialog from "../components/BulkEditDialog";
import EmptyState from "../components/EmptyState";
import ImportButton from "../components/ImportButton";
import CollectionsSidebar, {
  Collection,
  CreateCollectionData,
} from "../components/CollectionsSidebar";
import EditBookDialog from "../components/EditBookDialog";
import BookDetailModal from "../components/BookDetailModal";
import KeyboardShortcutsHelp from "../components/KeyboardShortcutsHelp";
import TagFilter from "../components/TagFilter";
import { startDrag, endDrag, isDragging, getDraggedCoverSrc, subscribe } from "../lib/dragState";
import { friendlyError } from "../lib/errors";
import { LiveRegion } from "../components/LiveRegion";
import { useToast } from "../components/Toast";
import { useDebounce } from "../hooks/useDebounce";
import type { Book, BookGridItem } from "../types";

interface ReadingProgress {
  book_id: string;
  chapter_index: number;
  scroll_position: number;
  last_read_at: number;
}

interface Tag {
  id: string;
  name: string;
}

interface BookTagAssoc {
  book_id: string;
  tag_id: string;
}

export default function Library() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [books, setBooks] = useState<BookGridItem[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [lastReadMap, setLastReadMap] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 150);
  const [sortBy, setSortBy] = useState<"date_added" | "last_read" | "title" | "author" | "progress" | "rating" | "series">(() => {
    const stored = localStorage.getItem("folio-library-sort-by");
    if (stored === "date_added" || stored === "last_read" || stored === "title" || stored === "author" || stored === "progress" || stored === "rating" || stored === "series") return stored;
    return "date_added";
  });
  const [sortAsc, setSortAsc] = useState(() => localStorage.getItem("folio-library-sort-asc") === "true");
  const [filterFormat, setFilterFormat] = useState<string>(() => localStorage.getItem("folio-library-filter-format") ?? "all");
  const [filterStatus, setFilterStatus] = useState<string>(() => localStorage.getItem("folio-library-filter-status") ?? "all");
  const [filterRating, setFilterRating] = useState<string>(() => localStorage.getItem("folio-library-filter-rating") ?? "all");
  const [filterSource, setFilterSource] = useState<string>(() => localStorage.getItem("folio-library-filter-source") ?? "all");
  const [filterTagIds, setFilterTagIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("folio-library-filter-tags");
      if (!stored) return [];
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
      return [];
    } catch { return []; }
  });
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [bookTagMap, setBookTagMap] = useState<Map<string, Set<string>>>(new Map());
  // Persist filter/sort state to localStorage
  useEffect(() => { localStorage.setItem("folio-library-sort-by", sortBy); }, [sortBy]);
  useEffect(() => { localStorage.setItem("folio-library-sort-asc", String(sortAsc)); }, [sortAsc]);
  useEffect(() => { localStorage.setItem("folio-library-filter-format", filterFormat); }, [filterFormat]);
  useEffect(() => { localStorage.setItem("folio-library-filter-status", filterStatus); }, [filterStatus]);
  useEffect(() => { localStorage.setItem("folio-library-filter-rating", filterRating); }, [filterRating]);
  useEffect(() => { localStorage.setItem("folio-library-filter-source", filterSource); }, [filterSource]);
  useEffect(() => { localStorage.setItem("folio-library-filter-tags", JSON.stringify(filterTagIds)); }, [filterTagIds]);

  const [fileNotAvailableBookId, setFileNotAvailableBookId] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const importCancelledRef = useRef(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const latestDetailRequestRef = useRef<string | null>(null);
  const latestEditRequestRef = useRef<string | null>(null);
  const [scanningBookId, setScanningBookId] = useState<string | null>(null);
  // Bulk selection (#60)
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);

  // Collapsed series groups (series view)
  const [collapsedSeries, setCollapsedSeries] = useState<Set<string>>(new Set());

  // scanToast state kept for LiveRegion — visual toasts now use useToast()
  const [scanToastMessage, setScanToastMessage] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number; bookTitle: string; status: string } | null>(null);

  // Recently read
  const [showContinueReading, setShowContinueReading] = useState(() => {
    const stored = localStorage.getItem("folio-show-continue-reading");
    return stored === null ? true : stored === "true";
  });
  const [recentlyRead, setRecentlyRead] = useState<Book[]>([]);

  // Discover — popular/new books from catalogs (loaded lazily, cached 24h)
  interface DiscoverEntry { id: string; title: string; author: string; summary: string; coverUrl: string | null; links: { href: string; mimeType: string; rel: string }[]; navUrl: string | null }
  const [showDiscover, setShowDiscover] = useState(() => localStorage.getItem("folio-show-discover") === "true");
  const [discoverBooks, setDiscoverBooks] = useState<DiscoverEntry[]>([]);
  const [discoverInfo, setDiscoverInfo] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(true);

  // Sync showContinueReading when changed from SettingsPanel
  useEffect(() => {
    const handler = () => {
      const stored = localStorage.getItem("folio-show-continue-reading");
      setShowContinueReading(stored === null ? true : stored === "true");
    };
    window.addEventListener("folio-show-continue-reading-changed", handler);
    return () => window.removeEventListener("folio-show-continue-reading-changed", handler);
  }, []);

  // Sync showDiscover when changed from SettingsPanel
  useEffect(() => {
    const handler = () => setShowDiscover(localStorage.getItem("folio-show-discover") === "true");
    window.addEventListener("folio-show-discover-changed", handler);
    return () => window.removeEventListener("folio-show-discover-changed", handler);
  }, []);

  // Collections state
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [activeSeries, setActiveSeries] = useState<string | null>(null);
  const [seriesList, setSeriesList] = useState<Array<{ name: string; count: number }>>([]);

  // Keep a stable ref to activeCollectionId for use in callbacks
  const activeCollectionIdRef = useRef(activeCollectionId);
  activeCollectionIdRef.current = activeCollectionId;

  const loadBooks = useCallback(async (collectionId: string | null = activeCollectionIdRef.current) => {
    try {
      let library: BookGridItem[];
      if (collectionId) {
        library = await invoke<BookGridItem[]>("get_books_in_collection_grid", { collectionId });
      } else {
        library = await invoke<BookGridItem[]>("get_library_grid");
      }
      setBooks(library);

      // Batch-load all reading progress in a single IPC call
      const chaptersMap = Object.fromEntries(library.map((b) => [b.id, b.total_chapters]));
      try {
        const allProgress = await invoke<ReadingProgress[]>("get_all_reading_progress");
        const pMap: Record<string, number> = {};
        const lrMap: Record<string, number> = {};
        for (const prog of allProgress) {
          const total = chaptersMap[prog.book_id] ?? 0;
          pMap[prog.book_id] = total > 0 ? Math.round(((prog.chapter_index + 1) / total) * 100) : 0;
          lrMap[prog.book_id] = prog.last_read_at;
        }
        setProgressMap(pMap);
        setLastReadMap(lrMap);
      } catch {
        addToast(t("library.progressLoadError", { defaultValue: "Could not load reading progress" }), "error");
      }

      // Load tags for filtering
      try {
        const [tags, assocs] = await Promise.all([
          invoke<Tag[]>("get_all_tags"),
          invoke<BookTagAssoc[]>("get_all_book_tags"),
        ]);
        setAllTags(tags);
        // Prune persisted filterTagIds to only IDs that still exist
        const validIds = new Set(tags.map((tg) => tg.id));
        setFilterTagIds((prev) => {
          const pruned = prev.filter((id) => validIds.has(id));
          return pruned.length === prev.length ? prev : pruned;
        });
        const map = new Map<string, Set<string>>();
        for (const { book_id, tag_id } of assocs) {
          if (!map.has(book_id)) map.set(book_id, new Set());
          map.get(book_id)!.add(tag_id);
        }
        setBookTagMap(map);
      } catch {
        // tag load failure is non-fatal — clear active tag filter to prevent
        // empty-library lockout when persisted filterTagIds can't be resolved
        setFilterTagIds([]);
      }

      // Refresh series sidebar so it reflects any metadata mutations
      try {
        const list = await invoke<Array<{ name: string; count: number }>>("get_series");
        setSeriesList(list);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadCollections = useCallback(async () => {
    try {
      const result = await invoke<Collection[]>("get_collections");
      setCollections(result);
    } catch {
      // collections load failure is non-fatal
    }
  }, []);

  const loadRecentlyRead = useCallback(async () => {
    try {
      const recent = await invoke<Book[]>("get_recently_read", { limit: 5 });
      setRecentlyRead(recent);
    } catch {
      // non-fatal
    }
  }, []);

  const loadSeries = useCallback(async () => {
    try {
      const list = await invoke<Array<{ name: string; count: number }>>("get_series");
      setSeriesList(list);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadCollections();
    loadBooks(null);
    loadRecentlyRead();
    loadSeries();
  }, [loadCollections, loadBooks, loadRecentlyRead, loadSeries]);

  // Re-fetch recently read when toggled on
  useEffect(() => {
    if (showContinueReading) loadRecentlyRead();
  }, [showContinueReading, loadRecentlyRead]);

  // Load discover books lazily in background (doesn't block UI)
  useEffect(() => {
    if (!loaded || !showDiscover) return;
    let cancelled = false;
    setDiscoverLoading(true);
    invoke<DiscoverEntry[]>("get_discover_books")
      .then((entries) => { if (!cancelled) setDiscoverBooks(entries); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDiscoverLoading(false); });
    return () => { cancelled = true; };
  }, [loaded, showDiscover]);

  // Reload books when active collection changes
  useEffect(() => {
    if (loaded) {
      loadBooks(activeCollectionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCollectionId]);

  const handleRemoveBook = useCallback(
    async (bookId: string) => {
      try {
        await invoke("remove_book", { bookId });
        await loadBooks(activeCollectionIdRef.current);
      } catch (err) {
        setError(friendlyError(err, t));
      }
    },
    [loadBooks]
  );

  const toggleSelected = useCallback((bookId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const openBook = useCallback(
    async (bookId: string) => {
      const gridItem = books.find((b) => b.id === bookId);
      if (gridItem && gridItem.is_imported === false) {
        let fullBook: Book | null;
        try {
          fullBook = await invoke<Book>("get_book", { bookId });
        } catch (err) {
          setError(friendlyError(err, t));
          return;
        }
        if (fullBook) {
          try {
            await invoke("check_file_exists", { filePath: fullBook.file_path });
          } catch {
            setFileNotAvailableBookId(bookId);
            return;
          }
        }
      }
      navigate(`/reader/${bookId}`);
    },
    [books, navigate, t]
  );

  const importFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    importCancelledRef.current = false;
    setImporting(true);
    setError(null);
    const results = { imported: 0, duplicates: 0, errors: [] as string[] };
    try {
      for (let i = 0; i < paths.length; i++) {
        if (importCancelledRef.current) break;
        setImportProgress({ current: i + 1, total: paths.length });
        try {
          await invoke("import_book", { filePath: paths[i] });
          results.imported++;
        } catch (err) {
          const msg = String(err);
          if (msg.includes("duplicate") || msg.includes("already")) {
            results.duplicates++;
          } else {
            results.errors.push(`${paths[i].split("/").pop()}: ${friendlyError(err, t)}`);
          }
        }
      }
      await loadBooks(activeCollectionIdRef.current);
      await loadRecentlyRead();
      const parts: string[] = [];
      if (results.imported > 0) parts.push(t("library.imported", { count: results.imported }));
      if (results.duplicates > 0) parts.push(t("library.skipped", { count: results.duplicates }));
      if (importCancelledRef.current) parts.push(t("library.cancelled"));
      if (results.errors.length > 0) parts.push(t("library.failed", { count: results.errors.length }));
      if (results.errors.length > 0 || importCancelledRef.current) {
        setError(parts.join(", ") + (results.errors.length > 0 ? ": " + results.errors.join("; ") : ""));
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
      importCancelledRef.current = false;
    }
  }, [loadBooks, loadRecentlyRead]);

  const handleSelectSeries = useCallback((name: string | null) => {
    setActiveSeries(name);
    setActiveCollectionId(null);
    if (name) setSortBy("series");
    loadBooks(null);
  }, [loadBooks]);

  const handleImportFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected) return;
      const folderPath = typeof selected === "string" ? selected : selected[0];
      if (!folderPath) return;
      setImporting(true);
      setError(null);
      const files = await invoke<string[]>("scan_folder_for_books", { folderPath });
      if (files.length === 0) {
        setError(t("library.noSupportedFiles"));
        setImporting(false);
        return;
      }
      await importFiles(files);
    } catch (err) {
      setError(friendlyError(err, t));
      setImporting(false);
    }
  }, [importFiles]);

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "All Books", extensions: ["epub", "cbz", "cbr", "pdf"] },
          { name: "EPUB", extensions: ["epub"] },
          { name: "PDF", extensions: ["pdf"] },
          { name: "CBZ", extensions: ["cbz"] },
          { name: "CBR", extensions: ["cbr"] },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths);
    } catch (err) {
      setError(friendlyError(err, t));
    }
  }, [importFiles]);

  const handleImportUrl = useCallback(async (url: string) => {
    try {
      setImporting(true);
      setError(null);
      await invoke("download_opds_book", { downloadUrl: url });
      await loadBooks(activeCollectionIdRef.current);
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setImporting(false);
    }
  }, [loadBooks]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const { type } = event.payload;
        if (type === "enter") {
          setDragging(true);
        } else if (type === "leave") {
          setDragging(false);
        } else if (type === "drop") {
          setDragging(false);
          const paths = event.payload.paths;
          const supportedExtensions = [".epub", ".cbz", ".cbr", ".pdf"];
          const bookPaths = paths.filter((p) =>
            supportedExtensions.some((ext) => p.toLowerCase().endsWith(ext))
          );
          if (bookPaths.length > 0) {
            importFiles(bookPaths);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [importFiles]);

  const filtered = useMemo(() => books
    .filter((book) => {
      if (debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        if (!book.title.toLowerCase().includes(q) && !book.author.toLowerCase().includes(q)) return false;
      }
      if (filterFormat !== "all" && book.format !== filterFormat) return false;
      if (filterStatus !== "all") {
        const pct = progressMap[book.id] ?? 0;
        if (filterStatus === "unread" && pct !== 0) return false;
        if (filterStatus === "in_progress" && (pct === 0 || pct >= 100)) return false;
        if (filterStatus === "finished" && pct < 100) return false;
      }
      if (filterRating !== "all") {
        const minRating = parseInt(filterRating);
        if (Math.round(book.rating ?? 0) < minRating) return false;
      }
      if (filterSource !== "all") {
        if (filterSource === "imported" && book.is_imported === false) return false;
        if (filterSource === "linked" && book.is_imported !== false) return false;
      }
      return true;
    })
    .filter((book) => {
      if (!activeSeries) return true;
      return book.series === activeSeries;
    })
    .filter((book) => {
      if (filterTagIds.length === 0) return true;
      const tags = bookTagMap.get(book.id);
      if (!tags) return false;
      return filterTagIds.every((id) => tags.has(id));
    })
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      switch (sortBy) {
        case "title": return dir * a.title.localeCompare(b.title);
        case "author": return dir * a.author.localeCompare(b.author);
        case "last_read": return dir * ((lastReadMap[a.id] ?? 0) - (lastReadMap[b.id] ?? 0));
        case "progress": return dir * ((progressMap[a.id] ?? 0) - (progressMap[b.id] ?? 0));
        case "rating": return dir * ((a.rating ?? 0) - (b.rating ?? 0));
        case "series": {
          const sa = a.series ?? "";
          const sb = b.series ?? "";
          if (sa !== sb) return dir * sa.localeCompare(sb);
          const va = a.volume ?? 9999;
          const vb = b.volume ?? 9999;
          if (va !== vb) return va - vb;
          return a.title.localeCompare(b.title);
        }
        case "date_added":
        default: return dir * (a.added_at - b.added_at);
      }
    }), [books, debouncedSearch, sortBy, sortAsc, filterFormat, filterStatus, filterRating, filterSource, progressMap, lastReadMap, activeSeries, filterTagIds, bookTagMap]);

  const handleShowBookDetail = useCallback(async (id: string) => {
    latestDetailRequestRef.current = id;
    setDetailLoading(true);
    try {
      const found = await invoke<Book>("get_book", { bookId: id });
      if (found && latestDetailRequestRef.current === id) setDetailBook(found);
    } catch (err) {
      addToast(friendlyError(err, t), "error");
    } finally {
      if (latestDetailRequestRef.current === id) setDetailLoading(false);
    }
  }, [t, addToast]);

  const handleEditBook = useCallback(async (id: string) => {
    latestEditRequestRef.current = id;
    setDetailBook(null);
    try {
      const book = await invoke<Book>("get_book", { bookId: id });
      if (book && latestEditRequestRef.current === id) setEditingBook(book);
    } catch (err) {
      addToast(friendlyError(err, t), "error");
    }
  }, [t, addToast]);

  const toCardData = useCallback((book: BookGridItem): BookCardData => ({
    id: book.id,
    title: book.title,
    author: book.author,
    coverPath: book.cover_path,
    totalChapters: book.total_chapters,
    format: book.format,
    progress: progressMap[book.id] ?? 0,
    language: book.language,
    publishYear: book.publish_year,
    series: book.series,
    volume: book.volume,
    rating: book.rating,
    isImported: book.is_imported,
  }), [progressMap]);

  // Drag ghost: track mouse position and drag state
  const bookDragging = useSyncExternalStore(subscribe, isDragging);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleGlobalMouseUp = () => endDrag();
    const handleMouseMove = (e: MouseEvent) => setMousePos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
          setSearch("");
        }
        return;
      }
      if (e.key === "/" || e.key === "f" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        setCollectionsOpen((prev) => !prev);
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setShowShortcuts((prev) => !prev);
      } else if (e.key === "Escape") {
        if (showShortcuts) setShowShortcuts(false);
        else if (collectionsOpen) setCollectionsOpen(false);
        else if (editingBook) setEditingBook(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showShortcuts, collectionsOpen, editingBook]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenAutoStart: (() => void) | undefined;
    listen<{ current: number; total: number; bookTitle: string; status: string }>("scan-progress", (event) => {
      const p = event.payload;
      if (p.status === "done" || p.status === "cancelled") {
        if (p.status === "cancelled" && p.current > 0) {
          addToast(t("library.scanCancelled", { count: p.current }), "info");
          setScanToastMessage(t("library.scanCancelled", { count: p.current }));
        }
        setScanProgress(null);
        loadBooks(activeCollectionIdRef.current);
      } else {
        setScanProgress(p);
      }
    }).then((fn) => { unlistenProgress = fn; });
    listen<number>("scan-auto-start", () => {
      invoke("start_scan").catch(() => {});
    }).then((fn) => { unlistenAutoStart = fn; });
    return () => { unlistenProgress?.(); unlistenAutoStart?.(); };
  }, [loadBooks]);

  const handleStartScan = useCallback(async () => {
    try { await invoke("start_scan", { includeSkipped: true }); } catch (err) { setError(friendlyError(err, t)); }
  }, []);
  const handleCancelScan = useCallback(async () => {
    try { await invoke("cancel_scan"); } catch {}
  }, []);

  // Note: previously auto-cleared search when no results remained after deletion,
  // but this conflicts with debounced search (race between raw and debounced values).
  // Users can clear search manually via the input or Escape key.

  const hasBooks = books.length > 0;
  const hasResults = filtered.length > 0;

  // Determine if we're in a manual collection view (enables remove-from-collection)
  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;
  const isManualCollectionView = activeCollection?.type === "manual";

  if (!loaded) {
    return (
      <div className="flex flex-col h-full bg-paper">
        {/* Skeleton toolbar */}
        <div className="shrink-0 h-14 px-6 flex items-center gap-3 border-b border-warm-border bg-surface">
          <div className="w-8 h-8 rounded-lg bg-warm-subtle animate-shimmer" />
          <div className="flex-1 h-8 rounded-lg bg-warm-subtle animate-shimmer" />
          <div className="w-20 h-8 rounded-lg bg-warm-subtle animate-shimmer" />
        </div>
        {/* Skeleton book grid */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="grid grid-cols-[repeat(auto-fill,160px)] justify-center gap-5">
            {Array.from({ length: Math.min(24, Math.max(4, Math.floor(((window.innerWidth - 64) / 180)) * Math.ceil(((window.innerHeight - 120) / 300)))) }, (_, i) => (
              <div key={i} className="w-full rounded-xl bg-surface border border-warm-border overflow-hidden">
                <div className="aspect-[2/3] bg-warm-subtle animate-shimmer" />
                <div className="p-2.5 space-y-2">
                  <div className="h-3.5 w-4/5 rounded bg-warm-subtle animate-shimmer" />
                  <div className="h-3 w-3/5 rounded bg-warm-subtle animate-shimmer" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full relative bg-paper transition-[padding] duration-200 ${collectionsOpen ? "pl-64" : ""}`}>
      {/* Toolbar — always show when books exist or a collection is selected */}
      {(hasBooks || activeCollectionId) && (
        <div className="shrink-0 h-14 px-6 flex items-center gap-3 border-b border-warm-border bg-surface">
          {/* Collections toggle */}
          <button
            type="button"
            onClick={() => setCollectionsOpen(true)}
            title={t("collections.title")}
            className={`shrink-0 p-2 rounded-lg transition-colors ${
              activeCollectionId
                ? "text-accent bg-accent-light"
                : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
            }`}
            aria-label={t("collections.openLabel")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M2 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Search input */}
          <div className="flex-1 relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <label htmlFor="library-search" className="sr-only">{t("library.searchPlaceholder")}</label>
            <input
              id="library-search"
              ref={searchRef}
              type="text"
              placeholder={t("library.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-warm-subtle rounded-lg text-sm text-ink placeholder-ink-muted border border-transparent focus:border-accent focus:outline-none focus:bg-surface transition-colors duration-150"
            />
          </div>
          {/* Filter: format */}
          <select
            value={filterFormat}
            onChange={(e) => setFilterFormat(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent focus:outline-none"
            aria-label={t("library.filterByFormat")}
          >
            <option value="all">{t("library.allFormats")}</option>
            <option value="epub">EPUB</option>
            <option value="pdf">PDF</option>
            <option value="cbz">CBZ</option>
            <option value="cbr">CBR</option>
          </select>

          {/* Filter: status */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent focus:outline-none"
            aria-label={t("library.filterByStatus")}
          >
            <option value="all">{t("library.allStatus")}</option>
            <option value="unread">{t("library.unread")}</option>
            <option value="in_progress">{t("library.inProgress")}</option>
            <option value="finished">{t("library.finished")}</option>
          </select>

          {/* Filter: rating */}
          <select
            value={filterRating}
            onChange={(e) => setFilterRating(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent focus:outline-none"
            aria-label={t("library.filterByRating")}
          >
            <option value="all">{t("library.allRatings")}</option>
            <option value="1">{t("library.starsPlus", { count: 1 })}</option>
            <option value="2">{t("library.starsPlus", { count: 2 })}</option>
            <option value="3">{t("library.starsPlus", { count: 3 })}</option>
            <option value="4">{t("library.starsPlus", { count: 4 })}</option>
            <option value="5">{t("library.fiveStars")}</option>
          </select>

          {/* Filter: source */}
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent focus:outline-none"
            aria-label={t("library.filterBySource")}
          >
            <option value="all">{t("library.allBooks")}</option>
            <option value="imported">{t("library.sourceImported")}</option>
            <option value="linked">{t("library.sourceLinked")}</option>
          </select>

          {/* Filter: tags */}
          <TagFilter
            allTags={allTags}
            bookTagMap={bookTagMap}
            selectedTagIds={filterTagIds}
            onChangeSelectedTagIds={setFilterTagIds}
          />

          {scanProgress ? (
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <svg className="animate-spin w-3.5 h-3.5 text-accent" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="truncate max-w-[200px]">
                {t("library.enrichingProgress", { current: scanProgress.current, total: scanProgress.total, bookTitle: scanProgress.bookTitle })}
              </span>
              <button onClick={handleCancelScan} className="shrink-0 text-ink-muted hover:text-ink transition-colors" title={t("library.cancelScan")}>
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ) : (
            <button type="button" onClick={handleStartScan} title={t("library.scanLibrary")}
              className="shrink-0 p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-warm-subtle transition-colors" aria-label={t("library.scanLibrary")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {/* Bulk select toggle (#60) */}
          {hasBooks && (
            <button
              type="button"
              onClick={() => { setSelectMode((m) => !m); setSelectedIds(new Set()); }}
              className={`p-1.5 rounded-lg transition-colors ${selectMode ? "bg-accent/20 text-accent" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
              title={selectMode ? t("library.exitSelect") : t("library.selectBooks")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M17 14v7m-3.5-3.5h7" />
              </svg>
            </button>
          )}
          <ImportButton
            onImportFiles={handleImport}
            onImportFolder={handleImportFolder}
            onImportUrl={handleImportUrl}
            loading={importing}
            progress={importProgress}
          />
        </div>
      )}

      {/* Sort bar */}
      {(hasBooks || activeCollectionId) && (
        <div className="shrink-0 px-6 py-1.5 flex items-center gap-1 border-b border-warm-border/50 bg-paper">
          {(["date_added", "title", "author", "last_read", "progress", "rating", "series"] as const).map((key) => {
            const labels: Record<string, string> = {
              date_added: t("library.sortDateAdded"),
              title: t("library.sortTitle"),
              author: t("library.sortAuthor"),
              last_read: t("library.sortLastRead"),
              progress: t("library.sortProgress"),
              rating: t("library.sortRating"),
              series: t("library.sortSeries"),
            };
            const isActive = sortBy === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (isActive) {
                    setSortAsc((prev) => !prev);
                  } else {
                    setSortBy(key);
                    setSortAsc(key === "title" || key === "author");
                  }
                }}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
                  isActive
                    ? "text-accent font-medium bg-accent-light"
                    : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                }`}
              >
                {labels[key]}
                <span className="inline-flex flex-col leading-none -space-y-px">
                  <svg width="8" height="5" viewBox="0 0 8 5" className={isActive && sortAsc ? "text-accent" : "text-ink-muted/30"}>
                    <path d="M4 0L7.5 5H0.5L4 0Z" fill="currentColor" />
                  </svg>
                  <svg width="8" height="5" viewBox="0 0 8 5" className={isActive && !sortAsc ? "text-accent" : "text-ink-muted/30"}>
                    <path d="M4 5L0.5 0H7.5L4 5Z" fill="currentColor" />
                  </svg>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="mx-6 mt-3 px-4 py-2.5 bg-red-50 text-red-700 text-sm rounded-xl flex items-center gap-2 border border-red-200">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 p-1 rounded transition-colors"
            aria-label={t("reader.dismiss")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {!hasBooks && activeCollectionId ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-base font-medium text-ink">{t("library.collectionEmpty")}</p>
            <p className="text-sm text-ink-muted mt-1">
              {activeCollection?.type === "manual"
                ? t("library.collectionEmptyManual")
                : t("library.collectionEmptyAuto")}
            </p>
            <button
              type="button"
              onClick={() => setActiveCollectionId(null)}
              className="mt-3 px-4 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
            >
              {t("library.backToAllBooks")}
            </button>
          </div>
        ) : !hasBooks ? (
          <EmptyState onImport={handleImport} onImportFolder={handleImportFolder} />
        ) : hasResults ? (
          <>
          <div className="grid grid-cols-[repeat(auto-fill,160px)] justify-center gap-5">
          {/* Continue Reading — recently opened books */}
          {showContinueReading && !search && !activeCollectionId && !activeSeries && recentlyRead.length > 0 && (
            <div className="mb-1 col-[1/-1]">
              <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide mb-3">{t("library.continueReading")}</h2>
              <div className="flex gap-4 overflow-x-auto pb-2">
                {recentlyRead.map((book) => (
                  <button
                    key={book.id}
                    onClick={() => openBook(book.id)}
                    className="shrink-0 w-28 group text-left rounded-lg overflow-hidden bg-surface border border-warm-border hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                  >
                    <div className="aspect-[2/3] bg-warm-subtle overflow-hidden">
                      {book.cover_path ? (
                        <img
                          src={convertFileSrc(book.cover_path)}
                          alt={book.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="flex items-center justify-center w-full h-full">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-ink-muted opacity-40">
                            <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="text-xs font-medium text-ink truncate">{book.title}</p>
                      {progressMap[book.id] > 0 && (
                        <div className="mt-1 h-0.5 rounded-full bg-warm-subtle">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${progressMap[book.id]}%` }} />
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Discover — popular/new from catalogs */}
          {showDiscover && !search && !activeCollectionId && !activeSeries && (discoverLoading || discoverBooks.length > 0) && (
            <div className="mb-1 col-[1/-1]" data-testid="discover-section">
              <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide mb-3">{t("library.discover")}</h2>
              <div className="flex gap-4 overflow-x-auto pb-2">
                {discoverLoading && discoverBooks.length === 0 && (
                  <>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="shrink-0 w-28 rounded-lg overflow-hidden bg-surface border border-warm-border animate-pulse">
                        <div className="aspect-[2/3] bg-warm-subtle" />
                        <div className="px-2 py-2 space-y-1.5">
                          <div className="h-3 bg-warm-subtle rounded w-4/5" />
                          <div className="h-2.5 bg-warm-subtle rounded w-3/5" />
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {discoverBooks.map((entry) => {
                  const epubLink = entry.links.find((l) => l.mimeType.includes("epub"));
                  const pdfLink = entry.links.find((l) => l.mimeType.includes("pdf"));
                  const downloadLink = epubLink ?? pdfLink;
                  const plainSummary = entry.summary?.replace(/<[^>]*>/g, "").trim();
                  return (
                    <div
                      key={entry.id}
                      className="shrink-0 w-28 group/card text-left rounded-lg overflow-hidden bg-surface border border-warm-border hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                    >
                      <div className="relative aspect-[2/3] bg-warm-subtle overflow-hidden">
                        {entry.coverUrl ? (
                          <img
                            src={entry.coverUrl}
                            alt={entry.title}
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div className="flex items-center justify-center w-full h-full">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-ink-muted opacity-40">
                              <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                        )}
                        {plainSummary && (
                          <button
                            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-ink/50 text-white flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity text-[10px] font-serif font-bold leading-none hover:bg-ink/70"
                            aria-label={t("library.showDescription")}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setDiscoverInfo(discoverInfo?.id === entry.id ? null : { id: entry.id, rect });
                            }}
                          >
                            i
                          </button>
                        )}
                      </div>
                      <div className="px-2 py-1.5">
                        <p className="text-xs font-medium text-ink truncate">{entry.title}</p>
                        {entry.author && <p className="text-[10px] text-ink-muted truncate">{entry.author}</p>}
                        {downloadLink && (
                          <button
                            onClick={async () => {
                              try {
                                await invoke("download_opds_book", { downloadUrl: downloadLink.href });
                                await loadBooks(activeCollectionIdRef.current);
                                setDiscoverBooks((prev) => prev.filter((e) => e.id !== entry.id));
                              } catch (err) {
                                setError(friendlyError(err, t));
                              }
                            }}
                            className="mt-1 text-[10px] font-medium text-accent hover:text-accent-hover transition-colors"
                          >
                            {t("library.addToLibrary")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {discoverInfo && (() => {
                const entry = discoverBooks.find((e) => e.id === discoverInfo.id);
                if (!entry) return null;
                const plainSummary = entry.summary?.replace(/<[^>]*>/g, "").trim();
                if (!plainSummary) return null;
                const { rect } = discoverInfo;
                const popoverWidth = 272;
                let left = rect.left + rect.width / 2 - popoverWidth / 2;
                left = Math.max(8, Math.min(left, window.innerWidth - popoverWidth - 8));
                return (
                  <>
                    <div className="fixed inset-0 z-50" onClick={() => setDiscoverInfo(null)} />
                    <div
                      className="fixed z-50 w-[272px] p-3.5 bg-surface border border-warm-border rounded-xl shadow-xl"
                      style={{ top: rect.bottom + 8, left }}
                    >
                      <p className="text-xs font-semibold text-ink mb-0.5 leading-snug">{entry.title}</p>
                      {entry.author && <p className="text-[10px] text-ink-muted mb-2">{entry.author}</p>}
                      <p className="text-[11px] text-ink-muted/80 leading-relaxed line-clamp-[8]">{plainSummary}</p>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {(activeCollection || activeSeries) && (
            <div className="flex items-center gap-2 pb-2 col-[1/-1]">
              <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{activeSeries ?? activeCollection?.name}</span>
              <span className="text-[10px] text-ink-muted/50">{t("library.booksCount", { count: filtered.length })}</span>
              <div className="flex-1 border-t border-warm-border/50" />
            </div>
          )}
            {sortBy === "series" ? (
              (() => {
                const seriesBooks = filtered.filter((b) => b.series);
                const nonSeriesBooks = filtered.filter((b) => !b.series);
                const groups: Record<string, typeof filtered> = {};
                for (const book of seriesBooks) {
                  (groups[book.series!] ??= []).push(book);
                }
                for (const bks of Object.values(groups)) {
                  bks.sort((a, b) => {
                    const va = a.volume ?? 9999;
                    const vb = b.volume ?? 9999;
                    if (va !== vb) return va - vb;
                    return a.title.localeCompare(b.title);
                  });
                }
                const sortedGroupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
                return (
                  <>
                    {sortedGroupNames.map((seriesName) => (
                      <React.Fragment key={seriesName}>
                        {/* Hide redundant series header when only one group and outer header already shows the name */}
                        {!(sortedGroupNames.length === 1 && (activeCollection || activeSeries)) && (
                        <button
                          type="button"
                          className="col-span-full flex items-center gap-2 pt-4 pb-2 text-left"
                          onClick={() => setCollapsedSeries((prev) => {
                            const next = new Set(prev);
                            if (next.has(seriesName)) next.delete(seriesName);
                            else next.add(seriesName);
                            return next;
                          })}
                        >
                          <svg
                            width="12" height="12" viewBox="0 0 24 24" fill="none"
                            className={`text-ink-muted/50 transition-transform ${collapsedSeries.has(seriesName) ? "" : "rotate-90"}`}
                          >
                            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{seriesName}</span>
                          <span className="text-[10px] text-ink-muted/50">{t("library.booksCount", { count: groups[seriesName].length })}</span>
                          <div className="flex-1 border-t border-warm-border/50" />
                        </button>
                        )}
                        {!collapsedSeries.has(seriesName) && groups[seriesName].map((book) => (
                          <div
                            key={book.id}
                            className="relative card-cv"
                            onMouseDown={() => !selectMode && startDrag(book.id, book.cover_path ? convertFileSrc(book.cover_path) : undefined)}
                            onMouseUp={() => !selectMode && endDrag()}
                            onDragStart={(e) => e.preventDefault()}
                          >
                            {selectMode && (
                              <SelectCheckbox
                                checked={selectedIds.has(book.id)}
                                title={book.title}
                                onToggle={() => toggleSelected(book.id)}
                              />
                            )}
                            <BookCard
                              book={toCardData(book)}
                              actions={{
                                onClick: () => {
                                  if (selectMode) {
                                    toggleSelected(book.id);
                                  } else {
                                    openBook(book.id);
                                  }
                                },
                                onDelete: selectMode ? undefined : handleRemoveBook,
                                onInfo: handleShowBookDetail,
                                onRemoveFromCollection:
                                  isManualCollectionView && activeCollectionId
                                    ? async () => {
                                        await invoke("remove_book_from_collection", {
                                          bookId: book.id,
                                          collectionId: activeCollectionId,
                                        });
                                        await loadBooks(activeCollectionId);
                                      }
                                    : undefined,
                              }}
                              isScanning={scanningBookId === book.id}
                              isSelected={selectMode && selectedIds.has(book.id)}
                            />
                          </div>
                        ))}
                      </React.Fragment>
                    ))}
                    {nonSeriesBooks.length > 0 && sortedGroupNames.length > 0 && (
                      <button
                        type="button"
                        className="col-span-full flex items-center gap-2 pt-4 pb-2 text-left"
                        onClick={() => setCollapsedSeries((prev) => {
                          const next = new Set(prev);
                          if (next.has("__other__")) next.delete("__other__");
                          else next.add("__other__");
                          return next;
                        })}
                      >
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="none"
                          className={`text-ink-muted/50 transition-transform ${collapsedSeries.has("__other__") ? "" : "rotate-90"}`}
                        >
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{t("library.otherBooks")}</span>
                        <span className="text-[10px] text-ink-muted/50">{t("library.booksCount", { count: nonSeriesBooks.length })}</span>
                        <div className="flex-1 border-t border-warm-border/50" />
                      </button>
                    )}
                    {!collapsedSeries.has("__other__") && nonSeriesBooks.map((book) => (
                      <div
                        key={book.id}
                        className="relative card-cv"
                        onMouseDown={() => !selectMode && startDrag(book.id, book.cover_path ? convertFileSrc(book.cover_path) : undefined)}
                        onMouseUp={() => !selectMode && endDrag()}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        {selectMode && (
                          <SelectCheckbox
                            checked={selectedIds.has(book.id)}
                            title={book.title}
                            onToggle={() => toggleSelected(book.id)}
                          />
                        )}
                        <BookCard
                          book={toCardData(book)}
                          actions={{
                            onClick: () => {
                              if (selectMode) {
                                toggleSelected(book.id);
                              } else {
                                openBook(book.id);
                              }
                            },
                            onDelete: selectMode ? undefined : handleRemoveBook,
                            onInfo: handleShowBookDetail,
                          }}
                          isScanning={scanningBookId === book.id}
                          isSelected={selectMode && selectedIds.has(book.id)}
                        />
                      </div>
                    ))}
                  </>
                );
              })()
            ) : (
              filtered.map((book) => (
                <div
                  key={book.id}
                  className="relative card-cv"
                  onMouseDown={() => !selectMode && startDrag(book.id, book.cover_path ? convertFileSrc(book.cover_path) : undefined)}
                  onMouseUp={() => !selectMode && endDrag()}
                  onDragStart={(e) => e.preventDefault()}
                >
                  {selectMode && (
                    <SelectCheckbox
                      checked={selectedIds.has(book.id)}
                      title={book.title}
                      onToggle={() => toggleSelected(book.id)}
                    />
                  )}
                  <BookCard
                    book={toCardData(book)}
                    actions={{
                      onClick: () => {
                        if (selectMode) {
                          toggleSelected(book.id);
                        } else {
                          openBook(book.id);
                        }
                      },
                      onDelete: selectMode ? undefined : handleRemoveBook,
                      onInfo: handleShowBookDetail,
                      onRemoveFromCollection:
                        isManualCollectionView && activeCollectionId
                          ? async () => {
                              await invoke("remove_book_from_collection", {
                                bookId: book.id,
                                collectionId: activeCollectionId,
                              });
                              await loadBooks(activeCollectionId);
                            }
                          : undefined,
                    }}
                    isScanning={scanningBookId === book.id}
                    isSelected={selectMode && selectedIds.has(book.id)}
                  />
                </div>
              ))
            )}
          </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-base font-medium text-ink">
              {t("library.noMatchFilters")}
            </p>
            <p className="text-sm text-ink-muted mt-1">
              {search
                ? t("library.noResultsFor", { query: search })
                : t("library.adjustFilters")}
            </p>
            {(filterFormat !== "all" || filterStatus !== "all" || filterRating !== "all" || filterSource !== "all" || search) && (
              <button
                type="button"
                onClick={() => { setSearch(""); setFilterFormat("all"); setFilterStatus("all"); setFilterRating("all"); setFilterSource("all"); }}
                className="mt-3 px-4 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
              >
                {t("library.clearAllFilters")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Import progress overlay */}
      {importing && importProgress && (
        <div className="absolute inset-x-0 bottom-0 z-30 bg-surface border-t border-warm-border px-6 py-4 shadow-[0_-4px_24px_-4px_rgba(44,34,24,0.10)]">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-ink">
                  {t("library.importingProgress", { current: importProgress.current, total: importProgress.total })}
                </span>
                <span className="text-xs text-ink-muted tabular-nums">
                  {Math.round((importProgress.current / importProgress.total) * 100)}%
                </span>
              </div>
              <div className="h-2 bg-warm-subtle rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => { importCancelledRef.current = true; }}
              className="shrink-0 px-3 py-1.5 text-sm text-ink-muted hover:text-red-600 bg-warm-subtle hover:bg-red-50 rounded-lg transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {dragging && (
        <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center bg-accent/[0.06] border-2 border-dashed border-accent rounded-inherit">
          <div className="flex flex-col items-center gap-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-accent">
              <path
                d="M12 3v14m0 0l-5-5m5 5l5-5M5 21h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-sm font-medium text-accent">
              {t("library.dropToAdd")}
            </span>
          </div>
        </div>
      )}

      {/* Drag ghost thumbnail */}
      {bookDragging && (
        <div
          className="fixed z-50 pointer-events-none opacity-75"
          style={{ left: mousePos.x - 40, top: mousePos.y - 55 }}
        >
          {getDraggedCoverSrc() ? (
            <img
              src={getDraggedCoverSrc()!}
              alt=""
              className="w-20 h-[110px] object-cover rounded shadow-lg"
            />
          ) : (
            <div className="w-20 h-[110px] rounded shadow-lg bg-warm-subtle flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-ink-muted">
                <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Collections sidebar */}
      {/* Keyboard shortcuts help */}
      {showShortcuts && (
        <KeyboardShortcutsHelp context="library" onClose={() => setShowShortcuts(false)} />
      )}

      {/* Loading overlay for book detail fetch */}
      {detailLoading && !detailBook && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/30 backdrop-blur-sm">
          <div className="w-10 h-10 border-3 border-warm-border border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {detailBook && (
        <BookDetailModal
          book={detailBook}
          onClose={() => { latestDetailRequestRef.current = null; setDetailLoading(false); setDetailBook(null); }}
          onOpen={(id) => {
            setDetailBook(null);
            openBook(id);
          }}
          onEdit={handleEditBook}
          onScan={async (id) => {
            setScanningBookId(id);
            try {
              const updatedBook = await invoke<Book>("scan_single_book", { bookId: id });
              await loadBooks(activeCollectionIdRef.current);
              setDetailBook(updatedBook);
              addToast(t("library.metadataUpdated"), "success");
              setScanToastMessage(t("library.metadataUpdated"));
            } catch (err) {
              const msg = String(err);
              const errorMsg = msg.includes("No match") ? t("library.noMetadataFound") : t("library.scanFailed");
              addToast(errorMsg, "error");
              setScanToastMessage(errorMsg);
            } finally {
              setScanningBookId(null);
            }
          }}
        />
      )}

      {/* Edit book dialog */}
      {editingBook && (
        <EditBookDialog
          bookId={editingBook.id}
          initialTitle={editingBook.title}
          initialAuthor={editingBook.author}
          description={editingBook.description}
          genres={editingBook.genres}
          rating={editingBook.rating}
          openlibraryKey={editingBook.openlibrary_key}
          initialSeries={editingBook.series}
          initialVolume={editingBook.volume}
          initialLanguage={editingBook.language}
          initialPublisher={editingBook.publisher}
          initialPublishYear={editingBook.publish_year}
          isImported={editingBook.is_imported}
          onClose={() => setEditingBook(null)}
          onSaved={() => {
            setEditingBook(null);
            loadBooks(activeCollectionIdRef.current);
          }}
        />
      )}

      <CollectionsSidebar
        open={collectionsOpen}
        collections={collections}
        activeCollectionId={activeCollectionId}
        activeSeries={activeSeries}
        seriesList={seriesList}
        onClose={() => setCollectionsOpen(false)}
        onSelect={(id) => {
          setActiveCollectionId(id);
          setActiveSeries(null);
        }}
        onSelectSeries={handleSelectSeries}
        onCreate={async (data: CreateCollectionData) => {
          try {
            await invoke("create_collection", {
              name: data.name,
              collType: data.type,
              icon: data.icon,
              color: data.color,
              rules: data.rules,
            });
            const updated = await invoke<Collection[]>("get_collections");
            setCollections(updated);
          } catch (err) {
            setError(friendlyError(err, t));
          }
        }}
        onEdit={async (id: string, data: CreateCollectionData) => {
          try {
            await invoke("update_collection", {
              id,
              name: data.name,
              collType: data.type,
              icon: data.icon,
              color: data.color,
              rules: data.rules,
            });
            const updated = await invoke<Collection[]>("get_collections");
            setCollections(updated);
            if (activeCollectionIdRef.current === id) {
              await loadBooks(id);
            }
          } catch (err) {
            setError(friendlyError(err, t));
          }
        }}
        onDelete={async (id: string) => {
          try {
            await invoke("delete_collection", { id });
            const updated = await invoke<Collection[]>("get_collections");
            setCollections(updated);
            if (activeCollectionIdRef.current === id) setActiveCollectionId(null);
          } catch (err) {
            setError(friendlyError(err, t));
          }
        }}
        onDropBook={async (bookId: string, collectionId: string) => {
          try {
            await invoke("add_book_to_collection", { bookId, collectionId });
            if (activeCollectionIdRef.current === collectionId) {
              await loadBooks(collectionId);
            }
          } catch (err) {
            setError(friendlyError(err, t));
          }
        }}
      />
      {importing && (
        <div className="fixed inset-0 bg-ink/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg flex flex-col items-center gap-3">
            <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
            <p className="text-sm text-gray-600 dark:text-gray-300">{t("import.importing")}</p>
          </div>
        </div>
      )}

      {/* Scan toast */}
      {fileNotAvailableBookId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-red-900/90 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 text-sm">
          <span>{t("bookCard.fileNotAvailable")}</span>
          <button
            onClick={() => {
              const bookId = fileNotAvailableBookId;
              setFileNotAvailableBookId(null);
              handleRemoveBook(bookId);
            }}
            className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded-lg text-xs font-medium transition-colors"
          >
            {t("common.remove")}
          </button>
          <button
            onClick={() => setFileNotAvailableBookId(null)}
            className="text-white/60 hover:text-white"
            aria-label={t("common.close")}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      {/* Bulk action bar (#60) */}
      {selectMode && selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-ink text-paper px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 text-sm">
          <span className="font-medium">{selectedIds.size} {t("library.selected")}</span>
          <button
            type="button"
            onClick={() => {
              const allIds = filtered.map((b) => b.id);
              setSelectedIds(new Set(selectedIds.size === allIds.length ? [] : allIds));
            }}
            className="text-accent hover:underline text-xs"
          >
            {selectedIds.size === filtered.length ? t("library.deselectAll") : t("library.selectAll")}
          </button>
          <button
            type="button"
            onClick={() => setBulkEditing(true)}
            className="text-accent hover:text-accent-hover text-xs font-medium"
          >
            {t("library.bulkEdit")}
          </button>
          <div className="w-px h-4 bg-paper/20" />
          <button
            type="button"
            onClick={async () => {
              if (!confirm(t("library.bulkDeleteConfirm", { count: selectedIds.size }))) return;
              try {
                await invoke("bulk_delete_books", { bookIds: [...selectedIds] });
                addToast(t("library.bulkDeleted", { count: selectedIds.size }), "success");
                setSelectedIds(new Set());
                setSelectMode(false);
                await loadBooks(activeCollectionIdRef.current);
              } catch (e) { addToast(friendlyError(e, t), "error"); }
            }}
            className="text-red-400 hover:text-red-300 text-xs font-medium"
          >
            {t("common.delete")}
          </button>
          <button
            type="button"
            onClick={() => { setSelectedIds(new Set()); setSelectMode(false); }}
            className="text-paper/60 hover:text-paper text-xs"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {/* Toast notifications now rendered by ToastProvider at app root */}

      {bulkEditing && (
        <BulkEditDialog
          bookIds={[...selectedIds]}
          books={filtered}
          onClose={() => setBulkEditing(false)}
          onSave={async (updatedCount) => {
            setBulkEditing(false);
            setSelectedIds(new Set());
            setSelectMode(false);
            await loadBooks(activeCollectionIdRef.current);
            addToast(t("library.bulkEditSuccess", { count: updatedCount }), "success");
          }}
        />
      )}

      {/* Screen reader announcements for import and scan progress */}
      <LiveRegion
        message={
          importing && importProgress
            ? `${t("library.importing")} ${importProgress.current} / ${importProgress.total}`
            : scanToastMessage || ""
        }
      />
    </div>
  );
}

function SelectCheckbox({
  checked,
  title,
  onToggle,
}: {
  checked: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <div
      className={`absolute top-2 left-2 z-10 w-7 h-7 flex items-center justify-center rounded-full border-2 shadow-md cursor-pointer transition-colors ${
        checked
          ? "bg-accent border-accent text-paper"
          : "bg-paper/90 border-warm-border text-transparent"
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
