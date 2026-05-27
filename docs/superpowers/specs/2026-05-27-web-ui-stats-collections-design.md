# Web UI Reading Stats & Collections Browser

**Date:** 2026-05-27
**Status:** Design — pending implementation
**Author:** Mike
**Research:** F-1-3 from research team report (2026-05-25)

## Problem

Folio's web server provides remote access to the library, but the web UI
only supports browsing books, reading, and downloading. Reading stats and
collections — both prominent features in the desktop app — are absent from
the web interface. Users accessing their library remotely cannot see their
reading progress or browse by collection, making the web experience feel
incomplete compared to desktop.

## Goal

Add two new views to the web UI:

1. **Reading Stats** — mirrors the desktop ReadingStats modal: time read,
   sessions, pages, books finished, current/longest streak, and a 30-day
   daily reading bar chart.
2. **Collections Browser** — dedicated page listing all collections (with
   icons, colors, type badges, book counts) and series. Filter by name,
   sort A-Z/Z-A. Click navigates to library with that collection/series
   pre-filtered.

Both views are read-only. No creating, editing, or deleting collections
from the web UI.

## Decisions

- **Extend existing `app.js` SPA** — no new dependencies, no build step,
  same vanilla JS patterns. Adds ~200-250 lines.
- **Header icon navigation** — folder icon (collections) and bar chart
  icon (stats) added to header, visible on all views. Accent-colored when
  active.
- **Read-only** — web UI displays data; all mutations happen in desktop.
- **`book_count` in collection list** — extend `GET /api/collections`
  response to include book count per collection, avoiding N+1 fetches.
- **Client-side filter/sort** — collections page filters and sorts
  locally. No server-side query params needed (collection count is small).

## Architecture

### New backend

| Change | File | Detail |
|--------|------|--------|
| New endpoint | `src-tauri/src/web_server/api.rs` | `GET /api/stats` — calls `db::get_reading_stats()`, returns JSON |
| Extend endpoint | `src-tauri/src/web_server/api.rs` | `GET /api/collections` — add `book_count` field to each collection |
| New DB query | `folio-core/src/db.rs` | `get_collection_book_counts()` — `SELECT collection_id, COUNT(*) ...` |

#### `GET /api/stats` response

```json
{
  "total_reading_time_secs": 45240,
  "total_sessions": 47,
  "total_pages_read": 1248,
  "books_finished": 8,
  "current_streak_days": 5,
  "longest_streak_days": 14,
  "daily_reading": [
    ["2026-04-28", 1800],
    ["2026-04-29", 3600]
  ]
}
```

Fields match the existing `ReadingStats` struct in `folio-core/src/db.rs`.
Snake_case serialization consistent with existing web API responses.

#### Extended collection response

Each collection object gains a `book_count` integer field. For manual
collections, count via `SELECT COUNT(*) FROM book_collections WHERE
collection_id = ?`. For automated collections, reuse
`get_books_in_collection_grid()` and take `.len()` — automated
collections evaluate dynamic rules that can't be reduced to a simple
COUNT query. Collection counts are small (typically <50), so the overhead
is acceptable. The counts are computed in `list_collections_with_counts()`
in `api.rs`, wrapping the existing `db::list_collections()` call.

### New frontend

| Change | File | Detail |
|--------|------|--------|
| New route | `app.js` | `#/stats` → `showStats()` |
| New route | `app.js` | `#/collections` → `showCollections()` |
| Header update | `app.js` | Add nav icons to all header renders |
| New helper | `app.js` | `formatDuration(secs)` — converts seconds to "Xh Ym" display |
| New CSS | `app.css` | Stats cards, chart bars, collection rows, toolbar |

#### New hash routes

| Route | View | Data |
|-------|------|------|
| `#/stats` | Reading stats | `GET /api/stats` |
| `#/collections` | Collections browser | `GET /api/collections` + `GET /api/series` |

#### Router changes

Add to the `route()` function:

```
#/stats        → showStats()
#/collections  → showCollections()
```

These are checked before the existing `#/book/` patterns.

### Stats page (`showStats`)

**Layout:**
- Header with back arrow, "Reading Stats" title, nav icons (chart highlighted)
- 6 stat cards in 2-column responsive grid:
  - Time Reading, Sessions, Pages Read, Books Finished, Current Streak, Longest Streak
- 30-day bar chart below stat cards
- Empty state when no reading data

**Stat cards:** Use `var(--card-bg)` background, 12px border-radius.
Large value top, small uppercase label bottom. Current streak value uses
`var(--accent)` color.

**Bar chart:** 30 flex bars (one per day), height normalized to daily max.
Min height 4% for days with any reading. `var(--accent)` at 70% opacity,
full opacity on hover. Each bar has `title` attribute showing date and
formatted duration.

**Duration formatting:** `formatDuration(secs)` returns:
- Under 1 minute: "< 1m"
- Under 1 hour: "Xm"
- 1 hour+: "Xh Ym"

**Empty state:** Centered message: "No reading stats yet. Start reading
on the desktop app to see your progress here."

### Collections page (`showCollections`)

**Layout:**
- Header with back arrow, "Collections" title, nav icons (folder highlighted)
- Toolbar: filter input + A→Z/Z→A sort toggle button
- Two sections: "Collections (N)" and "Series (N)"
- Each section is a vertical list of rows
- Empty state when no collections or series exist

**Collection rows:** Card-bg background, 8px radius, 1px border. Contains:
- Emoji icon (from collection `icon` field, or default folder emoji)
- Color swatch (8x8px, rounded, from collection `color` field — hidden if null)
- Name (bold)
- Type subtitle: "Manual collection" or green dot + "Auto-collection"
- Book count pill (right side)
- Chevron indicator

**Series rows:** Same layout but with book SVG icon instead of emoji.
No type badge. Name + book count.

**Filter:** Debounced 200ms, filters both sections by name
(case-insensitive). Sections hide entirely when zero matches. Section
header counts update to reflect filtered results.

**Sort:** Toggle button cycles A→Z / Z→A. Button label updates. Sorts
collections and series independently within their sections. Default: A→Z.

**Click behavior:** Clicking a collection row navigates to `#/` and sets
`activeCollectionId` to that collection's ID. Clicking a series row
navigates to `#/` and sets `activeSeries` to that series name. Both
reuse existing `showLibrary()` + `refreshLibrary()` logic.

### Header navigation

All views that render a header get two icon buttons right of the sort
dropdown (or right-aligned on views without search/sort):

- **Folder icon** — navigates to `#/collections`. Colored `var(--accent)`
  when on collections page, `var(--fg)` otherwise.
- **Chart icon** — navigates to `#/stats`. Colored `var(--accent)` when on
  stats page, `var(--fg)` otherwise.

Icons use inline SVG (Lucide icon set, matching desktop). 20x20px,
stroke-width 2. Wrapped in `<button>` with `title` attribute for a11y.

On library view: icons appear after the sort dropdown.
On detail/reader/stats/collections views: icons appear right-aligned
after the title.

### New CSS

```
.stats            — max-width container, centered, padding
.stat-cards       — 2-column grid, 12px gap
.stat-card        — card-bg, rounded-xl, centered text
.stat-value       — large font, semibold, tabular-nums
.stat-label       — tiny uppercase, muted color
.stat-chart       — flex row, items-end, 80px height, 2px gap
.stat-bar         — flex-1, accent color, rounded-top, hover state
.collections-toolbar — flex row, filter input + sort button
.collection-row   — card-bg row, flex, hover border highlight
.collection-icon  — 1.2rem emoji
.collection-color — 8x8 swatch
.collection-count — pill badge
.nav-icons        — flex row, gap-8, icon buttons
.nav-icon         — ghost button, 20x20 SVG
.nav-icon.active  — accent color
```

Mobile responsive: stat cards stay 2-column down to 320px. Collection
rows stack naturally (already full-width).

## Scope

**In scope:**
- `GET /api/stats` endpoint
- `book_count` on collection list response
- Stats page with 6 cards + 30-day chart
- Collections page with filter + sort
- Header nav icons on all views
- Empty states for both pages
- Mobile responsive

**Out of scope:**
- Collection CRUD from web
- Reading progress tracking from web
- Per-book stats breakdown
- Export/share stats
- Persisting filter/sort state across page loads

## Testing

- Rust: unit test for `/api/stats` endpoint (mock DB with reading sessions)
- Rust: unit test for collection `book_count` in list response
- Frontend: Playwright test — navigate to `#/stats`, verify stat cards render
- Frontend: Playwright test — navigate to `#/collections`, verify collection rows render, test filter input, test sort toggle
- Frontend: Playwright test — click collection row, verify library filters to that collection
