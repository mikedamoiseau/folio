# Series Stacked View

Add a "Stacked" display mode to the Series sort view. Each series renders as a single tile — first book's cover with offset covers behind it, series name + count below. Clicking drills into the series; back restores scroll position.

## Current State

When `sortBy === "series"`, Library.tsx groups books under collapsible series headers. Each series shows all its books in the grid with a header row containing the series name, book count, and a collapse chevron. This is the "Expanded" mode.

## Feature: Stacked Mode

### Toggle

A two-segment pill appears at the right end of the sort bar, only when `sortBy === "series"` AND `activeSeries` is null (not drilled in):

```
[ Stacked | Expanded ]
```

- Active segment: accent background, white text.
- Inactive segment: muted background, muted text.
- Inserted after the sort button `.map()` in the sort bar flex row (Library.tsx ~line 888), with `ml-auto` to push it to the right edge.
- State persisted to `localStorage` key `folio-series-view-mode` (values: `"stacked"` | `"expanded"`).
- Default: `"expanded"` (preserves current behavior for existing users).
- Hidden when drilled into a series (`activeSeries` is set) — the stacked/expanded distinction doesn't apply to a single-series book list.

### SeriesStackCard Component

New component `src/components/SeriesStackCard.tsx` rendered in place of the series header + book grid when stacked mode is active.

**Layout:** Same 160px width as BookCard. Cover area uses the same 2:3 aspect ratio (`aspect-[2/3]`, `bg-warm-subtle`, `overflow-hidden`).

**Stack visual:**
- Front card (z-2): first book's cover image (sorted by volume, lowest first). Full size, same rendering as BookCard cover (`object-cover`) with fallback spine.
- Middle card (z-1): offset +4px down, +4px right from front. Opacity 0.5. Uses second book's actual cover.
- Back card (z-0): offset +8px down, +8px right from front. Opacity 0.3. Uses third book's actual cover.
- All cover images use `loading="lazy"` for off-screen stacks.
- Series with 2 books: show 1 background card only.
- Series with 3+ books: show 2 background cards.
- Shadow on front card: `0 2px 6px rgba(0,0,0,0.15)`.
- Only series with 2+ books appear as stacks (matches `list_series` backend `HAVING count >= 2`). Single-book series fall into the "Other" section as regular BookCards.

**Below cover:**
- Series name: same text style as BookCard title (`text-sm font-medium`), truncated with `title` attribute for full name.
- Book count: `text-xs text-ink-muted`, e.g., "9 books".
- No author, no progress bar, no metadata pills, no rating.

**Interaction:**
- Hover: same 1.02x scale transition as BookCard (`group-hover:scale-[1.02]`).
- Click: triggers drill-in (see below).
- No context menu, no action buttons on hover.

**Non-series books:** Rendered as normal BookCards after all series stacks, under an "Other" separator (same as current expanded mode).

### Drill-In: Filter-in-Place

Clicking a series stack filters the grid to that series only:

1. **Save scroll position** to a React ref (`scrollBeforeDrillRef`). Read from the content area div (needs a new `contentRef` on the `overflow-y-auto` container at Library.tsx ~line 910).
2. **Set `activeSeries` directly** (not via `handleSelectSeries` — avoids clearing collection state and forcing sort, which are already correct in stacked mode).
3. **Render back bar** above the grid: reuses the existing series header style (uppercase name, book count, full-width separator) with a `←` arrow prepended. Clickable.
4. **Grid content:** Individual BookCards for that series, sorted by volume then title. Standard BookCard behavior (click opens reader, hover shows action buttons).
5. **Back action:** Click the back bar or press Escape → clear `activeSeries`, restore `contentRef.current.scrollTop` from `scrollBeforeDrillRef.current`.
6. **Escape priority:** shortcuts modal → highlight search → **drill-in** → collections sidebar → edit dialog.

### State

| State | Type | Storage | Default |
|-------|------|---------|---------|
| `seriesViewMode` | `"stacked" \| "expanded"` | localStorage `folio-series-view-mode` | `"expanded"` |
| `scrollBeforeDrillRef` | `React.MutableRefObject<number>` | ref (session only) | `0` |
| `contentRef` | `React.RefObject<HTMLDivElement>` | ref | — |
| `activeSeries` | `string \| null` | existing React state | `null` |

### i18n

**English (`en.json`):**
```json
"seriesView": {
  "stacked": "Stacked",
  "expanded": "Expanded",
  "backToLibrary": "← {{name}}",
  "bookCount": "{{count}} books",
  "bookCountSingular": "1 book"
}
```

**French (`fr.json`):**
```json
"seriesView": {
  "stacked": "Empilé",
  "expanded": "Étendu",
  "backToLibrary": "← {{name}}",
  "bookCount": "{{count}} livres",
  "bookCountSingular": "1 livre"
}
```

### Data Flow

No backend changes. The frontend already has all necessary data:
- `books` array contains `series` and `volume` fields on every `BookGridItem`.
- `seriesList` (from `get_series` command) provides series names and counts (2+ books only).
- Cover paths are on each book's `coverPath` field.

The stacked view groups books client-side the same way expanded mode does (Library.tsx lines 1091-1104), but renders `SeriesStackCard` instead of individual `BookCard`s.

### Rendering Logic (Library.tsx)

When `sortBy === "series"` and `seriesViewMode === "stacked"` and `activeSeries` is null:

```
for each series in grouped series (2+ books):
  render SeriesStackCard(series name, first 3 books by volume, total count, onClick → drill in)
render "Other" separator if non-series books exist
for each non-series book:
  render BookCard
```

When `activeSeries` is set (drilled in, regardless of seriesViewMode):
```
render back bar (← Series Name, book count) — existing header style + arrow
for each book in activeSeries:
  render BookCard (sorted by volume)
```

When `sortBy === "series"` and `seriesViewMode === "expanded"`:
```
current behavior unchanged
```

### Out of Scope

- No backend changes
- No virtual scrolling changes
- No series metadata editing from stacked view
- No drag-and-drop between stacks
- No animation on drill-in/back transitions (can add later)
- No keyboard navigation between stacks (Tab works via existing grid focus)
- No single-book series stacks (matches existing 2+ threshold)
