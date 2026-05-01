import presetsJson from "../data/opds-presets.json";
import type { Preset, LanguageCode, Category } from "../types/opdsPreset";

interface OpdsCatalogLike {
  url: string;
  presetId?: string | null;
}

export function loadPresets(): Preset[] {
  return presetsJson as Preset[];
}

export function filterPresets(
  presets: Preset[],
  query: string,
  languages: Set<LanguageCode>,
  categories: Set<Category>,
): Preset[] {
  const q = query.trim().toLowerCase();
  return presets.filter((p) => {
    if (q.length > 0) {
      const hay = `${p.name}\n${p.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (languages.size > 0) {
      const hit = p.languages.some((l) => languages.has(l));
      if (!hit) return false;
    }
    if (categories.size > 0) {
      const hit = p.categories.some((c) => categories.has(c));
      if (!hit) return false;
    }
    return true;
  });
}

export function isPresetAdded(
  preset: Preset,
  catalogs: OpdsCatalogLike[],
): boolean {
  return catalogs.some((c) => c.presetId === preset.id);
}

export function availableLanguages(presets: Preset[]): LanguageCode[] {
  const set = new Set<LanguageCode>();
  for (const p of presets) for (const l of p.languages) set.add(l);
  return Array.from(set).sort();
}

export function availableCategories(presets: Preset[]): Category[] {
  const set = new Set<Category>();
  for (const p of presets) for (const c of p.categories) set.add(c);
  return Array.from(set).sort();
}
