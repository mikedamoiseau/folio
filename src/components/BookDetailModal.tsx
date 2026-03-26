import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface Book {
  id: string;
  title: string;
  author: string;
  cover_path: string | null;
  format: "epub" | "cbz" | "cbr" | "pdf";
  description: string | null;
  series: string | null;
  volume: number | null;
  language: string | null;
  publisher: string | null;
  publish_year: number | null;
}

interface BookDetailModalProps {
  book: Book;
  onClose: () => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}

export default function BookDetailModal({ book, onClose, onOpen, onEdit }: BookDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // Auto-focus first button
    const firstBtn = dialogRef.current?.querySelector<HTMLElement>("button");
    firstBtn?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const coverSrc = book.cover_path ? convertFileSrc(book.cover_path) : null;

  const metadataRows: { label: string; value: string }[] = [];
  if (book.series) {
    const val = book.volume != null ? `${book.series} #${book.volume}` : book.series;
    metadataRows.push({ label: "Series", value: val });
  }
  if (book.language) metadataRows.push({ label: "Language", value: book.language });
  if (book.publish_year != null) metadataRows.push({ label: "Year", value: String(book.publish_year) });
  if (book.publisher) metadataRows.push({ label: "Publisher", value: book.publisher });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${book.title}`}
        className="bg-surface border border-warm-border rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: cover + title */}
        <div className="flex gap-4 p-5">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={`Cover of ${book.title}`}
              className="w-[100px] h-[150px] object-cover rounded-lg shadow-sm flex-shrink-0"
            />
          ) : (
            <div className="w-[100px] h-[150px] bg-warm-subtle rounded-lg flex items-center justify-center flex-shrink-0">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ink-muted opacity-50">
                <path
                  d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </div>
          )}
          <div className="flex flex-col justify-center min-w-0">
            <h2 className="text-lg font-semibold text-ink leading-snug">{book.title}</h2>
            <p className="text-sm text-ink-muted mt-1">{book.author}</p>
            {book.format !== "epub" && (
              <span className="mt-2 self-start text-[10px] font-semibold uppercase tracking-wider bg-warm-subtle text-ink-muted px-2 py-0.5 rounded">
                {book.format}
              </span>
            )}
          </div>
        </div>

        {/* Metadata rows */}
        {metadataRows.length > 0 && (
          <div className="px-5 pb-3">
            <div className="border-t border-warm-border pt-3 space-y-1.5">
              {metadataRows.map((row) => (
                <div key={row.label} className="flex text-sm">
                  <span className="text-ink-muted w-20 flex-shrink-0">{row.label}</span>
                  <span className="text-ink">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        {book.description && (
          <div className="px-5 pb-3">
            <div className="border-t border-warm-border pt-3">
              <p className="text-sm text-ink-muted leading-relaxed max-h-40 overflow-y-auto">
                {book.description}
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 px-5 py-4 border-t border-warm-border">
          <button
            type="button"
            onClick={() => onOpen(book.id)}
            className="flex-1 px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => onEdit(book.id)}
            className="flex-1 px-4 py-2 rounded-xl bg-warm-subtle text-ink text-sm font-medium hover:bg-warm-border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}
