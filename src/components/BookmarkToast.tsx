import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface BookmarkToastProps {
  bookmarkId: string;
  onDismiss: () => void;
}

export default function BookmarkToast({
  bookmarkId,
  onDismiss,
}: BookmarkToastProps) {
  const [mode, setMode] = useState<"confirmed" | "naming">("confirmed");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Auto-dismiss after 3s if still in confirmed mode
  useEffect(() => {
    if (mode !== "confirmed") return;
    timerRef.current = setTimeout(() => onDismiss(), 3000);
    return () => clearTimeout(timerRef.current);
  }, [mode, onDismiss]);

  const handleAddName = () => {
    clearTimeout(timerRef.current);
    setMode("naming");
  };

  useEffect(() => {
    if (mode === "naming") {
      inputRef.current?.focus();
    }
  }, [mode]);

  const saveName = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed) {
      try {
        await invoke("update_bookmark", {
          bookmarkId,
          name: trimmed,
        });
      } catch {
        // non-fatal
      }
    }
    onDismiss();
  }, [name, bookmarkId, onDismiss]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveName();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-ink/90 text-white text-sm rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
      {mode === "confirmed" ? (
        <>
          Bookmark saved
          <button
            onClick={handleAddName}
            className="text-blue-300 hover:text-blue-200 text-xs ml-1 transition-colors"
          >
            Add name...
          </button>
        </>
      ) : (
        <>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveName}
            placeholder="Bookmark name..."
            className="bg-white/10 border border-white/20 text-white placeholder-white/40 px-2 py-0.5 rounded text-sm w-44 outline-none focus:border-blue-400"
          />
          <span className="text-white/30 text-[10px]">↵</span>
        </>
      )}
    </div>
  );
}
