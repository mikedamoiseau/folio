# Web UI Improvement Report

Audit date: 2026-07-04. Based on code review of `src-tauri/src/web_server/` and live Playwright inspection of the running web UI (`http://localhost:7788`).

This document is written so each numbered item can be delegated to a separate agent as a self-contained work package. Read the **Shared Context** section first — it applies to every item.

---

## Shared Context (read before starting any item)

### Architecture

The web UI is a hand-written mini-SPA, completely independent from the React desktop app. It shares **no code, no components, and no styling** with `src/`.

| File | Size | Role |
|------|------|------|
| `src-tauri/src/web_server/static/index.html` | 14 lines | Bare shell: `<div id="app">` + `<script src="/app.js">` + `<link href="/app.css">` |
| `src-tauri/src/web_server/static/app.js` | ~587 lines | Vanilla JS IIFE. Hash-based router (`route()` fn). Views: `showLogin`, `showLibrary`, `showDetail`, `showReader`, `showStats`, `showCollections`. Template-literal HTML injection with an `esc()` HTML-escaper. Debounced (300ms) search. `fetch` with `credentials: "same-origin"`. |
| `src-tauri/src/web_server/static/app.css` | ~122 lines | Plain CSS. Custom properties in `:root`: `--bg:#111; --fg:#eee; --accent:#6c9; --card-bg:#1a1a2e; --border:#333`. Single `@media (max-width: 600px)` block. Dark-only, no theme toggle. |
| `src-tauri/src/web_server/web_ui.rs` | 63 lines | Serves the static files via `include_str!`/`include_bytes!` (assets are **embedded in the Rust binary**). Routes: `GET /`, `/app.js`, `/app.css`, `/favicon.png`, `/favicon.ico`. |
| `src-tauri/src/web_server/api.rs` | ~997 lines | JSON API consumed by app.js (see endpoint list below). |
| `src-tauri/src/web_server/auth.rs` | ~589 lines | Optional PIN auth. Session cookie `folio_session` (24h TTL, in-memory) or Basic Auth. Public (unauthenticated) route carve-out: `/api/auth`, `/api/health`, `/`, `/app.js`, `/app.css`, `/favicon.ico`, `/favicon.png`. Per-IP rate limiting. |
| `src-tauri/src/web_server/mod.rs` | ~1010 lines | `WebState`, `build_router`, security-headers middleware, `DEFAULT_PORT = 7788`. ~300 lines of `#[cfg(test)]` integration tests. |
| `src-tauri/src/web_server/opds_feed.rs` | ~945 lines | OPDS 1.2 catalog (separate surface, mostly out of scope here). |

### Existing API endpoints (api.rs `routes()`)

- `GET /api/health`, `POST /api/auth` (PIN login)
- `GET /api/books` (supports `?q=`, `?series=`, `?sort=`), `GET /api/books/{id}`
- `GET /api/books/{id}/cover`, `/chapters`, `/chapters/{index}` (sanitized HTML for EPUB/MOBI), `/images/{chapter}/{filename}`, `/pages/{index}` (rasterized page image for PDF/CBZ/CBR), `/page-count`, `/download`, `/download/{filename}`
- `GET /api/stats`, `/api/series`, `/api/collections`, `/api/collections/{id}/books`
- `GET /api/audit/login-history`, `GET /api/data-export`

### Desktop app design tokens (target look)

Defined in `src/index.css` (Tailwind v4, `@theme` mapping) and managed by `src/context/ThemeContext.tsx` (modes: light/dark/system/sepia/custom).

```css
/* Light */
--paper: #faf8f3;  --surface: #fff;     --ink: #2c2218;   --ink-muted: #8c7b6e;
--warm-border: #e5ddd4;  --warm-subtle: #f0ead8;
--accent: #c2714e;  --accent-hover: #a85f3f;  --accent-light: #f7ede6;

/* Dark (.dark override) */
--paper: #1a1614;  --surface: #231f1b;  --ink: #e8e2d9;  --accent: #d4886a;
```

Fonts: `--font-sans: "DM Sans Variable"`, `--font-serif: "Playfair Display Variable"`, `--font-reading: "Lora Variable"`. The web UI currently uses the system sans stack and mint-green `#6c9` accent — visually unrelated to the app.

### Rules that apply to every item

1. **Static assets are compiled into the binary.** Any change to `static/*` requires a Rust rebuild to show up in the served UI (`cargo build` / restart of `npm run tauri dev`). There is no frontend build step, no bundler, no npm deps for the web UI — keep it that way (vanilla JS/CSS only, no framework).
2. **New static files (e.g. `manifest.json`, `sw.js`, font files) need three registrations:** an `include_str!`/`include_bytes!` route in `web_ui.rs`, **and** an entry in the auth middleware's public-route carve-out in `auth.rs` (otherwise PIN-protected setups will 401 them), and correct `Content-Type`.
3. **Security invariants — do not weaken:** chapter HTML is sanitized server-side (`sanitize_chapter_html` in api.rs) before serving; keep using `esc()` for any user/book data interpolated into template literals in app.js; filename params go through `is_safe_filename` (api.rs); security headers come from `security_headers_middleware` (mod.rs) — check CSP there before adding inline scripts/styles (external files preferred).
4. **New API endpoints** go in `api.rs::routes()`. DB access goes through functions in `folio-core/src/db.rs` (receive `&Connection`, never manage pool lifecycle). New tables/columns: additive migration in `folio-core/src/db.rs::run_schema()`.
5. **Testing/verification:** web server has integration tests in `mod.rs` `#[cfg(test)]` — add coverage there for new endpoints. Before pushing: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` (repo root), `cargo test` (in `src-tauri/`), `npm run type-check && npm run test` (root). Visual verification: Playwright is available in the repo's `node_modules` — run scripts with `NODE_PATH=<repo>/node_modules node script.js` against `http://localhost:7788`.
6. **Surgical changes.** Match existing app.js/app.css style (vanilla, small, no abstractions). Don't refactor unrelated code.

### Observed defects (evidence from live inspection)

- Arrow keys do nothing in the reader (verified: pressed `ArrowRight` on page 1/50, page did not change).
- Reader page image is taller than the viewport; Prev/Next buttons are small and sit at the top — you must scroll back up to turn a page.
- Book detail page is nearly empty: cover, title, "Format: PDF", Read + Download buttons. No author, no description, no series info, no progress.
- Series filter bar is a single horizontal scroll strip of pills — already overflowing with ~25 series.
- One book with a missing cover renders as a plain white rectangle (no placeholder treatment).
- Card titles truncate ("Wunderwaffen - T2…" ×20) with no tooltip, indistinguishable in series-heavy libraries.
- Icon-only header buttons (collections folder, stats chart) have no `aria-label`/tooltip.
- Stats page is read-only and says "Start reading on the desktop app to see your progress here" — web reading is never recorded.

---

## Item 1 — Port the desktop design system to the web UI

**Priority: highest. Do this first — items 5, 6, 8, 10 build on the resulting CSS.**

### Goal
Web UI looks like Folio: warm paper/terracotta palette, same type hierarchy, light+dark variants — instead of the current generic `#111`/mint-green hacker theme.

### Scope
- Rewrite `app.css` around the desktop token set (see Shared Context). Define both palettes:
  - `:root` → light tokens, `[data-theme="dark"]` (attribute on `<html>`) → dark tokens.
  - Keep variable *names* semantic and aligned with `src/index.css` (`--paper`, `--surface`, `--ink`, `--ink-muted`, `--warm-border`, `--accent`, `--accent-hover`, `--accent-light`) so future maintenance can diff the two files.
- Typography: use the same families with graceful fallback. Two acceptable approaches — pick one and note it in the PR:
  - (a) Embed WOFF2 subsets of DM Sans + Lora as new static assets (see Shared Context rule 2; ~100–200 KB binary growth), or
  - (b) `font-family: "DM Sans", -apple-system, ... sans-serif` relying on local availability, styling headings with the serif stack `"Playfair Display", Georgia, serif`.
- Restyle all existing views to the new tokens: header, search input, filter pills, book grid/cards, detail page, reader chrome, stats page, login screen. Card hover states, button styles (primary = accent, secondary = surface + border) should visually match the desktop app's `src/components/BookCard.tsx` / buttons.
- Do **not** add the theme toggle here (that's Item 6) — but structure the CSS so Item 6 only has to flip the `data-theme` attribute.

### Files
`src-tauri/src/web_server/static/app.css` (main), small class-name touch-ups in `app.js` templates if needed, `web_ui.rs` + `auth.rs` only if font files are added.

### Acceptance criteria
- Side-by-side screenshot of web UI vs desktop app reads as the same product (palette, type, spacing).
- Both light and dark palettes fully defined in CSS (even though toggle ships in Item 6, default can follow `prefers-color-scheme`).
- No layout regressions at 1440px and 390px widths (Playwright screenshots at both).
- No new JS dependencies, no build step introduced.

---

## Item 2 — Keyboard shortcuts

**Priority: high. Small, independent. Verified gap: arrow keys currently do nothing.**

### Goal
Full keyboard operation of library and reader.

### Scope
Single `keydown` listener on `document` in app.js, dispatching on current route (the hash router already knows the active view). Ignore events when `event.target` is an input/select/textarea. Suggested map:

| Context | Key | Action |
|---------|-----|--------|
| Reader (page mode: PDF/CBZ/CBR) | `←` / `→` | Prev / next page (same handlers as the Prev/Next buttons) |
| Reader (chapter mode: EPUB/MOBI) | `←` / `→` | Prev / next chapter |
| Reader | `Home` / `End` | First / last page or chapter |
| Reader | `f` | Toggle fullscreen (`document.documentElement.requestFullscreen()` / `exitFullscreen`) |
| Reader / Detail | `Esc` or `Backspace` | Back (mirror the `←` header button) |
| Library | `/` | Focus search input (`preventDefault` so `/` isn't typed) |
| Library | `Esc` | Clear search / blur input |
| Anywhere | `?` | Overlay listing the shortcuts (simple dismissible `<div>`) |

Optional stretch: `←`/`→` grid navigation with a visible focus ring in the library (needs cards to be focusable — coordinate with Item 10's focus-state work).

### Files
`src-tauri/src/web_server/static/app.js` (listener + shortcut overlay), `app.css` (overlay styling).

### Acceptance criteria
- Playwright test-style verification: open a PDF book, press `ArrowRight`, page indicator changes from `Page 1 / N` to `Page 2 / N`.
- Typing `/` in the search box does not trigger shortcut handling.
- `?` overlay opens and closes.

---

## Item 3 — Comic/PDF reader ergonomics

**Priority: high. The library is comic-heavy (PDF/CBZ/CBR page-image books), and the current reader is the weakest screen.**

### Current behavior
`showReader` in app.js renders (for page-based formats) an `<img>` from `/api/books/{id}/pages/{index}` with small Prev/Next buttons *above* the image. Image renders at natural width, taller than the viewport → user scrolls down to read, scrolls back up to click Next. Every page turn is a fresh server-side raster + network round-trip with no preloading. No zoom, no fit modes, no touch gestures, no fullscreen.

### Scope
1. **Fit modes:** toolbar toggle with `fit-height` (default: whole page visible, `max-height: calc(100vh - header)`) and `fit-width` modes. Persist choice in `localStorage`.
2. **Click-to-turn:** clicking the left third of the page image = prev, right third = next, middle third = toggle chrome (header/toolbar) visibility for an immersive mode.
3. **Touch gestures:** horizontal swipe (`touchstart`/`touchend`, threshold ~50px) = prev/next on mobile.
4. **Preloading:** after rendering page N, `new Image().src = pageUrl(N+1)` (and N-1) so turns feel instant. Keep it simple — no cache eviction logic needed, the browser HTTP cache handles it. Check whether `/api/books/{id}/pages/{index}` responses carry cache headers; if not, add `Cache-Control: private, max-age=3600` in api.rs (page images are immutable per book file).
5. **Progress indicator:** thin bar or `page/total` readout in the toolbar; a range slider (`<input type="range">`) for jumping to a page is a cheap win.
6. **Move/duplicate Prev/Next controls** to a fixed overlay or bottom bar so they're reachable without scrolling (mostly obsolete once click-to-turn exists, but keep visible buttons for discoverability).
7. Keep the EPUB/MOBI chapter reader working — the reader has two modes; page-image ergonomics apply to the image mode, chapter mode gets fit-width text column + same chrome-toggle.

### Files
`app.js` (`showReader`), `app.css`, possibly `api.rs` (cache headers only).

### Dependencies
Coordinates with Item 2 (shares reader navigation handlers — build handlers once, call from both keys and clicks/swipes).

### Acceptance criteria
- Full page visible without scrolling at 1440×900 in fit-height mode.
- Click right side of image → next page. Swipe works on a 390px-wide touch-emulated Playwright page.
- Page N+1 request observable in network log *before* user turns the page.
- Chrome hides/shows on middle-click; no dead ends (chrome can always be brought back).

---

## Item 4 — Two-way reading progress sync

**Priority: high. Backend + frontend. Turns the web UI from a viewer into a real reading surface.**

### Current behavior
Progress flows one way: desktop app writes to SQLite; web stats page reads it. The web reader always opens at page/chapter 0 and records nothing. Stats page explicitly says "Start reading on the desktop app to see your progress here."

### Scope
1. **API — read:** `GET /api/books/{id}/progress` → current position (existing `ReadingProgress` model in `folio-core/src/models.rs`; check for an existing read function in `folio-core/src/db.rs` — the desktop app already loads progress, reuse that function).
2. **API — write:** `PUT /api/books/{id}/progress` with JSON body (position: chapter index + scroll offset for EPUB/MOBI, page index for PDF/CBZ/CBR — mirror whatever shape the desktop app persists; **grep every consumer of the progress table before changing any field semantics**). Auth-protected (default middleware). Reuse the desktop's upsert function in `folio-core/src/db.rs` if one exists; add one there if not.
3. **Frontend:** on reader open, fetch progress and jump to the saved position (offer "Resume at page 23 / Start over" if saved position > 0). While reading, debounce-save position (e.g. 2s after last page turn, plus `visibilitychange`/`pagehide` flush).
4. **Reading sessions (optional, only if cheap):** if the stats tables track sessions/time, consider a lightweight session record for web reads so the stats page reflects web activity. If the schema makes this non-trivial, skip — position sync is the core deliverable; note the decision in the PR.
5. **Conflict policy:** last-write-wins on `updated_at`. No merge logic.

### Files
`api.rs` (2 routes + handlers), `folio-core/src/db.rs` (reuse/add progress read+upsert), `app.js` (`showReader` + detail page "Continue" button), `mod.rs` (integration tests for both endpoints, including 401-when-PIN-set and write-then-read roundtrip).

### Acceptance criteria
- Integration tests in `mod.rs` pass: PUT then GET returns the written position; unauthenticated PUT is rejected when a PIN is configured.
- Read 5 pages in the web reader, close tab, reopen book → resumes at page 6 (or offers resume).
- Desktop app shows the updated position for the same book (verify by reading the DB row).
- `cargo test` (src-tauri) and clippy clean.

### Dependency
Item 8's "Continue" button and Item 5's "Continue Reading" shelf both consume `GET .../progress` — build this first.

---

## Item 5 — Home screen: "Continue Reading" + "Recently Added" shelves

**Priority: medium-high. Depends on Item 4 for real value (web-side positions), but can ship against desktop-written progress immediately.**

### Current behavior
Home = flat wall of every cover, sorted by "Recent" dropdown. No resume affordance; finding the book you're mid-way through means remembering its title.

### Scope
1. **API:** either extend `GET /api/books` with `?filter=reading` / `?filter=recent` params, or add `GET /api/books/continue-reading` (books with progress > 0 and < 100%, ordered by `last_read_at` desc, limit ~12). Check what the desktop Library screen uses in `folio-core/src/db.rs` — a query probably already exists; expose it, don't duplicate it.
2. **Frontend:** `showLibrary` renders (when unfiltered/unsearched):
   - **Continue Reading** — horizontal shelf, cards show a progress bar (percent from progress data) and open the reader directly at the saved position (not the detail page).
   - **Recently Added** — horizontal shelf, last ~12 imports.
   - **All Books** — the existing grid below.
   - When a search query or series/collection filter is active, hide the shelves and show only the filtered grid (current behavior).
3. Progress bar on shelf cards: thin accent-colored bar at the card bottom (matches desktop `BookCard` which shows reading progress).

### Files
`app.js` (`showLibrary`), `app.css` (shelf layout: horizontal scroll with snap points, `scroll-snap-type: x mandatory`), `api.rs` (+ `folio-core/src/db.rs` if a new query is needed), `mod.rs` tests for any new endpoint.

### Acceptance criteria
- With ≥1 in-progress book: home shows shelves + grid; clicking a Continue card lands in the reader at the saved position.
- With zero progress: Continue shelf hidden entirely (no empty-state noise).
- Searching hides shelves; clearing search restores them.
- Mobile (390px): shelves scroll horizontally with snap; no horizontal body scroll.

---

## Item 6 — Theme toggle: light / dark / system (+ sepia)

**Priority: medium. Small. Hard dependency on Item 1 (needs both palettes defined).**

### Scope
1. Header button cycling light → dark → system (system = follow `prefers-color-scheme` via `matchMedia`, react to changes live). Persist choice in `localStorage` (`folio_theme`).
2. Apply by setting `data-theme="light|dark"` on `<html>` before first paint — inline the tiny bootstrap script in `index.html` `<head>` (check the CSP in `security_headers_middleware` in mod.rs allows it; if `script-src` lacks `'unsafe-inline'`, either add a hash for this one script or accept a first-paint flash and set it at the top of app.js — prefer the hash approach, do not broadly enable `unsafe-inline`).
3. Optional: sepia as a third palette (desktop has it; tokens in `src/lib/themes` — port values if trivial, otherwise skip and note it).
4. Icon reflects current mode (sun/moon/auto glyph — inline SVG, no icon library).

### Files
`index.html` (bootstrap script), `app.js` (toggle + persistence), `app.css` (nothing new if Item 1 done right), possibly `mod.rs` (CSP hash).

### Acceptance criteria
- Toggle cycles and persists across reloads; no flash-of-wrong-theme on reload (or documented decision to accept it).
- System mode follows OS setting change live (Playwright: `page.emulateMedia({ colorScheme: 'dark' })`).
- All views legible in both palettes (spot-check screenshots: library, detail, reader, stats, login).

---

## Item 7 — Library navigation at scale (filters, series grouping, URL state)

**Priority: medium-high. Largest frontend item. The current filter strip is already unusable at ~25 series.**

### Current behavior
One horizontal `overflow-x: auto` strip of pill buttons: "All Books", then collections, then every series with a count. Filter/sort/search state lives only in JS variables — back button, reload, and bookmarks all lose state.

### Scope
1. **URL as source of truth:** encode state in the hash route, e.g. `#/library?q=asterix&series=Yakari&sort=title`. `route()` parses it; every filter/search/sort change rewrites the hash (`history.replaceState` for keystrokes, hash change for filter clicks so back button steps back sensibly). Reload/back/bookmark all restore the exact view. **Do this part first — it's the foundation.**
2. **Replace the pill strip** with a compact filter bar:
   - "Collections ▾" and "Series ▾" dropdown panels with a type-to-filter input inside (25+ entries must be searchable), entries show counts, active selections render as removable chips next to the search box.
   - Keep "All Books" as a one-click reset.
3. **Series stacks in the grid (optional stretch, propose before building):** when unfiltered, collapse books of the same series into one stacked-cover card ("Wunderwaffen · 21 books") that clicks through to `?series=...`. This fixes the "20 identical truncated covers" wall. If it conflicts with the shelves from Item 5, series stacks win in the All Books grid and shelves stay flat.
4. **Sort dropdown** stays, but selection is reflected in URL (`sort=recent|title|author|last-read|rating`).

### Files
`app.js` (router + `showLibrary` + `renderFilterBar` rewrite), `app.css` (dropdown panels, chips, stack cards). No backend changes — `/api/books?q=&series=&sort=` and `/api/series`, `/api/collections` already exist.

### Acceptance criteria
- Reload mid-search restores query, filter, and sort exactly.
- Back button returns to previous filter state, not out of the app.
- Series dropdown filters as you type; selecting adds a chip; chip × removes it.
- Works at 390px (dropdowns become full-width sheets or remain usable).

---

## Item 8 — Richer book detail page

**Priority: medium. Depends on Item 4 for the progress/Continue elements; everything else is independent.**

### Current behavior
Cover, title, "Format: PDF", Read + Download buttons, in an otherwise empty screen. `GET /api/books/{id}` likely already returns more fields than the page renders (author, series, description, rating, page count, file size, added date — check the `Book` model in `folio-core/src/models.rs` and the api.rs handler; extend the API response only if fields are missing and the data is in the DB).

### Scope
1. **Metadata block:** author, series name + volume, description (render as text — it may contain publisher HTML; keep escaping with `esc()`, or sanitize server-side if HTML rendering is wanted), format badge, page/chapter count, file size, date added, rating (read-only stars).
2. **Progress:** progress bar + "page 23 of 50 · 46%" if progress exists. Primary button becomes **Continue** (jumps to saved position); secondary "Start over". (Needs Item 4's GET endpoint.)
3. **Series navigation:** if the book belongs to a series, show "Series: Wunderwaffen (12/21)" linking to the filtered library, plus Prev/Next volume buttons resolved by series + volume ordering — `/api/books?series=X` already returns the set; resolve neighbors client-side.
4. **Layout:** two-column on desktop (cover left; meta right), stacked on mobile — the responsive pattern already exists in the 600px media query.

### Files
`app.js` (`showDetail`), `app.css`, possibly `api.rs` (add missing fields to the book-detail response).

### Acceptance criteria
- Detail page for a series book shows author, description, series position, working prev/next volume links.
- In-progress book shows Continue as primary action landing at saved position.
- No raw HTML injection from description (verify with a book whose description contains tags).
- Mobile layout stacks cleanly.

---

## Item 9 — PWA: installable, app-like on phones

**Priority: medium-low. Independent. Cheap because all assets are already static and embedded.**

### Scope
1. **`manifest.json`:** name "Folio", `display: standalone`, theme/background colors from the Item 1 palette, icons (192px + 512px PNG — derive from the existing app icon assets in `src-tauri/icons/`).
2. **Service worker (`sw.js`):** minimal cache-first for the app shell (`/`, `/app.js`, `/app.css`, `/favicon.png`, manifest, icons) with a cache-version bump strategy (bump a `CACHE_VERSION` string whenever static assets change — document this in a comment in web_ui.rs next to the embeds so future asset edits remember to bump it). **Network-only for `/api/*`** — do not cache API responses or book content in v1 (auth and freshness complexity not worth it; note offline book caching as explicit future work).
3. **Registration:** feature-detected `navigator.serviceWorker.register('/sw.js')` in app.js.
4. **New static routes:** `manifest.json`, `sw.js`, both icons — remember all three registrations per Shared Context rule 2 (web_ui.rs route + auth.rs public carve-out + Content-Type; `sw.js` must be served with `Content-Type: application/javascript`).
5. `<link rel="manifest">` + `<meta name="theme-color">` in index.html.

### Caveat to document in the PR
Install prompts and service workers require a secure context: `localhost` works for testing, but LAN-IP access over plain HTTP (the primary real-world use: phone → `http://192.168.x.x:7788`) will **not** allow SW registration or install on most browsers. The manifest + icons still improve add-to-homescreen on iOS Safari. State this limitation honestly; do not add TLS in this item.

### Acceptance criteria
- Lighthouse PWA checks pass on `http://localhost:7788` (manifest valid, SW registered, icons served).
- App-shell loads from SW cache on reload (verify in DevTools/Playwright network log).
- `/api/*` requests always hit the network.
- PIN-protected mode: manifest/sw/icons load without auth (carve-out verified by integration test in mod.rs).

---

## Item 10 — Polish & accessibility pass

**Priority: medium. Best done last — touches every view; earlier items reduce rework.**

### Scope (checklist)

**Covers & images**
- [ ] Cover placeholder: books with missing/failed covers get a styled placeholder (surface bg, book title in serif, subtle border) instead of a white rectangle / gray box. Single shared `onerror` handler + same markup for the no-cover case.
- [ ] `loading="lazy"` + explicit `width`/`height` (or `aspect-ratio` CSS) on all grid cover `<img>`s — kills layout shift and speeds first paint on large libraries.

**Feedback & states**
- [ ] Loading skeletons for library grid, detail, reader page loads (CSS shimmer on placeholder cards; the desktop app has a shimmer keyframe in `src/index.css` to imitate).
- [ ] Fetch error handling: visible toast/banner ("Couldn't reach Folio server — retry") instead of silent empty views. One small `showToast(msg)` helper.
- [ ] Empty states: empty library, empty search results ("No books match 'xyz'"), empty collection — each with a short friendly message.

**Navigation details**
- [ ] Preserve library scroll position when returning from detail/reader (save `scrollY` per hash in `sessionStorage`, restore on back).
- [ ] `document.title` reflects view: "Folio", "Book Title — Folio", "Reading: Book Title".
- [ ] Truncated card titles get `title` attribute tooltips (full name on hover).

**Accessibility**
- [ ] `aria-label` on all icon-only buttons (back arrow, collections folder, stats chart, future theme toggle).
- [ ] Visible `:focus-visible` ring (accent-colored outline) on every interactive element; book cards keyboard-focusable (`tabindex="0"` + Enter/Space activate) — coordinate with Item 2's grid navigation if built.
- [ ] Search input has a `<label>` (visually hidden is fine) or `aria-label`.
- [ ] Reader page images get meaningful `alt` ("Page 3 of 50").
- [ ] Color-contrast check of final Item 1 palette (WCAG AA for text on `--paper`/`--surface`).
- [ ] `prefers-reduced-motion` media query disabling skeleton shimmer and any transitions (desktop app already does this — mirror it).

### Files
`app.js`, `app.css` throughout.

### Acceptance criteria
- Keyboard-only walkthrough: reach and operate search, filters, a book card, detail actions, reader controls — visible focus at every step.
- Playwright screenshot of library with a missing-cover book shows styled placeholder.
- Killing the server mid-session and clicking around produces the error toast, not blank screens.

---

## Item 11 — Serve cover thumbnails in library/shelf grids

**Priority: medium-high (performance). Added 2026-07-04 after the initial audit. Independent of other items.**

### Current behavior
`GET /api/books/{id}/cover` (api.rs `get_cover`, ~line 420) reads `book.cover_path` — the **full-size** `cover.jpg` — and the web UI uses that one endpoint everywhere: library grid, shelf cards, and detail page. With a ~2000-book library the grid downloads thousands of full-resolution covers to render ~160-200px cards.

The infrastructure for the fix already exists and is unused by the web server:
- `folio-core/src/image_util.rs::make_thumbnail(bytes, target_width)` — produces a q80 JPEG clamped to a target width; returns `Ok(None)` when the source is already at/below the target ("use the original").
- The desktop app already persists `thumb.jpg` next to `cover.jpg` in `{app_data}/covers/{book_id}/` — verified ~2347 `thumb.jpg` files on disk on this machine. Find the desktop write path (grep `make_thumbnail` / `thumb.jpg` consumers in commands.rs / import pipeline) and mirror its exact naming + target width.

### Scope
1. **API:** extend `GET /api/books/{id}/cover` with `?size=thumb` (default `full` keeps current behavior — OPDS and detail page stay untouched). `size=thumb` resolution order:
   - serve `thumb.jpg` from the cover directory if present;
   - else generate it once via `image_util::make_thumbnail` from the full cover (same target width the desktop uses), persist it as `thumb.jpg` (best-effort — serve from memory even if the disk write fails), and serve it;
   - `make_thumbnail` → `Ok(None)` (cover already small) or any generation error → fall back to the full cover bytes.
   Follow the established cache-header scheme: `no-store` when a PIN is configured, `private, max-age=3600` otherwise (thumbnails are immutable per cover).
   Generation is CPU+IO work — run it in `tokio::task::spawn_blocking` and do not hold a DB pool connection across it (same pattern as the `file_size` stat fix in Item 8's review round).
2. **Frontend:** grid cards and shelf cards request `/cover?size=thumb`; detail page keeps the full cover. The existing `onerror` → styled placeholder path must keep working.
3. **No schema change.** No new endpoint — a query param on the existing route keeps the auth/public-carve-out story unchanged.

### TDD
Integration tests in mod.rs first (red→green), with a synthetic large cover fixture:
- `?size=thumb` returns 200 image/jpeg, and the returned image is at most the desktop thumbnail width (decode dimensions in the test with the `image` crate — already a workspace dependency).
- After the first thumb request, `thumb.jpg` exists in the cover dir; a second request serves it (no regeneration — assert e.g. via mtime stability or a cheap marker).
- Small-cover book: `?size=thumb` returns the original bytes unchanged.
- No `size` param → byte-identical to previous behavior.
- Book without a cover → 404 both sizes.
- Cache headers follow the PIN/no-PIN scheme.

### Acceptance criteria
- Library grid network transfer for covers drops by roughly an order of magnitude on a large library (spot-check via Playwright request sizes: grid cover responses each well under ~50 KB vs the full-size baseline).
- Grid/shelf visual quality unchanged at card size (screenshot review light+dark).
- Detail page still shows the full-resolution cover.
- All existing regression scripts stay green.

---

## Suggested delegation batches

| Batch | Items | Rationale |
|-------|-------|-----------|
| 1 | **1** (design system) | Foundation for everything visual; do alone to avoid merge conflicts in app.css |
| 2 | **2 + 3** (keyboard + reader ergonomics) | Same file region (`showReader`), shared navigation handlers — one agent |
| 3 | **4** (progress sync) | Backend-flavored, independent of CSS work — can run parallel to batch 2 |
| 4 | **5 + 8** (shelves + detail page) | Both consume Item 4's progress endpoint |
| 5 | **6 + 7** (theme toggle + navigation) | Toggle is trivial after Item 1; navigation rewrite is the big frontend chunk |
| 6 | **9 + 10** (PWA + polish) | Final pass over stabilized UI |
| 7 | **11** (cover thumbnails) | Added later; independent perf item, safe to run after the UI stabilizes |

Each batch: feature branch, run full CI suite locally before push (see Shared Context rule 5), PR to main.

---

# Implementation Decision Log

All 11 items were implemented 2026-07-04/05 on the epic branch `feature/web-ui-revamp` (sub-branches `web-ui/01-design-system`, `web-ui/02-reader-ux`, `web-ui/04-progress-sync`, `web-ui/05-shelves-detail`, `web-ui/06-theme-navigation`, `web-ui/09-pwa-polish`, `web-ui/11-cover-thumbnails`, each merged after a two-reviewer loop: workflow-based `/code-review` at high effort + Codex review, with all confirmed findings fixed before merge). Final merged state passes the full CI suite: `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, 236 src-tauri tests, 503 folio-core tests, `npm run type-check`, 580 frontend tests. **The branch has not been pushed** — pushing/PR was not part of the brief.

Decisions taken autonomously, for later review:

## Design / UX
1. **Typography without embedded fonts** (Item 1): font stacks reference "DM Sans"/"Playfair Display" with system fallbacks; no WOFF2 files embedded (no binary growth, no new static assets). Reviewers noted most visitors will get the fallback fonts. Revisit if exact font parity matters.
2. **Light-mode `--ink-muted` darkened to `#6e6055`** (diverges from the desktop token `#8c7b6e`) to meet WCAG AA on small text. Other tokens ported verbatim.
3. **Primary buttons use `--accent-hover` as background with a new `--on-accent` text token** (white in light, near-black in dark) — the only scheme that passed ≥4.5:1 in both palettes while keeping the terracotta look.
4. **Sepia theme skipped** (Item 6) — desktop sepia tokens live in `src/lib/themes` and porting them was disproportionate; toggle is light/dark/system only.
5. **Series stacks in the grid skipped** (Item 7 stretch) — conflicts with Item 5's shelves; large blast radius.
6. **"All Books" / go-home clears filters only, preserves search query and sort** — matches old pill behavior; full reset felt like data loss.
7. **`theme-color` meta is static light accent** (`#c2714e`); live theme-matching would require touching the CSP-hashed bootstrap script.

## API / backend
8. **Progress API shape** (Item 4): `chapter_index` doubles as page index for page-based formats (mirrors desktop persistence); web writes real scroll ratio for chapter mode. PUT accepts any non-negative index — the upper-bound check against `books.total_chapters` was removed because the reader navigates by live page-count and stale DB values caused silently-dropped saves; clients clamp on read.
9. **Completion side effects** unified in `commands.rs::apply_reading_progress(Option<&AppHandle>)` — web PUTs run the same completion-detection/activity-log path as desktop saves; the only thing a web-driven completion skips is the desktop-only window toast.
10. **Web reading sessions skipped** (Item 4 optional): `reading_sessions` exists but wiring session lifecycle into the web reader was not "near-free". Stats page still shows desktop-derived stats only for time-based metrics.
11. **Continue Reading predicate** excludes `total_chapters = 0` books, aligned with `get_reading_stats`' finished-predicate, so no book can be simultaneously "finished" in stats and "in progress" on the shelf.
12. **Page-image/page-count cache headers are PIN-aware** (`no-store` with PIN, `private, max-age=3600` without) — protects book content after session expiry on shared browsers, at the cost of losing HTTP-cache reuse for preloaded pages on PIN setups.
13. **Cover cache headers are NOT PIN-aware** (`private, max-age=86400` both sizes): cover artwork is far less sensitive than page content, and `no-store` would force OPDS e-reader clients (Basic Auth per request; this machine runs OPDS+PIN) to re-download megabytes of covers per catalog view.
14. **Thumbnails** (Item 11) reuse the desktop's `THUMB_WIDTH = 320` / `thumb.jpg` convention; on-demand generation validates the write path against the covers root, uses atomic temp+rename writes, mtime freshness + TOCTOU re-check, and falls back to full bytes on any failure. Unknown/malformed `?size=` values are treated as `full` (lenient, last value wins) so OPDS clients/proxies appending params never 400.
15. **`GET /api/books/{id}` gained `file_size`** stat'd from disk at request time via `spawn_blocking` (no schema change); `null` on any error.

## Frontend architecture
16. **URL is the source of truth for library state** (`#/library?q=&series=&collection=&sort=`); bare `#` = canonical unfiltered home. Keystrokes use `history.replaceState`; discrete actions push real hash entries. Params are parsed from `location.href`'s raw fragment, not `location.hash` (Firefox percent-decodes the latter).
17. **`esc()` escapes `"` and `'`** in addition to text-node entities — one escaper for both text and attribute contexts.
18. **`api()` returns `null` only for handled 401s** (login already rendered); network/HTTP failures throw a typed error that every view renders visibly (toast + inline error, differentiated messages for unreachable vs HTTP error vs bad payload).
19. **All localStorage/sessionStorage access goes through `safeStorage*` helpers** — storage-denied browser configs must not crash the app.
20. **Service worker caches the app shell only**; `/api` and `/opds` are never intercepted. `CACHE_VERSION` embeds a content hash of the shell assets, enforced by a CI test that recomputes the hash — shipping changed assets without bumping fails the build. Install/runtime fetches bypass the HTTP cache (`cache: 'reload'`/`no-cache`).
21. **PWA secure-context caveat**: service worker + install require https or localhost; the primary LAN use case (`http://192.168.x.x:7788`) gets manifest/icons benefits (iOS add-to-homescreen) but no offline shell. Documented in sw.js; no TLS added.
22. **CSP**: theme bootstrap inline script is allowed via sha256 hash (no `unsafe-inline`); the hash is verified against the actual `index.html` script text by a CI test.

## Process notes
23. TDD was strict red→green for all Rust endpoints/queries; frontend "tests" are Playwright acceptance scripts (9 scripts, ~240 assertions total, in the session scratchpad — they are session artifacts, not committed). Two agents noted writing script and implementation concurrently rather than strictly test-first; red state was still demonstrated for the load-bearing assertions.
24. Known pre-existing issues surfaced but NOT fixed (out of scope): `cargo clippy --features mobi` fails locally on missing `mobi.h` (environment gap, reproduced on base commit); `/api/books` takes ~8s under load with a ~2000-book library (serialization + no pagination — candidate for a future item); pdfium page rendering is serialized server-side (~3.5s/page under contention).
25. A pre-existing bug was fixed opportunistically in Item 5's round: `showLibrary()` destroyed the collections screen's series-row click-through by unconditionally resetting filter state (broken since the initial web UI commit).
