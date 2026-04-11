# PR Review: feat-48-settings-restructure
**Date:** 2026-04-11 20:02
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 556
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: Saved themes do not preserve the active appearance mode, so loading a saved theme can restore the wrong colors.

1. **File:** [src/components/SettingsPanel.tsx](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:288), [src/context/ThemeContext.tsx](/Users/mike/Documents/www/folio/src/context/ThemeContext.tsx:278)
   **What can go wrong:** If a user saves a theme while using `light`, `sepia`, `dark`, or `system`, reloading that saved theme later does not restore that appearance. It always switches the app into `custom` mode and applies whatever `customColors` happened to be stored at save time. A concrete failure case: save a “Dark” theme while currently in dark mode, then load it later and get an unrelated old custom palette instead of dark.
   **Why:** `handleSaveTheme()` stores `colors: customColors` regardless of the current `mode` ([SettingsPanel.tsx:288-302](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:288)). `loadTheme()` then always calls `setMode("custom")` after applying those colors ([ThemeContext.tsx:278-284](/Users/mike/Documents/www/folio/src/context/ThemeContext.tsx:278)). The saved-theme model also has no `mode` field, so the original appearance choice is lost entirely.
   **Impact:** Users can overwrite or load themes expecting a preset appearance and get the wrong visual state back. That makes the feature unreliable and can silently discard the intended theme configuration.
   **Fix:** Persist the theme `mode` in `SavedTheme` and restore it on load. For preset modes, either save the mode itself and reapply it, or snapshot the effective tokens for the active mode instead of always using `customColors`. If saved themes are meant to support only custom palettes, block saving unless `mode === "custom"` and make that constraint explicit in the UI.
   **Severity:** BLOCKING
   **Fixable:** YES

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Potential XSS via unsanitized theme names and lack of validation for saved theme data.

### Detailed Findings:

---

**1. Security: Potential XSS via Saved Theme Name**

- **File:** `src/components/SettingsPanel.tsx` (and implicitly `src/components/SavedThemesList.tsx`)
- **What:** The `name` property of `SavedTheme` objects, which are loaded from and saved to client-side storage (likely `localStorage` via `src/lib/savedThemes.ts`), is passed to the `SavedThemesList` component. If this name, which is user-editable, contains malicious script (e.g., `<script>alert('XSS')</script>`), and `SavedThemesList` renders it directly into the DOM without proper sanitization or escaping, it could lead to a Cross-Site Scripting (XSS) vulnerability.
- **Why:** Data retrieved from client-side storage (`localStorage`) is considered untrusted input. While React components typically escape text content by default, it is a common oversight to manually inject unsanitized strings, particularly when dealing with dynamic text, or within components that might use `dangerouslySetInnerHTML`. The `CLAUDE.md` acknowledges XSS risks in EPUBs and mentions `DOMPurify`, indicating an awareness of such threats, but this pattern needs consistent application to all untrusted inputs.
- **Impact:** An attacker could inject arbitrary JavaScript code into the application, leading to session hijacking, data exfiltration, defacement, or other malicious activities. This could happen if a user manually modifies their `localStorage` data, or if another vulnerability (e.g., in a different part of the application) allows an attacker to write to `localStorage`.
- **Fix:** Ensure that any user-editable text, such as `SavedTheme.name`, is explicitly sanitized or escaped before being rendered into the DOM, especially if `SavedThemesList` does not rely solely on React's default text node escaping. If `SavedThemesList` uses `dangerouslySetInnerHTML` or directly manipulates the DOM with these values, `DOMPurify` (as already used in the project) should be applied to `theme.name` before rendering. Alternatively, strictly validate that theme names only contain allowed characters when saving them.
- **Severity:** BLOCKING
- **Fixable:** YES

---

**2. Correctness: Lack of Robust Validation for `SavedTheme` Data from Storage**

- **File:** `src/components/SettingsPanel.tsx` (and implicitly `src/lib/savedThemes.ts`)
- **What:** The `loadSavedThemes` function (imported from `../lib/savedThemes.ts`) retrieves saved theme data. If this data, stored in `localStorage`, is malformed (e.g., not valid JSON, missing required properties, or properties with incorrect types like `fontSize` being a string instead of a number), parsing and processing it could cause the application to crash or lead to unexpected behavior.
- **Why:** `localStorage` is a string-based key-value store and does not enforce any schema or type safety. Data retrieved from it must be explicitly validated and type-guarded at runtime before being used by the application. The current diff does not show any such validation being performed on the `savedThemes` array after it's loaded.
- **Impact:** Application crashes (e.g., `JSON.parse` errors, `TypeError` when accessing properties), incorrect application of theme settings, or an inability to display/manage saved themes, leading to a poor user experience.
- **Fix:** Implement comprehensive runtime validation and type-guarding within the `loadSavedThemes` function (in `src/lib/savedThemes.ts`). This validation should:
    1.  Safely parse the JSON string (e.g., with a `try-catch` block).
    2.  Verify that the parsed data is an array.
    3.  For each item in the array, ensure it conforms to the `SavedTheme` interface (checking for presence, type, and reasonable values for properties like `id`, `name`, `colors`, `fontSize`, `fontFamily`, `typography`, `createdAt`).
    Malformed or invalid entries should be either filtered out or trigger a warning, and the storage should potentially be reset if the entire data structure is unrecoverable.
- **Severity:** BLOCKING
- **Fixable:** YES

---

**3. Design: Ambiguous Scope of Custom CSS Hint**

- **File:** `src/components/SettingsPanel.tsx`, line 926
- **What:** The new hint `t("settings.customCssGlobalHint")` (displayed near the custom CSS input) uses the term "global." This could be misleading if the custom CSS primarily affects only the reader component or components leveraging `ThemeContext`, rather than truly impacting the entire application UI.
- **Why:** The `customCss` state variable and its controls are nested within the "Appearance" accordion, which largely governs reading-specific styles (colors, fonts, typography). If `customCss` is indeed only applied within the reader or theme-consuming components, implying it's "global" could set incorrect user expectations.
- **Impact:** User confusion, frustration, or wasted effort if they attempt to apply styles to the application's UI outside the reader and find their changes have no effect.
- **Fix:** Clarify the scope of the custom CSS input. If the custom CSS primarily affects the reader component, rename the hint to something like `t("settings.customCssReaderHint")` to accurately reflect its influence. If it truly is intended to affect the entire application, ensure the implementation guarantees this global application of styles.
- **Severity:** SUGGESTION
- **Fixable:** YES

---


## [Claude — Implementer] Round 1

All 136 tests pass across 6 test files. Here's the full analysis and summary:

---

## Issue-by-issue Analysis

### Issue 1 — Mode not preserved in saved themes (Codex)

**Raised by:** Codex only | **Action:** Fixed

Codex is right. `handleSaveTheme` was capturing `customColors` regardless of the active mode, and `loadTheme` always forced `setMode("custom")`. If you save while in "dark" mode, you'd get whatever stale custom palette was in state, not the dark colors. Loading it later switches to custom mode with wrong colors.

**Changes made:**
- `src/lib/savedThemes.ts`: Added `mode: ColorMode` field to `SavedTheme` interface; added `isValidColorMode` check in `isValidTheme`
- `src/components/SettingsPanel.tsx`: `handleSaveTheme` now captures current `mode`; added `mode` to dependency array
- `src/context/ThemeContext.tsx`: `loadTheme` signature and implementation now accept `mode` and call `setMode(theme.mode)` instead of hardcoded `"custom"`
- `src/lib/savedThemes.test.ts`: Added `mode: "custom"` to test helper

### Issue 2 — XSS via saved theme name (Gemini)

**Raised by:** Gemini only | **Action:** Pushed back

This is a false positive. In `SavedThemesList.tsx`, theme names are rendered exclusively via React JSX text interpolation (`{theme.name}` at line 191, `{theme.name}` in aria-labels). React automatically escapes text content — there is no `dangerouslySetInnerHTML` used with theme names anywhere. The attack vector (user manually tampering with their own localStorage) is self-XSS, which is not a real vulnerability by modern standards.

### Issue 3 — Lack of validation for SavedTheme data from storage (Gemini)

**Raised by:** Gemini only | **Action:** Pushed back

Gemini didn't read the actual implementation. `savedThemes.ts` already has exactly the validation requested:
- `isValidTheme()` (lines 18-38): validates every field, type-checks all numbers with `Number.isFinite`, regex-validates hex colors against `HEX_COLOR_RE`, validates `textAlign` is `"left"|"justify"`, checks `hyphenation` is boolean, verifies `createdAt > 0`
- `loadSavedThemes()` (lines 41-51): try/catch around `JSON.parse`, `Array.isArray` guard, filters through `isValidTheme`
- The test suite has **20+ tests** specifically covering malformed data scenarios (corrupted JSON, missing fields, wrong types, NaN, Infinity, etc.)

### Issue 4 — Ambiguous "global" in Custom CSS hint (Gemini)

**Raised by:** Gemini only (SUGGESTION) | **Action:** Pushed back

The actual translation is "Applied globally — not included in saved themes." The word "globally" means "always active regardless of which theme is loaded" — it's distinguishing custom CSS from saved-theme settings. The hint's primary purpose is to tell users that custom CSS persists across theme switches. In context, this is clear.

---

## Summary Table

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Mode not preserved in saved themes | Codex | **Fixed** | Real bug: saving in preset mode captures wrong colors, loading always forces custom mode |
| XSS via theme names | Gemini | **Pushed back** | React escapes text content by default; no `dangerouslySetInnerHTML` used with names; self-XSS is not a real vuln |
| Lack of storage validation | Gemini | **Pushed back** | Already implemented: `isValidTheme()` validates all fields, types, hex colors; `loadSavedThemes()` has try/catch + array check + filter; 20+ tests cover this |
| Ambiguous "global" CSS hint | Gemini | **Pushed back** | The hint means "persists across theme changes, not saved with themes" — clear in context |

---


## [Codex — Reviewer] Round 2

NEEDS_FIX: Loading a saved preset theme still silently overwrites the user's custom palette in storage.

1. **File:** [src/components/SettingsPanel.tsx](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:288), [src/context/ThemeContext.tsx](/Users/mike/Documents/www/folio/src/context/ThemeContext.tsx:278)
   **What can go wrong:** Saving and later loading a `light`/`dark`/`sepia`/`system` theme can replace the user's actual custom theme with stale colors from an unrelated earlier state. Concrete case: a user has custom palette `A`, switches to `dark`, saves “Dark”, later edits their custom palette to `B`, then loads “Dark”. The app shows dark mode, but `customColors` is reset back to `A`. When they switch back to `custom`, their current palette `B` is gone.
   **Why:** `handleSaveTheme()` still persists `colors: customColors` for every mode, even when the active theme is not `custom` ([SettingsPanel.tsx:293-295](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:293)). `loadTheme()` then always calls `setCustomColors(theme.colors)` before applying `theme.mode` ([ThemeContext.tsx:278-283](/Users/mike/Documents/www/folio/src/context/ThemeContext.tsx:278)). Persisting `mode` fixed the visible mode restoration, but it did not stop preset-theme loads from mutating the hidden custom-theme state.
   **Impact:** Silent data loss of the user's custom palette. A saved preset theme becomes destructive: merely loading it can overwrite the custom colors the user intended to keep.
   **Fix:** Do not save or restore `customColors` for non-`custom` themes. Either:
   1. save/load `colors` only when `mode === "custom"`, leaving existing custom colors untouched for preset modes, or
   2. if saved themes are meant to snapshot exact colors, load them as `custom` instead of preserving preset modes.
   The current hybrid behavior mixes both models and corrupts state.
   **Severity:** BLOCKING
   **Fixable:** YES

---

## [Gemini — Reviewer] Round 2

LGTM: All previous issues have been addressed or validly pushed back on.

---


## [Claude — Implementer] Round 2

All 136 tests pass, type-check clean.

## Issue-by-issue Analysis

### Issue — Loading preset theme overwrites custom palette (Codex, Round 2)

**Raised by:** Codex only | **Action:** Fixed

Codex is right. The Round 1 fix correctly added `mode` to saved themes and restored it on load, but `loadTheme` still unconditionally called `setCustomColors(theme.colors)`. For preset modes (light/dark/sepia/system), the stored `colors` are whatever stale `customColors` happened to be in state at save time — they're meaningless for the preset and destructive when applied.

**Fix:** Guard `setCustomColors` behind `theme.mode === "custom"`. For preset modes, we only need to restore `fontFamily`, `fontSize`, `typography`, and call `setMode` — the preset handles its own colors. The stale `colors` field remains in storage harmlessly (and keeps the schema uniform) but is never applied.

---

## Summary Table

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Loading preset theme overwrites custom palette | Codex | **Fixed** | Real bug: `setCustomColors` was called unconditionally, overwriting the user's custom palette with stale colors when loading a preset-mode theme. Guarded behind `mode === "custom"`. |
| Round 1 issues (all) | Gemini | **LGTM** | Gemini confirmed Round 1 resolutions are satisfactory. |

---


## [Codex — Reviewer] Round 3

NEEDS_FIX: Adding required `mode` to the saved-theme schema drops every theme already stored by current releases.

1. **File:** [src/lib/savedThemes.ts](/Users/mike/Documents/www/folio/src/lib/savedThemes.ts:19)
   **What can go wrong:** Users who already have saved themes from the current `main` build will lose them after upgrading to this branch. On first load, every previously saved theme is filtered out and the Saved Themes list becomes empty.
   **Why:** `SavedTheme.mode` is now mandatory, and `isValidTheme()` rejects any stored entry without it (`typeof t.mode === "string" && isValidColorMode(t.mode)`). But `main` persisted themes without a `mode` field at all, so existing `localStorage["folio-saved-themes"]` data no longer passes validation.
   **Impact:** Data loss of user-saved themes across upgrade. This is persistent and silent: the app just stops showing existing themes.
   **Fix:** Add a backward-compatibility path in `loadSavedThemes()`. When a stored entry matches the old schema and lacks `mode`, hydrate it as `mode: "custom"` before validation/filtering, since that was the previous behavior. Add a regression test that loads a pre-upgrade saved theme and confirms it still appears.
   **Severity:** BLOCKING
   **Fixable:** YES

---

## [Gemini — Reviewer] Round 3

LGTM: All identified blocking issues have been addressed and pushbacks are justified.

---


## [Claude — Implementer] Round 3

---

## Issue-by-issue Analysis

### Issue — Schema migration drops existing themes (Codex, Round 3)

**Raised by:** Codex only | **Action:** Fixed

Codex is right. I verified that `savedThemes.ts` exists on `main` without a `mode` field in the `SavedTheme` interface. Users on the current release can have saved themes in localStorage that lack `mode`. The new `isValidTheme()` rejects those entries, silently emptying the saved themes list on upgrade.

**Fix:** Added `migrateTheme()` in `loadSavedThemes()` that hydrates entries missing `mode` with `"custom"` (matching the old behavior where `loadTheme` always called `setMode("custom")`). The migration runs before validation, so old themes pass `isValidTheme` normally. Added two regression tests: one confirming legacy themes are hydrated, one confirming existing `mode` values aren't overwritten.

---

## Summary Table

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Schema migration drops existing themes | Codex | **Fixed** | Real bug: `isValidTheme` rejects pre-upgrade themes lacking `mode`. Added `migrateTheme()` to hydrate missing `mode` as `"custom"` before validation. 2 regression tests added. |
| All prior issues | Gemini | **LGTM** | Gemini confirmed all prior resolutions are satisfactory. |

---

