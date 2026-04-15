import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface Tag {
  id: string;
  name: string;
}

interface TagFilterProps {
  allTags: Tag[];
  bookTagMap: Map<string, Set<string>>;
  selectedTagIds: string[];
  onChangeSelectedTagIds: (ids: string[]) => void;
}

export default function TagFilter({
  allTags,
  bookTagMap,
  selectedTagIds,
  onChangeSelectedTagIds,
}: TagFilterProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // Don't render if there are no tags
  if (allTags.length === 0) return null;

  // Count books per tag
  const tagBookCounts = new Map<string, number>();
  for (const [, tagIds] of bookTagMap) {
    for (const tagId of tagIds) {
      tagBookCounts.set(tagId, (tagBookCounts.get(tagId) ?? 0) + 1);
    }
  }

  // Filter tags by search
  const q = search.trim().toLowerCase();
  const visibleTags = q
    ? allTags.filter((tag) => tag.name.toLowerCase().includes(q))
    : allTags;

  const selectedSet = new Set(selectedTagIds);

  const toggleTag = (tagId: string) => {
    if (selectedSet.has(tagId)) {
      onChangeSelectedTagIds(selectedTagIds.filter((id) => id !== tagId));
    } else {
      onChangeSelectedTagIds([...selectedTagIds, tagId]);
    }
  };

  const clearAll = () => {
    onChangeSelectedTagIds([]);
  };

  const selectedNames = selectedTagIds
    .map((id) => allTags.find((tg) => tg.id === id)?.name)
    .filter(Boolean) as string[];

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`shrink-0 h-9 px-2 rounded-lg text-xs border transition-colors flex items-center gap-1 ${
          selectedTagIds.length > 0
            ? "bg-accent-light text-accent border-accent/30"
            : "bg-warm-subtle text-ink border-transparent focus:border-accent"
        } focus:outline-none`}
        aria-label={t("library.filterByTags")}
      >
        {selectedTagIds.length === 0 ? (
          <span>{t("library.tagsAll")}</span>
        ) : selectedNames.length <= 2 ? (
          selectedNames.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-accent/10 rounded text-[11px]"
            >
              {name}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const id = allTags.find((tg) => tg.name === name)?.id;
                  if (id) toggleTag(id);
                }}
                className="hover:text-accent-hover ml-0.5"
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="flex items-center gap-1">
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-accent/10 rounded text-[11px]">
              {selectedNames[0]}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const id = allTags.find((tg) => tg.name === selectedNames[0])?.id;
                  if (id) toggleTag(id);
                }}
                className="hover:text-accent-hover ml-0.5"
              >
                ×
              </button>
            </span>
            <span className="text-[10px] text-ink-muted">+{selectedNames.length - 1}</span>
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-surface border border-warm-border rounded-lg shadow-lg z-30 animate-fade-in">
          {/* Search input */}
          <div className="p-2 border-b border-warm-border">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("library.tagsFilterPlaceholder")}
              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          {/* Tag list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {visibleTags.length === 0 ? (
              <p className="px-3 py-2 text-xs text-ink-muted">{t("library.tagsFilterPlaceholder")}</p>
            ) : (
              visibleTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    selectedSet.has(tag.id)
                      ? "bg-accent-light text-accent"
                      : "text-ink hover:bg-warm-subtle"
                  }`}
                >
                  {/* Checkmark */}
                  <span className="w-3.5 shrink-0">
                    {selectedSet.has(tag.id) && (
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                        <path d="M4 10l4 4 8-8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 text-left truncate">{tag.name}</span>
                  <span className="text-[10px] text-ink-muted/60 tabular-nums">
                    {tagBookCounts.get(tag.id) ?? 0}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Clear all footer */}
          {selectedTagIds.length > 0 && (
            <div className="border-t border-warm-border p-1.5">
              <button
                type="button"
                onClick={clearAll}
                className="w-full text-center text-[11px] text-ink-muted hover:text-accent py-1 transition-colors"
              >
                {t("common.clear")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
