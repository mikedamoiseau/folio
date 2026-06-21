import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { friendlyError } from "../lib/errors";
import type { BookGridItem } from "../types";

interface BulkEditDialogProps {
  bookIds: string[];
  books: BookGridItem[];
  onClose: () => void;
  onSave: (updatedCount: number) => void;
}

interface FieldState {
  value: string;
  mixed: boolean;
  /** Explicit opt-in — the field is written only when the user checks it. */
  enabled: boolean;
}

function computeField(
  books: BookGridItem[],
  getter: (b: BookGridItem) => string | null | undefined,
): FieldState {
  const values = books.map((b) => getter(b) ?? "");
  const first = values[0];
  const allSame = values.every((v) => v === first);
  return { value: allSame ? first : "", mixed: !allSame, enabled: false };
}

export default function BulkEditDialog({
  bookIds,
  books,
  onClose,
  onSave,
}: BulkEditDialogProps) {
  const { t } = useTranslation();
  const selected = books.filter((b) => bookIds.includes(b.id));

  const [author, setAuthor] = useState<FieldState>(() =>
    computeField(selected, (b) => b.author),
  );
  const [series, setSeries] = useState<FieldState>(() =>
    computeField(selected, (b) => b.series),
  );
  const [year, setYear] = useState<FieldState>(() =>
    computeField(selected, (b) =>
      b.publish_year != null ? String(b.publish_year) : null,
    ),
  );
  const [language, setLanguage] = useState<FieldState>(() =>
    computeField(selected, (b) => b.language),
  );
  // publisher is not on BookGridItem, so always starts empty
  const [publisher, setPublisher] = useState<FieldState>({
    value: "",
    mixed: false,
    enabled: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const anyMixed = author.mixed || series.mixed || year.mixed || language.mixed;

  const handleSave = async () => {
    const fields: Record<string, unknown> = {};
    if (author.enabled) fields.author = author.value;
    if (series.enabled) fields.series = series.value;
    if (year.enabled) {
      const digits = year.value.replace(/\D/g, "");
      fields.publishYear = digits === "" ? 0 : Number(digits);
    }
    if (language.enabled) fields.language = language.value;
    if (publisher.enabled) fields.publisher = publisher.value;

    if (Object.keys(fields).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const count = await invoke<number>("bulk_update_metadata", { bookIds, fields });
      onSave(count);
    } catch (e) {
      setError(friendlyError(e, t));
    } finally {
      setSaving(false);
    }
  };

  const fieldRow = (
    label: string,
    state: FieldState,
    setState: (s: FieldState) => void,
    numeric?: boolean,
  ) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-ink-muted font-medium">
        <input
          type="checkbox"
          checked={state.enabled}
          aria-label={t("bulkEdit.enableField", { field: label })}
          onChange={(e) => setState({ ...state, enabled: e.target.checked })}
          className="accent-accent cursor-pointer"
        />
        <span>{label}</span>
        {state.mixed && (
          <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {t("bulkEdit.differs")}
          </span>
        )}
      </div>
      <input
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        aria-label={label}
        disabled={!state.enabled}
        value={state.mixed && !state.enabled ? "" : state.value}
        placeholder={state.mixed ? t("bulkEdit.multipleValues") : undefined}
        onChange={(e) =>
          setState({
            ...state,
            value: numeric ? e.target.value.replace(/\D/g, "") : e.target.value,
          })
        }
        className={`h-9 px-3 bg-warm-subtle rounded-lg text-sm text-ink border border-transparent focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${state.mixed && !state.enabled ? "italic text-ink-muted" : ""}`}
      />
      {state.enabled && state.mixed && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t("bulkEdit.overwriteWarning", { count: bookIds.length })}
        </p>
      )}
    </div>
  );

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[80]"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="font-serif text-base font-semibold text-ink">
            {t("bulkEdit.title", { count: bookIds.length })}
          </h3>
          <p className="text-xs text-ink-muted">{t("bulkEdit.optInHint")}</p>
          {anyMixed && (
            <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-900/40">
              {t("bulkEdit.mixedBanner", { count: bookIds.length })}
            </div>
          )}
          <div className="space-y-3">
            {fieldRow(t("bulkEdit.author"), author, setAuthor)}
            {fieldRow(t("bulkEdit.series"), series, setSeries)}
            {fieldRow(t("bulkEdit.year"), year, setYear, true)}
            {fieldRow(t("bulkEdit.language"), language, setLanguage)}
            {fieldRow(t("bulkEdit.publisher"), publisher, setPublisher)}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-3 justify-end pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors rounded-xl"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium disabled:opacity-50"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
