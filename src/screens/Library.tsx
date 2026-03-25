import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import BookCard from "../components/BookCard";
import EmptyState from "../components/EmptyState";
import ImportButton from "../components/ImportButton";

interface Book {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
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

  const loadLibrary = useCallback(async () => {
    try {
      const library: Book[] = await invoke("get_library");
      setBooks(library);

      // Load progress for each book
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

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const handleRemoveBook = useCallback(
    async (bookId: string) => {
      try {
        await invoke("remove_book", { bookId });
        await loadLibrary();
      } catch (err) {
        setError(String(err));
      }
    },
    [loadLibrary]
  );

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "EPUB", extensions: ["epub"] }],
      });

      if (!selected) return;

      setImporting(true);
      setError(null);

      await invoke("import_book", { filePath: selected });
      await loadLibrary();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }, [loadLibrary]);

  // Drag and drop handlers
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!dragging) setDragging(true);
    },
    [dragging]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const epubFile = files.find((f) => f.name.endsWith(".epub"));
      if (!epubFile) return;

      setImporting(true);
      setError(null);
      try {
        // In Tauri, dropped files provide a path
        const filePath = (epubFile as unknown as { path?: string }).path;
        if (filePath) {
          await invoke("import_book", { filePath });
          await loadLibrary();
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setImporting(false);
      }
    },
    [loadLibrary]
  );

  // Filter books by search
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

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-lg text-gray-500 dark:text-gray-400">
          Loading library…
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      {hasBooks && (
        <div className="shrink-0 h-14 px-6 flex items-center gap-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          {/* Search input */}
          <div className="flex-1 relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="11"
                cy="11"
                r="7"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M21 21l-4.35-4.35"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="text"
              placeholder="Search books…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 border-none focus:outline-2 focus:outline-blue-500 focus:-outline-offset-2"
            />
          </div>
          <ImportButton onClick={handleImport} loading={importing} />
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="mx-6 mt-3 px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm rounded-lg flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 p-1"
            aria-label="Dismiss error"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {!hasBooks ? (
          <EmptyState onImport={handleImport} />
        ) : hasResults ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-6">
            {filtered.map((book) => (
              <BookCard
                key={book.id}
                id={book.id}
                title={book.title}
                author={book.author}
                coverPath={book.cover_path}
                totalChapters={book.total_chapters}
                progress={progressMap[book.id] ?? 0}
                onClick={() => navigate(`/reader/${book.id}`)}
                onDelete={handleRemoveBook}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-base font-medium text-gray-900 dark:text-gray-100">
              No results for &ldquo;{search}&rdquo;
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Try a different title or author name.
            </p>
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {dragging && (
        <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center bg-blue-500/[0.08] border-2 border-dashed border-blue-500 rounded-inherit">
          <div className="flex flex-col items-center gap-2">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              className="text-blue-700 dark:text-blue-300"
            >
              <path
                d="M12 3v14m0 0l-5-5m5 5l5-5M5 21h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-base font-medium text-blue-700 dark:text-blue-300">
              Drop to import
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
