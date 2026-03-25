import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface LibraryFolderInfo {
  path: string;
  file_count: number;
  total_size_bytes: number;
}

interface MigrationDialogState {
  currentFolder: string;
  newFolder: string;
  fileCount: number;
  totalSizeBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { mode, setMode, fontSize, setFontSize, fontFamily, setFontFamily } =
    useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Library folder state
  const [libraryFolder, setLibraryFolder] = useState<string | null>(null);
  const [migrationDialog, setMigrationDialog] = useState<MigrationDialogState | null>(null);
  const [dontMoveFiles, setDontMoveFiles] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const loadLibraryFolder = useCallback(async () => {
    try {
      const folder = await invoke<string>("get_library_folder");
      setLibraryFolder(folder);
    } catch (e) {
      console.error('Failed to load library folder:', e);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadLibraryFolder();
    }
  }, [open, loadLibraryFolder]);

  useEffect(() => {
    if (!open) return;

    previousFocus.current = document.activeElement as HTMLElement;
    requestAnimationFrame(() => panelRef.current?.focus());

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (migrationDialog) {
          setMigrationDialog(null);
          setMigrationError(null);
          return;
        }
        onClose();
        return;
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
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
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus();
    };
  }, [open, onClose, migrationDialog]);

  const handleChangeFolder = async () => {
    try {
      const picked = await openFolderPicker({ directory: true });
      if (!picked) return;

      const newFolder = typeof picked === "string" ? picked : picked[0];
      if (!newFolder) return;

      const info = await invoke<LibraryFolderInfo>("get_library_folder_info");
      setDontMoveFiles(false);
      setMigrationError(null);
      setMigrationDialog({
        currentFolder: info.path,
        newFolder,
        fileCount: info.file_count,
        totalSizeBytes: info.total_size_bytes,
      });
    } catch (err) {
      // Folder picker cancelled or command unavailable
    }
  };

  const handleConfirmMigration = async () => {
    if (!migrationDialog) return;
    setMigrating(true);
    setMigrationError(null);
    try {
      await invoke("set_library_folder", {
        newFolder: migrationDialog.newFolder,
        moveFiles: !dontMoveFiles,
      });
      setLibraryFolder(migrationDialog.newFolder);
      setMigrationDialog(null);
    } catch (err) {
      setMigrationError(String(err));
    } finally {
      setMigrating(false);
    }
  };

  const handleCancelMigration = () => {
    if (migrating) return;
    setMigrationDialog(null);
    setMigrationError(null);
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-ink/20 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Reading settings"
        aria-modal="true"
        tabIndex={-1}
        className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-50 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] outline-none animate-slide-in-right"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold text-ink">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
            aria-label="Close settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Settings content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-7">
          {/* Theme */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
              Appearance
            </h3>
            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {(["light", "dark", "system"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setMode(option)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg capitalize transition-all duration-150 ${
                    mode === option
                      ? "bg-surface text-ink shadow-sm font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </section>

          {/* Font size */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
              Font Size
            </h3>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setFontSize(fontSize - 1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium"
                aria-label="Decrease font size"
              >
                −
              </button>
              <div className="flex-1 flex flex-col items-center gap-1">
                <input
                  type="range"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full accent-accent"
                  aria-label="Font size"
                />
                <span className="text-xs text-ink-muted tabular-nums">
                  {fontSize}px
                </span>
              </div>
              <button
                onClick={() => setFontSize(fontSize + 1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium"
                aria-label="Increase font size"
              >
                +
              </button>
            </div>
          </section>

          {/* Font family */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
              Reading Font
            </h3>
            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {(["serif", "sans-serif"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setFontFamily(option)}
                  className={`flex-1 px-3 py-2.5 text-sm rounded-lg transition-all duration-150 ${
                    fontFamily === option
                      ? "bg-surface text-ink shadow-sm font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                  style={{
                    fontFamily:
                      option === "serif"
                        ? '"Lora", Georgia, serif'
                        : '"DM Sans", system-ui, sans-serif',
                  }}
                >
                  {option === "serif" ? "Lora" : "DM Sans"}
                </button>
              ))}
            </div>
            <p
              className="mt-3 text-sm text-ink-muted leading-relaxed"
              style={{
                fontFamily:
                  fontFamily === "serif"
                    ? '"Lora", Georgia, serif'
                    : '"DM Sans", system-ui, sans-serif',
              }}
            >
              The quick brown fox jumps over the lazy dog.
            </p>
          </section>

          {/* Library */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
              Library
            </h3>
            <div className="space-y-2">
              <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                <p className="text-xs text-ink-muted mb-0.5">Storage folder</p>
                <p className="text-sm text-ink break-all leading-snug font-mono">
                  {libraryFolder ?? "—"}
                </p>
              </div>
              <button
                onClick={handleChangeFolder}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                Change folder…
              </button>
            </div>
          </section>
        </div>
      </div>

      {/* Migration confirmation dialog */}
      {migrationDialog && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 z-[60]"
            onClick={handleCancelMigration}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Change library folder"
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                Change Library Folder
              </h3>

              {/* Paths */}
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">Current folder</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.currentFolder}
                  </p>
                </div>
                <div className="flex justify-center text-ink-muted text-xs">↓</div>
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">New folder</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.newFolder}
                  </p>
                </div>
              </div>

              {/* File count / size */}
              <p className="text-sm text-ink-muted">
                {migrationDialog.fileCount} {migrationDialog.fileCount === 1 ? "file" : "files"},{" "}
                {formatBytes(migrationDialog.totalSizeBytes)}
              </p>

              {/* Don't move checkbox */}
              <label className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={dontMoveFiles}
                  onChange={(e) => setDontMoveFiles(e.target.checked)}
                  disabled={migrating}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-ink leading-snug">
                  Don't move existing files — only use new folder for future imports
                </span>
              </label>

              {/* Error */}
              {migrationError && (
                <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                  {migrationError}
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleCancelMigration}
                  disabled={migrating}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-xl transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmMigration}
                  disabled={migrating}
                  className="px-4 py-2 text-sm font-medium bg-accent text-surface rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
                >
                  {migrating && (
                    <svg
                      className="animate-spin w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12" cy="12" r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                  )}
                  {dontMoveFiles ? "Change Folder" : "Move & Update"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
