# Onboarding Preferences Step — Design

**Date:** 2026-06-01
**Status:** Approved, pending implementation plan

## Summary

Add a combined **Preferences** step to the existing onboarding wizard and make the
whole wizard re-runnable from a menu entry. The current wizard
(`Welcome → Import → Tips`) configures no settings; this adds a single screen for
the most-used settings and a way to replay setup later.

## Goals

- First launch: let the user set the most-used settings before reaching the library.
- Re-runnable: a menu entry replays the full wizard at any time.
- Reuse existing setters and persistence — no new persistence layer.

## Non-goals

- Library location picker (set elsewhere; changing it later is disruptive but out of scope here).
- Web UI / OPDS / backup configuration (advanced, stay in SettingsPanel).
- Custom color theme editor and user-uploaded fonts (advanced, stay in SettingsPanel).

## Flow

```
Welcome (1) → Preferences (2) → Import (3) → Tips (4)
```

Four steps. The `StepIndicator` is generalized from the hardcoded `1|2|3` to support 4.

Changing the language on the Preferences step applies immediately and re-renders
steps 2–4 in the new language. Welcome (step 1) renders in the previously detected
language, which is acceptable.

## Preferences step

One screen, five controls, each wired to an existing setter. All apply live.

| Control | Wired to | Persistence |
|---------|----------|-------------|
| Language | `i18n.changeLanguage(code)` + `LANGUAGES` (from `src/i18n`) | i18next localStorage cache (automatic) |
| Theme mode | `ThemeContext.setMode` | localStorage (existing, automatic) |
| Font family | `ThemeContext.setFontFamily` | localStorage (existing, automatic) |
| Font size | `ThemeContext.setFontSize` (stepper, `MIN_FONT_SIZE`..`MAX_FONT_SIZE`) | localStorage (existing, automatic) |
| Import mode | `invoke("set_setting_value", { key: "import_mode", value })` | SQLite DB |

### Option subsets

- **Theme mode:** `light / dark / system / sepia`. Omit `custom` (advanced color editor).
- **Font family:** the 4 built-ins — `serif` (Lora), `literata`, `sans-serif` (DM Sans),
  `dyslexic` (OpenDyslexic). Omit user-uploaded custom fonts.
- **Import mode:** `copy` / `link` (the two values SettingsPanel already writes).

### No new persistence layer

Appearance and language already auto-persist through their existing mechanisms
(ThemeContext writes localStorage; i18next caches to localStorage). Import mode
persists via the existing `set_setting_value` command. The Preferences step only
calls these existing setters — it introduces no new save path.

On entry, the step reads current values: language from `i18n.language`, theme/font
from ThemeContext, import mode via `invoke("get_setting_value", { key: "import_mode" })`.

## State management

- **`useOnboarding` hook** (`src/hooks/useOnboarding.ts`):
  - `Step` type `1 | 2 | 3` → `1 | 2 | 3 | 4`.
  - `advance` cap `3` → `4`.
  - Add `restart()`: clears the `folio-onboarding-complete` localStorage flag,
    sets `isActive = true`, resets `currentStep = 1`.

- **`OnboardingContext`** (new, `src/context/OnboardingContext.tsx`):
  - Provider at App level wrapping `useOnboarding`, exposing
    `{ isActive, currentStep, advance, skip, complete, restart }`.
  - Reason: the menu trigger (SettingsPanel) and the wizard (rendered in Library)
    must share one state. The hook is currently private to the wizard.

## Menu entry (re-run)

A **"Re-run setup wizard"** button in `SettingsPanel` calls `restart()` from the
context. SettingsPanel is the natural home; the App header is already crowded.
Re-run replays all four steps from step 1.

## Shared extraction

The font option array currently lives inline in `SettingsPanel.tsx` JSX. Extract it
to `src/lib/themes.ts` as `FONT_OPTIONS` (`{ key, label, css }[]`) and consume it in
both SettingsPanel and the Preferences step, to avoid duplication.

## Files touched

- `src/hooks/useOnboarding.ts` — 4 steps, `restart()`
- `src/context/OnboardingContext.tsx` — **new** provider
- `src/components/OnboardingWizard.tsx` — new `PreferencesStep`, generalized `StepIndicator`, consume context
- `src/components/SettingsPanel.tsx` — "Re-run setup wizard" button; use `FONT_OPTIONS`
- `src/lib/themes.ts` — add `FONT_OPTIONS`
- `src/App.tsx` — wrap tree with `OnboardingProvider`
- `src/screens/Library.tsx` — wizard consumes context (import handlers still passed as props)
- i18n locale files — add `onboarding.preferences.*` keys for all languages

## Testing

- **`useOnboarding`:** advance reaches step 4; `restart()` reactivates and resets to step 1.
- **`OnboardingWizard.test.tsx`:** Preferences step renders all five controls; each
  control fires its setter (mock ThemeContext setters + `i18n.changeLanguage`);
  changing language re-renders; import-mode write mocks `invoke`.
- **Menu re-entry:** "Re-run setup wizard" in SettingsPanel triggers `restart()` and
  the wizard becomes active.

## Risks / notes

- Language change mid-wizard re-renders later steps — verify focus trap and step
  indicator survive the re-render.
- `restart()` must clear the persisted completion flag, or the wizard would re-hide
  on next launch unexpectedly.
