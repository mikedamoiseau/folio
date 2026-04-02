import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface ImportButtonProps {
  onImportFiles: () => void;
  onImportFolder: () => void;
  onImportUrl: (url: string) => void;
  loading?: boolean;
  progress?: { current: number; total: number } | null;
}

export default function ImportButton({
  onImportFiles,
  onImportFolder,
  onImportUrl,
  loading,
  progress,
}: ImportButtonProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const label =
    loading && progress && progress.total > 1
      ? t("import.importingProgress", { current: progress.current, total: progress.total })
      : loading
      ? t("import.importing")
      : t("import.addBooks");

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Focus URL input when dialog opens
  useEffect(() => {
    if (urlDialogOpen) urlInputRef.current?.focus();
  }, [urlDialogOpen]);

  const handleUrlSubmit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUrlDialogOpen(false);
    setUrl("");
    onImportUrl(trimmed);
  };

  return (
    <>
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => (loading ? undefined : setMenuOpen((v) => !v))}
          disabled={loading}
          className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 shadow-sm"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="opacity-25"
                />
                <path
                  d="M4 12a8 8 0 018-8"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="opacity-75"
                />
              </svg>
              {label}
            </span>
          ) : (
            label
          )}
        </button>

        {/* Dropdown menu */}
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-warm-border rounded-xl shadow-lg py-1 z-30 animate-fade-in">
            <button
              type="button"
              className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-warm-subtle flex items-center gap-2.5 transition-colors"
              onClick={() => {
                setMenuOpen(false);
                onImportFiles();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0 text-ink-muted">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M14 2v6h6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              {t("import.addFiles")}
            </button>
            <button
              type="button"
              className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-warm-subtle flex items-center gap-2.5 transition-colors"
              onClick={() => {
                setMenuOpen(false);
                onImportFolder();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0 text-ink-muted">
                <path d="M2 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              {t("import.importFolder")}
            </button>
            <button
              type="button"
              className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-warm-subtle flex items-center gap-2.5 transition-colors"
              onClick={() => {
                setMenuOpen(false);
                setUrlDialogOpen(true);
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0 text-ink-muted">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("import.importFromUrl")}
            </button>
          </div>
        )}
      </div>

      {/* URL import dialog */}
      {urlDialogOpen && (
        <>
          <div
            className="fixed inset-0 bg-ink/20 backdrop-blur-sm z-40 animate-fade-in"
            onClick={() => setUrlDialogOpen(false)}
          />
          <div className="fixed top-1/3 left-1/2 -translate-x-1/2 w-[420px] max-w-[90vw] bg-surface border border-warm-border rounded-2xl shadow-xl z-50 p-6 animate-fade-in">
            <h3 className="font-serif text-base font-semibold text-ink mb-4">
              {t("import.importFromUrl")}
            </h3>
            <input
              ref={urlInputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleUrlSubmit();
                if (e.key === "Escape") setUrlDialogOpen(false);
              }}
              placeholder={t("import.urlPlaceholder")}
              className="w-full h-10 px-3 bg-warm-subtle rounded-lg text-sm text-ink placeholder-ink-muted border border-transparent focus:border-accent/40 focus:outline-none focus:bg-surface transition-colors"
            />
            <p className="mt-2 text-xs text-ink-muted">
              {t("import.urlHint")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setUrlDialogOpen(false)}
                className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-lg transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleUrlSubmit}
                disabled={!url.trim()}
                className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {t("common.import")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
