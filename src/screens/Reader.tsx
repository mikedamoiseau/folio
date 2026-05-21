import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReaderPane from "../components/ReaderPane";

interface ReaderProps {
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

/**
 * Reader screen — layout shell that mounts the per-book reading view.
 *
 * Mounts one ReaderPane today; when split view is on (ROADMAP #40),
 * two panes render side-by-side at a fixed 50/50 split. The companion
 * pane currently shows the same book as the primary — m3 will add a
 * book picker so the user can pair two different books.
 *
 * Split state persists per book in `localStorage` so reopening the
 * same book restores the layout.
 */
export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();

  const splitStorageKey = bookId ? `folio-split-mode-${bookId}` : null;
  const [splitMode, setSplitMode] = useState(() => {
    if (!splitStorageKey) return false;
    return localStorage.getItem(splitStorageKey) === "1";
  });

  // Reset / reload the persisted preference whenever the route's
  // bookId changes (the Reader stays mounted across books, so the
  // initializer above only runs on first mount).
  useEffect(() => {
    if (!splitStorageKey) {
      setSplitMode(false);
      return;
    }
    setSplitMode(localStorage.getItem(splitStorageKey) === "1");
  }, [splitStorageKey]);

  const toggleSplit = useCallback(() => {
    if (!splitStorageKey) return;
    setSplitMode((prev) => {
      const next = !prev;
      if (next) localStorage.setItem(splitStorageKey, "1");
      else localStorage.removeItem(splitStorageKey);
      return next;
    });
  }, [splitStorageKey]);

  if (!bookId) return null;

  if (!splitMode) {
    return (
      <ReaderPane
        bookId={bookId}
        onOpenSettings={onOpenSettings}
        settingsOpen={settingsOpen}
        splitMode={false}
        isPrimary
        onToggleSplit={toggleSplit}
      />
    );
  }

  return (
    <div className="flex flex-row w-full h-full min-h-0">
      <div className="flex-1 min-w-0 border-r border-warm-border">
        <ReaderPane
          bookId={bookId}
          onOpenSettings={onOpenSettings}
          settingsOpen={settingsOpen}
          splitMode
          isPrimary
          onToggleSplit={toggleSplit}
        />
      </div>
      <div className="flex-1 min-w-0">
        <ReaderPane
          bookId={bookId}
          onOpenSettings={onOpenSettings}
          settingsOpen={settingsOpen}
          splitMode
          isPrimary={false}
          onToggleSplit={toggleSplit}
        />
      </div>
    </div>
  );
}
