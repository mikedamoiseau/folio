import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import ImportButton from "../components/ImportButton";
import CollectionsSidebar, {
  Collection,
  CreateCollectionData,
} from "../components/CollectionsSidebar";
import EditBookDialog from "../components/EditBookDialog";
import KeyboardShortcutsHelp from "../components/KeyboardShortcutsHelp";
import { startDrag, endDrag, isDragging, getDraggedCoverSrc, subscribe } from "../lib/dragState";

interface Book {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
  format: "epub" | "cbz" | "cbr" | "pdf";
  description: string | null;
  genres: string | null;
  rating: number | null;
  isbn: string | null;
  openlibrary_key: string | null;
}

interface ReadingProgress {
  book_id: string;
  chapter_index: number;
  scroll_position: number;
  last_read_at: number;
}

export default function Library() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<Book[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [lastReadMap, setLastReadMap] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"date_added" | "last_read" | "title" | "author" | "progress">("date_added");
  const [sortAsc, setSortAsc] = useState(false);
  const [filterFormat, setFilterFormat] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const importCancelledRef = useRef(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Recently read
  const [recentlyRead, setRecentlyRead] = useState<Book[]>([]);

  // Collections state
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);

  // Keep a stable ref to activeCollectionId for use in callbacks
  const activeCollectionIdRef = useRef(activeCollectionId);
  activeCollectionIdRef.current = activeCollectionId;

  const loadBooks = useCallback(async (collectionId: string | null = activeCollectionIdRef.current) => {
    try {
      let library: Book[];
      if (collectionId) {
        library = await invoke<Book[]>("get_books_in_collection", { collectionId });
      } else {
        library = await invoke<Book[]>("get_library");
      }
      setBooks(library);

      const progData = await Promise.all(
        library.map(async (book) => {
          try {
            const prog: ReadingProgress | null = await invoke(
              "get_reading_progress",
              { bookId: book.id }
            );
            if (prog && book.total_chapters > 0) {
              const pct = Math.round(
                ((prog.chapter_index + 1) / book.total_chapters) * 100
              );
              return { id: book.id, pct, lastRead: prog.last_read_at };
            }
          } catch {
            // ignore progress fetch errors
          }
          return { id: book.id, pct: 0, lastRead: 0 };
        })
      );

      setProgressMap(Object.fromEntries(progData.map((d) => [d.id, d.pct])));
      setLastReadMap(Object.fromEntries(progData.map((d) => [d.id, d.lastRead])));
    } catch (err) {
      setError(String(err));
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

  useEffect(() => {
    loadCollections();
    loadBooks(null);
    loadRecentlyRead();
  }, [loadCollections, loadBooks, loadRecentlyRead]);

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
        setError(String(err));
      }
    },
    [loadBooks]
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
            results.errors.push(`${paths[i].split("/").pop()}: ${msg}`);
          }
        }
      }
      await loadBooks(activeCollectionIdRef.current);
      await loadRecentlyRead();
      const parts: string[] = [];
      if (results.imported > 0) parts.push(`${results.imported} imported`);
      if (results.duplicates > 0) parts.push(`${results.duplicates} skipped`);
      if (importCancelledRef.current) parts.push("cancelled");
      if (results.errors.length > 0) parts.push(`${results.errors.length} failed`);
      if (results.errors.length > 0 || importCancelledRef.current) {
        setError(parts.join(", ") + (results.errors.length > 0 ? ": " + results.errors.join("; ") : ""));
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
      importCancelledRef.current = false;
    }
  }, [loadBooks, loadRecentlyRead]);

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
        setError("No supported book files (.epub, .pdf, .cbz, .cbr) found in that folder.");
        setImporting(false);
        return;
      }
      await importFiles(files);
    } catch (err) {
      setError(String(err));
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
      setError(String(err));
    }
  }, [importFiles]);

  const handleImportUrl = useCallback(async (url: string) => {
    try {
      setImporting(true);
      setError(null);
      await invoke("download_opds_book", { downloadUrl: url });
      await loadBooks(activeCollectionIdRef.current);
    } catch (err) {
      setError(String(err));
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

  const filtered = books
    .filter((book) => {
      if (search) {
        const q = search.toLowerCase();
        if (!book.title.toLowerCase().includes(q) && !book.author.toLowerCase().includes(q)) return false;
      }
      if (filterFormat !== "all" && book.format !== filterFormat) return false;
      if (filterStatus !== "all") {
        const pct = progressMap[book.id] ?? 0;
        if (filterStatus === "unread" && pct !== 0) return false;
        if (filterStatus === "in_progress" && (pct === 0 || pct >= 100)) return false;
        if (filterStatus === "finished" && pct < 100) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      switch (sortBy) {
        case "title": return dir * a.title.localeCompare(b.title);
        case "author": return dir * a.author.localeCompare(b.author);
        case "last_read": return dir * ((lastReadMap[a.id] ?? 0) - (lastReadMap[b.id] ?? 0));
        case "progress": return dir * ((progressMap[a.id] ?? 0) - (progressMap[b.id] ?? 0));
        case "date_added":
        default: return dir * (a.added_at - b.added_at);
      }
    });

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

  const hasBooks = books.length > 0;
  const hasResults = filtered.length > 0;

  // Determine if we're in a manual collection view (enables remove-from-collection)
  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;
  const isManualCollectionView = activeCollection?.type === "manual";

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full bg-paper">
        <p className="text-sm text-ink-muted">Loading library…</p>
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
            title="Collections"
            className={`shrink-0 p-2 rounded-lg transition-colors ${
              activeCollectionId
                ? "text-accent bg-accent-light"
                : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
            }`}
            aria-label="Open collections"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M2 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"
                stroke="currentColor"
                strokeWidth="1.75"
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
            <input
              ref={searchRef}
              type="text"
              placeholder="Search by title or author…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-warm-subtle rounded-lg text-sm text-ink placeholder-ink-muted border border-transparent focus:border-accent/40 focus:outline-none focus:bg-surface transition-colors duration-150"
            />
          </div>
          {/* Filter: format */}
          <select
            value={filterFormat}
            onChange={(e) => setFilterFormat(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent/40 focus:outline-none"
            aria-label="Filter by format"
          >
            <option value="all">All formats</option>
            <option value="epub">EPUB</option>
            <option value="pdf">PDF</option>
            <option value="cbz">CBZ</option>
            <option value="cbr">CBR</option>
          </select>

          {/* Filter: status */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent/40 focus:outline-none"
            aria-label="Filter by status"
          >
            <option value="all">All status</option>
            <option value="unread">Unread</option>
            <option value="in_progress">In progress</option>
            <option value="finished">Finished</option>
          </select>

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
          {(["date_added", "title", "author", "last_read", "progress"] as const).map((key) => {
            const labels: Record<string, string> = {
              date_added: "Date added",
              title: "Title",
              author: "Author",
              last_read: "Last read",
              progress: "Progress",
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
            aria-label="Dismiss error"
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
            <p className="text-base font-medium text-ink">This collection is empty</p>
            <p className="text-sm text-ink-muted mt-1">
              {activeCollection?.type === "manual"
                ? "Drag books onto this collection to add them."
                : "No books match this collection\u2019s rules yet."}
            </p>
            <button
              type="button"
              onClick={() => setActiveCollectionId(null)}
              className="mt-3 px-4 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
            >
              Back to all books
            </button>
          </div>
        ) : !hasBooks ? (
          <EmptyState onImport={handleImport} onImportFolder={handleImportFolder} />
        ) : hasResults ? (
          <>
          {/* Continue Reading — recently opened books */}
          {!search && !activeCollectionId && recentlyRead.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-ink-muted uppercase tracking-wide mb-3">Continue Reading</h2>
              <div className="flex gap-4 overflow-x-auto pb-2">
                {recentlyRead.map((book) => (
                  <button
                    key={book.id}
                    onClick={() => navigate(`/reader/${book.id}`)}
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
          <div className="grid grid-cols-[repeat(auto-fill,160px)] justify-center gap-5">
            {filtered.map((book) => (
              <div
                key={book.id}
                onMouseDown={() => startDrag(book.id, book.cover_path ? convertFileSrc(book.cover_path) : undefined)}
                onMouseUp={() => endDrag()}
                onDragStart={(e) => e.preventDefault()}
              >
                <BookCard
                  id={book.id}
                  title={book.title}
                  author={book.author}
                  coverPath={book.cover_path}
                  totalChapters={book.total_chapters}
                  format={book.format}
                  progress={progressMap[book.id] ?? 0}
                  onClick={() => navigate(`/reader/${book.id}`)}
                  onDelete={handleRemoveBook}
                  onEdit={(id) => {
                    const book = books.find((b) => b.id === id);
                    if (book) setEditingBook(book);
                  }}
                  onRemoveFromCollection={
                    isManualCollectionView && activeCollectionId
                      ? async () => {
                          await invoke("remove_book_from_collection", {
                            bookId: book.id,
                            collectionId: activeCollectionId,
                          });
                          await loadBooks(activeCollectionId);
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-base font-medium text-ink">
              No books match the current filters
            </p>
            <p className="text-sm text-ink-muted mt-1">
              {search
                ? `No results for "${search}". Try a different search term.`
                : "Try adjusting your sort, format, or status filters."}
            </p>
            {(filterFormat !== "all" || filterStatus !== "all" || search) && (
              <button
                type="button"
                onClick={() => { setSearch(""); setFilterFormat("all"); setFilterStatus("all"); }}
                className="mt-3 px-4 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Import progress overlay */}
      {importing && importProgress && importProgress.total > 1 && (
        <div className="absolute inset-x-0 bottom-0 z-30 bg-surface border-t border-warm-border px-6 py-4 shadow-[0_-4px_24px_-4px_rgba(44,34,24,0.10)]">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-ink">
                  Importing {importProgress.current} of {importProgress.total}…
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
              Cancel
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
              Drop to add books
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
        onClose={() => setCollectionsOpen(false)}
        onSelect={(id) => {
          setActiveCollectionId(id);
        }}
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
            setError(String(err));
          }
        }}
        onDelete={async (id: string) => {
          try {
            await invoke("delete_collection", { id });
            const updated = await invoke<Collection[]>("get_collections");
            setCollections(updated);
            if (activeCollectionIdRef.current === id) setActiveCollectionId(null);
          } catch (err) {
            setError(String(err));
          }
        }}
        onDropBook={async (bookId: string, collectionId: string) => {
          try {
            await invoke("add_book_to_collection", { bookId, collectionId });
            if (activeCollectionIdRef.current === collectionId) {
              await loadBooks(collectionId);
            }
          } catch (err) {
            setError(String(err));
          }
        }}
      />
    </div>
  );
}
