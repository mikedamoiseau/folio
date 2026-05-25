# Series Stacked View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Stacked" display mode to the Series sort view — each series renders as a single tile with offset covers behind it, clicking drills in with scroll-position restore on back.

**Architecture:** New `SeriesStackCard` component renders the stacked tile. Library.tsx gains a `seriesViewMode` state toggle (pill in sort bar) and a `contentRef` for scroll restore. Drill-in reuses existing `activeSeries` filter. No backend changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, i18next, Vitest

**Spec:** `docs/superpowers/specs/2026-05-25-series-stacked-view-design.md`

---

### Task 1: SeriesStackCard Component

**Files:**
- Create: `src/components/SeriesStackCard.tsx`
- Create: `src/components/SeriesStackCard.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
// src/components/SeriesStackCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SeriesStackCard from "./SeriesStackCard";

const mockBooks = [
  { id: "b1", coverSrc: "cover1.jpg" },
  { id: "b2", coverSrc: "cover2.jpg" },
  { id: "b3", coverSrc: "cover3.jpg" },
];

describe("SeriesStackCard", () => {
  it("renders series name and book count", () => {
    render(
      <SeriesStackCard
        seriesName="Achille Talon"
        bookCount={9}
        covers={mockBooks}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText("Achille Talon")).toBeDefined();
    expect(screen.getByText("9 books")).toBeDefined();
  });

  it("renders singular count for 2 books", () => {
    render(
      <SeriesStackCard
        seriesName="Test"
        bookCount={2}
        covers={mockBooks.slice(0, 2)}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText("2 books")).toBeDefined();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      <SeriesStackCard
        seriesName="Test"
        bookCount={3}
        covers={mockBooks}
        onClick={onClick}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders correct number of background cards for 2 covers", () => {
    const { container } = render(
      <SeriesStackCard
        seriesName="Test"
        bookCount={2}
        covers={mockBooks.slice(0, 2)}
        onClick={vi.fn()}
      />
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(2);
  });

  it("renders correct number of background cards for 3+ covers", () => {
    const { container } = render(
      <SeriesStackCard
        seriesName="Test"
        bookCount={5}
        covers={mockBooks}
        onClick={vi.fn()}
      />
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(3);
  });

  it("shows full series name in title attribute", () => {
    render(
      <SeriesStackCard
        seriesName="A Very Long Series Name That Gets Truncated"
        bookCount={3}
        covers={mockBooks}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTitle("A Very Long Series Name That Gets Truncated")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --run src/components/SeriesStackCard.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the SeriesStackCard component**

```tsx
// src/components/SeriesStackCard.tsx
import { useTranslation } from "react-i18next";

interface SeriesStackCover {
  id: string;
  coverSrc: string | null;
}

interface SeriesStackCardProps {
  seriesName: string;
  bookCount: number;
  covers: SeriesStackCover[];
  onClick: () => void;
}

export default function SeriesStackCard({
  seriesName,
  bookCount,
  covers,
  onClick,
}: SeriesStackCardProps) {
  const { t } = useTranslation();
  const backCards = covers.slice(1, 3);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left group cursor-pointer"
      title={seriesName}
    >
      <div className="relative" style={{ padding: "8px 8px 0 0" }}>
        {/* Background cards — rendered first so they sit behind */}
        {backCards.map((book, i) => {
          const offset = (i + 1) * 4;
          return (
            <div
              key={book.id}
              className="absolute rounded-lg overflow-hidden bg-warm-subtle"
              style={{
                top: offset,
                left: offset,
                right: -offset,
                bottom: -offset,
                opacity: i === 0 ? 0.5 : 0.3,
                zIndex: 0,
              }}
            >
              {book.coverSrc && (
                <img
                  src={book.coverSrc}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              )}
            </div>
          );
        })}
        {/* Front card */}
        <div
          className="relative aspect-[2/3] bg-warm-subtle overflow-hidden rounded-lg transition-transform duration-300 group-hover:scale-[1.02]"
          style={{
            zIndex: 2,
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
          }}
        >
          {covers[0]?.coverSrc ? (
            <img
              src={covers[0].coverSrc}
              alt={seriesName}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex items-center justify-center w-full h-full">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ink-muted/30">
                <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      </div>
      {/* Series info */}
      <div className="mt-2 px-0.5">
        <p className="text-sm font-medium text-ink truncate" title={seriesName}>
          {seriesName}
        </p>
        <p className="text-xs text-ink-muted">
          {t("seriesView.bookCount", { count: bookCount })}
        </p>
      </div>
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- --run src/components/SeriesStackCard.test.tsx`
Expected: 6 tests PASS

- [ ] **Step 5: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/SeriesStackCard.tsx src/components/SeriesStackCard.test.tsx
git commit -m "feat(library): add SeriesStackCard component

Stacked tile showing first book cover with offset background cards,
series name and book count below. Supports 2- and 3+-cover variants."
```

---

### Task 2: i18n Keys

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English keys**

Add after the `"highlightSearch"` block in `src/locales/en.json`:

```json
"seriesView": {
  "stacked": "Stacked",
  "expanded": "Expanded",
  "backToLibrary": "← {{name}}",
  "bookCount": "{{count}} books"
},
```

- [ ] **Step 2: Add French keys**

Add after the `"highlightSearch"` block in `src/locales/fr.json`:

```json
"seriesView": {
  "stacked": "Empilé",
  "expanded": "Étendu",
  "backToLibrary": "← {{name}}",
  "bookCount": "{{count}} livres"
},
```

- [ ] **Step 3: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS (i18n keys don't break anything until used)

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add series stacked view translation keys (EN + FR)"
```

---

### Task 3: Library.tsx — State, Toggle, and Content Ref

**Files:**
- Modify: `src/screens/Library.tsx`

This task adds the state, pill toggle, contentRef, and scroll ref — but does NOT change the grid rendering yet.

- [ ] **Step 1: Add state and refs**

At the top of the `Library` component, near the existing `collapsedSeries` state (line ~113), add:

```tsx
const [seriesViewMode, setSeriesViewMode] = useState<"stacked" | "expanded">(() => {
  const stored = localStorage.getItem("folio-series-view-mode");
  return stored === "stacked" ? "stacked" : "expanded";
});
const contentRef = useRef<HTMLDivElement>(null);
const scrollBeforeDrillRef = useRef(0);
```

Add a `useEffect` to persist `seriesViewMode`:

```tsx
useEffect(() => { localStorage.setItem("folio-series-view-mode", seriesViewMode); }, [seriesViewMode]);
```

- [ ] **Step 2: Attach contentRef to the scrollable container**

Find the content area div (className `"flex-1 overflow-y-auto p-6"`, ~line 910). Add the ref:

```tsx
<div ref={contentRef} className="flex-1 overflow-y-auto p-6">
```

- [ ] **Step 3: Add pill toggle to sort bar**

After the closing `})}` of the sort buttons `.map()` (end of the sort bar, before the closing `</div>`), add:

```tsx
{sortBy === "series" && !activeSeries && (
  <div className="ml-auto flex text-[11px] rounded-md overflow-hidden border border-warm-border">
    <button
      type="button"
      onClick={() => setSeriesViewMode("stacked")}
      className={`px-2.5 py-1 transition-colors ${
        seriesViewMode === "stacked"
          ? "bg-accent text-white"
          : "text-ink-muted hover:bg-warm-subtle"
      }`}
    >
      {t("seriesView.stacked")}
    </button>
    <button
      type="button"
      onClick={() => setSeriesViewMode("expanded")}
      className={`px-2.5 py-1 transition-colors ${
        seriesViewMode === "expanded"
          ? "bg-accent text-white"
          : "text-ink-muted hover:bg-warm-subtle"
      }`}
    >
      {t("seriesView.expanded")}
    </button>
  </div>
)}
```

- [ ] **Step 4: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(library): add series view mode state and pill toggle

Stacked/Expanded pill toggle appears in sort bar when Series sort
is active and not drilled in. Persisted to localStorage."
```

---

### Task 4: Library.tsx — Stacked Grid Rendering

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add SeriesStackCard import**

At the top of Library.tsx, add:

```tsx
import SeriesStackCard from "../components/SeriesStackCard";
```

Also add `convertFileSrc` usage awareness — it's already imported.

- [ ] **Step 2: Add stacked rendering branch**

Find the series rendering block (starts `{sortBy === "series" ? (`, ~line 1089). Inside the IIFE, after `sortedGroupNames` is computed, add a branch for stacked mode. The existing code renders series headers + books when expanded. Add the stacked branch before the existing expanded rendering:

```tsx
if (seriesViewMode === "stacked" && !activeSeries) {
  return (
    <>
      {sortedGroupNames.map((seriesName) => {
        const booksInSeries = groups[seriesName];
        const covers = booksInSeries.slice(0, 3).map((b) => ({
          id: b.id,
          coverSrc: b.cover_path ? convertFileSrc(b.cover_path) : null,
        }));
        return (
          <div key={seriesName} className="relative card-cv">
            <SeriesStackCard
              seriesName={seriesName}
              bookCount={booksInSeries.length}
              covers={covers}
              onClick={() => {
                scrollBeforeDrillRef.current = contentRef.current?.scrollTop ?? 0;
                setActiveSeries(seriesName);
              }}
            />
          </div>
        );
      })}
      {nonSeriesBooks.length > 0 && sortedGroupNames.length > 0 && (
        <button
          type="button"
          className="col-span-full flex items-center gap-2 pt-4 pb-2 text-left"
          onClick={() => setCollapsedSeries((prev) => {
            const next = new Set(prev);
            if (next.has("__other__")) next.delete("__other__");
            else next.add("__other__");
            return next;
          })}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={`text-ink-muted/50 transition-transform ${collapsedSeries.has("__other__") ? "" : "rotate-90"}`}>
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{t("library.otherBooks")}</span>
          <span className="text-[10px] text-ink-muted/50">{t("library.booksCount", { count: nonSeriesBooks.length })}</span>
          <div className="flex-1 border-t border-warm-border/50" />
        </button>
      )}
      {!collapsedSeries.has("__other__") && nonSeriesBooks.map((book) => (
        /* render BookCard same as existing non-series book rendering */
      ))}
    </>
  );
}
```

The non-series BookCard rendering inside the stacked branch must match the existing pattern exactly (same `<div key={book.id} className="relative card-cv">` wrapper with the same drag handlers, BookCard props, etc.). Copy from the existing non-series rendering block (~lines 1199-1232).

- [ ] **Step 3: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(library): render SeriesStackCard tiles in stacked mode

When series sort + stacked mode active, each series renders as a
single stacked tile. Non-series books render normally below."
```

---

### Task 5: Drill-In Back Bar and Scroll Restore

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add back bar when drilled in from stacked mode**

Find the section where `activeSeries` header is rendered (~line 1082-1088). The existing header shows the series name when drilled in from the sidebar. Modify it to show a back arrow when in stacked mode:

When `activeSeries` is set AND `seriesViewMode === "stacked"`, render a clickable back bar instead of the static header:

```tsx
{activeSeries && seriesViewMode === "stacked" && (
  <button
    type="button"
    className="col-span-full flex items-center gap-2 pt-4 pb-2 text-left"
    onClick={() => {
      setActiveSeries(null);
      requestAnimationFrame(() => {
        contentRef.current?.scrollTo({ top: scrollBeforeDrillRef.current });
      });
    }}
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-ink-muted/50">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
      {t("seriesView.backToLibrary", { name: activeSeries })}
    </span>
    <span className="text-[10px] text-ink-muted/50">
      {t("seriesView.bookCount", { count: filtered.length })}
    </span>
    <div className="flex-1 border-t border-warm-border/50" />
  </button>
)}
```

Keep the existing header for `activeSeries && seriesViewMode !== "stacked"` (sidebar-driven drill-in).

- [ ] **Step 2: Add Escape key handler for drill-in**

In the Escape key handler (~line 580), add drill-in close after `showShortcuts` and before `collectionsOpen`. Also add `highlightSearchOpen` if present, then `activeSeries`:

```tsx
} else if (e.key === "Escape") {
  if (showShortcuts) setShowShortcuts(false);
  else if (highlightSearchOpen) setHighlightSearchOpen(false);
  else if (activeSeries && seriesViewMode === "stacked") {
    setActiveSeries(null);
    requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: scrollBeforeDrillRef.current });
    });
  }
  else if (collectionsOpen) setCollectionsOpen(false);
  else if (editingBook) setEditingBook(null);
}
```

Update the `useEffect` dependency array to include `activeSeries`, `seriesViewMode`, and `highlightSearchOpen`.

- [ ] **Step 3: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(library): drill-in back bar with scroll restore

Clicking a stacked tile saves scroll position and drills in.
Back bar with arrow restores scroll. Escape closes drill-in."
```

---

### Task 6: Full Verification and UX Testing

**Files:** None (verification only)

- [ ] **Step 1: Run all verification gates**

```bash
# From src-tauri/
cargo fmt --check
cargo clippy -- -D warnings
cargo test

# From project root
npm run type-check
npm run test
```

Expected: All PASS

- [ ] **Step 2: Manual testing checklist**

Start the dev server: `npm run tauri dev`

Test these scenarios:
1. Sort by Series → pill toggle appears at right end of sort bar
2. Click "Stacked" → grid shows stacked tiles with offset covers
3. Hover a stack → 1.02x scale
4. Click a stack → drills in, shows back bar with `←`, books sorted by volume
5. Click back bar → returns to stacked view, scroll position restored
6. Press Escape while drilled in → same as clicking back
7. Switch to "Expanded" → current behavior unchanged
8. Non-series books appear below stacks under "Other" header
9. Reload app → seriesViewMode persisted from localStorage
10. Switch sort to "Title" → pill toggle disappears
11. Switch back to "Series" → pill toggle reappears with saved mode

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(library): address stacked view testing findings"
```
