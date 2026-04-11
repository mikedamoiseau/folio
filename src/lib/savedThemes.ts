import { TOKEN_NAMES, type ColorTokens } from "./themes";
import type { TypographySettings } from "../context/ThemeContext";

export interface SavedTheme {
  id: string;
  name: string;
  colors: ColorTokens;
  fontFamily: string;
  fontSize: number;
  typography: TypographySettings;
  createdAt: number;
}

const STORAGE_KEY = "folio-saved-themes";

function isValidTheme(obj: unknown): obj is SavedTheme {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.colors === "object" && t.colors !== null &&
    TOKEN_NAMES.every((name) => typeof (t.colors as Record<string, unknown>)[name] === "string") &&
    typeof t.fontFamily === "string" &&
    typeof t.fontSize === "number" && Number.isFinite(t.fontSize) &&
    typeof t.typography === "object" && t.typography !== null &&
    typeof (t.typography as Record<string, unknown>).lineHeight === "number" && Number.isFinite((t.typography as Record<string, unknown>).lineHeight) &&
    typeof (t.typography as Record<string, unknown>).pageMargins === "number" && Number.isFinite((t.typography as Record<string, unknown>).pageMargins) &&
    ((t.typography as Record<string, unknown>).textAlign === "left" || (t.typography as Record<string, unknown>).textAlign === "justify") &&
    typeof (t.typography as Record<string, unknown>).paragraphSpacing === "number" && Number.isFinite((t.typography as Record<string, unknown>).paragraphSpacing) &&
    typeof (t.typography as Record<string, unknown>).hyphenation === "boolean" &&
    typeof t.createdAt === "number" && Number.isFinite(t.createdAt) && t.createdAt > 0
  );
}

export function loadSavedThemes(): SavedTheme[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTheme);
  } catch {
    return [];
  }
}

export function saveSavedThemes(themes: SavedTheme[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
}

export function addTheme(themes: SavedTheme[], theme: SavedTheme): SavedTheme[] {
  const idIdx = themes.findIndex((t) => t.id === theme.id);
  if (idIdx !== -1) {
    return themes.map((t, i) => (i === idIdx ? theme : t));
  }
  if (themes.some((t) => t.name === theme.name)) return themes;
  return [...themes, theme];
}

export function deleteTheme(themes: SavedTheme[], id: string): SavedTheme[] {
  return themes.filter((t) => t.id !== id);
}

export function renameTheme(themes: SavedTheme[], id: string, newName: string): SavedTheme[] {
  if (themes.some((t) => t.name === newName && t.id !== id)) return themes;
  return themes.map((t) => (t.id === id ? { ...t, name: newName } : t));
}
