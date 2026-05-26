# First-Launch Guided Onboarding

**Date:** 2026-05-26
**Status:** Design — pending implementation
**Author:** Mike
**Research:** F-1-1 from research team report (2026-05-25)

## Problem

New users launch Folio to an empty library with three action buttons ("Add
Books", "Import Folder", drag-and-drop hint) but no guided introduction.
There is no welcome moment, no explanation of what Folio can do, and no
contextual tips after the first book is imported. Users who don't already
have an ebook file ready may not know about the built-in OPDS catalogs.

## Goal

Add a 3-step modal wizard on first launch that:

1. Welcomes the user and establishes Folio's purpose.
2. Guides them to import their first book (file picker, folder, or
   drag-and-drop).
3. Shows 2-3 quick tips about key features (focus mode, online catalogs,
   drag-and-drop).

Out of scope: sample book bundling or download, OPDS catalog setup during
onboarding, theme/preference personalization, progressive coach marks,
re-triggering on empty library.

## Decisions

- **Modal overlay** on Library screen, not a dedicated route or EmptyState
  replacement.
- **No sample book** — user imports their own files.
- **Skip button on every step** — one-shot, never re-triggers once
  dismissed or completed.
- **Minimal tips** — 3 static tip cards, not a feature tour.
- **localStorage only** — no backend/DB changes for onboarding state.

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/components/OnboardingWizard.tsx` | Modal wizard — renders 3 steps, handles transitions |
| `src/hooks/useOnboarding.ts` | Manages onboarding state: current step, skip, complete |

### Modified files

| File | Change |
|------|--------|
| `src/screens/Library.tsx` | Render `<OnboardingWizard>` when onboarding active; pass import handlers |
| `src/components/EmptyState.tsx` | Extract book illustration into `BookStackIllustration` (shared with wizard Step 1) |
| `src/locales/en/translation.json` | Add `onboarding.*` keys |

### No backend changes

Import uses existing `invoke("import_books")` and `invoke("import_folder")`
commands. Onboarding completion state stored in localStorage.

## Component design

### Component tree

```
Library.tsx
  └─ OnboardingWizard (modal overlay, conditionally rendered)
       ├─ WelcomeStep        (step 1)
       ├─ ImportStep          (step 2, reuses existing import logic)
       └─ TipsStep            (step 3)
  └─ EmptyState (visible behind dimmed overlay)
```

### useOnboarding hook

```typescript
interface UseOnboarding {
  isActive: boolean;      // true if onboarding not yet completed/skipped
  currentStep: 1 | 2 | 3;
  advance: () => void;    // move to next step
  skip: () => void;       // set flag + close
  complete: () => void;   // set flag + close (from final step)
}
```

State source: `localStorage.getItem("folio-onboarding-complete")`.
`skip()` and `complete()` both set `"folio-onboarding-complete"` to
`"true"` and set `isActive` to `false`.

### BookStackIllustration

Extracted from EmptyState's inline book stack SVG/div markup into a shared
component. Used by both EmptyState and OnboardingWizard Step 1. No prop
changes — purely a structural extraction.

## Step behavior

### Step 1 — Welcome

- Book stack illustration (shared component)
- Heading: "Welcome to Folio"
- Subtitle: "Your personal reading companion. Let's get your first book on
  the shelf."
- Primary CTA: "Add Your First Book" → `advance()` to Step 2
- Skip link: "Skip — you can always import later" → `skip()`

### Step 2 — Import

- Import icon in accent circle
- Heading: "Import a Book"
- Two import options (styled as clickable rows):
  - "Add Files" (EPUB, PDF, CBZ, CBR, MOBI) → opens Tauri file dialog
  - "Import Folder" (all books from a folder) → opens Tauri directory dialog
- Dashed drag-and-drop zone with hint text
- On successful import (at least one book added) → auto `advance()` to
  Step 3
- On import error → existing toast system shows error, stays on Step 2
- Skip link → `skip()`

Import handlers are passed down from Library.tsx. OnboardingWizard
receives `onImport` and `onImportFolder` callbacks that call the existing
Library handlers and return their result. The wizard's ImportStep awaits
the callback — if the library book count increases after the call
resolves (checked via a `get_library` invoke), it calls `advance()`.
This avoids modifying the existing import functions.

### Step 3 — Tips

- Checkmark icon in accent circle
- Heading: "You're All Set"
- Subtitle: "A few things to know"
- 3 tip cards:
  1. **Focus Mode** — "Press `D` while reading for a distraction-free
     experience"
  2. **Online Catalogs** — "Browse free books from Project Gutenberg,
     Standard Ebooks, and more"
  3. **Drag & Drop** — "Drop book files anywhere in the app to import them
     instantly"
- Primary CTA: "Start Reading" → `complete()`

## Modal behavior

- **Backdrop:** semi-transparent dark overlay with subtle blur
  (`bg-black/60 backdrop-blur-sm`)
- **Not closable** by clicking backdrop or pressing Escape — user must use
  Skip or complete the flow
- **Centered**, max-width 440px, responsive horizontal padding
- **Entry animation:** fade-in + slight scale-up (200ms ease-out)
- **Step transitions:** crossfade between steps (150ms)
- **Step indicator:** 3 horizontal dots at top — filled accent for
  completed/current steps, warm-border for upcoming

## Styling

All styling uses existing Tailwind classes and Folio design tokens:

| Element | Classes / tokens |
|---------|-----------------|
| Modal container | `bg-surface rounded-2xl shadow-2xl` |
| Step dots (active) | `bg-accent` |
| Step dots (inactive) | `bg-warm-border` |
| Primary button | Same as EmptyState accent button |
| Import option rows | `bg-warm-subtle rounded-xl` |
| Tip cards | `bg-warm-subtle rounded-xl` with `bg-accent-light` icon circles |
| Skip link | `text-accent hover:text-accent-hover` |

Theme-aware: inherits light/dark tokens from ThemeContext automatically.

## i18n

All user-facing strings behind translation keys:

```
onboarding.welcome.title         = "Welcome to Folio"
onboarding.welcome.subtitle      = "Your personal reading companion. Let's get your first book on the shelf."
onboarding.welcome.cta           = "Add Your First Book"
onboarding.welcome.skip          = "Skip"
onboarding.welcome.skipHint      = "you can always import later"
onboarding.import.title          = "Import a Book"
onboarding.import.subtitle       = "Choose how to add your first book"
onboarding.import.addFiles       = "Add Files"
onboarding.import.addFilesHint   = "EPUB, PDF, CBZ, CBR, MOBI"
onboarding.import.importFolder   = "Import Folder"
onboarding.import.importFolderHint = "Add all books from a folder"
onboarding.import.dragDrop       = "or drag & drop files here"
onboarding.tips.title            = "You're All Set"
onboarding.tips.subtitle         = "A few things to know"
onboarding.tips.focus            = "Focus Mode"
onboarding.tips.focusDesc        = "Press D while reading for a distraction-free experience"
onboarding.tips.catalogs         = "Online Catalogs"
onboarding.tips.catalogsDesc     = "Browse free books from Project Gutenberg, Standard Ebooks, and more"
onboarding.tips.dragDrop         = "Drag & Drop"
onboarding.tips.dragDropDesc     = "Drop book files anywhere in the app to import them instantly"
onboarding.tips.cta              = "Start Reading"
```

## Edge cases

| Scenario | Behavior |
|----------|----------|
| User drags file onto modal | Import fires, success → advance to Step 3 |
| Import fails | Toast error, stay on Step 2 |
| Multiple books imported at once | All added, advance to Step 3 |
| Browser refresh mid-onboarding | Flag not set yet → restarts from Step 1 |
| User clears localStorage | Onboarding shows again (acceptable — rare manual action) |
| User removes all books later | No re-trigger — flag persists |
| Dark mode active on first launch | Modal inherits dark tokens automatically |

## Testing

### Unit tests (Vitest)

- `useOnboarding` hook:
  - Returns `isActive: true` when no localStorage flag
  - Returns `isActive: false` when flag set
  - `advance()` increments step 1→2→3
  - `skip()` sets localStorage flag and `isActive: false`
  - `complete()` sets localStorage flag and `isActive: false`

### Component tests (Vitest + testing-library)

- OnboardingWizard renders Step 1 on mount
- "Add Your First Book" click advances to Step 2
- Skip link closes wizard and sets flag
- Step indicator shows correct active states
- Step 3 "Start Reading" calls complete

### Manual verification

- First launch shows wizard over empty library
- Import via file picker from Step 2 advances to Step 3
- Skip from any step closes modal, EmptyState visible
- Second launch does not show wizard
- Dark mode: all elements readable with correct token colors
