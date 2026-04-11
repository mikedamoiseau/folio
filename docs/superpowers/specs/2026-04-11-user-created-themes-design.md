# User-Created Themes (#48) — Design Spec

## Overview

Add the ability to save, name, and switch between multiple custom visual themes in Folio's settings panel. Currently users can customize colors and typography but only maintain one active configuration. This feature lets users create named presets like "Night Reading", "Beach Mode", etc.

## Scope

**In scope:**
- Saved themes list (localStorage array)
- "Save current as theme" with name input
- Theme picker showing saved themes
- Delete and rename saved themes
- Settings panel restructure: merge Typography under Appearance

**Out of scope (future):**
- Import/export themes as JSON
- Theme sharing between devices
- Backend/database storage

## Data Model

```typescript
interface SavedTheme {
  id: string;           // crypto.randomUUID()
  name: string;         // user-chosen, unique within saved themes
  colors: ColorTokens;  // all 9 color tokens
  fontFamily: string;
  fontSize: number;
  typography: TypographySettings;
  createdAt: number;    // Date.now()
}
```

**Storage:** `folio-saved-themes` key in localStorage, JSON-serialized array of `SavedTheme`.

**What a theme captures:** colors, font family, font size, and typography settings (line height, page margins, text align, paragraph spacing, hyphenation).

**What a theme does NOT capture:** custom CSS (global override layer), scroll mode, dual page, manga mode, page animation. These remain independent global settings.

## Settings Panel Restructure

### Before

- **Appearance** (accordion) — color presets, custom toggle, custom color editor, custom CSS
- **Text & Typography** (accordion) — font size, font family, line height, margins, text align, paragraph spacing, hyphenation

### After

- **Appearance** (accordion)
  1. **Saved Themes** — theme picker list at the top; "Save as theme" button
  2. Color mode presets (Light / Sepia / Dark / Auto)
  3. Custom Colors toggle + editor (unchanged)
  4. **Typography** (subsection header) — font family, font size, line height, margins, text align, paragraph spacing, hyphenation (moved from the old Text & Typography accordion)
  5. Custom CSS (with hint: "Applied globally — not included in saved themes")

The "Text & Typography" accordion is removed entirely.

## Theme Selection Behavior

- Selecting a saved theme applies all its settings immediately: `customColors`, `fontFamily`, `fontSize`, `typography`
- The color mode switches to `custom` so the saved color tokens take effect
- After loading a theme, editing any setting is independent — there is no live binding between a saved theme and the active settings
- No "active theme" indicator is tracked — themes are snapshots you load from, not live references

## Save Flow

1. User clicks "Save as theme" button
2. An inline text input appears below the button with a name field and "Save" / "Cancel" buttons
3. On save:
   - If name is empty: show validation error
   - If name matches an existing saved theme: show inline confirmation ("Name exists — overwrite?")
   - Otherwise: capture current `customColors`, `fontFamily`, `fontSize`, `typography` into a new `SavedTheme` and append to the array
4. The new theme appears in the saved themes list

## Saved Themes List

- Displayed as a vertical list of theme entries at the top of the Appearance section
- Each entry shows the theme name and a small color preview (e.g., paper + ink + accent swatches)
- Clicking a theme loads it (applies all settings)
- Each entry has icon buttons for rename and delete:
  - **Rename:** inline edit — the name becomes an editable text field, press Enter or blur to confirm
  - **Delete:** shows inline confirmation ("Delete 'Theme Name'?") before removing

## Custom CSS Disclaimer

The custom CSS section includes a hint line: "Custom CSS is applied globally and is not included in saved themes."

## Technical Approach

### New files
- `src/lib/savedThemes.ts` — `SavedTheme` type, localStorage CRUD helpers (`loadSavedThemes`, `saveSavedThemes`, `addTheme`, `deleteTheme`, `renameTheme`)
- `src/components/SavedThemesList.tsx` — the saved themes picker + save/rename/delete UI

### Modified files
- `src/context/ThemeContext.tsx` — expose a `loadTheme(theme: SavedTheme)` helper that sets customColors + fontFamily + fontSize + typography + switches mode to "custom" in one call
- `src/components/SettingsPanel.tsx` — restructure: remove Text & Typography accordion, merge its contents under Appearance with a subsection header; add `SavedThemesList` component at the top of Appearance
- `src/lib/themes.ts` — re-export `SavedTheme` type if needed for cross-module use

### No backend changes
No Rust code, database schema, or Tauri command changes required.

## Testing Strategy

- Unit tests for localStorage CRUD helpers (load, save, add, delete, rename, name conflict detection)
- Unit tests for `loadTheme` function (verify it sets all expected values)
- Settings panel restructure verified visually via dev server

## i18n

All new UI strings must use translation keys via `useTranslation()`, following the existing `settings.*` namespace convention. New keys include: "Save as theme", "No saved themes yet", theme-related confirmations, the custom CSS disclaimer, and the "Typography" subsection header.

## Edge Cases

- **Empty themes list:** show a hint like "No saved themes yet"
- **localStorage quota:** gracefully handle `QuotaExceededError` when saving
- **Corrupted data:** `loadSavedThemes` validates and filters out malformed entries (same pattern as existing `loadStoredCustomColors`)
- **Name collisions:** handled via overwrite confirmation in save flow
