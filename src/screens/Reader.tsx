import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReaderPane from "../components/ReaderPane";
import BookPickerModal from "../components/BookPickerModal";

interface ReaderProps {
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

/**
 * Reader screen — layout shell that mounts the per-book reading view.
 *
 * Mounts one ReaderPane today; when split view is on (ROADMAP #40),
 * two panes render side-by-side at a fixed 50/50 split. The companion
 * pane starts on the same book as the primary; the user clicks the
 * "Choose another book" header button on that pane to swap it for
 * a different library entry. Split state persists per book in
 * `localStorage` so reopening the same book restores the layout.
 */
export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();

  const splitStorageKey = bookId ? `folio-split-mode-${bookId}` : null;
  const [splitMode, setSplitMode] = useState(() => {
    if (!splitStorageKey) return false;
    return localStorage.getItem(splitStorageKey) === "1";
  });
  const [companionBookId, setCompanionBookId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reset / reload the persisted preference whenever the route's
  // bookId changes (the Reader stays mounted across books, so the
  // initializer above only runs on first mount).
  useEffect(() => {
    if (!splitStorageKey) {
      setSplitMode(false);
      setCompanionBookId(null);
      return;
    }
    setSplitMode(localStorage.getItem(splitStorageKey) === "1");
    // Companion bookId starts as null on every book change; the user
    // re-picks it for each primary book. m4 will persist this so the
    // pairing survives reopen.
    setCompanionBookId(null);
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

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const handleSelectCompanion = useCallback((id: string) => {
    setCompanionBookId(id);
    setPickerOpen(false);
  }, []);

  if (!bookId) return null;

  // Effective companion id: the user's selection if they made one,
  // otherwise mirror the primary book so the second pane has something
  // sensible to render until they pick.
  const effectiveCompanionId = companionBookId ?? bookId;

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
    <>
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
            // Key on the companion bookId so React fully remounts the
            // pane (and its per-book state machine) whenever the user
            // picks a different book — same hygiene as a route change.
            key={effectiveCompanionId}
            bookId={effectiveCompanionId}
            onOpenSettings={onOpenSettings}
            settingsOpen={settingsOpen}
            splitMode
            isPrimary={false}
            onToggleSplit={toggleSplit}
            onChangeBook={openPicker}
          />
        </div>
      </div>
      {pickerOpen && (
        <BookPickerModal
          excludeBookId={bookId}
          onSelect={handleSelectCompanion}
          onClose={closePicker}
        />
      )}
    </>
  );
}
