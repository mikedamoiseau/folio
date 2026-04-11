# Changelog

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

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
