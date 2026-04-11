import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SavedTheme } from "../lib/savedThemes";

interface SavedThemesListProps {
  themes: SavedTheme[];
  onLoad: (theme: SavedTheme) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
}

export default function SavedThemesList({
  themes,
  onLoad,
  onSave,
  onDelete,
  onRename,
}: SavedThemesListProps) {
  const { t } = useTranslation();

  // Save form state
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<SavedTheme | null>(null);

  // Per-theme inline state: which theme id is pending delete / renaming
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const saveInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Focus save input when form opens
  useEffect(() => {
    if (showSaveForm) {
      saveInputRef.current?.focus();
    }
  }, [showSaveForm]);

  // Focus rename input when rename starts
  useEffect(() => {
    if (renamingId !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // ── Save form handlers ──────────────────────────────────────

  function openSaveForm() {
    setSaveName("");
    setSaveError(null);
    setOverwriteTarget(null);
    setShowSaveForm(true);
  }

  function closeSaveForm() {
    setShowSaveForm(false);
    setSaveName("");
    setSaveError(null);
    setOverwriteTarget(null);
  }

  function commitSave(nameOverride?: string) {
    const trimmed = (nameOverride ?? saveName).trim();
    if (!trimmed) {
      setSaveError(t("settings.themeNameRequired"));
      return;
    }

    const conflict = themes.find((th) => th.name === trimmed);
    if (conflict && overwriteTarget?.id !== conflict.id) {
      // Show overwrite confirmation
      setOverwriteTarget(conflict);
      setSaveError(null);
      return;
    }

    onSave(trimmed);
    closeSaveForm();
  }

  function handleSaveKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitSave();
    } else if (e.key === "Escape") {
      closeSaveForm();
    }
  }

  // ── Rename handlers ─────────────────────────────────────────

  function startRename(theme: SavedTheme) {
    setDeletingId(null);
    setRenamingId(theme.id);
    setRenameValue(theme.name);
  }

  function commitRename(id: string) {
    const trimmed = renameValue.trim();
    if (trimmed) {
      onRename(id, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue("");
  }

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>, id: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(id);
    } else if (e.key === "Escape") {
      cancelRename();
    }
  }

  // ── Delete handlers ─────────────────────────────────────────

  function handleDeleteConfirm(id: string) {
    onDelete(id);
    setDeletingId(null);
  }

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="space-y-1">
      {/* Empty state */}
      {themes.length === 0 && (
        <p className="text-[11px] text-ink-muted/60 px-1 py-1">
          {t("settings.noSavedThemes")}
        </p>
      )}

      {/* Theme list */}
      {themes.map((theme) => {
        const isDeleting = deletingId === theme.id;
        const isRenaming = renamingId === theme.id;

        return (
          <div
            key={theme.id}
            role="button"
            tabIndex={0}
            className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 transition-colors cursor-pointer"
            onClick={() => {
              if (!isDeleting && !isRenaming) {
                onLoad(theme);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !isDeleting && !isRenaming) {
                e.preventDefault();
                onLoad(theme);
              }
            }}
          >
            {/* Color swatches */}
            <div className="flex gap-0.5 shrink-0">
              <span
                className="w-3 h-3 rounded-sm border border-black/10"
                style={{ backgroundColor: theme.colors["paper"] }}
                aria-hidden="true"
              />
              <span
                className="w-3 h-3 rounded-sm border border-black/10"
                style={{ backgroundColor: theme.colors["ink"] }}
                aria-hidden="true"
              />
              <span
                className="w-3 h-3 rounded-sm border border-black/10"
                style={{ backgroundColor: theme.colors["accent"] }}
                aria-hidden="true"
              />
            </div>

            {/* Name — normal or inline rename input */}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => handleRenameKeyDown(e, theme.id)}
                onBlur={() => commitRename(theme.id)}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 text-sm bg-transparent border-b border-accent outline-none text-ink min-w-0"
              />
            ) : (
              <span className="flex-1 text-sm text-ink truncate min-w-0">
                {theme.name}
              </span>
            )}

            {/* Actions — delete pending or hover icons */}
            {isDeleting ? (
              <span
                className="flex items-center gap-1 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-[10px] text-ink-muted mr-0.5">
                  {t("settings.deleteThemeConfirm", { name: theme.name })}
                </span>
                <button
                  type="button"
                  onClick={() => handleDeleteConfirm(theme.id)}
                  className="text-[10px] px-1.5 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
                >
                  {t("common.delete")}
                </button>
                <button
                  type="button"
                  onClick={() => setDeletingId(null)}
                  className="text-[10px] px-1.5 py-0.5 text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
              </span>
            ) : (
              <span
                className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Rename button */}
                <button
                  type="button"
                  onClick={() => startRename(theme)}
                  className="p-0.5 text-ink-muted hover:text-ink transition-colors"
                  aria-label={t("common.edit") + " " + theme.name}
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => { setDeletingId(theme.id); setRenamingId(null); }}
                  className="p-0.5 text-ink-muted hover:text-red-500 transition-colors"
                  aria-label={t("common.remove") + " " + theme.name}
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M15 5L5 15M5 5l10 10"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            )}
          </div>
        );
      })}

      {/* Save form */}
      {showSaveForm ? (
        <div className="mt-2 space-y-1.5">
          {/* Overwrite confirmation */}
          {overwriteTarget ? (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-warm-subtle">
              <span className="flex-1 text-[11px] text-ink-muted">
                {t("settings.themeOverwrite", { name: overwriteTarget.name })}
              </span>
              <button
                type="button"
                onClick={() => {
                  onSave(overwriteTarget.name);
                  closeSaveForm();
                }}
                className="text-[10px] px-1.5 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors shrink-0"
              >
                {t("settings.overwrite")}
              </button>
              <button
                type="button"
                onClick={() => setOverwriteTarget(null)}
                className="text-[10px] px-1.5 py-0.5 text-ink-muted hover:text-ink transition-colors shrink-0"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  ref={saveInputRef}
                  type="text"
                  value={saveName}
                  onChange={(e) => { setSaveName(e.target.value); setSaveError(null); }}
                  onKeyDown={handleSaveKeyDown}
                  placeholder={t("settings.themeName")}
                  className="flex-1 text-sm px-2 py-1 rounded-lg bg-warm-subtle border border-warm-border outline-none focus:border-accent text-ink placeholder:text-ink-muted/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => commitSave()}
                  className="text-[11px] px-2 py-1 bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors shrink-0"
                >
                  {t("settings.save")}
                </button>
                <button
                  type="button"
                  onClick={closeSaveForm}
                  className="text-[11px] px-2 py-1 text-ink-muted hover:text-ink transition-colors shrink-0"
                >
                  {t("common.cancel")}
                </button>
              </div>
              {saveError && (
                <p className="text-[10px] text-red-500 px-1">{saveError}</p>
              )}
            </>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={openSaveForm}
          className="mt-1 w-full text-left px-2 py-1.5 text-sm text-ink-muted hover:text-ink border border-dashed border-warm-border hover:border-accent rounded-lg transition-colors"
        >
          {t("settings.saveAsTheme")}
        </button>
      )}
    </div>
  );
}
