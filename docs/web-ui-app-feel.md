# Web UI — App Look & Feel Report

Audit date: 2026-07-14. Based on code review of `src-tauri/src/web_server/static/` (`index.html`, `manifest.json`, `app.css`, `app.js`) — no live inspection this pass.

Follow-up to [`web-ui-improvements.md`](./web-ui-improvements.md) (Items 1–15, all shipped on `feature/web-ui-revamp`). That report made the web UI **look** like Folio; this one makes it **feel** like a native app instead of a web page. Scope is mobile/tablet + installed-PWA (standalone) only — desktop browser is intentionally unaffected.

The **Shared Context** and every numbered rule in `web-ui-improvements.md` (§"Rules that apply to every item") apply here verbatim: vanilla JS/CSS only, assets embedded in the binary (Rust rebuild to see changes), new static files need three registrations, `CACHE_VERSION` content-hash bump on any shell-asset edit (CI-enforced), surgical changes, full CI suite before push. Read that section first.

## Status legend

| Mark | Meaning |
|------|---------|
| 🔲 | Planned — not started |
| 🚧 | In progress |
| ✅ | Done (merged) |
| ⏸️ | Deferred / descoped |

## Constraint: visual identity is frozen

The warm-paper / Playfair Display / terracotta identity (ported in Item 1) stays **untouched**. No palette, type, or spacing changes. Every item below is shell behavior, layout structure, and touch semantics only.

## Verdict (why it reads as a web page)

Chrome, scroll, and touch all use browser defaults. Primary nav lives as three ~20px icons crammed top-right of the header; nothing is pinned (header is `position:sticky`, the whole body scrolls); affordances are hover-only; there is zero safe-area handling. All fixable without touching the visual identity.

### Tells (observed in code)

| # | Tell | Evidence |
|---|------|----------|
| 1 | No bottom tab bar. Primary nav = 3× 20px icons in a crammed header | `navIconsHtml` app.js:3693; header render app.js:798 |
| 2 | Zero safe-area insets. No `env(safe-area-inset-*)`, no `viewport-fit=cover` | grep: none in css/js/html |
| 3 | Not a fixed shell. Header `position:sticky`, whole body scrolls, no `overscroll-behavior` → native pull-to-refresh reloads the SPA, rubber-band reveals edges | app.css:96; no `overscroll-*` anywhere |
| 4 | Hover-only feedback. Cards lift on `:hover`, no `:active`/press, no `@media(hover:none)` fork | app.css:137 |
| 5 | `100vh` not `100dvh`/`100svh`. Reader height fights mobile dynamic toolbars | app.css:207 |
| 6 | Instant `innerHTML` swaps between views. No push/pop transition (reader has slide anims; view→view is a hard cut) | `route()` app.js:365 |
| 7 | `apple-mobile-web-app-status-bar-style=default` — misses edge-to-edge themed bar | index.html:12 (accepted tradeoff in Item 13) |
| 8 | Small tap targets — sort `<select>` 6px pad, nav icons 6px (~32px, under the 44px min) | app.css:107, `.nav-icon` app.css:358 |
| 9 | iOS long-press callout / text selection not suppressed on chrome/cards (`-webkit-touch-callout`, `user-select` set only on the reader image) | app.css:220 |

---

## Tier 1 — the "it's an app" backbone

Highest leverage. These three together flip the feel; the rest is polish on top.

### Item A — Bottom tab bar for primary navigation  ✅

**Goal.** Move primary nav (Library / Collections / Stats) out of the top-right icon cluster into a fixed, thumb-reach bottom tab bar — the single strongest native signal. The top header shrinks to title + search.

**Scope.**
- New fixed bottom bar (`position:fixed; bottom:0`) with Library / Collections / Stats tabs (reuse the existing inline SVGs from `navIconsHtml`), active tab in `--accent`. Theme toggle stays in the top header (it is a setting, not a destination).
- Remove the collections/stats icons from `navIconsHtml`'s top-header cluster; keep theme toggle there.
- Tab bar renders on every top-level view (library, collections, stats) and is hidden in the reader (immersive) and on login. It reflects the active route from the hash.
- Only shown at narrow widths / standalone — desktop browser keeps the header cluster (`@media (max-width: …)` or a `hover:none`/`pointer:coarse` gate).

**Files.** `app.js` (`navIconsHtml`, a new `tabBarHtml`/`bindTabBar`, called from `showLibrary`/`showCollections`/`showStats`; hidden in `showReader`/`showLogin`), `app.css` (tab bar), `sw.js` `CACHE_VERSION` bump.

**Acceptance.** At 390px: fixed bottom bar with three tabs, active tab highlighted, tapping switches view; bar absent in reader and login; desktop (1440px) unchanged. Content is not obscured by the bar (pairs with Item C's content padding).

### Item B — Safe-area insets + edge-to-edge chrome  ✅

**Goal.** Respect notch / status bar / home indicator so chrome doesn't sit under system UI in standalone mode. THE tell of a web page pretending to be an app.

**Scope.**
- `index.html` viewport meta → add `viewport-fit=cover`.
- Pad `env(safe-area-inset-top)` on the sticky/fixed header, `env(safe-area-inset-bottom)` on the tab bar (Item A) and reader bottom toolbar, left/right insets where full-bleed.
- `apple-mobile-web-app-status-bar-style` → `black-translucent` (revisits the Item 13 accepted tradeoff) with a painted safe-area top strip so the status bar text stays legible in both themes.
- Any `index.html` edit forces a `CACHE_VERSION` bump; the CSP-pinned inline theme script must stay byte-identical (its sha256 is CI-verified).

**Files.** `index.html` (viewport + status-bar meta), `app.css` (inset padding), `sw.js` `CACHE_VERSION`, verify CSP hash test still passes.

**Acceptance.** Installed on a notched iPhone (or simulator): header clears the notch, bottom bar clears the home indicator, no content under system UI, status bar legible in light and dark. Desktop/non-notched unaffected (insets resolve to 0).

### Item C — Fixed app shell + kill overscroll  ✅

**Goal.** Pin chrome, scroll only the content region, stop the browser's pull-to-refresh reload and rubber-band overscroll.

**Scope.**
- `overscroll-behavior: none` on `html, body` (kills pull-to-refresh SPA reload + rubber-band edge reveal).
- Restructure the shell: header fixed/pinned at top, tab bar fixed at bottom (Item A), a single scrollable content region between them (`overflow-y:auto`, its own momentum scroll). Replace `min-height:100vh` / `height:100vh` with `100dvh` (Item 5 tell).
- Content region gets top padding = header height + safe-area, bottom padding = tab bar height + safe-area, so nothing hides under fixed chrome.
- Preserve existing scroll-restore (Item 10 / Item 14 replay): it now targets the content region's `scrollTop`, not `window.scrollY` — audit `scrollTo`/`scrollY`/`scrollTop` call sites in app.js (library scroll-restore, reader).

**Files.** `app.css` (shell layout, `overscroll`, `dvh`), `app.js` (scroll-restore retarget — grep `scrollTo(`, `scrollY`, `scrollTop` in the library/reader paths), `sw.js` `CACHE_VERSION`.

**Acceptance.** At 390px: pulling down past the top does not reload; content scrolls under a static header/tab bar; reader fills the dynamic viewport with no cut-off behind the URL bar; back-from-book still restores scroll position (Item 14 multi-page replay intact).

**As shipped (deviation from proposed scope).** The web UI is a single-root SPA that re-renders `#app` (header included) per view, and the header is already `position:sticky; top:0` (first element → effectively pinned). The two observable tells were solved directly: `overscroll-behavior:none` on `html, body` kills pull-to-refresh + rubber-band, and the reader's full-viewport surfaces moved from `100vh` to `100dvh` (with a `100vh` fallback). The proposed persistent-shell restructure (extract header into a shared shell, introduce a single dedicated scroll region, retarget every `window.scrollY` scroll-restore call site) was **not** done: it is a large, high-regression refactor that the acceptance criteria do not require (sticky header already pins chrome; window-scroll keeps scroll-restore intact). Scroll-restore was left on `window` and is unchanged.

---

## Tier 2 — touch polish

### Item D — Press states, not hover  ✅

**Goal.** Touch has no hover; give real press feedback and stop sticky-hover artifacts.

**Scope.** Guard the card lift / recolor behind `@media (hover: hover)`; add `:active { transform: scale(.97) }` (respecting `prefers-reduced-motion`) to cards, buttons, tabs, toolbar controls. `-webkit-tap-highlight-color: transparent` globally.

**Files.** `app.css`, `sw.js` `CACHE_VERSION`.

**Acceptance.** On touch: tapping a card gives a brief press-scale, no lingering hover state after the tap; desktop hover lift unchanged.

**As shipped (deviation from proposed scope).** Shipped the sticky-hover fix only: the `.card`/`.shelf-card` lift is gated behind `@media (hover: hover) and (pointer: fine)` (tighter than the proposed `(hover: hover)` — plain `(hover: hover)` still matches the common coarse-primary hybrids where a finger tap re-latches the lift). A residual case remains that pure CSS can't reach: a touchscreen laptop whose *primary* pointer is a trackpad reports `pointer: fine`, so a finger tap there can still latch the lift (media queries describe the primary device, not the pointer that fired `:hover`); eliminating that needs JS pointer-type tracking, deferred with the rest of the custom press-state work. The browser's **native** tap-highlight is kept as universal touch feedback. The proposed global `-webkit-tap-highlight-color: transparent` **+** custom `:active` press-scale were **not** shipped: removing the native highlight forces a bespoke press-state onto every tappable element, and each replacement hit an edge case that three review rounds kept surfacing — `transform` is a no-op on non-replaced inline links (`.series-link`), scrollable `<button>` lists (`.filter-panel-item`) flash-shrink mid-scroll, `<div role=button>` rows (`.card`, `.collection-row`) get no `:active` on iOS without a touch shim, and relocating the control `:hover` rules flipped cascade order against equal-specificity `.active` rules (a desktop regression). The card-lift gate is the highest-leverage, zero-cascade-risk piece and delivers tell #4's headline; a full custom press-state system would need JS pointer-type tracking and per-element handling, deferred as out of proportion to a Tier-2 polish item.

### Item E — 44px minimum tap targets  ✅

**Goal.** Meet the 44×44px touch-target floor on all interactive chrome.

**Scope.** Enlarge nav icons, reader toolbar buttons, sort `<select>`, chip-remove, filter buttons to ≥44px hit area (padding or min-width/height; visual size can stay smaller with a transparent expanded hit area).

**Files.** `app.css`, `sw.js` `CACHE_VERSION`.

**Acceptance.** Every interactive control ≥44px in the touch hit test at 390px; layout not visibly bulkier on desktop.

### Item F — Suppress long-press callout & stray selection  ✅

**Goal.** Chrome shouldn't trigger the iOS long-press callout or text-selection like a web document.

**Scope.** `-webkit-touch-callout: none` + `user-select: none` on chrome (header, tab bar, cards, toolbar). Keep selection enabled on actual reading content (chapter text, book description).

**Files.** `app.css`, `sw.js` `CACHE_VERSION`.

**Acceptance.** Long-pressing a card or tab does nothing; long-pressing chapter text still selects.

---

## Tier 3 — navigation feel  ⏸️ will not implement

Descoped 2026-07-15. Tier 1 (app shell) + Tier 2 (touch polish) delivered the "it's an app" feel; the remaining navigation-motion items are polish that the maintainer chose not to pursue. Both items are left documented below for anyone who revisits the decision.

### Item G — Directional view transitions  ⏸️

**Goal.** Convey navigation hierarchy: push (slide in from right) on drill-in, pop (slide in from left) on back — the app stack metaphor. Reuse the existing motion tokens.

**Scope.** Wrap view swaps in `route()` with the View Transitions API (`document.startViewTransition`) where supported, directional based on push vs pop (track nav direction from hash history), CSS-only fallback (reuse `--ease-page-turn` / `slide-in-left|right` keyframes already in app.css). Respect `prefers-reduced-motion` (instant swap). Must not regress the reader's own page-turn animation (Item 12).

**Files.** `app.js` (`route()` / a `renderView` wrapper), `app.css` (transition classes), `sw.js` `CACHE_VERSION`.

**Acceptance.** Library→detail slides in from the right; back slides in from the left; reduced-motion = instant; reader page-turn (Item 12) unaffected; no double-animation.

### Item H — Edge-swipe back gesture  ⏸️ optional

**Goal.** Native-style swipe-from-left-edge to go back on detail/reader.

**Scope.** Touch handler on detail/reader: horizontal drag starting within ~20px of the left edge triggers back (mirrors the header back button), with drag-follow + threshold. Must not conflict with the reader's existing swipe page-turn (Item 12) — edge-zone origin disambiguates. Descope if it fights the reader gesture.

**Files.** `app.js`, `app.css`, `sw.js` `CACHE_VERSION`.

**Acceptance.** Edge-swipe on detail navigates back; reader page-turn still works mid-page; no accidental back when turning pages.

---

## Suggested delegation batches

| Batch | Item(s) | Rationale |
|-------|---------|-----------|
| 1 | **A + B + C** (Tier 1 backbone) | Interdependent shell rewrite (tab bar height, safe-area padding, and fixed-shell content padding must agree). One branch, one PR. |
| 2 | **D + E + F** (Tier 2 touch) | All `app.css`-only, small, independent of Tier 1's structure. |
| 3 | **G** (view transitions) | ⏸️ Will not implement — `route()` change; descoped 2026-07-15. |
| 4 | **H** (edge-swipe back) | ⏸️ Will not implement — optional; descoped 2026-07-15. |

Each batch: feature branch (`feature/web-ui-app-shell` for batch 1), full CI suite locally before push, `CACHE_VERSION` bump verified, PR to main.
