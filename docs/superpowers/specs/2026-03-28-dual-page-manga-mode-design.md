# Dual-Page Spread / Manga Mode — Design Spec

**Date:** 2026-03-28
**Roadmap item:** #38
**Status:** Approved

## Goal

Add a dual-page spread view for all formats (CBZ, CBR, PDF, EPUB) with an optional right-to-left page order for manga reading. Togglable from both the reader bar and settings panel as a global preference.

## Scope

**In scope:**
- Two-page spread for page-image formats (PDF, CBZ, CBR)
- Two-column layout for EPUB in paginated mode
- Manga mode: swap left/right page order within a spread
- Quick toggle in reader bar + persistent toggle in SettingsPanel
- Cover-solo pairing: page 1 always solo, then 2-3, 4-5, etc.

**Out of scope (future):**
- Preloading next spread in background (noted in roadmap)
- Auto-detection of landscape/wide images for solo display (noted in roadmap)
- Per-book or per-format settings (global only for v1)
- Keyboard shortcuts for toggling (can add later)

## Data Model & Settings

No database changes. Two new localStorage keys via ThemeContext:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `folio-dual-page` | `boolean` | `false` | Show two pages side by side |
| `folio-manga-mode` | `boolean` | `false` | Swap page order in spread (RTL) |

Both managed in ThemeContext alongside existing reader preferences (`scrollMode`, `typography`, etc.).

### Spread Pairing Logic

All formats use the same deterministic pairing:

- Page 1 (index 0): always solo (cover)
- Pages 2-3 (indices 1-2), 4-5 (indices 3-4), 6-7 (indices 5-6)... paired
- Last page solo if odd total count
- Given a page index, its spread: `spreadIndex = pageIndex === 0 ? 0 : Math.ceil(pageIndex / 2)`
- Left page of spread N (N > 0): `pageIndex = (N * 2) - 1`
- Right page of spread N (N > 0): `pageIndex = N * 2`
- Manga mode: swap left and right within each spread

## PageViewer Changes (CBZ/CBR/PDF)

### Layout

- Container switches from single centered `<img>` to a flex row with two image slots
- Each slot loads its page independently via existing `get_pdf_page` / `get_comic_page` IPC commands
- Manga mode applies `flex-direction: row-reverse` (or swaps slot contents)
- Solo pages (cover, last odd page) center at full container width

### Navigation

- Page turn advances by 2 (to the next spread) instead of 1
- Arrow keys, scroll wheel, and prev/next buttons all advance by spread
- Progress tracking stores the left page's index (lower number) in `chapterIndex`
- Bookmarks navigate to the spread containing the bookmarked page

### Zoom & Pan

- Zoom/pan applies to the spread container, not individual images
- Both images scale together as a unit via CSS transform on the parent
- Same zoom range (0.5x–4x) and interaction model as current single-page

### Loading

- Both pages fetched in parallel (two concurrent `invoke` calls)
- Spread renders once both images resolve
- If one page is ready before the other, show it + spinner for the pending one

## EPUB Changes

### Paginated Mode

- Apply CSS `columns: 2` with appropriate `column-gap` on the paginated content container
- Each page turn advances by 2 columns of content
- Browser handles text reflow natively

### Manga Mode (RTL)

- Set `direction: rtl` on the column container
- Text flows right column first, then left — standard CSS RTL column behavior

### Continuous Scroll Mode

- Dual-page is disabled/hidden when continuous scroll is active
- The toggle button does not appear in scroll mode

### Unchanged Behavior

- Highlights, text search, bookmarks all work as before (underlying HTML is identical)
- Reading progress still tracks chapter index + scroll position

## UI Controls

### Reader Bottom Bar (Quick Toggle)

- New icon button: "book spread" icon (two rectangles side by side)
- Click toggles dual-page on/off
- When dual-page is active, second button appears: manga/RTL icon
- Both buttons show active/inactive visual state (e.g., highlighted background)
- Hidden when EPUB is in continuous scroll mode

### SettingsPanel

- New section or subsection in existing reader settings area: "Reading Layout"
- Toggle: "Dual-page spread" — with brief description
- Toggle: "Manga mode (right-to-left)" — visually disabled when dual-page is off
- Same state as quick-toggle buttons (shared via ThemeContext)

## Edge Cases

| Case | Behavior |
|------|----------|
| Single-page book | Displays solo, dual-page toggle has no effect |
| Cover page | Always solo, centered |
| Last page (odd total) | Displays solo, centered |
| Bookmark on right page of spread | Navigate to the spread, both pages visible |
| Window too narrow | Consider falling back to single page (responsive breakpoint TBD during implementation) |
| Dual-page toggled mid-read | Recalculate current spread from current page index, no progress loss |
| EPUB continuous scroll + dual-page | Dual-page toggle hidden/disabled |
