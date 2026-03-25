import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import ImportButton from "../components/ImportButton";
import CollectionsSidebar, {
  Collection,
  CreateCollectionData,
} from "../components/CollectionsSidebar";

interface Book {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
  format: "epub" | "cbz" | "cbr" | "pdf";
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
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);

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

      const progEntries = await Promise.all(
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
              return [book.id, pct] as const;
            }
          } catch {
            // ignore progress fetch errors
          }
          return [book.id, 0] as const;
        })
      );

      setProgressMap(Object.fromEntries(progEntries));
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

  useEffect(() => {
    loadCollections();
    loadBooks(null);
  }, [loadCollections, loadBooks]);

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

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Books", extensions: ["epub", "cbz", "cbr", "pdf"] }],
      });

      if (!selected) return;

      setImporting(true);
      setError(null);

      await invoke("import_book", { filePath: selected });
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
          const epubPaths = paths.filter((p) =>
            supportedExtensions.some((ext) => p.toLowerCase().endsWith(ext))
          );
          if (epubPaths.length === 0) return;
          setImporting(true);
          setError(null);
          try {
            for (const filePath of epubPaths) {
              await invoke("import_book", { filePath });
            }
            await loadBooks(activeCollectionIdRef.current);
          } catch (err) {
            setError(String(err));
          } finally {
            setImporting(false);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [loadBooks]);

  const filtered = books.filter((book) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      book.title.toLowerCase().includes(q) ||
      book.author.toLowerCase().includes(q)
    );
  });

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
    <div className="flex flex-col h-full relative bg-paper">
      {/* Toolbar */}
      {hasBooks && (
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
              type="text"
              placeholder="Search by title or author…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-warm-subtle rounded-lg text-sm text-ink placeholder-ink-muted border border-transparent focus:border-accent/40 focus:outline-none focus:bg-surface transition-colors duration-150"
            />
          </div>
          <ImportButton onClick={handleImport} loading={importing} />
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
        {!hasBooks ? (
          <EmptyState onImport={handleImport} />
        ) : hasResults ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-5">
            {filtered.map((book) => (
              <div
                key={book.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("bookId", book.id)}
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
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-base font-medium text-ink">
              No results for &ldquo;{search}&rdquo;
            </p>
            <p className="text-sm text-ink-muted mt-1">
              Try a different title or author name.
            </p>
          </div>
        )}
      </div>

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

      {/* Collections sidebar */}
      <CollectionsSidebar
        open={collectionsOpen}
        collections={collections}
        activeCollectionId={activeCollectionId}
        onClose={() => setCollectionsOpen(false)}
        onSelect={(id) => {
          setActiveCollectionId(id);
          setCollectionsOpen(false);
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
