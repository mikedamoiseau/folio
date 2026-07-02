# Changelog

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

## [2.5.0] - 2026-07-02

A trust-and-feedback release driven by a full UX audit of the first-run →
import → organize → read → catalog/settings path. The themes: destructive
actions are now reversible or confirmed (never silent), every async action
reports its outcome, and error/empty states are built rather than blank.

### Added
- **Undo for deletes.** Deleting a book, deleting a multi-selection, and removing a book from a collection now show a brief **Undo** toast; the book is hidden immediately and the actual removal only fires after the window, so an undo reverses it before anything irreversible happens (no file is deleted).
- **Settings search.** A search box at the top of Settings filters the collapsible sections by name and keyword (e.g. "pin", "css", "backup") and expands matches.
- **Reader header overflow menu.** The reader header is grouped (navigate / content / display) with low-frequency actions tucked into a `⋯` menu instead of a flat row of icons.
- **Continuous-load progress.** Continuous-scroll reading shows a real "Loaded X / N chapters" counter (backed by per-chapter progress events) instead of an indeterminate spinner.
- **Catalog connection test.** Adding a custom OPDS catalog validates the URL and runs a pre-flight fetch/parse (including private/LAN feeds) before saving, so a bad or unreachable feed is caught at add time. A no-catalogs empty state offers a shortcut to the preset picker.
- **OPDS download size.** Catalog download links show the file size when the feed reports it.
- **Plugin folder writability check.** Granting a plugin a write folder now verifies the folder is actually writable (enforced in `plugin_enable`, not just the UI) before recording the grant.

### Changed
- **Confirmations are styled, not native.** A reusable `ConfirmDialog` replaces the browser `confirm()` for destructive decisions — profile delete (also now disabled for the active/default profile), bulk delete (with count), and catalog removal.
- **Bulk edit is opt-in per field.** Each field has an explicit checkbox; only checked fields are written, with a banner and per-field warning when the selection has differing values — no more silent mass-overwrite. Mixed detection runs over the whole selection, not just the visible subset.
- **Save feedback everywhere.** Editing book metadata confirms with a "Saved" toast; settings toggles that previously swallowed persistence errors now revert and surface the failure; the web-server PIN shows an "Unsaved" indicator and saves on blur so it isn't lost on close.
- **Backup Save vs Test split.** The single "Save & Test" button is now separate **Save** and **Test connection** actions with independent results, so a save failure is distinguishable from a connection failure.
- **Import errors are actionable.** Failures show a friendly message (not a raw backend string), persist instead of vanishing in 4s, and offer **Retry**; partial-batch failures highlight the failed count and stay visible; the onboarding import step shows a banner + retry on empty/error/cancelled instead of getting silently stuck.
- **Reader recovery & polish.** Chapter-load errors show a recoverable card with **Try again**; the missing-file dialog is a single consolidated prompt; a content skeleton renders while a chapter loads; a just-created highlight can be removed from its toast; the settings button shows an open state.
- **Grid/organize.** Dragging a book onto a collection confirms with a toast; the delete confirmation shows the cover and full title; the selection is preserved while in selection mode; the select checkbox no longer overlaps the card action buttons; tag-filter counts respect the other active filters; empty results distinguish "no books yet" from "filters hide everything"; the edit-dialog error is a sticky top banner.

### Fixed
- **Clear-filters now clears tag filters too** — previously a tag-only filter survived "clear all filters".
- **Invalid nested button** in the catalog row (a `<button>` inside a `<button>`) split into siblings, fixing keyboard/click behavior.
- **Web-server port** out-of-range values show an inline range error instead of silently clamping to the boundary.
- **Blank pages in reader.** Page images are delivered as `blob:` URLs, but the CSP `img-src` never allowed `blob:`, so under enforced CSP (production builds) every page rendered as a broken image (a blank page with just a "Page N of M" box) — all formats, all profiles. `blob:` added to `img-src`. Worked in `tauri dev` (relaxed CSP), which is why it shipped.
- **Silent page-load failures.** The page `<img>` had no `onError` handler, so an image that failed to render showed only the browser's broken-image state with no visible error. It now surfaces the error overlay.

## [2.4.0] - 2026-06-18

A backup-and-restore release. Library restore now reconstructs the whole
library — not just books — and exported backups are far smaller. Several
restore paths that silently dropped data (or failed outright) are fixed.

### Added
- **Full restore.** Restoring a backup now brings back reading progress, bookmarks, highlights, collections, and tags in addition to books and covers. Restore is a best-effort, non-destructive merge: rows referencing a book that wasn't imported are skipped, and re-importing the same backup is safe (idempotent). Backed by a new `restore_secondary_data` helper in `folio-core`.
- **Linked books in restore.** Linked books (not copied into the library) are now restored as links to their original absolute path. The source volume must be mounted at the same path on the restoring machine. Previously they were silently dropped.

### Changed
- **Smaller backups.** Library exports now ship the lightweight grid thumbnails rather than full-resolution covers — on a ~2,000-book library the cover payload drops from ~1.1 GB to ~150 MB. Restored covers are the 320px thumbnail; full-resolution covers are re-derivable by re-importing from source files.
- **Large-file exports.** Book files ≥4 GB no longer abort the export mid-write (ZIP64 is now forced for stored entries), so full backups of large libraries produce a valid, extractable archive.
- **Cleaner PDF metadata.** PDF import now ignores junk embedded metadata from tool-generated files: a bare-UUID Title falls back to the filename, and a URL Author (e.g. an ImageMagick homepage) is dropped.

### Fixed
- **Restore worked at all.** `library.json` is written as an object (`{ version, books, ... }`) but restore parsed it as a bare array, so every restore errored and the UI silently bounced back to the file picker. Restore now parses the object (and still accepts a bare array for older backups).
- **Library refreshes after restore.** The grid now re-fetches automatically once a restore completes, instead of showing stale contents until the next manual reload.

## [2.3.0] - 2026-06-17

An extensibility release. Folio gains a sandboxed plugin system (Rhai scripts
with an explicit, consent-gated permission model), a typed lifecycle event bus
underpinning it, and resilient network behaviour for metadata enrichment and
OPDS. Imports get a fast skip-before-hash path for unchanged files, and caches
are unified behind a single managed abstraction with stats and a clear-all
control.

### Added
- **Plugin system.** Folio can now run user-installed plugins written in [Rhai](https://rhai.rs), scoped by an explicit permission model and gated behind a consent dialog. Plugins declare capabilities in a manifest and are granted them per-install; a new **Settings → Plugins** panel (EN/FR) lists installed plugins, surfaces requested permissions, and manages consent. The desktop host exposes plugin commands over IPC and ships example plugins.
  - **Capabilities** landed incrementally: `read:highlights` and `write:files` (with a highlight-exporter example), then `import:books` plus network access, enabling an OPDS auto-download plugin that pulls books from a remote feed.
  - Built on a typed **lifecycle event bus** in `folio-core` — command paths emit structured events (import, enrich, etc.) that plugins and internal observers subscribe to, replacing ad-hoc hooks.
- **Library book counts.** The library view shows the total book count and an imported-vs-linked breakdown.
- **OPDS conditional requests.** Book feeds now send weak ETags and honour `304 Not Modified`, so unchanged feeds skip re-downloads. Backed by a `book_etag_pairs` DB helper.

### Changed
- **Fast re-import (skip-before-hash).** Re-importing an unchanged source file now skips before hashing when the source path, size, and mtime are unchanged — much faster folder re-scans on large libraries. New `source_path` / `size` / `mtime` columns back the fast path, which self-heals on mtime drift and falls through to hash dedup when the cheap check misses.
- **Resilient enrichment HTTP.** All metadata-provider requests route through a `send_with_retry` loop with backoff and `Retry-After` handling; a new `RateLimited` error variant surfaces exhausted 429 retries. The scan UI shows provider-retry feedback during enrichment so backoff is visible rather than looking like a hang.
- **Unified cache abstraction.** Memory and disk page caches now sit behind a single `ManagedCache` trait and registry (`MemoryCacheAdapter`, `DiskPageCacheAdapter`). Settings gains a unified cache-stats view and a clear-all control wired over IPC.

### Fixed
- **macOS SMB accented-filename imports.** Imports/reads of files with accented (non-ASCII) names from an SMB share could fail with `os error 2`; this is a known macOS smbfs Unicode bug, and the import/read error now explains the cause and suggests mounting over NFS instead of presenting it as a Folio failure.

### Internal
- **CI hardening.** Lint and formatting are now enforced workspace-wide: `cargo clippy --workspace --all-targets` and `cargo fmt --all --check` cover both `folio` and `folio-core`. The Rust toolchain is pinned to `1.96.0` in `rust-toolchain.toml` and matched in CI so local and CI never drift. A `docs-on-merge` workflow keeps in-repo docs in sync after PR merges.
- **Documentation.** Added a plugin-system architecture guide and documented the workspace-wide fmt/clippy checks and toolchain pin.

## [2.2.1] - 2026-06-02

### Fixed
- **arm64 macOS app crashed on launch unless `brew install libmobi` was present.** The Apple Silicon release dynamically linked libmobi against the absolute Homebrew path `/opt/homebrew/opt/libmobi/lib/libmobi.0.dylib`, so any user without that exact install hit a `dyld: Library not loaded` abort before the app even started. The arm64 macOS build now builds libmobi from source as a static archive (mirroring the Windows build — `BUILD_SHARED_LIBS=OFF`, bundled miniz merged in) and links it statically, so the `.app` is self-contained and needs no Homebrew install. `folio-core/build.rs` gains a `LIBMOBI_STATIC` opt-in for this; local dev and Linux keep dynamic linkage.

## [2.2.0] - 2026-06-02

A performance release focused on large libraries: cover images and the book
grid no longer scale their cost with the number of books, so scrolling stays
smooth into the thousands.

### Performance
- **Cover thumbnails for the library grid.** Covers are now downscaled to a 320 px-wide JPEG thumbnail (`{book_id}/thumb.jpg`) on import and served to the grid, instead of decoding the full-resolution cover — often 1,500–1,900 px wide (~5 MP) — just to paint a 160 px card. Existing libraries are backfilled in a background thread at startup; covers already at or below 320 px are left untouched (a cheap header probe, no full decode), so only the genuinely large ones are re-encoded. The full-resolution cover is still used in the book detail view. Cuts cover decode work by roughly 95 % and, on a ~1,800-book library, total cover storage from ~950 MB to a few tens of MB.
- **Virtualized library grid.** The main library view renders only the rows near the viewport instead of mounting every book card into the DOM at once. A new windowed grid (built on `react-virtuoso`; it chunks the flat book list into rows whose column count tracks the window width and reuses the page's existing scroll container, so the Continue Reading / Discover headers still scroll above it) keeps DOM size, style recalculation, and paint cost proportional to what is on screen rather than to library size — scrolling stays smooth into the thousands of books. Library cards were also lightened: the hover action buttons mount only on hover/focus, and the badge backdrop-blur (expensive to composite) was dropped.

## [2.1.0] - 2026-05-30

A feature release on top of the 2.0 platform: side-by-side reading, richer
library cues, and a production-hardened remote-access server (audit trails, a
GDPR data export, and backup pre-flight checks). The `2.0.1`–`2.0.3` tags in
between were `folio-core` crate point-releases; this is the next user-facing app
release.

### Performance
- **PDF page disk cache** (ROADMAP "perf + comics" #3). Rendered PDF pages now survive app restarts. On first open of a PDF, `prepare_pdf` renders the first ten pages at a fixed canonical width (2400 px) into the shared `page-cache/{hash}/` namespace and returns the page count so the reader can skip a second `get_pdf_page_count` round-trip. Subsequent reads hit disk and resize down to the viewport width, bypassing pdfium entirely. Cache misses render at the canonical width, write best-effort, and trigger a coalesced background eviction every 25 lazy writes. Eviction reads filesystem-truth via `book_disk_size_bytes` so a stale manifest snapshot cannot drift the size budget. Shares the same Settings size cap and LRU / 7-day eviction as the comic cache. Linked / unhashed PDFs (or storage errors) gracefully fall back to live render at the viewport width — pre-spec performance preserved.
- **Page images served at viewport resolution over binary IPC** (ROADMAP P2). PDF / CBZ / CBR pages are now resized to the viewport width on the Rust side, transmitted as raw bytes through Tauri IPC, and wrapped as `Blob` + `URL.createObjectURL` in the frontend. Cuts IPC payloads by roughly 70–90 % on typical pages, removes the base64 encode/decode round-trip, and lowers steady-state renderer memory. Landed across m1–m4: viewport-resize support in `folio-core`, binary page commands, frontend blob URLs with revoke-on-eviction, and retirement of the legacy data-URI commands.
- **Reader screen code-splitting** (F-4-6). The Reader route is lazy-loaded via a Vite dynamic import, so the library/home view no longer ships the reader bundle up front — smaller initial download and faster first paint.

### Added
- **Split view** (ROADMAP #40). Read two books side-by-side. A new header button (or the `\` shortcut) toggles split mode; the companion pane opens a library picker so the pairing can be any two books. Each pane writes its own reading progress (the persistence guard collapses to primary-only when both panes happen to show the same book). The active pane gets a subtle accent ring so keyboard navigation routes there; click the other pane to swap focus. Split state and companion bookId persist per book in `localStorage` so reopening restores the layout. Includes a swap-panes button on the primary header (navigates to the companion bookId and seeds the new primary's split state) and an X to close the companion pane from the companion header. Built from a structural extraction that split the 2200-line Reader screen into a thin shell + a reusable `ReaderPane` component, then layered the layout shell + book picker + focus routing on top across four milestones.
- **Page-thumbnail strip** for image-based formats (CBZ / CBR / PDF). A toggleable horizontal strip below the reader shows every page; clicking a thumbnail jumps to that page (and stamps navigation history). Header button + `m` shortcut. Per-book open/closed state persists in `localStorage`.
  - Virtualized: only thumbnails inside the visible window plus overscan render as DOM nodes, so a 1000-page book stays cheap.
  - Module-level per-book blob-URL cache survives strip close/reopen — second open is instant.
  - Directional prefetch + distance-from-current load ordering: pages near the current page decode first, and a scroll-direction-biased prefetch window keeps the next viewport already decoded by the time it lands.
  - Per-tile loading / error / loaded states with retry-on-click for failed tiles. Empty tiles render transparent (no border / background) so the strip stays quiet while many pages decode.
  - Subtle motion: strip slide-up enter, per-tile fade-up, active-tile shadow + accent number label, edge mask fading thumbs into the surface. All animations honour `prefers-reduced-motion`.
- **Reading status indicators** (F-1-4). Each library card's top-right pill now conveys reading status by colour: **Active** (sage, shows %) for books read within the last 14 days, **Paused** (amber, shows %) for in-progress books idle longer than that, and **Finished** (a checkmark) for completed books. Unread books show no pill. Status is derived at render time from existing progress + last-read data — no new storage, no database writes. A pure `getReadingStatus` helper carries the logic with unit tests for every state and the 14-day boundary.
- **Smart collection auto-suggestions** (F-1-6). Folio proposes collections based on your reading history and library shape, bridging the gap between manual collections and rule-based smart collections.

### Security & remote access
- **GDPR data export endpoint** (F-3-6). `GET /api/data-export` on the embedded web server returns a timestamped ZIP of your personal data — books metadata, reading progress, bookmarks, highlights, the activity log, and settings — as a single JSON document. Credentials are never exported (backup configuration and metadata-provider API keys are redacted; the web PIN lives in the OS keyring). The endpoint requires authentication and is refused entirely unless a web PIN is configured, so it never serves your data on an open server.
- **Web server login audit trail** (F-3-1). Login attempts against the remote-access server are recorded to a dedicated `web_session_log` (timestamp, IP, user-agent, outcome) so you can review access. Web PIN-screen attempts log all outcomes; OPDS reader-app connections log only failures. The PIN is never written. Entries are pruned after 90 days / 5,000 rows, and the trail is readable via `GET /api/audit/login-history`. Logging is best-effort and never blocks or fails a login.
- **Backup connectivity verification & secret rotation** (F-3-7). Backup credentials are tested before they are saved, with an atomic DB + keychain update and rollback on failure, so silent backup misconfiguration no longer goes unnoticed.

### Internal
- **Structured activity audit log** (F-2-2). A typed `ActivityEvent` enum replaces loose string-based activity writes and is the single source of truth for the action/entity wire contract consumed by the frontend; adds activity-log export and configurable pruning.
- **Observability primitives** (F-2-3). Structured logging via `tracing` is initialised at startup (with a retained appender guard) and previously-silent `eprintln` warnings are routed through it; key operations (`import_book`, `enrich_book`) are instrumented.
- **IPC response metrics middleware** (F-4-8). A ring-buffer metrics layer times hot-path Tauri commands (count, avg, p95, max, slow-call warnings) and exposes them via a `get_ipc_metrics` command, with panic-safe, poison-recovering aggregation.

### Fixed
- **PageViewer re-animated the current page on layout reflow.** The slide-in animation re-fired when the load-spread effect re-ran for reasons other than a real page turn (for example, the thumbnail strip mounting and shifting the page-image cache key). Tracked the last-animated page index so the animation only plays on actual navigation.
- **Split-view overlay scoping, focus trap, and swap symmetry.** Post-review fixes on top of the initial split-view ship: the TOC focus trap now uses a ref instead of `getElementById("toc-sidebar")` so two ReaderPanes can render a sidebar without colliding on the same DOM id; the TOC sidebar/backdrop and the missing-file dialog scope to their pane (`absolute` over a `relative` pane root) instead of the whole viewport, so opening the companion's TOC no longer plants the sidebar over the primary pane; `swapPanes` leaves the old primary's pairing intact (`companion-A = B`) so navigating back to A restores the same split layout instead of degenerating into a same-book split. The localStorage contract moved into `src/lib/splitView.ts` with 14 unit tests covering key derivation, read/write, swap round-trip, effective companion fallback, and the persistence collapse.

## [2.0.3] - 2026-05-18

### Added
- `folio_core::opds_feed` — public primitives for rendering OPDS Atom feeds: `xml_escape`, `mobi_ext_and_mime`, `cover_mime`, `book_to_entry`, `wrap_feed`, `EntryUrls`, `FeedKind`, and the two content-type constants. Lets external tooling render OPDS feeds from `Book` rows without depending on the desktop app's `web_server` module.

## [2.0.2] - 2026-05-18

### Added
- `folio_core::db::provision_library(path)` — public entry point for creating a library file and applying the canonical schema without taking a connection-pool handle. Idempotent.

## [2.0.0] - 2026-05-03

A milestone release. The 1.x line shipped the reader and the library; 2.0 is the platform underneath it. The desktop app now sits on top of `folio-core`, a separately-tested Rust crate with a pluggable `Storage` trait and structured errors — the same machinery that powers the embedded web server. New formats (MOBI / AZW / AZW3), a back/forward navigation stack, a curated OPDS preset picker, and a refactored remote-access toggle round out the user-facing additions. UX has had a measurable consistency pass (4 px spacing grid, clustered animation durations, normalized icon strokes, codified error surfaces).

### Added
- **MOBI / AZW / AZW3 reading** (ROADMAP #34) — Mobipocket and Kindle formats via libmobi, with a parsed-book in-memory cache, capped memory, and word-count metadata. Available on Linux, arm64 macOS, and Windows (statically linked, no separate libmobi install). Intel macOS remains unsupported.
- **Navigation history** (ROADMAP #36) — back/forward stack across the HTML reader (EPUB / MOBI) and the image/PDF reader. Same-position pushes truncate the forward branch correctly; same-chapter and search-driven jumps stamp history; state resets on book switch so navigation cannot leak between books.
- **OPDS preset picker** — curated catalog of 13+ vetted OPDS feeds (multilingual: English, French, Hungarian, Bulgarian) addable in one click from an inline picker in the catalog browser. Includes Project Gutenberg, Standard Ebooks, Wikisource, Elephant Editions, Feedbooks, ManyBooks, ebooksgratuits, and others. Pure preset filter and facet helpers behind the UI.
- **Independent Web UI / OPDS toggles** — the Remote Access settings replace the single start/stop button with two checkboxes. Web UI and OPDS can be enabled independently and the embedded server reconciles itself accordingly. Existing single-toggle settings auto-migrate on first launch.
- **Library section toggles + collapsible series groups** — Continue Reading and Discover sections can each be hidden, and grouped series are collapsible.

### Changed
- **`folio-core` crate extraction** (ROADMAP #63) — `db`, `models`, `error`, `paths`, the format parsers (EPUB / PDF / CBZ / CBR / MOBI), `page_cache`, `enrichment`, providers, `opds`, `openlibrary`, `backup`, and `sync` now live in a separately-tested crate. The Tauri layer (`src-tauri/`) owns commands, the tray, and the embedded web server; everything else is reusable Rust.
- **Pluggable `Storage` trait** (ROADMAP #64) — book file I/O, cover images, page cache, EPUB inline images, and backup file reads all go through a `Storage` trait with atomic overwrites and key-validation guards. The DB `file_path` column now stores storage keys rather than raw paths. Foundation for cloud-backed storage backends without touching command handlers.
- **Structured error types across the Rust backend** (ROADMAP #55) — every Tauri command returns a typed `FolioError` enum (`NotFound`, `PermissionDenied`, `InvalidInput`, `Network`, `Database`, `Io`, `Serialization`, `Internal`) serialized at the IPC boundary as `{kind, message}`. `friendlyError()` routes by `kind` first, with all 8 categories translated in English and French. Web-server HTTP handlers map error kinds to correct status codes (404 / 403 / 400 / 502 / 500) instead of always returning 500.
- **UX consistency pass** — spacing locked to a 4 px grid (scanner test), SVG `strokeWidth` normalized to 1.5 / 2 (spinner exempt), Tailwind animation durations clustered at 150 / 200 / 300 ms, toast / inline / dialog error surfaces codified, dark-mode coverage scanner with Library red-banner fixes.
- **Settings reorg** — orphan Activity Log launcher folded into the Library section.
- **macOS tray responsiveness** — closing the window now minimizes instead of hiding so the macOS event loop stays alive and the tray menu remains responsive. `ExitRequested` handler prevents auto-exit when autostart and tray are enabled. The tray *Show* action recreates the window if destroyed.
- **Backup running flag via RAII guard** — `BACKUP_RUNNING` is now released through a guard so an early return or panic cannot leave the flag stuck.

### Fixed
- **Web server deadlock on auto-start** — the auto-start path held the `web_server_handle` mutex while calling `rebuild_tray_menu`, which also locks the same mutex. Since `std::sync::Mutex` is not reentrant, this deadlocked on every launch with the web server enabled, hanging all web-server IPC calls.
- **App no longer panics on startup DB failures** — database initialisation errors now propagate through the Tauri setup closure instead of crashing via `.expect()`.
- **Web-server auto-start survives poisoned locks** — a poisoned mutex at launch logs a warning and skips web-server auto-start rather than crashing.
- **Correct translations for archive corruption, chapter loading, keychain failures, JSON parse errors** — several mis-wired error kinds and translation keys were silently falling through to raw English messages. French-locale users now see localised copy for these paths.
- **External EPUB links open in the default browser** — previously they tried to navigate inside the reader iframe.
- **OPDS catalogs over LAN / loopback** — user-added catalogs are trusted so cover images render correctly from LAN / loopback hosts; UA now uses a Mozilla-prefixed string accepted by legitimate catalog servers.
- **OPDS preset URL hygiene** — broken / unreachable presets pruned, working ones (Feedbooks, ManyBooks) restored once verified end-to-end.
- **MOBI hardening** — cache memory cap honored, OPDS cover MIME tightened to webp, MSVC build fixed by casting `MOBIFiletype` enum tail through `u32`, word-count error mapping corrected.
- **Library multi-select state visibility** — selection mode now shows clearly; missing i18n key added; series sections refresh live after edits.
- **Settings server status sync** — server status refreshes on focus and the checkbox state syncs back on a failed start.
- **Library file migration warning** — opting out of file migration when changing the library folder now warns the user before proceeding.
- **EPUB inline image keys disambiguated** — inline images from different EPUBs no longer collide in the cache; keys now hash the resolved zip path.

## [1.4.1] - 2026-04-15

### Added
- **Tag filter in library toolbar** — searchable multi-select combobox to filter books by tags. Select one or more tags; books must have all selected tags to appear (AND logic). Selection persists to localStorage.
- **Chip-on-comma tag input** — in the Edit Book dialog, typing a comma immediately creates a tag. Pressing Enter also works. Clicking Save commits any pending tag text before saving metadata. Supports comma-separated batch input (e.g., "japan, manga" creates two tags).
- **Eager tag loading** — tags and book-tag associations are loaded alongside the library for instant client-side filtering.

### Fixed
- **Tags not saving in Edit Book dialog** — tags typed in the input were silently lost because the Save button didn't commit pending tag text. Only pressing Enter (with no visual cue) would save tags.
- **Web server deadlock on auto-start** — the auto-start code held the `web_server_handle` mutex while calling `rebuild_tray_menu`, which also locks the same mutex. Since `std::sync::Mutex` is not reentrant, this deadlocked on every app launch with web server enabled, making all web server IPC calls (status, start, stop) hang forever.
- **System tray responsiveness on macOS** — window close now minimizes instead of hiding, keeping the macOS event loop alive so the tray menu stays responsive. Added `ExitRequested` handler to prevent auto-exit when autostart and tray are enabled. Tray "Show" recreates the window if destroyed.

## [1.4.0] - 2026-04-11

### Added
- **Remote Access (Web Server)** — browse and read your library from any device on the local network. Embeds an HTTP server with PIN authentication, JSON API, OPDS catalog, and a built-in web UI. See `docs/WEB_SERVER_API.md` for full documentation.
  - JSON REST API for books, covers, chapters, pages, downloads, collections
  - OPDS Atom XML catalog (compatible with KOReader, Calibre, Moon+ Reader)
  - Embedded web UI (login, responsive book grid, EPUB/PDF/comic reader)
  - PIN-based auth with OS keychain storage, session tokens, HTTP Basic Auth for OPDS
  - Rate limiting on login (5 attempts / 5 min per IP)
  - QR code for easy mobile access
  - Auto-start on app launch if previously enabled
  - Graceful shutdown when app closes
  - Settings panel with PIN, port, start/stop toggle, URL + QR display
- Security headers on all web server responses (CSP, X-Frame-Options, X-Content-Type-Options)
- EPUB HTML sanitization for web serving (ammonia, prevents XSS)
- Path traversal protection on image endpoints
- Streamed file downloads (no memory exhaustion on large files)
- OPDS pagination (50 books per page)
- **Bulk book actions** — select multiple books in the library grid, then delete in bulk. Selection mode with select all/deselect all.
- **Unified toast notifications** — consistent bottom-center toast system replacing ad-hoc notification patterns. Auto-dismiss with pause-on-hover.
- **Screen reader live regions** — aria-live announcements for chapter changes, bookmark confirmations, and import progress.
- **Database migration versioning** — schema_version table tracks applied migrations for safe future schema changes.
- **PDF cache memory limits** — LRU cache now evicts by total memory (200 MB cap) in addition to entry count.
- **Bounded background threads** — background operations (enrichment, backup, sync) use tokio's bounded thread pool instead of unbounded OS threads.
- **Highlight popup smart positioning** — color picker popup detects both top and bottom viewport edges to avoid clipping.
- **User-created themes (#48)** — save, name, load, rename, and delete custom visual themes. Each theme captures color tokens, font family, font size, and typography settings. Settings panel restructured: typography controls merged under Appearance accordion. Up to 50 saved themes with full validation and case-insensitive naming.
- **Web server favicon** — Folio app icon served as favicon on the web UI.
- **Accordion animation** — settings panel accordions now animate open/close with smooth height transitions.
- **Accordion content panels** — subtle background on expanded accordion sections for better visual separation.

## [1.3.0] - 2026-04-02

### Added
- **Comic page cache (CBZ/CBR)** — pages are extracted to a disk cache on first open. Subsequent page loads read from disk (~1-5ms vs ~50-500ms from archive). Three-layer eviction: LRU by book count (5), configurable size cap (default 500 MB), age expiry (7 days). Manage in Settings > Library.
- **PDF text search** — Cmd/Ctrl+F now works in PDFs using pdfium text extraction, with the same search UI as EPUB (snippets, click-to-navigate, match highlighting).
- **Page turn animations** — optional slide animation when turning pages in PDF/CBZ/CBR. Configurable in Settings > Page Layout. Adjacent pages preloaded in background for smooth transitions.
- **Page load timeout with retry** — pages that take too long show a "taking longer than usual" hint at 8s, with a retry button at 30s. Retry is often instant since background rendering continues and caches the result.
- **Loading skeleton placeholders** — library grid shows shimmer skeletons while books load, replacing the blank loading state.
- **Provider priority ordering** — drag enrichment providers up/down in Settings to control priority order.
- **Comic Vine enrichment provider** — comprehensive comics metadata (American, European, manga). Requires free API key.
- **BnF (Bibliothèque nationale de France) enrichment provider** — excellent coverage for French editions via SRU API, no key needed.
- **Linked books** — option to reference books at their original location without copying. Link badge on cards, source filter, "Copy to library" action in edit dialog.
- **Library cleanup** — Settings > Library > "Check for missing files" scans for broken entries and removes them with automatic backup.
- **Backup restore picker** — restore from automated backups via dropdown or manual backup via file picker.
- **Multi-language support (i18n)** — English and French translations across all components, with flag dropdown language switcher.
- **Diagnostic page logging** — enable with `FOLIO_DEBUG_PAGES=1` (backend) or `localStorage.setItem("folio-debug-pages", "1")` (frontend) for page load pipeline debugging.
- **Route transition animation** — subtle fade + slide-up when navigating between Library and Reader.
- **Empty state entrance animation** — staggered book stack pop-in when library is empty.
- **Progress bar fill animation** — BookCard progress bars animate from zero on mount.
- **Catalog loading spinner** — spinner overlay when browsing to an OPDS catalog.

### Changed
- **SFTP backup provider** — added alongside existing S3 and FTP providers.
- **Backup progress** — real-time step and file count reporting during backup.
- **Context-aware library sections** — "Continue Reading" and "Discover" hidden when viewing a collection or series.
- **Sharp comic zoom** — physical DOM resizing instead of CSS scale for sharp images at any zoom level.
- **PDF rendering** — JPEG encoding (quality 90) for faster page loads and smaller transfers.

### Fixed
- **In-flight request deduplication** — concurrent page requests for the same page share a single IPC invoke, preventing pdfium render queue buildup.
- **Preload debounce** — adjacent page preloads wait 500ms to prevent queue buildup during fast navigation.
- **Consistent page turn animation** — spread div stays mounted during loading so animation plays for both cached and uncached pages.
- **Backdrop blur standardized** — all 16 modal/panel overlays now use consistent `backdrop-blur-sm`.
- **Button radius standardized** — main action buttons unified to `rounded-xl`.
- **SVG icon strokes normalized** — strokeWidth 1.75/2.5 → 2, icon sizes 17×17 → 18×18 across 7 files.
- **BookmarkToast colors** — replaced hardcoded blue with design system accent tokens.
- **Form input focus glow** — subtle accent ring on focus for better visibility.
- **Library filter focus contrast** — upgraded from `border-accent/40` to full `border-accent`.
- Highlight popup smart positioning (viewport-aware clamping).
- Search results navigation with match counter and prev/next arrows.
- Archive decompression limits (zip bomb protection for EPUB/CBZ/CBR).
- Transaction boundaries for book import (prevents orphaned files on DB failure).
- Backup secret atomicity (keychain errors now propagated instead of silently ignored).
- OPDS URL resolution via RFC-compliant `url::Url::join()`.
- Activity log pruning combined count+age query.
- Scroll-to-match for in-book search results.
- CBR archive validation (entry count and size limits).
- PDF search result caching for faster repeated searches.

### Security
- Archive decompression limits: max 10,000 entries, 100 MB per entry for EPUB/CBZ/CBR.
- Backup secret atomicity: keychain write failures now return errors instead of creating config/secret desync.
- OPDS URL resolution hardened against protocol-relative URL injection.

## [1.2.0] - 2026-03-28

### Added
- **Dual-page spread / Manga mode** — side-by-side two-page view for all formats (CBZ, CBR, PDF, EPUB). Cover page displayed solo, subsequent pages paired. Manga mode swaps page order and arrow key direction for RTL reading. Toggle in reader header and Settings > Page Layout.
- **Series grouping** — books with series metadata are automatically grouped in the sidebar and via a "Series" sort option in the library grid, sorted by volume.
- **Custom user fonts** — import TTF/OTF/WOFF2 font files via Settings. Custom fonts appear alongside built-in options in the font picker.
- **Literata font** — added as a built-in reading font (designed by Google for e-reading).
- **Bookmark naming & editing** — name bookmarks via an expanding toast after creation (`B` key), or edit names inline in the bookmarks panel.

### Changed
- **Settings panel reorganized** — grouped into fewer accordions: Appearance (theme + custom CSS), Text & Typography (font size + font + line height/margins/etc.), Page Layout (paginated/continuous + dual-page + manga).

### Fixed
- Clipboard copy and JSON export for collection sharing
- Page-based bookmark progress calculation for CBZ/CBR/PDF

## [1.1.0] - 2026-03-26

### Added
- **CBR format support** — RAR-based comic book archives
- **PDF support** — page-by-page rendering via bundled pdfium
- **CBZ cover extraction** — first page used as cover thumbnail
- **Page viewer** — unified component for PDF/CBZ/CBR with zoom (0.5×–4×), pan, and keyboard/mouse wheel navigation
- **Collections** — manual and automated collections with sidebar, drag-and-drop, custom icons and colors, export as Markdown/JSON
- **Sort & filter** — sort by date added, title, author, last read, progress, rating, format; filter by format, status, rating
- **Tags** — freeform labels with autocomplete
- **Highlights & annotations** — inline text highlighting (5 colors) with notes, export as Markdown
- **Book metadata editing** — edit title, author, cover, series, language, publisher, year, tags
- **Keyboard shortcuts** — library and reader shortcuts with `?` help overlay
- **Focus mode** — hide all UI chrome with `D`, edge-reveal controls, auto-hide cursor
- **Page zoom** — Ctrl+scroll or Cmd+/- to zoom, pan when zoomed, reset on page change
- **Mouse wheel navigation** — scroll to turn pages in PDF/CBZ/CBR (300ms debounce)
- **Copy-on-import** — books copied into managed library folder with configurable path
- **Multi-file import** — bulk file picker with progress indicator
- **Bulk folder import** — recursive scan for supported formats
- **Remote file import** — import from URL (direct download)
- **OPDS catalog browsing** — browse Project Gutenberg, Standard Ebooks, and custom OPDS catalogs with search, navigation, and one-click download
- **Library export/backup** — metadata-only or full backup as ZIP, import from backup
- **Remote backup** — incremental sync to S3 and FTP via OpenDAL
- **Reading stats dashboard** — time spent reading, pages/chapters per day, books finished, reading streaks, 30-day bar chart
- **OpenLibrary integration** — pull descriptions, genres, ratings; auto-match by title+author
- **Auto-enrichment** — ISBN lookup, title+author search, filename parsing, background scan queue with progress and cancel
- **Multi-provider enrichment** — EnrichmentProvider trait, Google Books API provider, provider settings in Settings
- **ComicInfo.xml parsing** — extract metadata from CBZ comic archives
- **Recently opened** — top 5 most recently read books shown at library top
- **Share collections** — export as Markdown or JSON
- **Book recommendations** — Discover section with popular books from configured OPDS catalogs
- **Multiple profiles** — separate libraries, each with own database, library folder, and settings
- **Sepia theme** — warm parchment preset alongside light and dark
- **Custom color themes** — pick background + text color, auto-derive remaining tokens
- **OpenDyslexic font** — bundled accessibility font with weighted letterforms
- **Star ratings** — 1-5 star rating per book, sort and filter by rating
- **Full-text search** — Cmd/Ctrl+F to search EPUB content with highlighted matches
- **Advanced typography** — line height, page margins, text alignment, paragraph spacing, hyphenation
- **Custom CSS override** — inject CSS into EPUB rendering
- **Continuous scroll mode** — all EPUB chapters in one scrollable document
- **Estimated time to finish** — WPM-based reading time estimate in EPUB reader footer
- **Activity log** — persistent log of all data-changing operations, filterable in Settings

### Fixed
- Path traversal prevention in cover image extraction
- Cover image extension allowlisting
- DOMPurify removed (redundant with ammonia backend sanitization)
- Bookmarks table index for query performance
- Chapter index and scroll position validation
- Scroll restoration tied to specific chapter to prevent race conditions
- Keyboard handler conflicts between reader and panels
- Focus outlines and disabled button contrast (accessibility)
- User-friendly error messages for backend failures
- Book file existence validation before reading
- Loading overlay during import to prevent race conditions
- Focus trap and ARIA attributes on TOC sidebar
- Font size slider accessibility (aria-valuetext)
- Base64 image encoding replaced with asset protocol to prevent memory issues
- EPUB zip archive caching to avoid reopening on every page turn
- DB connection pool size and timeout configuration
- Book import timeout/size guard

## [1.0.0] - 2026-03-25

### Added
- EPUB 2 & 3 import via file picker and drag-and-drop (Tauri v2 native events)
- Library screen with book grid, cover art, reading progress indicator
- Search/filter books by title or author
- Remove books from library with confirmation
- Reader screen with chapter navigation (buttons + keyboard shortcuts)
- Table of Contents sidebar
- Reading progress auto-saved to SQLite and restored on reopen
- Light / dark theme toggle with system preference detection
- Adjustable font size (14–24px) and font family (serif/sans-serif)
- XSS sanitization of EPUB HTML via `ammonia`
- Duplicate EPUB detection (UNIQUE constraint on file path)
- GitHub Actions CI/CD: lint, test, cross-platform release builds
