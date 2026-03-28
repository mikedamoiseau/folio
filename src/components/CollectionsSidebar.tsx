import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
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
  onClose: () => void;
  onSelect: (id: string | null) => void;
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

const FIELD_OPTIONS: { value: CollectionRule["field"]; label: string }[] = [
  { value: "author", label: "Author" },
  { value: "filename", label: "Title" },
  { value: "series", label: "Series" },
  { value: "language", label: "Language" },
  { value: "publisher", label: "Publisher" },
  { value: "description", label: "Description" },
  { value: "format", label: "Format" },
  { value: "tag", label: "Tag" },
  { value: "date_added", label: "Date Added" },
  { value: "reading_progress", label: "Reading Progress" },
];

const OPERATOR_OPTIONS: Record<CollectionRule["field"], { value: string; label: string }[]> = {
  author: [
    { value: "contains", label: "contains" },
  ],
  filename: [
    { value: "contains", label: "contains" },
  ],
  series: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
  ],
  language: [
    { value: "equals", label: "is" },
    { value: "contains", label: "contains" },
  ],
  publisher: [
    { value: "contains", label: "contains" },
  ],
  description: [
    { value: "contains", label: "contains" },
  ],
  format: [
    { value: "equals", label: "is" },
  ],
  tag: [
    { value: "equals", label: "is" },
    { value: "contains", label: "contains" },
  ],
  date_added: [
    { value: "last_n_days", label: "within last (days)" },
  ],
  reading_progress: [
    { value: "equals", label: "is" },
  ],
};

const READING_PROGRESS_VALUES = [
  { value: "unread", label: "Unread" },
  { value: "in_progress", label: "In Progress" },
  { value: "finished", label: "Finished" },
];

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const dragging = useSyncExternalStore(subscribe, isDragging);

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
        <span className="flex-1 text-xs text-ink-muted">Delete "{collection.name}"?</span>
        <button
          onClick={() => onDelete()}
          className="text-xs px-2 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
        >
          Delete
        </button>
        <button
          onClick={() => setConfirmDelete(false)}
          className="text-xs px-2 py-0.5 text-ink-muted hover:text-ink transition-colors"
        >
          Cancel
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
        <span className="text-[10px] text-ink-muted opacity-60 mr-1">auto</span>
      )}
      {/* Share button */}
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
        aria-label={`Share ${collection.name}`}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            const md = await invoke<string>("export_collection_markdown", { collectionId: collection.id });
            await navigator.clipboard.writeText(md);
          } catch { /* ignore */ }
        }}
        title="Copy as Markdown"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M13 3H7a2 2 0 00-2 2v10a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 1h4a2 2 0 012 2v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Edit button */}
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
        aria-label={`Edit ${collection.name}`}
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        title="Edit collection"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M13.586 3.586a2 2 0 112.828 2.828l-9.5 9.5-3.5 1 1-3.5 9.172-9.828z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Delete button */}
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-accent transition-all"
        aria-label={`Delete ${collection.name}`}
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
    </div>
  );
}

// ---- RuleRow ----

function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: Omit<CollectionRule, "id">;
  onChange: (updated: Omit<CollectionRule, "id">) => void;
  onRemove: () => void;
}) {
  const operators = OPERATOR_OPTIONS[rule.field];

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={rule.field}
        onChange={(e) => {
          const field = e.target.value as CollectionRule["field"];
          const defaultValue = field === "reading_progress" ? "unread" : "";
          onChange({ field, operator: OPERATOR_OPTIONS[field][0].value, value: defaultValue });
        }}
        className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink focus:outline-none focus:border-accent"
      >
        {FIELD_OPTIONS.map((f) => (
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
          {READING_PROGRESS_VALUES.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={rule.value}
          placeholder="value"
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="flex-1 min-w-0 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 p-0.5 text-ink-muted hover:text-accent transition-colors"
        aria-label="Remove rule"
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
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<"manual" | "automated">(initial?.type ?? "manual");
  const [selectedIcon, setSelectedIcon] = useState<string>(initial?.icon ?? "");
  const [selectedColor, setSelectedColor] = useState<string>(initial?.color ?? PRESET_COLORS[0]);
  const [rules, setRules] = useState<Omit<CollectionRule, "id">[]>(
    initial?.rules.map(({ field, operator, value }) => ({ field, operator, value })) ?? []
  );

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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-5 py-4 border-b border-warm-border flex items-center gap-3 shrink-0">
        <button
          onClick={onCancel}
          className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
          aria-label="Back"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="font-serif text-base font-semibold text-ink">{initial ? "Edit Collection" : "New Collection"}</h2>
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Name */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Collection name"
            autoFocus
            className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">Type</label>
          <div className="flex rounded-lg border border-warm-border overflow-hidden">
            {(["manual", "automated"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`flex-1 py-1.5 text-xs font-medium capitalize transition-colors ${
                  type === t
                    ? "bg-accent text-white"
                    : "bg-warm-subtle text-ink-muted hover:text-ink"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Icon picker */}
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1.5">Icon (optional)</label>
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
          <label className="block text-xs font-medium text-ink-muted mb-1.5">Color</label>
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
                aria-label={`Color ${color}`}
              />
            ))}
          </div>
        </div>

        {/* Rule builder (automated only) */}
        {type === "automated" && (
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">Rules</label>
            <div className="space-y-2">
              {rules.map((rule, index) => (
                <RuleRow
                  key={index}
                  rule={rule}
                  onChange={(updated) => updateRule(index, updated)}
                  onRemove={() => removeRule(index)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addRule}
              className="mt-2 w-full py-1.5 text-xs text-ink-muted border border-dashed border-warm-border rounded-lg hover:border-accent hover:text-accent transition-colors"
            >
              + Add rule
            </button>
            {matchCount !== null && (
              <p className="mt-2 text-xs text-ink-muted">
                {matchCount === 0
                  ? "No books match these rules"
                  : `${matchCount} book${matchCount === 1 ? "" : "s"} match${matchCount === 1 ? "es" : ""} these rules`}
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
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="flex-1 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving..." : "Save"}
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
  onClose,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  onDropBook,
}: CollectionsSidebarProps) {
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
              <h2 className="font-serif text-base font-semibold text-ink">Collections</h2>
              <button
                onClick={onClose}
                className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
                aria-label="Close collections"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* List */}
            <nav className="flex-1 overflow-y-auto py-1" aria-label="Collections">
              {/* All Books row */}
              <button
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                  activeCollectionId === null
                    ? "bg-accent-light text-accent font-medium"
                    : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                }`}
                onClick={() => onSelect(null)}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" className="shrink-0">
                  <path
                    d="M3 5h14M3 10h14M3 15h14"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
                <span>All Books</span>
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
                New Collection
              </button>
            </div>
          </>
        )}
    </aside>,
    document.body,
  );
}
