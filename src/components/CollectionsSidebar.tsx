import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { getDraggedBookId, endDrag, isDragging, subscribe } from "../lib/dragState";

// ---- Types ----

export interface CollectionRule {
  id: string;
  field: "author" | "filename" | "series" | "language" | "publisher" | "description" | "format" | "tag" | "date_added" | "reading_progress";
  operator: string;
  value: string;
}

export interface Collection {
  id: string;
  name: string;
  type: "manual" | "automated";
  icon?: string;
  color?: string;
  rules: CollectionRule[];
}

export interface CreateCollectionData {
  name: string;
  type: "manual" | "automated";
  icon?: string;
  color?: string;
  rules: Omit<CollectionRule, "id">[];
}

interface CollectionsSidebarProps {
  open: boolean;
  collections: Collection[];
  activeCollectionId: string | null;
  activeSeries: string | null;
  seriesList: Array<{ name: string; count: number }>;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onSelectSeries: (name: string | null) => void;
  onCreate: (data: CreateCollectionData) => void | Promise<void>;
  onEdit: (id: string, data: CreateCollectionData) => void | Promise<void>;
  onDelete: (id: string) => void;
  onDropBook: (bookId: string, collectionId: string) => void;
}

// ---- Constants ----

const PRESET_COLORS = [
  "#c2714e", // accent/terracotta
  "#6b8f71", // sage green
  "#7a6b9a", // muted purple
  "#4e7a8f", // steel blue
  "#8f7a4e", // warm gold
  "#8f4e4e", // dusty rose
  "#4e8f8a", // teal
  "#666666", // neutral gray
];

const PRESET_ICONS = ["📚", "⭐", "❤️", "🔖", "🎯", "💡", "🌟", "📖", "🏆", "✨"];

function getFieldOptions(t: (key: string) => string) {
  return [
    { value: "author" as const, label: t("collections.fieldAuthor") },
    { value: "filename" as const, label: t("collections.fieldTitle") },
    { value: "series" as const, label: t("collections.fieldSeries") },
    { value: "language" as const, label: t("collections.fieldLanguage") },
    { value: "publisher" as const, label: t("collections.fieldPublisher") },
    { value: "description" as const, label: t("collections.fieldDescription") },
    { value: "format" as const, label: t("collections.fieldFormat") },
    { value: "tag" as const, label: t("collections.fieldTag") },
    { value: "date_added" as const, label: t("collections.fieldDateAdded") },
    { value: "reading_progress" as const, label: t("collections.fieldReadingProgress") },
  ];
}

function getOperatorOptions(t: (key: string) => string): Record<CollectionRule["field"], { value: string; label: string }[]> {
  return {
    author: [
      { value: "contains", label: t("collections.operatorContains") },
    ],
    filename: [
      { value: "contains", label: t("collections.operatorContains") },
    ],
    series: [
      { value: "contains", label: t("collections.operatorContains") },
      { value: "equals", label: t("collections.operatorIs") },
    ],
    language: [
      { value: "equals", label: t("collections.operatorIs") },
      { value: "contains", label: t("collections.operatorContains") },
    ],
    publisher: [
      { value: "contains", label: t("collections.operatorContains") },
    ],
    description: [
      { value: "contains", label: t("collections.operatorContains") },
    ],
    format: [
      { value: "equals", label: t("collections.operatorIs") },
    ],
    tag: [
      { value: "equals", label: t("collections.operatorIs") },
      { value: "contains", label: t("collections.operatorContains") },
    ],
    date_added: [
      { value: "last_n_days", label: t("collections.operatorWithinDays") },
    ],
    reading_progress: [
      { value: "equals", label: t("collections.operatorIs") },
    ],
  };
}

function getReadingProgressValues(t: (key: string) => string) {
  return [
    { value: "unread", label: t("collections.unread") },
    { value: "in_progress", label: t("collections.inProgressValue") },
    { value: "finished", label: t("collections.finishedValue") },
  ];
}

// ---- CollectionRow ----

function CollectionRow({
  collection,
  isActive,
  onSelect,
  onEdit,
  onDelete,
  onDropBook,
  isManual,
}: {
  collection: Collection;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDropBook: (bookId: string, collectionId: string) => void;
  isManual: boolean;
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [shareMenu, setShareMenu] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const dragging = useSyncExternalStore(subscribe, isDragging);

  const copyToClipboard = async (text: string) => {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  };

  const handleMouseUp = () => {
    if (!isManual) return;
    const bookId = getDraggedBookId();
    if (bookId) {
      endDrag();
      onDropBook(bookId, collection.id);
    }
  };

  const showDropHighlight = isManual && dragging && isHovered;

  if (confirmDelete) {
    return (
      <div className="px-3 py-2 flex items-center gap-2 bg-accent-light border-l-2 border-accent">
        <span className="flex-1 text-xs text-ink-muted">{t("collections.deleteConfirm", { name: collection.name })}</span>
        <button
          onClick={() => onDelete()}
          className="text-xs px-2 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
        >
          {t("common.delete")}
        </button>
        <button
          onClick={() => setConfirmDelete(false)}
          className="text-xs px-2 py-0.5 text-ink-muted hover:text-ink transition-colors"
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group relative flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
        isActive
          ? "bg-accent-light text-accent"
          : showDropHighlight
          ? "bg-accent-light ring-1 ring-inset ring-accent text-accent"
          : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
      }`}
      onClick={onSelect}
      onMouseUp={handleMouseUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Color swatch */}
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: collection.color ?? "#8c7b6e" }}
      />
      {/* Icon */}
      {collection.icon && (
        <span className="text-sm leading-none">{collection.icon}</span>
      )}
      {/* Name */}
      <span className="flex-1 text-sm truncate font-medium" title={collection.name}>{collection.name}</span>
      {/* Automated badge */}
      {collection.type === "automated" && (
        <span className="text-[10px] text-ink-muted opacity-60 mr-1">{t("collections.auto")}</span>
      )}
      {/* Share button */}
      <div className="relative">
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
          aria-label={t("collections.shareLabel", { name: collection.name })}
          onClick={(e) => {
            e.stopPropagation();
            setShareMenu((v) => !v);
          }}
          title={t("collections.exportCollection")}
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
            <path d="M13 3H7a2 2 0 00-2 2v10a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9 1h4a2 2 0 012 2v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {shareMenu && (
          <>
            <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setShareMenu(false); }} />
            <div className="absolute right-0 top-6 z-40 bg-surface border border-warm-border rounded-lg shadow-lg py-1 w-40 animate-fade-in">
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-warm-subtle transition-colors"
                onClick={async (e) => {
                  e.stopPropagation();
                  setShareMenu(false);
                  try {
                    const md = await invoke<string>("export_collection_markdown", { collectionId: collection.id });
                    await copyToClipboard(md);
                    setCopyFeedback(t("collections.copiedMarkdown"));
                    setTimeout(() => setCopyFeedback(null), 1500);
                  } catch {
                    setCopyFeedback(t("collections.exportFailedMsg"));
                    setTimeout(() => setCopyFeedback(null), 1500);
                  }
                }}
              >
                {t("collections.copyAsMarkdown")}
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-warm-subtle transition-colors"
                onClick={async (e) => {
                  e.stopPropagation();
                  setShareMenu(false);
                  try {
                    const json = await invoke<string>("export_collection_json", { collectionId: collection.id });
                    await copyToClipboard(json);
                    setCopyFeedback(t("collections.copiedJson"));
                    setTimeout(() => setCopyFeedback(null), 1500);
                  } catch {
                    setCopyFeedback(t("collections.exportFailedMsg"));
                    setTimeout(() => setCopyFeedback(null), 1500);
                  }
                }}
              >
                {t("collections.copyAsJson")}
              </button>
            </div>
          </>
        )}
      </div>
      {/* Edit button */}
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
        aria-label={t("collections.editLabel", { name: collection.name })}
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        title={t("collections.editCollection")}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M13.586 3.586a2 2 0 112.828 2.828l-9.5 9.5-3.5 1 1-3.5 9.172-9.828z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Delete button */}
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
        aria-label={t("collections.deleteLabel", { name: collection.name })}
        onClick={(e) => {
          e.stopPropagation();
          setConfirmDelete(true);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path
            d="M7 4h6M4 7h12M6 7l1 10h6l1-10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    {copyFeedback && createPortal(
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-ink/90 text-white text-sm rounded-lg shadow-lg animate-fade-in">
        {copyFeedback}
      </div>,
      document.body,
    )}
    </div>
  );
}

// ---- RuleRow ----

function RuleRow({
  rule,
  onChange,
  onRemove,
  fieldOptions,
  operatorOptions,
  readingProgressValues,
}: {
  rule: Omit<CollectionRule, "id">;
  onChange: (updated: Omit<CollectionRule, "id">) => void;
  onRemove: () => void;
  fieldOptions: { value: CollectionRule["field"]; label: string }[];
  operatorOptions: Record<CollectionRule["field"], { value: string; label: string }[]>;
  readingProgressValues: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const operators = operatorOptions[rule.field];

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={rule.field}
        onChange={(e) => {
          const field = e.target.value as CollectionRule["field"];
          const defaultValue = field === "reading_progress" ? "unread" : "";
          onChange({ field, operator: operatorOptions[field][0].value, value: defaultValue });
        }}
        className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink focus:outline-none focus:border-accent"
      >
        {fieldOptions.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      <select
        value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value })}
        className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink focus:outline-none focus:border-accent"
      >
        {operators.map((op) => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      {rule.field === "reading_progress" ? (
        <select
          value={rule.value || "unread"}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink focus:outline-none focus:border-accent"
        >
          {readingProgressValues.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={rule.value}
          placeholder={t("collections.valuePlaceholder")}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 p-0.5 text-ink-muted hover:text-accent transition-colors"
        aria-label={t("collections.removeRule")}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// ---- CollectionForm (create & edit) ----

function CollectionForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Collection;
  onSave: (data: CreateCollectionData) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<"manual" | "automated">(initial?.type ?? "manual");
  const [selectedIcon, setSelectedIcon] = useState<string>(initial?.icon ?? "");
  const [selectedColor, setSelectedColor] = useState<string>(initial?.color ?? PRESET_COLORS[0]);
  const [rules, setRules] = useState<Omit<CollectionRule, "id">[]>(
    initial?.rules.map(({ field, operator, value }) => ({ field, operator, value })) ?? []
  );

  const fieldOptions = getFieldOptions(t);
  const operatorOptions = getOperatorOptions(t);
  const readingProgressValues = getReadingProgressValues(t);

  // Live match count preview for automated rules
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (type !== "automated" || rules.length === 0 || rules.some((r) => !r.value.trim())) {
      setMatchCount(null);
      return;
    }
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const count = await invoke<number>("preview_collection_rules", { rules });
        setMatchCount(count);
      } catch {
        setMatchCount(null);
      }
    }, 400);
    return () => clearTimeout(previewTimer.current);
  }, [type, rules]);

  const addRule = () => {
    setRules((prev) => [
      ...prev,
      { field: "author", operator: "contains", value: "" },
    ]);
  };

  const updateRule = (index: number, updated: Omit<CollectionRule, "id">) => {
    setRules((prev) => prev.map((r, i) => (i === index ? updated : r)));
  };

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        type,
        icon: selectedIcon || undefined,
        color: selectedColor,
        rules,
      });
    } finally {
      setSaving(false);
    }
  };

  const typeLabels: Record<string, string> = {
    manual: t("collections.manual"),
    automated: t("collections.automated"),
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-5 py-4 border-b border-warm-border flex items-center gap-3 shrink-0">
        <button
          onClick={onCancel}
          className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
          aria-label={t("common.back")}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="font-serif text-base font-semibold text-ink">{initial ? t("collections.editCollection") : t("collections.newCollection")}</h2>
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Name */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">{t("collections.name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("collections.namePlaceholder")}
            autoFocus
            className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">{t("collections.type")}</label>
          <div className="flex rounded-lg border border-warm-border overflow-hidden">
            {(["manual", "automated"] as const).map((tp) => (
              <button
                key={tp}
                type="button"
                onClick={() => setType(tp)}
                className={`flex-1 py-1.5 text-xs font-medium capitalize transition-colors ${
                  type === tp
                    ? "bg-accent text-white"
                    : "bg-warm-subtle text-ink-muted hover:text-ink"
                }`}
              >
                {typeLabels[tp]}
              </button>
            ))}
          </div>
        </div>

        {/* Icon picker */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">{t("collections.iconOptional")}</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                onClick={() => setSelectedIcon(selectedIcon === icon ? "" : icon)}
                className={`w-8 h-8 flex items-center justify-center text-base rounded-lg border transition-colors ${
                  selectedIcon === icon
                    ? "border-accent bg-accent-light"
                    : "border-warm-border bg-warm-subtle hover:border-accent/50"
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>

        {/* Color picker */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">{t("collections.color")}</label>
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setSelectedColor(color)}
                className={`w-6 h-6 rounded-full transition-transform ${
                  selectedColor === color ? "scale-125 ring-2 ring-offset-1 ring-accent" : "hover:scale-110"
                }`}
                style={{ backgroundColor: color }}
                aria-label={t("collections.colorLabel", { color })}
              />
            ))}
          </div>
        </div>

        {/* Rule builder (automated only) */}
        {type === "automated" && (
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">{t("collections.rules")}</label>
            <div className="space-y-2">
              {rules.map((rule, index) => (
                <RuleRow
                  key={index}
                  rule={rule}
                  onChange={(updated) => updateRule(index, updated)}
                  onRemove={() => removeRule(index)}
                  fieldOptions={fieldOptions}
                  operatorOptions={operatorOptions}
                  readingProgressValues={readingProgressValues}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addRule}
              className="mt-2 w-full py-1.5 text-xs text-ink-muted border border-dashed border-warm-border rounded-lg hover:border-accent hover:text-accent transition-colors"
            >
              {t("collections.addRule")}
            </button>
            {matchCount !== null && (
              <p className="mt-2 text-xs text-ink-muted">
                {matchCount === 0
                  ? t("collections.noMatchRules")
                  : matchCount === 1
                    ? t("collections.matchCount", { count: matchCount })
                    : t("collections.matchesCount", { count: matchCount })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-warm-border flex gap-2 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="flex-1 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

// ---- Main Component ----

export default function CollectionsSidebar({
  open,
  collections,
  activeCollectionId,
  activeSeries,
  seriesList,
  onClose,
  onSelect,
  onSelectSeries,
  onCreate,
  onEdit,
  onDelete,
  onDropBook,
}: CollectionsSidebarProps) {
  const { t } = useTranslation();
  const [formMode, setFormMode] = useState<{ mode: "create" } | { mode: "edit"; collection: Collection } | null>(null);

  if (!open) return null;

  const handleCreate = async (data: CreateCollectionData) => {
    await onCreate(data);
    setFormMode(null);
  };

  const handleEdit = async (data: CreateCollectionData) => {
    if (formMode?.mode !== "edit") return;
    await onEdit(formMode.collection.id, data);
    setFormMode(null);
  };

  return createPortal(
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-surface border-r border-warm-border z-20 flex flex-col shadow-[4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-left">
        {formMode?.mode === "create" ? (
          <CollectionForm
            onSave={handleCreate}
            onCancel={() => setFormMode(null)}
          />
        ) : formMode?.mode === "edit" ? (
          <CollectionForm
            initial={formMode.collection}
            onSave={handleEdit}
            onCancel={() => setFormMode(null)}
          />
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between shrink-0">
              <h2 className="font-serif text-base font-semibold text-ink">{t("collections.title")}</h2>
              <button
                onClick={onClose}
                className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
                aria-label={t("collections.closeLabel")}
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* List */}
            <nav className="flex-1 overflow-y-auto py-1" aria-label={t("collections.title")}>
              {/* All Books row */}
              <button
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                  activeCollectionId === null && activeSeries === null
                    ? "bg-accent-light text-accent font-medium"
                    : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                }`}
                onClick={() => { onSelect(null); onSelectSeries(null); }}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" className="shrink-0">
                  <path
                    d="M3 5h14M3 10h14M3 15h14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span>{t("collections.allBooks")}</span>
              </button>

              {/* Divider */}
              {collections.length > 0 && (
                <div className="mx-3 my-1 border-t border-warm-border" />
              )}

              {/* Collection rows */}
              {collections.map((collection) => (
                <CollectionRow
                  key={collection.id}
                  collection={collection}
                  isActive={activeCollectionId === collection.id}
                  isManual={collection.type === "manual"}
                  onSelect={() => onSelect(collection.id)}
                  onEdit={() => setFormMode({ mode: "edit", collection })}
                  onDelete={() => onDelete(collection.id)}
                  onDropBook={onDropBook}
                />
              ))}

              {/* Series section */}
              {seriesList.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-warm-border" />
                  <div className="px-3 pt-2 pb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                      {t("collections.series")}
                    </span>
                  </div>
                  {seriesList.map((s) => (
                    <button
                      key={s.name}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                        activeSeries === s.name
                          ? "bg-accent-light text-accent font-medium"
                          : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                      }`}
                      onClick={() => {
                        onSelect(null);
                        onSelectSeries(s.name);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="shrink-0">
                        <path d="M4 4h3v12H4zM9 4h3v12H9zM14 6h3v8h-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                      </svg>
                      <span className="flex-1 text-left truncate">{s.name}</span>
                      <span className="text-[10px] text-ink-muted/60 tabular-nums">{s.count}</span>
                    </button>
                  ))}
                </>
              )}
            </nav>

            {/* Footer */}
            <div className="px-3 py-3 border-t border-warm-border shrink-0">
              <button
                onClick={() => setFormMode({ mode: "create" })}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {t("collections.newCollection")}
              </button>
            </div>
          </>
        )}
    </aside>,
    document.body,
  );
}
