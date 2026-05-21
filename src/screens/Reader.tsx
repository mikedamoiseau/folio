import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ReaderPane from "../components/ReaderPane";
import BookPickerModal from "../components/BookPickerModal";

interface ReaderProps {
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

/**
 * Reader screen — layout shell that mounts the per-book reading view.
 *
 * Single-pane today by default; split view (ROADMAP #40) mounts two
 * panes side-by-side at a fixed 50/50 split. The user picks the
 * companion book through the BookPickerModal opened from the
 * companion pane's header. Active-pane focus is tracked here so
 * keyboard navigation routes to whichever pane the user last clicked.
 *
 * Persistence: split mode and the companion bookId both persist per
 * primary book in `localStorage` so reopening restores the layout +
 * pairing.
 */
export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();

  const splitStorageKey = bookId ? `folio-split-mode-${bookId}` : null;
  const companionStorageKey = bookId ? `folio-split-companion-${bookId}` : null;

  const [splitMode, setSplitMode] = useState(() => {
    if (!splitStorageKey) return false;
    return localStorage.getItem(splitStorageKey) === "1";
  });
  const [companionBookId, setCompanionBookId] = useState<string | null>(() => {
    if (!companionStorageKey) return null;
    return localStorage.getItem(companionStorageKey);
  });
  const [activePaneId, setActivePaneId] = useState<"primary" | "companion">("primary");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reload persisted state on bookId change (Reader stays mounted
  // across books, so the initializers above only run on first mount).
  useEffect(() => {
    if (!splitStorageKey || !companionStorageKey) {
      setSplitMode(false);
      setCompanionBookId(null);
      setActivePaneId("primary");
      return;
    }
    setSplitMode(localStorage.getItem(splitStorageKey) === "1");
    setCompanionBookId(localStorage.getItem(companionStorageKey));
    setActivePaneId("primary");
  }, [splitStorageKey, companionStorageKey]);

  const toggleSplit = useCallback(() => {
    if (!splitStorageKey) return;
    setSplitMode((prev) => {
      const next = !prev;
      if (next) localStorage.setItem(splitStorageKey, "1");
      else localStorage.removeItem(splitStorageKey);
      return next;
    });
    setActivePaneId("primary");
  }, [splitStorageKey]);

  const persistCompanion = useCallback(
    (id: string | null) => {
      if (!companionStorageKey) return;
      if (id) localStorage.setItem(companionStorageKey, id);
      else localStorage.removeItem(companionStorageKey);
    },
    [companionStorageKey],
  );

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const handleSelectCompanion = useCallback(
    (id: string) => {
      setCompanionBookId(id);
      persistCompanion(id);
      setPickerOpen(false);
    },
    [persistCompanion],
  );

  const swapPanes = useCallback(() => {
    if (!bookId || !companionBookId || companionBookId === bookId) return;
    // Treat the URL's `:bookId` as canonical primary, so a true swap
    // navigates to the companion book and seeds the new primary's
    // split state with the old primary as its companion. The
    // useEffect above re-pulls localStorage on bookId change, so the
    // newly-mounted Reader picks the seed up automatically.
    const oldPrimary = bookId;
    persistCompanion(null);
    localStorage.setItem(`folio-split-mode-${companionBookId}`, "1");
    localStorage.setItem(`folio-split-companion-${companionBookId}`, oldPrimary);
    navigate(`/reader/${companionBookId}`);
  }, [bookId, companionBookId, persistCompanion, navigate]);

  const closeCompanion = useCallback(() => {
    if (!splitStorageKey) return;
    setSplitMode(false);
    localStorage.removeItem(splitStorageKey);
    setActivePaneId("primary");
  }, [splitStorageKey]);

  if (!bookId) return null;

  const effectiveCompanionId = companionBookId ?? bookId;
  const sameBook = effectiveCompanionId === bookId;

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
            isActive={activePaneId === "primary"}
            canPersist
            onActivate={() => setActivePaneId("primary")}
            onToggleSplit={toggleSplit}
            onSwapPanes={!sameBook ? swapPanes : undefined}
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
            isActive={activePaneId === "companion"}
            // Both panes write their own book's progress, except when
            // they share a bookId (the picker hasn't been used yet) —
            // then only the primary writes to avoid racing on the
            // same DB row.
            canPersist={!sameBook}
            onActivate={() => setActivePaneId("companion")}
            onToggleSplit={toggleSplit}
            onChangeBook={openPicker}
            onCloseThisPane={closeCompanion}
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
