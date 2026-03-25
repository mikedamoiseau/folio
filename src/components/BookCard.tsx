import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface BookCardProps {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  totalChapters: number;
  format?: "epub" | "cbz" | "cbr" | "pdf";
  progress?: number; // 0-100
  onClick: () => void;
  onDelete?: (id: string) => void;
  onRemoveFromCollection?: () => void;
}

export default function BookCard({
  id,
  title,
  author,
  coverPath,
  format,
  progress,
  onClick,
  onDelete,
  onRemoveFromCollection,
}: BookCardProps) {
  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;
  const [confirming, setConfirming] = useState(false);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(true);
  };

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(id);
    setConfirming(false);
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-xl bg-surface border border-warm-border overflow-hidden cursor-pointer transition-all duration-200 ease-out shadow-sm hover:shadow-[0_8px_24px_-4px_rgba(44,34,24,0.18)] hover:-translate-y-1 focus:outline-2 focus:outline-accent focus:outline-offset-2"
    >
      {/* Cover — 2:3 aspect ratio */}
      <div className="relative aspect-[2/3] bg-warm-subtle overflow-hidden">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={`Cover of ${title}`}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex flex-col items-center justify-center w-full h-full gap-3">
            {/* Decorative spine lines */}
            <div className="flex flex-col gap-1.5 w-10">
              <div className="h-px bg-warm-border w-full" />
              <div className="h-px bg-warm-border w-3/4" />
              <div className="h-px bg-warm-border w-full" />
            </div>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              className="text-ink-muted opacity-50"
            >
              <path
                d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}

        {/* Subtle gradient overlay at bottom for text legibility */}
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />

        {/* Format badge — shown for non-epub */}
        {format && format !== "epub" && !confirming && (
          <span className="absolute bottom-2 left-2 bg-ink/70 text-paper text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded backdrop-blur-sm">
            {format}
          </span>
        )}

        {/* Progress badge */}
        {progress != null && progress > 0 && !confirming && (
          <span className="absolute top-2 right-2 bg-ink/70 text-paper text-[10px] font-medium px-2 py-0.5 rounded-full backdrop-blur-sm">
            {progress}%
          </span>
        )}

        {/* Delete button — hover reveal */}
        {onDelete && !confirming && (
          <button
            type="button"
            onClick={handleDeleteClick}
            aria-label={`Remove ${title}`}
            className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-red-600 focus:opacity-100 focus:outline-none"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}

        {/* Remove from collection button — bottom-right, only when in a manual collection */}
        {onRemoveFromCollection && !confirming && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemoveFromCollection(); }}
            aria-label="Remove from collection"
            title="Remove from collection"
            className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-accent focus:opacity-100 focus:outline-none"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
              <path d="M8 12h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        )}

        {/* Inline delete confirmation */}
        {confirming && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-ink/80 px-4 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-paper text-xs font-medium text-center leading-snug">
              Remove this book?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirm}
                className="px-3 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1 rounded-lg bg-paper/20 hover:bg-paper/30 text-paper text-xs font-medium focus:outline-none focus:ring-2 focus:ring-paper/50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Info area */}
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-ink truncate leading-snug">
          {title}
        </p>
        <p className="text-xs text-ink-muted truncate mt-0.5">
          {author}
        </p>
        {progress != null && progress > 0 && (
          <div className="mt-2 h-0.5 rounded-full bg-warm-subtle">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
}
