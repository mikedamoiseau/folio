# Page Turn Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional horizontal slide animation when navigating pages in PDF/CBZ/CBR formats (PageViewer component).

**Architecture:** A new wrapper div (`slideRef`) around the existing `spreadRef` in PageViewer handles the CSS `translateX` slide transition, keeping it decoupled from zoom/pan transforms. A `pageAnimation` boolean in ThemeContext controls the feature, with a toggle in the Page Layout settings accordion.

**Tech Stack:** React 19, CSS transitions, localStorage, i18next

---

### Task 1: Add `pageAnimation` to ThemeContext

**Files:**
- Modify: `src/context/ThemeContext.tsx`

- [ ] **Step 1: Add storage key**

In the `STORAGE_KEYS` object (~line 59), add:

```typescript
const STORAGE_KEYS = {
  theme: "folio-theme",
  customColors: "folio-custom-colors",
  fontSize: "folio-font-size",
  fontFamily: "folio-font-family",
  scrollMode: "folio-scroll-mode",
  typography: "folio-typography",
  customCss: "folio-custom-css",
  dualPage: "folio-dual-page",
  mangaMode: "folio-manga-mode",
  pageAnimation: "folio-page-animation",
} as const;
```

- [ ] **Step 2: Add to context interface and provider**

Add `pageAnimation` and `setPageAnimation` to `ThemeContextValue` interface (~line 37):

```typescript
interface ThemeContextValue {
  // ... existing fields ...
  mangaMode: boolean;
  setMangaMode: (enabled: boolean) => void;
  pageAnimation: boolean;
  setPageAnimation: (enabled: boolean) => void;
}
```

In `ThemeProvider` (~line 162), add state after the `mangaMode` state:

```typescript
const [pageAnimation, setPageAnimationState] = useState(() => {
  const stored = localStorage.getItem(STORAGE_KEYS.pageAnimation);
  return stored === null ? true : stored === "true";
});
```

Note: defaults to `true` (unlike `dualPage`/`mangaMode` which default to `false`). The `stored === null` check ensures the first-time default is `true`.

Add the setter callback after the `setMangaMode` callback:

```typescript
const setPageAnimation = useCallback((enabled: boolean) => {
  setPageAnimationState(enabled);
  localStorage.setItem(STORAGE_KEYS.pageAnimation, String(enabled));
}, []);
```

Add `pageAnimation` and `setPageAnimation` to the `value` useMemo object and its dependency array (~line 263).

- [ ] **Step 3: Run type check**

Run: `npm run type-check`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/context/ThemeContext.tsx
git commit -m "feat(settings): add pageAnimation to ThemeContext with localStorage persistence"
```

---

### Task 2: Add i18n keys

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English translation**

In `src/locales/en.json`, in the `settings` object, after the `mangaHint` key (~line 226), add:

```json
"pageAnimation": "Page turn animation",
"pageAnimationHint": "Slide effect when turning pages in PDF and comic formats."
```

- [ ] **Step 2: Add French translation**

In `src/locales/fr.json`, in the `settings` object, after the `mangaHint` key (~line 226), add:

```json
"pageAnimation": "Animation de changement de page",
"pageAnimationHint": "Effet de glissement lors du changement de page pour les PDF et les bandes dessinées."
```

- [ ] **Step 3: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add page turn animation labels in EN and FR"
```

---

### Task 3: Add settings toggle in SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Destructure `pageAnimation` from theme**

In the `useTheme()` destructuring (~line 265), add `pageAnimation` and `setPageAnimation`:

```typescript
const { mode, setMode, customColors, setCustomColors, fontSize, setFontSize, fontFamily, setFontFamily, scrollMode, setScrollMode, typography, setTypography, customCss, setCustomCss, dualPage, setDualPage, mangaMode, setMangaMode, pageAnimation, setPageAnimation } =
  useTheme();
```

- [ ] **Step 2: Add toggle after manga mode**

After the manga mode `</label>` closing tag (~line 1097), before the closing `</div>` of the toggles container (~line 1098), add the page animation toggle:

```tsx
              {/* Page turn animation toggle */}
              <label className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-ink">{t("settings.pageAnimation")}</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">{t("settings.pageAnimationHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pageAnimation}
                  onClick={() => setPageAnimation(!pageAnimation)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${pageAnimation ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${pageAnimation ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
```

- [ ] **Step 3: Run type check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): add page turn animation toggle in Page Layout section"
```

---

### Task 4: Pass `pageAnimation` prop to PageViewer

**Files:**
- Modify: `src/screens/Reader.tsx`
- Modify: `src/components/PageViewer.tsx` (interface only)

- [ ] **Step 1: Add `pageAnimation` to PageViewer props interface**

In `src/components/PageViewer.tsx`, add to `PageViewerProps` (~line 10):

```typescript
interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
  dualPage?: boolean;
  mangaMode?: boolean;
  pageAnimation?: boolean;
}
```

Add to the destructuring (~line 20):

```typescript
export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
  dualPage = false,
  mangaMode = false,
  pageAnimation = true,
}: PageViewerProps) {
```

- [ ] **Step 2: Pass prop from Reader.tsx**

In `src/screens/Reader.tsx`, add `pageAnimation` to the useTheme destructuring (find the existing `useTheme()` call and add it). Then in the PageViewer JSX (~line 1296):

```tsx
<PageViewer
  bookId={bookId!}
  format={bookFormat}
  totalPages={pageCount}
  initialPage={chapterIndex}
  onPageChange={(index) => setChapterIndex(index)}
  dualPage={dualPage}
  mangaMode={mangaMode}
  pageAnimation={pageAnimation}
/>
```

- [ ] **Step 3: Run type check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/PageViewer.tsx src/screens/Reader.tsx
git commit -m "feat(reader): pass pageAnimation prop from Reader to PageViewer"
```

---

### Task 5: Implement slide animation in PageViewer

**Files:**
- Modify: `src/components/PageViewer.tsx`

This is the core task. We add a wrapper div (`slideRef`) around `spreadRef`, a direction ref, and animate the wrapper on page changes.

- [ ] **Step 1: Add refs and direction tracking**

After the existing `spreadRef` declaration (~line 42), add:

```typescript
const slideRef = useRef<HTMLDivElement>(null);
const directionRef = useRef<"left" | "right">("right");
```

- [ ] **Step 2: Add the `animateSlide` helper**

After the `applyTransform` callback (~line 56), add:

```typescript
const animateSlide = useCallback(() => {
  if (!pageAnimation || !slideRef.current) return;
  const el = slideRef.current;
  // Step 1: instantly position off-screen (no transition)
  el.style.transition = "none";
  el.style.transform = directionRef.current === "right"
    ? "translateX(100%)"
    : "translateX(-100%)";
  // Step 2: force reflow so the browser registers the off-screen position
  el.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
  // Step 3: animate slide to center
  el.style.transition = "transform 200ms ease-out";
  el.style.transform = "translateX(0)";
  const onEnd = () => {
    el.style.transition = "none";
    el.style.transform = "";
    el.removeEventListener("transitionend", onEnd);
  };
  el.addEventListener("transitionend", onEnd);
}, [pageAnimation]);
```

- [ ] **Step 3: Set direction in `prevSpread` and `nextSpread`**

In `prevSpread` (~line 119), add `directionRef.current = "left";` as the first line inside the callback:

```typescript
const prevSpread = useCallback(() => {
  directionRef.current = "left";
  if (dualPage) {
    if (spread.left <= 0) return;
    const prevLeft = spread.left <= 2 ? 0 : spread.left - 2;
    goTo(prevLeft);
  } else {
    goTo(pageIndex - 1);
  }
}, [dualPage, spread.left, pageIndex, goTo]);
```

In `nextSpread` (~line 129), add `directionRef.current = "right";` as the first line inside the callback:

```typescript
const nextSpread = useCallback(() => {
  directionRef.current = "right";
  if (dualPage) {
    const nextLeft = spread.right !== null ? spread.right + 1 : spread.left + 1;
    if (nextLeft >= totalPages) return;
    goTo(nextLeft);
  } else {
    goTo(pageIndex + 1);
  }
}, [dualPage, spread, pageIndex, totalPages, goTo]);
```

For `goTo` (handles direct page jumps from the go-to-page input), direction defaults to whatever `directionRef` is currently set to — no change needed since `directionRef` starts as `"right"`.

- [ ] **Step 4: Trigger animation when page images load**

In the `loadSpread` effect (~line 79), trigger the animation after images are set. Add the `animateSlide` call after the state setters:

```typescript
useEffect(() => {
  let cancelled = false;
  setLoading(true);
  setError(null);

  const loadSpread = async () => {
    try {
      const promises: Promise<string>[] = [loadPage(spread.left, pdfRenderWidth)];
      if (spread.right !== null) {
        promises.push(loadPage(spread.right, pdfRenderWidth));
      }
      const results = await Promise.all(promises);
      if (cancelled) return;
      setLeftImageData(results[0]);
      setRightImageData(results.length > 1 ? results[1] : null);
      // Trigger slide animation after new images are set
      requestAnimationFrame(() => {
        if (!cancelled) animateSlide();
      });
    } catch (err) {
      if (!cancelled) setError(String(err));
    } finally {
      if (!cancelled) setLoading(false);
    }
  };

  loadSpread();
  return () => { cancelled = true; };
}, [spread.left, spread.right, loadPage, pdfRenderWidth, animateSlide]);
```

- [ ] **Step 5: Wrap `spreadRef` with `slideRef` in JSX**

Replace the existing `spreadRef` div and its contents (~lines 318-341) with a wrapper structure:

```tsx
          <div
            ref={slideRef}
            className="absolute inset-0"
          >
            <div
              ref={spreadRef}
              className={`absolute top-1/2 left-1/2 flex items-center justify-center gap-1 will-change-transform ${mangaMode && dualPage ? "flex-row-reverse" : "flex-row"}`}
              style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, transform: `translate(calc(-50% + ${panRef.current.x}px), calc(-50% + ${panRef.current.y}px))` }}
            >
              {leftImageData && (
                <img
                  src={leftImageData}
                  alt={`Page ${spread.left + 1} of ${totalPages}`}
                  className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                  style={dualPage && rightImageData ? { maxWidth: "50%" } : undefined}
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
          </div>
```

The `slideRef` wrapper is `absolute inset-0` so it fills the container. The slide `translateX` on this wrapper moves the entire spread (including zoom/pan transforms on `spreadRef`) in unison.

- [ ] **Step 6: Run type check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 7: Manual test**

Run: `npm run tauri dev`

Test the following:
1. Open a PDF or CBZ/CBR book
2. Press right arrow — page should slide in from right (200ms)
3. Press left arrow — page should slide in from left
4. Mouse wheel forward/backward — same slide directions
5. Click next/prev buttons — same slide directions
6. Toggle "Page turn animation" off in Settings > Page Layout — pages should change instantly (no slide)
7. Toggle dual-page spread on — animation should work the same with two-page spreads
8. Zoom in (Ctrl+scroll), then navigate — zoom resets and slide animation plays
9. Use go-to-page input — should slide as "next" direction
10. Rapid navigation (hold arrow key) — cooldown prevents overlap, no glitches

- [ ] **Step 8: Commit**

```bash
git add src/components/PageViewer.tsx
git commit -m "feat(reader): add slide animation for page turns in PDF/CBZ/CBR"
```

---

### Task 6: Update roadmap

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Mark feature as done**

In `docs/ROADMAP.md`, update the Page Turn Animations entry (~line 441). Change:

```markdown
#### 40. Page Turn Animations
- Optional visual effects when turning pages (curl, slide, fade)
- Configurable or disableable in settings
- Pure polish feature
```

To:

```markdown
#### 40. Page Turn Animations — **Done**
- ~~Optional slide animation when turning pages in PDF/CBZ/CBR formats~~
- ~~Configurable toggle in Settings > Page Layout (on by default)~~
- ~~CSS transition on wrapper div, decoupled from zoom/pan transforms~~
- Future: additional animation styles (fade, curl)
```

Also update the Phase 8 summary row in the table at the bottom to include "Page Turn Animations" in the done count.

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: mark page turn animations as done in roadmap"
```
