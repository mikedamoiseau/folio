# Dual-Page Spread / Manga Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dual-page spread view for all formats (CBZ, CBR, PDF, EPUB) with optional right-to-left manga mode, togglable from both the reader bar and settings panel.

**Architecture:** Two new boolean settings (`dualPage`, `mangaMode`) in ThemeContext persisted to localStorage. PageViewer renders two images side by side for page-based formats. EPUB paginated mode uses CSS `columns: 2`. Spread pairing logic (cover solo, then pairs) lives in a pure utility function. Quick-toggle buttons in the reader header bar, persistent toggles in SettingsPanel.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/lib/utils.ts` | `getSpreadPages()` pure function — spread pairing logic |
| `src/lib/utils.test.ts` | Tests for `getSpreadPages()` |
| `src/context/ThemeContext.tsx` | `dualPage` and `mangaMode` state + localStorage persistence |
| `src/components/PageViewer.tsx` | Dual-image layout, spread-aware navigation, zoom on container |
| `src/screens/Reader.tsx` | Pass `dualPage`/`mangaMode` to PageViewer, EPUB dual-column CSS, header toggle buttons |
| `src/components/SettingsPanel.tsx` | "Reading Layout" accordion with dual-page and manga mode toggles |

---

### Task 1: Add spread pairing utility with tests

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/lib/utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/utils.test.ts`:

```typescript
import {
  // ... existing imports ...
  getSpreadPages,
} from "./utils";

// ---------------------------------------------------------------------------
// getSpreadPages
// ---------------------------------------------------------------------------
describe("getSpreadPages", () => {
  it("returns cover page solo (index 0)", () => {
    expect(getSpreadPages(0, 10)).toEqual({ left: 0, right: null });
  });

  it("pairs pages after cover: 1-2, 3-4, etc.", () => {
    expect(getSpreadPages(1, 10)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(2, 10)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(3, 10)).toEqual({ left: 3, right: 4 });
    expect(getSpreadPages(4, 10)).toEqual({ left: 3, right: 4 });
  });

  it("returns last page solo when odd total", () => {
    // 7 pages: cover(0), 1-2, 3-4, 5-6 — 6 is last, totalPages=7
    expect(getSpreadPages(6, 7)).toEqual({ left: 5, right: 6 });
    // 6 pages: cover(0), 1-2, 3-4, 5 solo
    expect(getSpreadPages(5, 6)).toEqual({ left: 5, right: null });
  });

  it("handles single-page book", () => {
    expect(getSpreadPages(0, 1)).toEqual({ left: 0, right: null });
  });

  it("handles two-page book", () => {
    expect(getSpreadPages(0, 2)).toEqual({ left: 0, right: null });
    expect(getSpreadPages(1, 2)).toEqual({ left: 1, right: null });
  });

  it("handles three-page book", () => {
    expect(getSpreadPages(0, 3)).toEqual({ left: 0, right: null });
    expect(getSpreadPages(1, 3)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(2, 3)).toEqual({ left: 1, right: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --run`
Expected: FAIL — `getSpreadPages` is not exported from `./utils`

- [ ] **Step 3: Implement `getSpreadPages`**

Add to `src/lib/utils.ts`:

```typescript
/** Given a page index and total pages, return the left and right pages for a dual-page spread.
 *  Cover (index 0) is always solo. After that, pages pair as 1-2, 3-4, 5-6, etc.
 *  If the last page has no partner (odd total), it displays solo (right: null). */
export function getSpreadPages(
  pageIndex: number,
  totalPages: number,
): { left: number; right: number | null } {
  // Cover is always solo
  if (pageIndex === 0) return { left: 0, right: null };

  // Find the left page of the pair containing pageIndex
  // After cover: pairs are (1,2), (3,4), (5,6), ...
  // Left page of a pair is always odd-indexed
  const left = pageIndex % 2 === 1 ? pageIndex : pageIndex - 1;
  const right = left + 1;

  // If the right page is beyond total, it's solo
  if (right >= totalPages) return { left, right: null };

  return { left, right };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- --run`
Expected: All `getSpreadPages` tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "feat(dual-page): add getSpreadPages utility with tests"
```

---

### Task 2: Add dualPage and mangaMode to ThemeContext

**Files:**
- Modify: `src/context/ThemeContext.tsx`

- [ ] **Step 1: Add storage keys**

In the `STORAGE_KEYS` object in `src/context/ThemeContext.tsx`, add two new entries:

```typescript
const STORAGE_KEYS = {
  theme: "ebook-reader-theme",
  customColors: "ebook-reader-custom-colors",
  fontSize: "ebook-reader-font-size",
  fontFamily: "ebook-reader-font-family",
  scrollMode: "ebook-reader-scroll-mode",
  typography: "ebook-reader-typography",
  customCss: "ebook-reader-custom-css",
  dualPage: "ebook-reader-dual-page",
  mangaMode: "ebook-reader-manga-mode",
} as const;
```

- [ ] **Step 2: Extend ThemeContextValue interface**

Add to the `ThemeContextValue` interface:

```typescript
interface ThemeContextValue {
  // ... existing fields ...
  customCss: string;
  setCustomCss: (css: string) => void;
  dualPage: boolean;
  setDualPage: (enabled: boolean) => void;
  mangaMode: boolean;
  setMangaMode: (enabled: boolean) => void;
}
```

- [ ] **Step 3: Add state and setters in ThemeProvider**

Inside the `ThemeProvider` function, add state initialization after the `customCss` state:

```typescript
const [dualPage, setDualPageState] = useState(() => localStorage.getItem(STORAGE_KEYS.dualPage) === "true");
const [mangaMode, setMangaModeState] = useState(() => localStorage.getItem(STORAGE_KEYS.mangaMode) === "true");
```

Add setter callbacks after the `setCustomCss` callback:

```typescript
const setDualPage = useCallback((enabled: boolean) => {
  setDualPageState(enabled);
  localStorage.setItem(STORAGE_KEYS.dualPage, String(enabled));
}, []);

const setMangaMode = useCallback((enabled: boolean) => {
  setMangaModeState(enabled);
  localStorage.setItem(STORAGE_KEYS.mangaMode, String(enabled));
}, []);
```

- [ ] **Step 4: Add to context value**

In the `useMemo` call that builds the context `value`, add the new fields:

```typescript
const value = useMemo<ThemeContextValue>(() => ({
  // ... existing fields ...
  customCss, setCustomCss,
  dualPage, setDualPage,
  mangaMode, setMangaMode,
}), [mode, resolved, setMode, customColors, setCustomColors, fontSize, setFontSize, fontFamily, setFontFamily, scrollMode, setScrollMode, typography, setTypography, customCss, setCustomCss, dualPage, setDualPage, mangaMode, setMangaMode]);
```

- [ ] **Step 5: Run type-check**

Run: `npm run type-check`
Expected: PASS (no consumers use the new fields yet, so no breakage)

- [ ] **Step 6: Commit**

```bash
git add src/context/ThemeContext.tsx
git commit -m "feat(dual-page): add dualPage and mangaMode to ThemeContext"
```

---

### Task 3: Dual-page layout in PageViewer

**Files:**
- Modify: `src/components/PageViewer.tsx`

- [ ] **Step 1: Add props and imports**

Update the `PageViewerProps` interface and imports at the top of `src/components/PageViewer.tsx`:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSpreadPages } from "../lib/utils";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
  dualPage?: boolean;
  mangaMode?: boolean;
}
```

- [ ] **Step 2: Add dual-page state and loading logic**

Replace the existing state/loading section (lines 23–78) with spread-aware logic. The full updated component body from state declarations through `goTo`:

```typescript
export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
  dualPage = false,
  mangaMode = false,
}: PageViewerProps) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [leftImageData, setLeftImageData] = useState<string | null>(null);
  const [rightImageData, setRightImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);

  const spread = dualPage ? getSpreadPages(pageIndex, totalPages) : { left: pageIndex, right: null };

  // Apply transform directly to the DOM (no React re-render)
  const applyTransform = useCallback((z: number, p: { x: number; y: number }) => {
    if (spreadRef.current) {
      spreadRef.current.style.transform = `scale(${z}) translate(${p.x / z}px, ${p.y / z}px)`;
    }
  }, []);

  const loadPage = useCallback(
    async (index: number): Promise<string> => {
      const command = format === "pdf" ? "get_pdf_page" : "get_comic_page";
      const data = await invoke<string>(command, {
        bookId,
        pageIndex: index,
      });
      return data;
    },
    [bookId, format]
  );

  // Load spread (one or two pages in parallel)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadSpread = async () => {
      try {
        const promises: Promise<string>[] = [loadPage(spread.left)];
        if (spread.right !== null) {
          promises.push(loadPage(spread.right));
        }
        const results = await Promise.all(promises);
        if (cancelled) return;
        setLeftImageData(results[0]);
        setRightImageData(results.length > 1 ? results[1] : null);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadSpread();
    return () => { cancelled = true; };
  }, [spread.left, spread.right, loadPage]);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalPages) return;
      setPageIndex(index);
      onPageChange?.(index);
      // Reset zoom/pan on page change
      setZoom(1);
      panRef.current = { x: 0, y: 0 };
    },
    [totalPages, onPageChange]
  );

  // Navigate by spread: advance to next/prev spread's left page
  const prevSpread = useCallback(() => {
    if (dualPage) {
      if (spread.left <= 0) return;
      // Go to previous spread: if current is cover, nowhere to go.
      // If current left is 1 or 2, go to cover (0).
      // Otherwise go back 2 from current left.
      const prevLeft = spread.left <= 2 ? 0 : spread.left - 2;
      goTo(prevLeft);
    } else {
      goTo(pageIndex - 1);
    }
  }, [dualPage, spread.left, pageIndex, goTo]);

  const nextSpread = useCallback(() => {
    if (dualPage) {
      const nextLeft = spread.right !== null ? spread.right + 1 : spread.left + 1;
      if (nextLeft >= totalPages) return;
      goTo(nextLeft);
    } else {
      goTo(pageIndex + 1);
    }
  }, [dualPage, spread, pageIndex, totalPages, goTo]);

  const isAtStart = dualPage ? spread.left <= 0 : pageIndex <= 0;
  const isAtEnd = dualPage
    ? (spread.right !== null ? spread.right >= totalPages - 1 : spread.left >= totalPages - 1)
    : pageIndex >= totalPages - 1;
```

- [ ] **Step 3: Update zoom/pan handlers to use spreadRef**

The zoom callbacks remain the same. Update `handleMouseMove` to use `spreadRef` instead of `imgRef` — but since `applyTransform` already targets `spreadRef`, no changes needed to the zoom/pan callbacks themselves. Remove the old `imgRef` ref (no longer needed — zoom applies to `spreadRef`).

The keyboard, wheel, and mouse handlers stay the same except replace `prevPage`/`nextPage` with `prevSpread`/`nextSpread`:

```typescript
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100));
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100);
      if (next <= 1) {
        panRef.current = { x: 0, y: 0 };
        applyTransform(next, panRef.current);
      }
      return next;
    });
  }, [applyTransform]);
  const zoomReset = useCallback(() => {
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    applyTransform(1, panRef.current);
  }, [applyTransform]);

  // Keyboard: arrows for pages, +/- for zoom
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "ArrowLeft") prevSpread();
      else if (e.key === "ArrowRight") nextSpread();
      else if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomReset();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevSpread, nextSpread, zoomIn, zoomOut, zoomReset]);

  // Mouse wheel: Ctrl+scroll = zoom, plain scroll = page nav
  const wheelCooldown = useRef(false);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }
      if (zoom > 1) return;
      if (wheelCooldown.current || loading) return;
      if (Math.abs(e.deltaY) < 10) return;
      wheelCooldown.current = true;
      if (e.deltaY > 0) nextSpread();
      else prevSpread();
      setTimeout(() => { wheelCooldown.current = false; }, 300);
    },
    [nextSpread, prevSpread, loading, zoomIn, zoomOut, zoom]
  );

  // Pan with mouse drag when zoomed in
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };
      panOffset.current = { ...panRef.current };
    },
    [zoom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      panRef.current = {
        x: panOffset.current.x + dx,
        y: panOffset.current.y + dy,
      };
      applyTransform(zoom, panRef.current);
    },
    [zoom, applyTransform]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const isZoomed = zoom !== 1;
```

- [ ] **Step 4: Update the JSX render**

Replace the entire `return (...)` block with dual-page-aware rendering:

```tsx
  // Page display label for navigation bar
  const pageLabel = dualPage && spread.right !== null
    ? `Pages ${spread.left + 1}–${spread.right + 1} / ${totalPages}`
    : `Page ${spread.left + 1} / ${totalPages}`;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-paper">
      {/* Page image area */}
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center overflow-hidden px-4 py-4 ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {loading ? (
          <div className="text-sm text-ink-muted">Loading page…</div>
        ) : error ? (
          <div className="text-sm text-red-500 text-center max-w-sm">
            Failed to load page: {error}
          </div>
        ) : (
          <div
            ref={spreadRef}
            className={`flex items-center justify-center gap-1 max-h-full will-change-transform ${mangaMode && dualPage ? "flex-row-reverse" : "flex-row"}`}
            style={{
              transform: `scale(${zoom}) translate(${panRef.current.x / zoom}px, ${panRef.current.y / zoom}px)`,
            }}
          >
            {leftImageData && (
              <img
                src={leftImageData}
                alt={`Page ${spread.left + 1} of ${totalPages}`}
                className="max-h-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                style={{ maxWidth: dualPage && rightImageData ? "50%" : "100%" }}
                draggable={false}
              />
            )}
            {rightImageData && (
              <img
                src={rightImageData}
                alt={`Page ${(spread.right ?? 0) + 1} of ${totalPages}`}
                className="max-h-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                style={{ maxWidth: "50%" }}
                draggable={false}
              />
            )}
          </div>
        )}
      </div>

      {/* Navigation bar */}
      <div className="shrink-0 border-t border-warm-border bg-surface px-5 py-3 flex items-center gap-3">
        <button
          onClick={prevSpread}
          disabled={isAtStart}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Prev
        </button>

        <span className="flex-1 text-center text-xs text-ink-muted tabular-nums">
          {pageLabel}
        </span>

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-xs text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors disabled:opacity-30"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomReset}
            className={`px-2 h-7 text-[11px] tabular-nums rounded-lg transition-colors ${isZoomed ? "text-accent bg-accent-light hover:bg-accent-light/80 font-medium" : "text-ink-muted bg-warm-subtle"}`}
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-xs text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors disabled:opacity-30"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <button
          onClick={nextSpread}
          disabled={isAtEnd}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          Next
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
```

- [ ] **Step 5: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/PageViewer.tsx
git commit -m "feat(dual-page): add dual-page spread layout to PageViewer"
```

---

### Task 4: Wire dual-page into Reader.tsx and add header toggle buttons

**Files:**
- Modify: `src/screens/Reader.tsx`

- [ ] **Step 1: Import dualPage/mangaMode from ThemeContext**

Update the `useTheme()` destructuring at line 48 of `src/screens/Reader.tsx`:

```typescript
const { fontSize, setFontSize, fontFamily, scrollMode, typography, customCss, dualPage, setDualPage, mangaMode, setMangaMode } = useTheme();
```

- [ ] **Step 2: Pass props to PageViewer**

Update the `<PageViewer>` usage (around line 1204) to pass the new props:

```tsx
<PageViewer
  bookId={bookId!}
  format={bookFormat}
  totalPages={pageCount}
  initialPage={chapterIndex}
  onPageChange={(index) => setChapterIndex(index)}
  dualPage={dualPage}
  mangaMode={mangaMode}
/>
```

- [ ] **Step 3: Add dual-page toggle buttons in reader header**

In the reader header (around line 1085, before the DND toggle button), add the dual-page toggle buttons. These should be visible for all formats but hidden when EPUB is in continuous scroll mode:

```tsx
          {/* Dual-page toggle — hidden in continuous scroll mode */}
          {!(isContinuous && bookFormat === "epub") && (
            <div className="flex items-center">
              <button
                onClick={() => setDualPage(!dualPage)}
                className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${dualPage ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
                aria-label="Toggle dual-page spread"
                title="Dual-page spread"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="4" width="8" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="14" y="4" width="8" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              {dualPage && (
                <button
                  onClick={() => setMangaMode(!mangaMode)}
                  className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${mangaMode ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
                  aria-label="Toggle manga mode (right-to-left)"
                  title="Manga mode (RTL)"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                    <path d="M19 12H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M10 7l-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
```

- [ ] **Step 4: Add EPUB dual-column CSS**

In the EPUB rendering section (around line 1218, after the `<style>` tag for typography overrides), add a conditional dual-page style block:

```tsx
            {/* Dynamic typography overrides — must target .reader-content p to beat index.css specificity */}
            <style>{`
              .reader-content p {
                margin-bottom: ${typography.paragraphSpacing}em;
                text-align: ${typography.textAlign};
                hyphens: ${typography.hyphenation ? "auto" : "manual"};
                -webkit-hyphens: ${typography.hyphenation ? "auto" : "manual"};
              }
            `}</style>
            {dualPage && !isContinuous && (
              <style>{`
                .reader-content {
                  columns: 2;
                  column-gap: 48px;
                  column-rule: 1px solid var(--warm-border, #e5e0d8);
                  ${mangaMode ? "direction: rtl;" : ""}
                }
                .reader-content > * {
                  ${mangaMode ? "direction: ltr;" : ""}
                }
              `}</style>
            )}
            {customCss && <style>{customCss}</style>}
```

Note: When manga mode is active, we set `direction: rtl` on the container so columns flow right-to-left, but reset each child to `direction: ltr` so the actual text reads normally left-to-right.

- [ ] **Step 5: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/screens/Reader.tsx
git commit -m "feat(dual-page): wire dual-page into Reader with header toggles and EPUB columns"
```

---

### Task 5: Add dual-page toggles to SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Import dualPage/mangaMode from ThemeContext**

Update the `useTheme()` destructuring at line 262 of `src/components/SettingsPanel.tsx`:

```typescript
const { mode, setMode, customColors, setCustomColors, fontSize, setFontSize, fontFamily, setFontFamily, scrollMode, setScrollMode, typography, setTypography, customCss, setCustomCss, dualPage, setDualPage, mangaMode, setMangaMode } =
  useTheme();
```

- [ ] **Step 2: Add Reading Layout accordion**

Add a new `<Accordion>` section after the "EPUB Reading Mode" accordion (after line 950, before the "Custom CSS" accordion):

```tsx
          {/* Reading Layout */}
          <Accordion title="Reading Layout">
            <div className="space-y-4">
              {/* Dual-page toggle */}
              <label className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-ink">Dual-page spread</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">Show two pages side by side, like an open book.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={dualPage}
                  onClick={() => setDualPage(!dualPage)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${dualPage ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${dualPage ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>

              {/* Manga mode toggle */}
              <label className={`flex items-center justify-between gap-3 ${!dualPage ? "opacity-40 pointer-events-none" : ""}`}>
                <div>
                  <span className="text-sm text-ink">Manga mode (right-to-left)</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">Swap page order so the right page comes first, for manga and RTL comics.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mangaMode}
                  aria-disabled={!dualPage}
                  onClick={() => dualPage && setMangaMode(!mangaMode)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${mangaMode && dualPage ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${mangaMode && dualPage ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
            </div>
          </Accordion>
```

- [ ] **Step 3: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(dual-page): add Reading Layout section to SettingsPanel"
```

---

### Task 6: Final verification and type-check

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm run test -- --run`
Expected: All tests PASS (including new `getSpreadPages` tests)

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Run Rust checks** (no Rust changes, but verify nothing broke)

Run from `src-tauri/`:
```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd ..
```
Expected: All PASS

- [ ] **Step 4: Commit any remaining changes**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix(dual-page): address verification issues"
```
