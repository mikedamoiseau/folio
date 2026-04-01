# Page Turn Animations — Design Spec

## Overview

Add an optional horizontal slide animation when turning pages in page-based formats (PDF, CBZ, CBR). The animation plays in PageViewer when navigating via prev/next spread. Configurable via a settings toggle, enabled by default.

## Scope

- **In scope:** PDF, CBZ, CBR — all formats using the PageViewer component
- **Out of scope:** EPUB (both paginated and continuous scroll modes). EPUB chapter loads involve fetching new HTML content with variable timing, making slide animations feel laggy.

## Animation Mechanics

CSS transition on a new wrapper div (`slideRef`) that wraps the existing `spreadRef` container in PageViewer.tsx. This keeps slide animation separate from zoom/pan transforms on `spreadRef`.

**Flow on page change (`goTo()`):**

1. Instantly position `slideRef` off-screen: `translateX(100%)` for forward navigation, `translateX(-100%)` for backward (no transition)
2. Next animation frame (`requestAnimationFrame`): set `transition: transform 200ms ease-out` and `translateX(0)` on `slideRef` — the wrapper slides into view, carrying the spread with it
3. On `transitionend` event: remove the transition property from `slideRef` to keep it inert until the next page turn

**Direction:**

- `nextSpread()` sets direction to `"right"` → spread enters from the right
- `prevSpread()` sets direction to `"left"` → spread enters from the left
- Direct page jumps (go-to-page input): slide as "next" direction
- Direction is always left-to-right regardless of manga mode (keeps it simple, matches user expectation of the visual slide)

**Timing:** 200ms, `ease-out` easing. Fast enough to avoid sluggishness, slow enough to register visually.

## Integration with Existing PageViewer Logic

- **Zoom reset and transform coordination:** `goTo()` already resets zoom to 1 and pan to (0,0) via `applyTransform()`, which sets `spreadRef.style.transform` directly. The slide animation must use a **wrapper div around `spreadRef`** rather than `spreadRef` itself, so the slide `translateX` and the zoom/pan `translate` don't collide on the same element. The wrapper handles the slide; `spreadRef` continues to handle zoom/pan as before.
- **Direction tracking:** New `directionRef = useRef<"left"|"right">("right")`, set by `prevSpread()`/`nextSpread()` before calling `goTo()`.
- **Wheel cooldown:** Existing 300ms cooldown prevents rapid-fire page turns. The 200ms animation completes within that window — no conflict.
- **Loading state:** If images haven't loaded when the animation fires, the slide shows a blank/loading spread, which is acceptable. The existing loading spinner continues to work.
- **Overflow:** The parent container already has `overflow: hidden`, so off-screen positioning won't cause scrollbars.
- **No changes to Reader.tsx navigation logic** — the animation is entirely contained within PageViewer.tsx (plus the settings plumbing).

## Settings

- **New setting:** `pageAnimation: boolean` in ThemeContext.tsx, default `true`
- **Persistence:** `localStorage` key `folio-page-animation`
- **UI:** Toggle in SettingsPanel.tsx under the **Page Layout** accordion group, alongside dual-page and manga mode toggles
- **Label:** "Page turn animation"
- **i18n:** Add `settings.pageAnimation` key in EN (`en.json`) and FR (`fr.json`)
- **Prop:** PageViewer receives `pageAnimation` from Reader.tsx. When `false`, `goTo()` skips animation — instant page change as today.

## Files Changed

| File | Change |
|------|--------|
| `src/components/PageViewer.tsx` | Animation logic in `goTo()`, `directionRef`, transition class management |
| `src/context/ThemeContext.tsx` | Add `pageAnimation` state + localStorage persistence |
| `src/components/SettingsPanel.tsx` | Toggle under Page Layout accordion |
| `src/screens/Reader.tsx` | Pass `pageAnimation` prop to PageViewer |
| `src/locales/en.json` | Add `settings.pageAnimation` translation key |
| `src/locales/fr.json` | Add `settings.pageAnimation` translation key |
