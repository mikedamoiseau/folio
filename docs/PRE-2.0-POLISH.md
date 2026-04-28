# Pre-2.0 Polish Checklist

A living checklist for the work that makes Folio *feel finished* before tagging
**2.0**. The roadmap features are essentially closed (only #40 Split View
remains in Phase 8); what's left is the kind of polish that matters for
perception, not feature count.

Each section is sized rough. Pick what fits the schedule — the four highest-
leverage items are starred (★).

---

## 1. First-run experience ★

The app currently drops new users onto an empty Library. They have to figure
out import + library-folder location on their own. A small welcome flow
turns "looks unfinished" into "ships with intent".

- [ ] **First-launch detection** — store a `folio.firstRunComplete` flag in
  localStorage; show onboarding once
- [ ] **Welcome dialog** — what Folio is, formats supported, where the
  library folder lives (with "Change…" button), pointer to Settings for
  advanced options
- [ ] **Sample book** — bundle one short public-domain EPUB so users land
  on a non-empty library and can click *Read* immediately. Alice in
  Wonderland from the existing MOBI corpus is a candidate (rights are
  clear).
- [ ] **Empty-library CTA improvement** — current `EmptyState` in
  `src/screens/Library.tsx` could grow a "Try the sample book" button
  alongside Add / Import
- [ ] **Settings tooltip pass** — short hover-tooltips on non-obvious
  options (scroll mode, dual-page, manga RTL, custom CSS)

**Sizing:** ~1.5–2 days. Most of the work is the welcome flow + bundling.

---

## 2. Empty states everywhere ★

`EmptyState` exists and is used *only* in Library. Other surfaces show blank
panels or shimmer placeholders forever.

- [ ] **Reader without bookmarks** — "No bookmarks yet — press `b` to
  add one here"
- [ ] **Reader without highlights** — same treatment
- [ ] **Search with zero results** — friendly hint to broaden query
  (verify, may already be partial)
- [ ] **Activity Log empty** — first launch
- [ ] **Reading Stats empty** — no reading sessions logged yet
- [ ] **Collections empty** — sidebar default
- [ ] **OPDS catalog: no results / unreachable** — friendlier than a raw
  error toast
- [ ] **Profile with empty library** — distinguishes from "no profiles"
  in multi-profile setups

**Sizing:** ~1 day. `EmptyState` already exists; mostly wiring + i18n.

---

## 3. Error recovery & friendly messages

`friendlyError()` exists but coverage is uneven. Some flows still show raw
backend strings.

- [ ] **Audit `friendlyError()` callers** — every `setError` / toast call
  should go through it. Grep for any that don't.
- [ ] **Missing-file dialog polish** — already in Reader; verify it
  triggers cleanly for *all* filesystem-error cases (locked file, denied
  permission, drive ejected mid-read), not just absent files
- [ ] **Backup destination unreachable** — S3 401, FTP timeout, WebDAV
  5xx. Friendly recovery suggestion ("Check credentials in Settings →
  Backup")
- [ ] **OPDS catalog timeout / 5xx** — "Catalog is unreachable. Try again
  later or pick a different one."
- [ ] **Bulk import failures summary** — when 50 books are imported and 3
  fail, show *which* failed and why (verify edge cases:
  password-protected zips, corrupt EPUBs)
- [ ] **Console error sweep** — 4 `console.error`/`warn` calls in
  `Reader.tsx` swallow user-facing context. Decide per-callsite: surface
  as toast or accept as silent (and document why)

**Sizing:** ~1.5–2 days.

---

## 4. Accessibility sweep ★

Phase 9 added the *hooks* (LiveRegion, aria-*, focus traps). What hasn't
been verified is the **end-to-end experience**. 26 files touch a11y
attributes — coverage is uneven.

- [ ] **Run with VoiceOver (macOS)** — open Library, navigate the grid,
  open a book, navigate chapters, add a bookmark, search. Note what's
  confusing or silent.
- [ ] **Run with NVDA (Windows)** — same flow
- [ ] **Tab order audit** — Settings panel, Edit Book dialog, Bulk Edit
  dialog. Sensible stops? Any keyboard traps?
- [ ] **Focus-visible rings** — every focusable element should show a
  visible ring; many `focus:ring-*` classes exist but coverage isn't
  100%
- [ ] **Skip links** — Library has a search input bound to `/`, but a
  "Skip to main content" link helps keyboard-only users
- [ ] **Reduced-motion** — `prefers-reduced-motion` should disable page-
  turn animations, shimmer loaders, and fade transitions
- [ ] **Color contrast** — sample warm-paper + dark themes against WCAG
  AA for body text, ink-muted, accents

**Sizing:** ~1–1.5 days. The work is mostly *finding* problems; fixes are
small per item.

---

## 5. Performance audit

`VirtualBookGrid` is in place — the rest is measure-and-document.

- [ ] **Cold-start time** — icon-click → interactive Library, with 0
  books and with 1k books. Acceptable? Record the number.
- [ ] **EPUB continuous mode on a long book** — 600+ page novel: time-
  to-first-paint, idle memory, scroll smoothness
- [ ] **PDF zoom/pan jank** — pdfium re-render at high zoom on a
  graphics-heavy PDF
- [ ] **Library grid with 1k+ books** — virtualized; verify scroll FPS
  and that cover-image loading doesn't thrash
- [ ] **Search across a large book** — backend response time + render
  time for 200 results
- [ ] **Memory ceiling** — open EPUB → close → open PDF → close → open
  MOBI → close, in a loop. Memory should plateau, not climb.

**Sizing:** ~1 day to measure + record. Fixes scoped per finding.

---

## 6. i18n quality

EN/FR have identical 540-key sets (verified via `jq paths(scalars)`). Coverage
is fine; *quality* and *robustness* are what's left.

- [ ] **FR strings reread by a French speaker** — auto-translation drift
  from when keys were added in EN-first
- [ ] **String length** — verify FR fits in current button widths and
  doesn't overflow on labels like "Toggle dual-page spread". Future
  longer locales (DE/ES) will surface the same issues; checking now is
  cheap.
- [ ] **Pluralization** — `i18next` ICU forms used correctly? `{{count}}
  match` vs `{{count}} matches` should respect locale plural rules, not
  English branching
- [ ] **Date / number formatting** — `Intl.DateTimeFormat` /
  `Intl.NumberFormat` with the active locale, not hardcoded `en-US`
- [ ] **RTL preview** — even without shipping Arabic/Hebrew, layout
  shouldn't break with `dir="rtl"`. (Manga-mode RTL works for paginated
  books; check the rest.)

**Sizing:** ~half a day for the audit; fixes per finding.

---

## 7. Visual & UX consistency

Papercuts that reviewers notice on a 2.0 demo.

- [ ] **Spacing audit** — pick a screen, measure padding/margins on 5
  buttons. All multiples of 4px? Any one-offs?
- [ ] **Icon weight consistency** — SVG strokes are mostly `1.5` or `2`.
  Pick one per size and stick with it.
- [ ] **Animation timing** — durations should cluster (150 / 250 / 400
  ms), not be ad-hoc
- [ ] **Toast vs dialog vs inline error** — codify when each is used;
  drift is visible
- [ ] **Settings panel grouping** — re-skim with fresh eyes after the
  recent reorg. Any obviously-better grouping for an orphan setting?
- [ ] **Dark mode pass** — open every screen in dark mode. Hunt for low-
  contrast text, missing dark-bg overrides on borders, white flash on
  chapter loads.

**Sizing:** ~1 day.

---

## 8. Bug bash hygiene

- [ ] **Issue tracker triage** — every open issue: defer post-2.0, fix
  now, or close as won't-fix. Don't ship 2.0 with a "soon" pile.
- [ ] **TODO sweep** — `git grep -nE 'TODO|FIXME|XXX'`. Per comment:
  file an issue, fix, or delete.
- [ ] **Console output in dev** — open WebView devtools and watch
  console during normal usage. Any noise?
- [ ] **Drag-and-drop edge cases** — drop a folder, drop a corrupted
  file, drop 100 files at once
- [ ] **Profile switching mid-read** — does Reader handle the rug-pull
  gracefully?

**Sizing:** ongoing — schedule a focused 1-day session once everything else
lands.

---

## 9. Pre-tag housekeeping ★

- [ ] **README** — still matches what the app does? Screenshots current?
- [ ] **CHANGELOG** for 2.0 — assemble from `git log --grep="^feat\|^fix"`
  since 1.0 / latest tag
- [ ] **Version bump** — `package.json` + `src-tauri/Cargo.toml` +
  `src-tauri/tauri.conf.json` to `2.0.0`
- [ ] **Release notes draft** — what users see on update; lead with
  marquee features (MOBI, Nav History, the rest of Phase 8), bury Rust
  refactors
- [ ] **Pre-push hook** — already exists per `CLAUDE.md`; verify still
  passes clean
- [ ] **CI matrix** — confirm `release.yml` builds cleanly on macOS arm64,
  macOS Intel (without MOBI), Linux, Windows
- [ ] **License & attribution** — libmobi (LGPL), pdfium (BSD), unrar
  (RARLAB) — credits in a visible Settings → About section
- [ ] **Privacy doc** — if you collect anything (telemetry, OPDS server
  logs), state it; if not, state *that*. Users care.

**Sizing:** ~1 day for the actual tag.

---

## Recommended subset

If you can only do four sections, do **★ items**: First-run experience,
Empty states, Accessibility sweep, and Pre-tag housekeeping. That's roughly
**4–5 days** and covers the four things that most affect the "feels like a
2.0" perception. The remaining sections become 2.0.x cleanup or ride along
opportunistically.

## Total

If everything: **~9–11 focused days.**
