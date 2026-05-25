# Series Stacked View

Add a "Stacked" display mode to the Series sort view. Each series renders as a single tile — first book's cover with offset covers behind it, series name + count below. Clicking drills into the series; back restores scroll position.

## Current State

When `sortBy === "series"`, Library.tsx groups books under collapsible series headers. Each series shows all its books in the grid with a header row containing the series name, book count, and a collapse chevron. This is the "Expanded" mode.

## Feature: Stacked Mode

### Toggle

A two-segment pill appears at the right end of the sort bar, only when `sortBy === "series"`:

```
[ Stacked | Expanded ]
```

- Active segment: accent background, white text.
- Inactive segment: muted background, muted text.
- State persisted to `localStorage` key `folio-series-view-mode` (values: `"stacked"` | `"expanded"`).
- Default: `"expanded"` (preserves current behavior for existing users).

### SeriesStackCard Component

New component `src/components/SeriesStackCard.tsx` rendered in place of the series header + book grid when stacked mode is active.

**Layout:** Same 160px width as BookCard. Cover area uses the same 2:3 aspect ratio (160×240).

**Stack visual:**
- Front card (z-2): first book's cover image (sorted by volume, lowest first). Full size, same rendering as BookCard cover with fallback spine.
- Middle card (z-1): offset +4px down, +4px right from front. Opacity 0.5. Uses second book's cover if available, else muted placeholder.
- Back card (z-0): offset +8px down, +8px right from front. Opacity 0.3. Uses third book's cover if available, else muted placeholder.
- Series with only 1 book: show 1 background card only.
- Series with 2 books: show 1 background card only.
- Series with 3+ books: show 2 background cards.
- Shadow on front card: `0 2px 6px rgba(0,0,0,0.15)`.

**Below cover:**
- Series name: same text style as BookCard title (`text-sm font-medium`), truncated with `title` attribute for full name.
- Book count: `text-xs text-ink-muted`, e.g., "9 books".
- No author, no progress bar, no metadata pills, no rating.

**Interaction:**
- Hover: same 1.02x scale transition as BookCard.
- Click: triggers drill-in (see below).
- No context menu, no action buttons on hover.

**Non-series books:** Rendered as normal BookCards after all series stacks, under an "Other" separator (same as current expanded mode).

### Drill-In: Filter-in-Place

Clicking a series stack filters the grid to that series only:

1. **Save scroll position** to a React ref (`scrollBeforeDrillRef`) before changing state.
2. **Set `activeSeries`** to the clicked series name. This reuses the existing `activeSeries` state and filtering logic already used by the Collections sidebar (Library.tsx lines 474-476).
3. **Render back bar** above the grid: a full-width bar with `← {Series Name}` (clickable) and book count on the right. Styled like the existing series header but with a back arrow.
4. **Grid content:** Individual BookCards for that series, sorted by volume then title. Standard BookCard behavior (click opens reader, hover shows action buttons).
5. **Back action:** Click the back bar or press Escape → clear `activeSeries`, scroll to `scrollBeforeDrillRef.current`.

### State

| State | Type | Storage | Default |
|-------|------|---------|---------|
| `seriesViewMode` | `"stacked" \| "expanded"` | localStorage `folio-series-view-mode` | `"expanded"` |
| `scrollBeforeDrillRef` | `React.MutableRefObject<number>` | ref (session only) | `0` |
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
- `seriesList` (from `get_series` command) provides series names and counts.
- Cover paths are on each book's `coverPath` field.

The stacked view groups books client-side the same way expanded mode does (Library.tsx lines 1091-1104), but renders `SeriesStackCard` instead of individual `BookCard`s.

### Rendering Logic (Library.tsx)

When `sortBy === "series"` and `seriesViewMode === "stacked"` and `activeSeries` is null:

```
for each series in grouped series:
  render SeriesStackCard(series name, first 3 books, total count, onClick → drill in)
render "Other" separator if non-series books exist
for each non-series book:
  render BookCard
```

When `activeSeries` is set (drilled in):
```
render back bar with series name
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
