import { useMemo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  loadPresets,
  filterPresets,
  isPresetAdded,
  availableLanguages,
  availableCategories,
} from "../lib/opdsPresets";
import type { LanguageCode, Category, Preset } from "../types/opdsPreset";

interface OpdsCatalog {
  name: string;
  url: string;
  presetId?: string | null;
}

interface Props {
  currentCatalogs: OpdsCatalog[];
  onClose: () => void;
  onAdded: () => void;
}

export default function OpdsPresetPicker({
  currentCatalogs,
  onClose,
  onAdded,
}: Props) {
  const { t } = useTranslation();
  const presets = useMemo(() => loadPresets(), []);
  const langs = useMemo(() => availableLanguages(presets), [presets]);
  const cats = useMemo(() => availableCategories(presets), [presets]);

  const [query, setQuery] = useState("");
  const [selectedLangs, setSelectedLangs] = useState<Set<LanguageCode>>(new Set());
  const [selectedCats, setSelectedCats] = useState<Set<Category>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterPresets(presets, query, selectedLangs, selectedCats),
    [presets, query, selectedLangs, selectedCats],
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => a.name.localeCompare(b.name)),
    [filtered],
  );

  const toggleLang = useCallback((l: LanguageCode) => {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  }, []);

  const toggleCat = useCallback((c: Category) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setQuery("");
    setSelectedLangs(new Set());
    setSelectedCats(new Set());
  }, []);

  const handleAdd = useCallback(
    async (p: Preset) => {
      setAddingId(p.id);
      setErrorId(null);
      try {
        await invoke("add_opds_catalog", {
          name: p.name,
          url: p.url,
          presetId: p.id,
        });
        onAdded();
      } catch {
        setErrorId(p.id);
      } finally {
        setAddingId(null);
      }
    },
    [onAdded],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-warm-border flex items-center gap-2 shrink-0">
        <button
          onClick={onClose}
          className="p-1 text-ink-muted hover:text-ink rounded"
          aria-label={t("common.back")}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M12 5l-7 5 7 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h3 className="font-serif text-sm font-semibold text-ink">{t("catalog.presets.title")}</h3>
      </div>

      {/* Filters */}
      <div className="px-5 py-3 border-b border-warm-border space-y-2 shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("catalog.presets.searchPlaceholder")}
          className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
        />
        {langs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-ink-muted self-center mr-1">
              {t("catalog.presets.languageFilter")}:
            </span>
            {langs.map((l) => {
              const active = selectedLangs.has(l);
              return (
                <button
                  key={l}
                  type="button"
                  aria-label={t(`catalog.presets.lang.${l}`)}
                  onClick={() => toggleLang(l)}
                  className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "bg-warm-subtle text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`catalog.presets.lang.${l}`)}
                </button>
              );
            })}
          </div>
        )}
        {cats.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-ink-muted self-center mr-1">
              {t("catalog.presets.categoryFilter")}:
            </span>
            {cats.map((c) => {
              const active = selectedCats.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={t(`catalog.presets.category.${c}`)}
                  onClick={() => toggleCat(c)}
                  className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "bg-warm-subtle text-ink-muted hover:text-ink"
                  }`}
                >
                  {t(`catalog.presets.category.${c}`)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-sm text-ink-muted">{t("catalog.presets.empty")}</p>
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-accent hover:underline"
            >
              {t("catalog.presets.clearFilters")}
            </button>
          </div>
        ) : (
          sorted.map((p) => {
            const added = isPresetAdded(p, currentCatalogs);
            const adding = addingId === p.id;
            const failed = errorId === p.id;
            return (
              <div
                key={p.id}
                data-preset-id={p.id}
                className="flex items-start gap-3 px-5 py-3 border-b border-warm-border/50"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink leading-snug">{p.name}</p>
                      <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{p.description}</p>
                    </div>
                    {added ? (
                      <span className="text-[11px] text-ink-muted shrink-0 px-2 py-0.5">
                        ✓ {t("catalog.presets.added")}
                      </span>
                    ) : adding ? (
                      <span className="text-[11px] text-ink-muted shrink-0 px-2 py-0.5">…</span>
                    ) : (
                      <button
                        type="button"
                        data-action="add"
                        onClick={() => handleAdd(p)}
                        className="text-[11px] font-medium text-accent bg-accent-light hover:bg-accent hover:text-white px-2 py-0.5 rounded transition-colors shrink-0"
                      >
                        {t("catalog.presets.add")}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {p.languages.map((l) => (
                      <span
                        key={l}
                        className="text-[10px] px-1.5 py-0 rounded-full bg-warm-subtle text-ink-muted"
                      >
                        {t(`catalog.presets.lang.${l}`)}
                      </span>
                    ))}
                    {p.categories.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] px-1.5 py-0 rounded-full bg-accent-light/60 text-accent"
                      >
                        {t(`catalog.presets.category.${c}`)}
                      </span>
                    ))}
                  </div>
                  {failed && (
                    <p className="text-[11px] text-red-500 mt-1">
                      {t("catalog.presets.addError")}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
