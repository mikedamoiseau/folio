# User-Created Themes (#48) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save, name, load, rename, and delete custom visual themes (colors + typography + font) in Folio's settings panel.

**Architecture:** Pure frontend feature. A new `savedThemes.ts` module handles localStorage CRUD for theme snapshots. A new `SavedThemesList.tsx` component renders the theme picker and save/delete/rename UI. `ThemeContext` gains a `loadTheme()` helper. The Settings panel is restructured: the "Text & Typography" accordion merges under "Appearance" as a subsection.

**Tech Stack:** React 19, TypeScript, Vitest, Tailwind CSS v4, i18next

**Workflow per milestone:**
1. Create feature branch from `main`
2. TDD: write failing tests first, then implement to make them pass
3. Run full CI checks: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && pnpm run type-check && pnpm run test`
4. Commit on the feature branch
5. Run `~/bin/pr-review.sh --no-branch` for 3-agent review (fixes applied directly)
6. Self-review the diff and pr-review report one more time
7. Merge feature branch to `main`
8. Start next milestone

---

## Milestone 1: Saved Themes Data Layer (`src/lib/savedThemes.ts`)

**Branch:** `feat/48-saved-themes-data-layer`

**Files:**
- Create: `src/lib/savedThemes.ts`
- Create: `src/lib/savedThemes.test.ts`

### Task 1.1: Define SavedTheme type and localStorage key

- [ ] **Step 1: Create `src/lib/savedThemes.ts` with types and constants**

```typescript
import type { ColorTokens } from "./themes";
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
```

- [ ] **Step 2: Run type-check to verify imports resolve**

Run: `pnpm run type-check`
Expected: PASS (no errors related to savedThemes.ts)

### Task 1.2: Implement and test `loadSavedThemes`

- [ ] **Step 1: Write failing tests for `loadSavedThemes`**

Create `src/lib/savedThemes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { loadSavedThemes } from "./savedThemes";

describe("loadSavedThemes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty array when nothing stored", () => {
    expect(loadSavedThemes()).toEqual([]);
  });

  it("returns parsed themes from localStorage", () => {
    const themes = [
      {
        id: "abc",
        name: "Night",
        colors: {
          paper: "#1a1a1a", surface: "#222", ink: "#eee", "ink-muted": "#999",
          "warm-border": "#333", "warm-subtle": "#2a2a2a", accent: "#ff6600",
          "accent-hover": "#cc5500", "accent-light": "#2e1f17",
        },
        fontFamily: "serif",
        fontSize: 18,
        typography: {
          lineHeight: 1.8, pageMargins: 32, textAlign: "justify" as const,
          paragraphSpacing: 1.1, hyphenation: true,
        },
        createdAt: 1000,
      },
    ];
    localStorage.setItem("folio-saved-themes", JSON.stringify(themes));
    expect(loadSavedThemes()).toEqual(themes);
  });

  it("returns empty array for corrupted JSON", () => {
    localStorage.setItem("folio-saved-themes", "not json{");
    expect(loadSavedThemes()).toEqual([]);
  });

  it("filters out malformed entries missing required fields", () => {
    const data = [
      { id: "ok", name: "Valid", colors: { paper: "#fff", surface: "#fff", ink: "#000", "ink-muted": "#888", "warm-border": "#ddd", "warm-subtle": "#eee", accent: "#c00", "accent-hover": "#a00", "accent-light": "#fee" }, fontFamily: "serif", fontSize: 18, typography: { lineHeight: 1.8, pageMargins: 32, textAlign: "justify", paragraphSpacing: 1.1, hyphenation: true }, createdAt: 1 },
      { id: "bad" }, // missing fields
      { name: "no-id", colors: {} }, // missing id
    ];
    localStorage.setItem("folio-saved-themes", JSON.stringify(data));
    const result = loadSavedThemes();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: FAIL — `loadSavedThemes` is not exported

- [ ] **Step 3: Implement `loadSavedThemes`**

Add to `src/lib/savedThemes.ts`:

```typescript
function isValidTheme(obj: unknown): obj is SavedTheme {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.colors === "object" && t.colors !== null &&
    typeof t.fontFamily === "string" &&
    typeof t.fontSize === "number" &&
    typeof t.typography === "object" && t.typography !== null &&
    typeof t.createdAt === "number"
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: PASS

### Task 1.3: Implement and test `saveSavedThemes`

- [ ] **Step 1: Add tests for `saveSavedThemes`**

Append to `src/lib/savedThemes.test.ts`:

```typescript
import { loadSavedThemes, saveSavedThemes } from "./savedThemes";

describe("saveSavedThemes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists themes to localStorage", () => {
    const themes = [
      {
        id: "t1", name: "Test", colors: {
          paper: "#fff", surface: "#fff", ink: "#000", "ink-muted": "#888",
          "warm-border": "#ddd", "warm-subtle": "#eee", accent: "#c00",
          "accent-hover": "#a00", "accent-light": "#fee",
        },
        fontFamily: "serif", fontSize: 18,
        typography: { lineHeight: 1.8, pageMargins: 32, textAlign: "justify" as const, paragraphSpacing: 1.1, hyphenation: true },
        createdAt: 1,
      },
    ];
    saveSavedThemes(themes);
    expect(loadSavedThemes()).toEqual(themes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: FAIL — `saveSavedThemes` is not exported

- [ ] **Step 3: Implement `saveSavedThemes`**

Add to `src/lib/savedThemes.ts`:

```typescript
export function saveSavedThemes(themes: SavedTheme[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: PASS

### Task 1.4: Implement and test `addTheme`, `deleteTheme`, `renameTheme`

- [ ] **Step 1: Add tests for `addTheme`**

Append to `src/lib/savedThemes.test.ts`:

```typescript
import { loadSavedThemes, saveSavedThemes, addTheme, deleteTheme, renameTheme, type SavedTheme } from "./savedThemes";

// Helper to make a valid theme object
function makeTheme(overrides: Partial<SavedTheme> = {}): SavedTheme {
  return {
    id: "id-1", name: "Theme 1",
    colors: {
      paper: "#fff", surface: "#fff", ink: "#000", "ink-muted": "#888",
      "warm-border": "#ddd", "warm-subtle": "#eee", accent: "#c00",
      "accent-hover": "#a00", "accent-light": "#fee",
    },
    fontFamily: "serif", fontSize: 18,
    typography: { lineHeight: 1.8, pageMargins: 32, textAlign: "justify", paragraphSpacing: 1.1, hyphenation: true },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("addTheme", () => {
  beforeEach(() => { localStorage.clear(); });

  it("adds a new theme to an empty list", () => {
    const theme = makeTheme({ name: "New" });
    const result = addTheme([], theme);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("New");
  });

  it("overwrites existing theme with same name", () => {
    const existing = makeTheme({ id: "old", name: "Dupe", fontSize: 16 });
    const replacement = makeTheme({ id: "new", name: "Dupe", fontSize: 20 });
    const result = addTheme([existing], replacement);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
    expect(result[0].fontSize).toBe(20);
  });
});

describe("deleteTheme", () => {
  it("removes theme by id", () => {
    const t1 = makeTheme({ id: "a", name: "A" });
    const t2 = makeTheme({ id: "b", name: "B" });
    const result = deleteTheme([t1, t2], "a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("returns same array if id not found", () => {
    const t1 = makeTheme({ id: "a", name: "A" });
    const result = deleteTheme([t1], "nonexistent");
    expect(result).toEqual([t1]);
  });
});

describe("renameTheme", () => {
  it("renames theme by id", () => {
    const t1 = makeTheme({ id: "a", name: "Old Name" });
    const result = renameTheme([t1], "a", "New Name");
    expect(result[0].name).toBe("New Name");
  });

  it("returns same array if id not found", () => {
    const t1 = makeTheme({ id: "a", name: "A" });
    const result = renameTheme([t1], "nonexistent", "X");
    expect(result).toEqual([t1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement `addTheme`, `deleteTheme`, `renameTheme`**

Add to `src/lib/savedThemes.ts`:

```typescript
export function addTheme(themes: SavedTheme[], theme: SavedTheme): SavedTheme[] {
  const filtered = themes.filter((t) => t.name !== theme.name);
  return [...filtered, theme];
}

export function deleteTheme(themes: SavedTheme[], id: string): SavedTheme[] {
  return themes.filter((t) => t.id !== id);
}

export function renameTheme(themes: SavedTheme[], id: string, newName: string): SavedTheme[] {
  return themes.map((t) => (t.id === id ? { ...t, name: newName } : t));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- src/lib/savedThemes.test.ts`
Expected: PASS

- [ ] **Step 5: Run full CI checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && pnpm run type-check && pnpm run test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/savedThemes.ts src/lib/savedThemes.test.ts
git commit -m "feat(themes): add SavedTheme data layer with localStorage CRUD (#48)"
```

- [ ] **Step 7: Run pr-review**

Run: `~/bin/pr-review.sh --no-branch`

Review the `.pr-reviews/` report and diff. If fixes were applied, verify CI still passes. Self-review the changes one more time.

- [ ] **Step 8: Merge to main**

```bash
git checkout main
git merge feat/48-saved-themes-data-layer
```

---

## Milestone 2: ThemeContext `loadTheme` helper

**Branch:** `feat/48-theme-context-load`

**Files:**
- Modify: `src/context/ThemeContext.tsx`
- Export `TypographySettings` type (already exported implicitly — verify)

### Task 2.1: Export TypographySettings and add loadTheme

- [ ] **Step 1: Verify `TypographySettings` is importable**

Check that `src/context/ThemeContext.tsx` exports `TypographySettings`. It's defined as an `export interface` already — confirm with type-check after importing in `savedThemes.ts`.

Run: `pnpm run type-check`
Expected: PASS (the import in `savedThemes.ts` from Milestone 1 already uses it)

- [ ] **Step 2: Add `loadTheme` to ThemeContext**

In `src/context/ThemeContext.tsx`, add to the `ThemeContextValue` interface:

```typescript
loadTheme: (theme: { colors: ColorTokens; fontFamily: string; fontSize: number; typography: TypographySettings }) => void;
```

In the `ThemeProvider` component, add the implementation:

```typescript
const loadTheme = useCallback((theme: { colors: ColorTokens; fontFamily: string; fontSize: number; typography: TypographySettings }) => {
  setCustomColors(theme.colors);
  setFontFamily(theme.fontFamily);
  setFontSize(theme.fontSize);
  setTypography(theme.typography);
  setMode("custom");
}, [setCustomColors, setFontFamily, setFontSize, setTypography, setMode]);
```

Add `loadTheme` to the `useMemo` value object and its dependency array.

- [ ] **Step 3: Run type-check**

Run: `pnpm run type-check`
Expected: PASS

- [ ] **Step 4: Run full CI checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && pnpm run type-check && pnpm run test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/context/ThemeContext.tsx
git commit -m "feat(themes): add loadTheme helper to ThemeContext (#48)"
```

- [ ] **Step 6: Run pr-review**

Run: `~/bin/pr-review.sh --no-branch`

Review report and diff. Self-review one more time.

- [ ] **Step 7: Merge to main**

```bash
git checkout main
git merge feat/48-theme-context-load
```

---

## Milestone 3: i18n — add translation keys

**Branch:** `feat/48-theme-i18n`

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

### Task 3.1: Add translation keys

- [ ] **Step 1: Add English translation keys**

Add under the `"settings"` object in `src/locales/en.json`:

```json
"savedThemes": "Saved Themes",
"noSavedThemes": "No saved themes yet",
"saveAsTheme": "Save as theme",
"themeName": "Theme name",
"save": "Save",
"themeNameRequired": "Name is required",
"themeOverwrite": "\"{{name}}\" exists \u2014 overwrite?",
"overwrite": "Overwrite",
"deleteThemeConfirm": "Delete \"{{name}}\"?",
"typography": "Typography",
"customCssGlobalHint": "Applied globally \u2014 not included in saved themes."
```

- [ ] **Step 2: Add French translation keys**

Add matching keys in `src/locales/fr.json` under `"settings"`:

```json
"savedThemes": "Th\u00e8mes enregistr\u00e9s",
"noSavedThemes": "Aucun th\u00e8me enregistr\u00e9",
"saveAsTheme": "Enregistrer comme th\u00e8me",
"themeName": "Nom du th\u00e8me",
"save": "Enregistrer",
"themeNameRequired": "Le nom est requis",
"themeOverwrite": "\u00ab {{name}} \u00bb existe d\u00e9j\u00e0 \u2014 \u00e9craser ?",
"overwrite": "\u00c9craser",
"deleteThemeConfirm": "Supprimer \u00ab {{name}} \u00bb ?",
"typography": "Typographie",
"customCssGlobalHint": "Appliqu\u00e9 globalement \u2014 non inclus dans les th\u00e8mes enregistr\u00e9s."
```

- [ ] **Step 3: Run type-check**

Run: `pnpm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add translation keys for saved themes (#48)"
```

- [ ] **Step 5: Run pr-review**

Run: `~/bin/pr-review.sh --no-branch`

Review report and diff. Self-review one more time.

- [ ] **Step 6: Merge to main**

```bash
git checkout main
git merge feat/48-theme-i18n
```

---

## Milestone 4: SavedThemesList component

**Branch:** `feat/48-saved-themes-ui`

**Files:**
- Create: `src/components/SavedThemesList.tsx`

### Task 4.1: Build the SavedThemesList component

- [ ] **Step 1: Create `src/components/SavedThemesList.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ColorTokens } from "../lib/themes";
import type { TypographySettings } from "../context/ThemeContext";
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
  const [saving, setSaving] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  const handleSaveClick = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNameError(t("settings.themeNameRequired"));
      return;
    }
    const existing = themes.find((th) => th.name === trimmed);
    if (existing && !overwriteTarget) {
      setOverwriteTarget(trimmed);
      return;
    }
    onSave(trimmed);
    setSaving(false);
    setNameInput("");
    setNameError(null);
    setOverwriteTarget(null);
  };

  const handleCancelSave = () => {
    setSaving(false);
    setNameInput("");
    setNameError(null);
    setOverwriteTarget(null);
  };

  const handleRenameConfirm = (id: string) => {
    const trimmed = renameInput.trim();
    if (trimmed) {
      onRename(id, trimmed);
    }
    setRenamingId(null);
    setRenameInput("");
  };

  return (
    <div className="space-y-2">
      {/* Theme list */}
      {themes.length === 0 && !saving && (
        <p className="text-xs text-ink-muted">{t("settings.noSavedThemes")}</p>
      )}
      {themes.map((theme) => (
        <div
          key={theme.id}
          className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-warm-subtle transition-colors cursor-pointer"
          onClick={() => {
            if (renamingId !== theme.id && deletingId !== theme.id) onLoad(theme);
          }}
        >
          {/* Color swatches */}
          <div className="flex gap-0.5 shrink-0">
            {[theme.colors.paper, theme.colors.ink, theme.colors.accent].map(
              (color, i) => (
                <div
                  key={i}
                  className="w-3 h-3 rounded-sm border border-warm-border/50"
                  style={{ backgroundColor: color }}
                />
              ),
            )}
          </div>

          {/* Name or rename input */}
          {renamingId === theme.id ? (
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameConfirm(theme.id);
                if (e.key === "Escape") { setRenamingId(null); setRenameInput(""); }
              }}
              onBlur={() => handleRenameConfirm(theme.id)}
              autoFocus
              className="flex-1 min-w-0 text-sm bg-transparent border-b border-accent text-ink outline-none"
            />
          ) : (
            <span className="flex-1 min-w-0 text-sm text-ink truncate">
              {theme.name}
            </span>
          )}

          {/* Delete confirmation */}
          {deletingId === theme.id ? (
            <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <span className="text-[10px] text-ink-muted">
                {t("settings.deleteThemeConfirm", { name: theme.name })}
              </span>
              <button
                onClick={() => { onDelete(theme.id); setDeletingId(null); }}
                className="text-[10px] px-1.5 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
              >
                {t("common.delete")}
              </button>
              <button
                onClick={() => setDeletingId(null)}
                className="text-[10px] px-1.5 py-0.5 text-ink-muted hover:text-ink transition-colors"
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : renamingId !== theme.id ? (
            <span
              className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Rename button */}
              <button
                onClick={() => { setRenamingId(theme.id); setRenameInput(theme.name); }}
                className="p-0.5 text-ink-muted hover:text-ink transition-colors"
                aria-label="Rename"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                  <path d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {/* Delete button */}
              <button
                onClick={() => setDeletingId(theme.id)}
                className="p-0.5 text-ink-muted hover:text-red-500 transition-colors"
                aria-label="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ) : null}
        </div>
      ))}

      {/* Save form */}
      {saving ? (
        <div className="space-y-2 p-3 rounded-lg bg-warm-subtle">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => { setNameInput(e.target.value); setNameError(null); setOverwriteTarget(null); }}
            placeholder={t("settings.themeName")}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveClick(); if (e.key === "Escape") handleCancelSave(); }}
            className="w-full px-2 py-1.5 text-sm bg-surface border border-warm-border rounded-lg text-ink placeholder-ink-muted/40 outline-none focus:border-accent"
          />
          {nameError && <p className="text-xs text-red-500">{nameError}</p>}
          {overwriteTarget && (
            <p className="text-xs text-ink-muted">
              {t("settings.themeOverwrite", { name: overwriteTarget })}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSaveClick}
              className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              {overwriteTarget ? t("settings.overwrite") : t("settings.save")}
            </button>
            <button
              onClick={handleCancelSave}
              className="flex-1 px-2 py-1.5 text-xs rounded-lg border border-warm-border text-ink-muted hover:text-ink hover:border-ink-muted transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSaving(true)}
          className="w-full px-3 py-2 text-sm rounded-lg border border-dashed border-warm-border text-ink-muted hover:text-ink hover:border-ink-muted transition-colors"
        >
          {t("settings.saveAsTheme")}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run type-check**

Run: `pnpm run type-check`
Expected: PASS

- [ ] **Step 3: Run full CI checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && pnpm run type-check && pnpm run test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/components/SavedThemesList.tsx
git commit -m "feat(themes): add SavedThemesList component (#48)"
```

- [ ] **Step 5: Run pr-review**

Run: `~/bin/pr-review.sh --no-branch`

Review report and diff. Self-review one more time.

- [ ] **Step 6: Merge to main**

```bash
git checkout main
git merge feat/48-saved-themes-ui
```

---

## Milestone 5: Settings panel restructure + integration

**Branch:** `feat/48-settings-restructure`

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

### Task 5.1: Move typography under Appearance and add SavedThemesList

This is the main integration task. The changes to `SettingsPanel.tsx`:

1. Import `SavedThemesList` and saved theme CRUD functions
2. Add state for `savedThemes` array (loaded from localStorage on mount)
3. Add the `SavedThemesList` component at the top of the Appearance accordion
4. Remove the "Text & Typography" `<Accordion>` entirely
5. Move its contents (font size, font family, typography sliders) into the Appearance accordion, under a subsection header `<h4>` with `t("settings.typography")`
6. Update the custom CSS hint to use the new translation key `settings.customCssGlobalHint`

- [ ] **Step 1: Add imports and state to SettingsPanel**

At top of file, add:

```typescript
import SavedThemesList from "./SavedThemesList";
import {
  loadSavedThemes,
  saveSavedThemes,
  addTheme,
  deleteTheme,
  renameTheme,
  type SavedTheme,
} from "../lib/savedThemes";
```

Inside `SettingsPanel` component, after existing state declarations, add:

```typescript
const [savedThemes, setSavedThemes] = useState<SavedTheme[]>(loadSavedThemes);
const { loadTheme } = useTheme();
```

Note: `loadTheme` needs to be destructured from `useTheme()` alongside existing values.

Add handler functions:

```typescript
const handleSaveTheme = useCallback((name: string) => {
  const theme: SavedTheme = {
    id: crypto.randomUUID(),
    name,
    colors: customColors,
    fontFamily,
    fontSize,
    typography,
    createdAt: Date.now(),
  };
  const updated = addTheme(savedThemes, theme);
  setSavedThemes(updated);
  saveSavedThemes(updated);
}, [customColors, fontFamily, fontSize, typography, savedThemes]);

const handleDeleteTheme = useCallback((id: string) => {
  const updated = deleteTheme(savedThemes, id);
  setSavedThemes(updated);
  saveSavedThemes(updated);
}, [savedThemes]);

const handleRenameTheme = useCallback((id: string, newName: string) => {
  const updated = renameTheme(savedThemes, id, newName);
  setSavedThemes(updated);
  saveSavedThemes(updated);
}, [savedThemes]);

const handleLoadTheme = useCallback((theme: SavedTheme) => {
  loadTheme(theme);
}, [loadTheme]);
```

- [ ] **Step 2: Add SavedThemesList at top of Appearance accordion**

Inside the Appearance `<Accordion>`, before the preset mode buttons `<div className="flex gap-1 bg-warm-subtle rounded-xl p-1">`, add:

```tsx
{/* Saved Themes */}
<div className="mb-4 pb-4 border-b border-warm-border/50">
  <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
    {t("settings.savedThemes")}
  </h4>
  <SavedThemesList
    themes={savedThemes}
    onLoad={handleLoadTheme}
    onSave={handleSaveTheme}
    onDelete={handleDeleteTheme}
    onRename={handleRenameTheme}
  />
</div>
```

- [ ] **Step 3: Remove the Text & Typography accordion**

Delete the entire `<Accordion title={t("settings.textTypography")} ...>` block (lines ~884-1119 in the current file).

- [ ] **Step 4: Add typography subsection inside Appearance**

After the custom color editor section and before the Custom CSS section, add a new subsection. Place it right after the closing `</div>` of the `{mode === "custom" && ...}` block:

```tsx
{/* Typography */}
<div className="mt-4 pt-4 border-t border-warm-border/50">
  <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
    {t("settings.typography")}
  </h4>

  {/* Font size — paste the existing font size JSX here */}
  {/* Reading font — paste the existing reading font JSX here */}
  {/* Typography sliders — paste the existing typography sliders JSX here */}
</div>
```

Move the exact JSX from the deleted accordion into this subsection. The code remains identical — only its location changes.

- [ ] **Step 5: Update custom CSS hint**

Replace the existing `customCssHint` usage. Add a second hint line below the existing one for the global disclaimer:

```tsx
<p className="text-[11px] text-ink-muted leading-relaxed">
  {t("settings.customCssGlobalHint")}
</p>
```

- [ ] **Step 6: Run type-check**

Run: `pnpm run type-check`
Expected: PASS

- [ ] **Step 7: Visual verification**

Run: `pnpm run tauri dev`

Verify in the browser:
1. Settings panel opens, Appearance accordion contains everything
2. Saved Themes section shows "No saved themes yet"
3. "Save as theme" button opens the name input form
4. Can save a theme, see it in the list with color swatches
5. Can click a saved theme to load it (mode switches to custom, colors/font/typography applied)
6. Can rename a saved theme (inline edit)
7. Can delete a saved theme (with confirmation)
8. Overwrite confirmation works when saving with a duplicate name
9. Typography controls (font size, font family, line height, margins, etc.) are now under Appearance
10. Custom CSS section shows the global hint
11. No "Text & Typography" accordion exists
12. Page Layout accordion is unaffected

- [ ] **Step 8: Run full CI checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && pnpm run type-check && pnpm run test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(themes): integrate saved themes + restructure settings panel (#48)"
```

- [ ] **Step 10: Run pr-review**

Run: `~/bin/pr-review.sh --no-branch`

Review report and diff. This is the largest milestone — pay close attention to the review. Self-review one more time.

- [ ] **Step 11: Merge to main**

```bash
git checkout main
git merge feat/48-settings-restructure
```

---

## Summary

| Milestone | Branch | What it delivers |
|-----------|--------|-----------------|
| 1 | `feat/48-saved-themes-data-layer` | `SavedTheme` type + localStorage CRUD (load, save, add, delete, rename) with full test coverage |
| 2 | `feat/48-theme-context-load` | `loadTheme()` helper on ThemeContext that applies a theme snapshot in one call |
| 3 | `feat/48-theme-i18n` | All new translation keys for en + fr |
| 4 | `feat/48-saved-themes-ui` | `SavedThemesList` component with save/load/rename/delete UI |
| 5 | `feat/48-settings-restructure` | SettingsPanel restructure: merge typography under Appearance, integrate SavedThemesList, add custom CSS disclaimer |
