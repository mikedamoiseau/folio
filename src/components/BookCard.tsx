import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface BookCardProps {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  totalChapters: number;
  progress?: number; // 0-100
  onClick: () => void;
  onDelete?: (id: string) => void;
}

export default function BookCard({
  id,
  title,
  author,
  coverPath,
  progress,
  onClick,
  onDelete,
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
      className="group text-left rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden cursor-pointer transition-shadow duration-150 ease-in-out hover:shadow-md focus:outline-2 focus:outline-blue-500 focus:outline-offset-2"
    >
      {/* Cover area */}
      <div className="relative h-[180px] bg-gray-100 dark:bg-gray-800">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={`Cover of ${title}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex items-center justify-center w-full h-full">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              className="text-gray-400"
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
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/[0.08] transition-colors duration-150" />
        {/* Reading badge */}
        {progress != null && progress > 0 && !confirming && (
          <span className="absolute top-2 right-2 bg-black/65 text-white text-xs px-2 py-0.5 rounded-full">
            {progress}% read
          </span>
        )}
        {/* Delete button — hover reveal */}
        {onDelete && !confirming && (
          <button
            type="button"
            onClick={handleDeleteClick}
            aria-label={`Remove ${title}`}
            className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-6 h-6 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-600 focus:opacity-100 focus:outline-none"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {/* Inline confirmation */}
        {confirming && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-white text-xs font-medium text-center leading-snug">
              Remove this book?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleConfirm}
                className="px-3 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1 rounded-md bg-white/20 hover:bg-white/30 text-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-white/50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Info area */}
      <div className="p-3">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {title}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
          {author}
        </p>
        {progress != null && progress > 0 && (
          <div className="mt-2 h-1 rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
}
