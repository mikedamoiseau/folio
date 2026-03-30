import { useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatMetadataPills } from "../lib/utils";
import StarRating from "./StarRating";

interface BookCardProps {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  totalChapters: number;
  format?: "epub" | "cbz" | "cbr" | "pdf";
  progress?: number; // 0-100
  language?: string | null;
  publishYear?: number | null;
  series?: string | null;
  volume?: number | null;
  rating?: number | null;
  isImported?: boolean;
  onClick: () => void;
  onDelete?: (id: string) => void;
  onEdit?: (id: string) => void;
  onInfo?: (id: string) => void;
  onRemoveFromCollection?: () => void;
  onScanForMetadata?: (id: string) => void;
  isScanning?: boolean;
}

export default function BookCard({
  id,
  title,
  author,
  coverPath,
  format,
  progress,
  language,
  publishYear,
  series,
  volume,
  rating,
  isImported,
  onClick,
  onDelete,
  onEdit,
  onInfo,
  onRemoveFromCollection,
  onScanForMetadata,
  isScanning,
}: BookCardProps) {
  const { t } = useTranslation();
  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;
  const [confirming, setConfirming] = useState(false);
  const pills = formatMetadataPills({ language, publishYear, series, volume });

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
      className="w-full h-full group text-left rounded-xl bg-surface border border-warm-border overflow-hidden cursor-pointer transition-all duration-200 ease-out shadow-sm hover:shadow-[0_8px_24px_-4px_rgba(44,34,24,0.18)] hover:-translate-y-1 focus:outline-2 focus:outline-accent focus:outline-offset-2"
    >
      {/* Cover — 2:3 aspect ratio */}
      <div className="relative aspect-[2/3] bg-warm-subtle overflow-hidden">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={t("bookCard.coverAlt", { title })}
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

        {/* Linked badge — only for linked (non-imported) books */}
        {isImported === false && !confirming && (
          <span
            className="absolute top-2 left-2 bg-ink/70 text-paper text-[9px] px-1.5 py-0.5 rounded backdrop-blur-sm flex items-center gap-0.5"
            title={t("bookCard.linkedBadge")}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M6.5 9.5L9.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M11 5L12.5 3.5a2.12 2.12 0 00-3-3L8 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M5 11L3.5 12.5a2.12 2.12 0 003 3L8 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
        )}

        {/* Progress badge */}
        {progress != null && progress > 0 && !confirming && (
          <span className="absolute top-2 right-2 bg-ink/70 text-paper text-[10px] font-medium px-2 py-0.5 rounded-full backdrop-blur-sm">
            {progress}%
          </span>
        )}

        {/* Metadata action buttons — top-left, vertical stack */}
        {!confirming && (
          <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {onEdit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(id); }}
                aria-label={t("bookCard.editLabel", { title })}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-accent focus:opacity-100 focus:outline-none"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {onScanForMetadata && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); if (!isScanning) onScanForMetadata(id); }}
                className={`w-6 h-6 rounded-full bg-ink/60 hover:bg-accent text-white flex items-center justify-center transition-all ${isScanning ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                title={t("bookCard.scanForMetadata")}
                disabled={isScanning}
              >
                {isScanning ? (
                  <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            )}
            {onInfo && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onInfo(id); }}
                aria-label={t("bookCard.detailsLabel", { title })}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-accent focus:opacity-100 focus:outline-none"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" />
                  <path d="M12 16v-4m0-4h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Delete button — bottom-right, separate */}
        {onDelete && !confirming && (
          <button
            type="button"
            onClick={handleDeleteClick}
            aria-label={t("bookCard.removeLabel", { title })}
            className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-red-600 focus:opacity-100 focus:outline-none"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        )}

        {/* Remove from collection button — bottom-left, only when in a manual collection */}
        {onRemoveFromCollection && !confirming && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemoveFromCollection(); }}
            aria-label={t("bookCard.removeFromCollection")}
            title={t("bookCard.removeFromCollection")}
            className="absolute bottom-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-accent focus:opacity-100 focus:outline-none"
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
            role="alertdialog"
            aria-modal="true"
            aria-label={t("bookCard.confirmDeletion")}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-ink/80 px-4 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirming(false); } }}
          >
            <p className="text-white text-xs text-center line-clamp-2 font-medium leading-snug">
              {t("bookCard.confirmDelete", { title })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirm}
                className="px-3 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                {t("common.remove")}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1 rounded-lg bg-paper/20 hover:bg-paper/30 text-paper text-xs font-medium focus:outline-none focus:ring-2 focus:ring-paper/50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Info area */}
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-ink truncate leading-snug" title={title}>
          {title}
        </p>
        <p className="text-xs text-ink-muted truncate mt-0.5" title={author}>
          {author}
        </p>
        {rating != null && rating > 0 && (
          <div className="mt-1">
            <StarRating value={Math.round(rating)} size="sm" />
          </div>
        )}
        {pills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {pills.map((pill) => (
              <span
                key={pill.label}
                className="text-[10px] leading-tight bg-warm-subtle text-ink-muted px-1.5 py-0.5 rounded-full"
              >
                {pill.label}
              </span>
            ))}
          </div>
        )}
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
