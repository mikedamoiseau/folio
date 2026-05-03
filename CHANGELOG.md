# Changelog

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
