# Series Grouping

## Overview

Group books by series in two complementary ways: a "Series" section in the sidebar for quick navigation, and a "Series" sort option in the library grid that visually groups books under series headers. Uses existing `series` and `volume` columns on the books table — no schema changes needed.

## Sidebar: Series Section

A new "Series" heading appears in the sidebar, below the collections list, separated by a divider.

### Data source

Auto-populated from books: query all distinct `series` values where `series IS NOT NULL`, with a count of books per series. Only series with **2 or more books** are shown.

### Display

Each series row shows the series name and a book count badge. Rows are sorted alphabetically by series name.

### Interaction

- Click a series → filters the library grid to books in that series, sorted by volume number (then title as fallback for books without a volume)
- Click "All Books" → clears both series and collection filters
- Series selection and collection selection are **mutually exclusive**: clicking a series deselects any active collection, and clicking a collection deselects any active series

### Backend

New DB function: `list_series(conn) -> Result<Vec<SeriesInfo>>` where `SeriesInfo { name: String, count: i64 }`. Query: `SELECT series, COUNT(*) as count FROM books WHERE series IS NOT NULL GROUP BY series HAVING count >= 2 ORDER BY series ASC`.

New Tauri command: `get_series()` — calls `list_series` and returns the result.

New struct in models.rs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesInfo {
    pub name: String,
    pub count: i64,
}
```

## Library Grid: Group by Series

### Sort option

Add **"Series"** to the existing sort dropdown (alongside Date added, Title, Author, Progress, Rating).

### Grouping behavior

When "Series" sort is active:

1. **Series groups first**: Books with a `series` value are grouped together. Each group gets a text header row spanning the grid showing the series name and book count.
2. **Within each group**: Books sorted by `volume` number ascending. Books without a volume number fall back to title sort.
3. **Groups sorted alphabetically** by series name.
4. **Non-series books after**: Books with no series value appear after all series groups, sorted by title.

### Header rendering

Series headers are simple text divider rows that span the full width of the book grid. Not collapsible — just a visual separator with the series name and count.

### Filters still apply

All existing filters (format, status, rating, search) apply on top of the grouping. If a filter removes all books from a series group, that group header is not shown.

## Scope Exclusions

- No enrichment changes (series extraction from OpenLibrary/Google Books is a separate future item — added to roadmap)
- No new DB schema (uses existing `series` and `volume` columns)
- No collapsible/expandable series groups
- No series-specific cover art or icons
- No manual series assignment UI (users can already set series via the edit dialog)
