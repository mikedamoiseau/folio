import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
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
  dirty: boolean;
}

function computeField(
  books: BookGridItem[],
  getter: (b: BookGridItem) => string | null | undefined,
): FieldState {
  const values = books.map((b) => getter(b) ?? "");
  const first = values[0];
  const allSame = values.every((v) => v === first);
  return { value: allSame ? first : "", mixed: !allSame, dirty: false };
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
    dirty: false,
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

  const handleSave = async () => {
    const fields: Record<string, unknown> = {};
    if (author.dirty) fields.author = author.value;
    if (series.dirty) fields.series = series.value;
    if (year.dirty) {
      const digits = year.value.replace(/\D/g, "");
      fields.publishYear = digits === "" ? 0 : Number(digits);
    }
    if (language.dirty) fields.language = language.value;
    if (publisher.dirty) fields.publisher = publisher.value;

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
      setError(String(e));
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
      <label className="text-xs text-ink-muted font-medium">{label}</label>
      <input
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        value={state.dirty ? state.value : state.mixed ? "" : state.value}
        placeholder={
          state.mixed && !state.dirty
            ? t("bulkEdit.multipleValues")
            : undefined
        }
        onChange={(e) =>
          setState({
            value: numeric ? e.target.value.replace(/\D/g, "") : e.target.value,
            mixed: state.mixed,
            dirty: true,
          })
        }
        className={`h-9 px-3 bg-warm-subtle rounded-lg text-sm text-ink border border-transparent focus:border-accent focus:outline-none ${state.mixed && !state.dirty ? "italic text-ink-muted" : ""}`}
      />
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
