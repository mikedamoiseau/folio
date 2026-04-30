# Ebook Reader — Feature Roadmap

## Phase 1: Foundation (Storage & Organization)

These features fix core limitations and unlock future work.

### 1. Copy-on-Import with Configurable Library Folder — **Done**
- ~~On import, copy the file into an app-managed library directory~~
- ~~Add a setting for the destination folder (default: `~/Documents/Folio Library/` or platform equivalent)~~
- ~~Allow changing the folder in settings — existing files should be migrated when the folder changes~~
- This is the foundation for remote files, backup/export, and general reliability
- *Prerequisite for: Remote Files, Library Export/Backup*

### 2. Multi-File Import Picker — **Done**
- ~~Add a file picker button that supports selecting multiple files at once (in addition to the existing drag-and-drop)~~
- ~~Currently, drag-and-drop supports multiple files~~
- ~~Show a progress indicator when importing multiple files (e.g., "Importing 3 of 12...")~~
- ~~Report per-file results: successes, skipped duplicates, and failures with reasons~~
- ~~Complements Copy-on-Import — bulk picking files that all get copied into the library folder~~

### 3. Collections — **Done**
- ~~Manual and automated collections, sidebar, drag-and-drop, icons/colors~~

### 4. Sort & Filter Options — **Done**
- ~~Sort library by: date added, last read, author, title, progress, format~~
- ~~Filter by: format, reading status (unread/in progress/finished)~~
- ~~Pairs naturally with collections — filters in the main view, collections in the sidebar~~

### 5. Tags — **Done**
- ~~Lightweight freeform labels orthogonal to collections (e.g., "to-read", "favorites", "borrowed", "lent-to-sarah")~~
- ~~Autocomplete from existing tags when assigning~~
- ~~Filterable in library view — searchable multi-select tag filter in toolbar (AND logic), chip-on-comma tag input in edit dialog~~

## Phase 2: Reading Experience

Improve the core activity — actually reading books.

### 6. Annotations & Highlights — **Done**
- ~~Inline text highlighting with color choices~~
- ~~Notes attached to highlights~~
- ~~Highlights panel/sidebar in reader~~
- ~~Export annotations as Markdown or plain text~~

### 7. Book Metadata Editing — **Done**
- ~~Edit title, author, and cover image for any book~~
- ~~Useful for poorly-formatted EPUBs or CBZ files with no metadata~~

### 8. Keyboard Shortcuts — **Done**
- ~~Library: navigate grid, open book, search, toggle sidebar~~
- ~~Reader: page navigation, toggle TOC, create bookmark~~
- ~~Display shortcut hints or a help overlay (e.g., `?` key)~~

### 8d. Floating Chapter Navigation — **Done**
- ~~Floating prev/next arrows on left/right edges of the EPUB reader~~
- ~~Auto-hide when bottom chapter nav is visible (IntersectionObserver)~~
- ~~Hidden in focus mode and for page-based formats (PDF/CBZ/CBR use PageViewer)~~

### 8c. Page Zoom — **Done**
- ~~Ctrl+scroll to zoom in/out on the current page~~
- ~~Zoom level indicator with reset button~~
- ~~Useful for PDF and comic formats (CBZ/CBR) with small text or detailed artwork~~
- ~~Pan/drag to navigate when zoomed in~~
- ~~Keyboard: Cmd/Ctrl + / − / 0 to zoom in/out/reset~~
- ~~Zoom resets on page change~~
- ~~Zoom-aware rendering: PDFs re-rendered at current zoom resolution; comics use physical DOM resizing (not CSS scale) for sharp images at any zoom level~~
- ~~JPEG encoding (90% quality) for ~10x faster PDF page loads and smaller transfers~~
- ~~In-memory LRU cache (20 entries) for rendered PDF pages~~
- ~~Remember zoom level per book (persisted to localStorage, restored on reopen)~~

### 8e. Go to Page — **Done**
- ~~Click the page label in the footer (e.g., "Page 5 / 45") to open an inline number input~~
- ~~Type a page number and press Enter to jump directly~~
- ~~Escape or click away to cancel~~
- ~~Works in both single-page and dual-page spread modes~~

### 8b. Mouse Wheel Page Navigation — **Done**
- ~~In the reader, use mouse wheel (scroll up/down) to go to previous/next page — same as arrow keys left/right~~
- ~~Works for page-based formats (PDF, CBZ, CBR)~~
- Debounced (300ms cooldown) so trackpad gestures don't rapid-fire
- Toggleable in settings (TBD — some users may prefer natural scrolling for EPUB)

### 10a. Do Not Disturb / Focus Mode — **Done**
- ~~Toggle in reader to hide all UI chrome (header, footer, progress bar) for distraction-free reading~~
- Suppress system notifications while active (macOS Focus/DND API — TBD)
- ~~Minimal edge-reveal controls — move mouse to top/bottom edge to briefly show header/footer~~
- ~~Hide cursor after 2s of inactivity~~
- ~~Keyboard shortcut: `d` to toggle, `Escape` to exit~~
- ~~Toggle button in reader header (clock icon)~~

## Phase 3: Import & Sync

Expand where books come from and how they persist.

### 11. Remote Files — **Partial** *(OPDS done)*
- Google Drive, Dropbox integration (OAuth flows)
- ~~Direct URL import (paste a link, app downloads the file)~~
- ~~OPDS catalog browsing (many free ebook sources use this protocol)~~
  - ~~Built-in catalogs: Project Gutenberg, Standard Ebooks~~
  - ~~Add custom OPDS catalog URLs (self-hosted Calibre servers, etc.)~~
  - ~~Browse, search, navigate sub-catalogs, pagination~~
  - ~~One-click download & import into library~~
- ~~Downloads into the library folder from Phase 1~~

### 11b. Linked Books (Read Without Importing) — **Done**
- ~~Option on import to keep the file in its original location instead of copying to the library folder~~
- ~~Settings toggle for default import mode (copy vs link) — applies to file picker, folder import, drag-and-drop~~
- ~~Linked books have full features: progress, bookmarks, highlights, metadata — only the file stays external~~
- ~~Visual badge on linked book cards (external-link icon) to distinguish from library-local books~~
- ~~Library filter: All / Imported / Linked~~
- ~~Graceful handling when file is missing (drive ejected, path moved): error toast with remove option~~
- ~~"Copy to library" action in Edit Book dialog to internalize a linked book later~~
- ~~Remote backup and ZIP export skip linked book files (metadata still included)~~
- ~~`is_imported` column in books table, translation keys in EN + FR~~

### 11c. Library Cleanup — **Done**
- ~~"Check for missing files" action in Settings > Library~~
- ~~Scans all books, removes ones where file no longer exists~~
- ~~Auto-backup of library metadata before cleanup~~
- ~~Missing-file dialog in Reader with "Remove from library" option~~
- ~~Especially useful alongside linked books (#11b)~~

### 11d. Backup Restore Picker — **Done**
- ~~Restore from automated backups via dropdown (lists backups from app data dir)~~
- ~~Restore from manual backup via file picker (replaces "Import from backup" flow)~~
- ~~Show backup date, type (pre-cleanup), and size~~
- ~~*Depends on: Library Cleanup (#11c), Library Export/Backup (#13)*~~

### 12. Bulk Import — **Done**
- ~~Scan a folder recursively for supported formats (.epub, .cbz, .cbr, .pdf)~~
- ~~skip duplicates~~ *(hash-based dedup silently returns existing book)*
- ~~Progress indicator for large imports~~

### 13. Library Export / Backup — **Done**
- ~~Export full library: metadata-only (small) or full backup with book files~~
- ~~Import from a backup archive~~
- ~~Useful for migration between machines~~

### 13b. Remote Backup Destinations — **Partial** *(S3, FTP, SFTP, WebDAV done)*
- ~~Backup to external services: AWS S3, FTP, SFTP (SSH), WebDAV — implemented via OpenDAL~~
- ~~Configurable destinations in settings — add/remove targets, provider-specific fields~~
- ~~Incremental backups (only changed book files since last backup; metadata always full set)~~
- ~~Real-time progress reporting during backup (step label + file count)~~
- ~~Partial upload recovery (file size comparison to detect interrupted transfers)~~
- ~~Concurrency guard (prevents double-backup corruption)~~
- ~~Secrets stored in OS keychain, scoped per provider~~
- ~~Activity log: success (with item counts) and failure logged~~
- Google Drive, Dropbox, network share (not yet)
- Scheduled automatic backups (daily/weekly) (not yet)
- *Depends on: Library Export/Backup*

### 14. Book Discovery & Catalog Search — **Done** *(via OPDS in #11)*
- ~~Search free/legal ebook catalogs directly from the app and one-click import into library~~
- ~~Browse by catalog: select a source, then browse/search within it~~
- ~~Unified search: search by title/author across all configured catalogs at once~~
- ~~One-click download & import: book goes straight into the library folder~~
- ~~Built on OPDS — the standard protocol used by most free ebook sources~~
- ~~Known OPDS-compatible sources: Project Gutenberg, Standard Ebooks~~
- ~~Allow users to add custom OPDS catalog URLs (for self-hosted Calibre servers, etc.)~~
- ~~Show available formats per result, prefer EPUB when available~~

### 15. Reading Position Sync / Multi-Device Sync — **Done**
- ~~Sync reading progress, bookmarks, and highlights across devices~~
- ~~Local-first design: sync uses the same remote provider configured for backup (S3, FTP, SFTP, WebDAV)~~
- ~~Per-book sync files at `.folio-sync/books/{file_hash}.json` — books identified by content hash so the same file on different devices syncs correctly~~
- ~~Pull on book open (non-blocking, 5-second timeout) — merges remote changes into local DB~~
- ~~Push on book close (fire-and-forget background thread) — uploads local state to remote~~
- ~~Last-write-wins merge with per-item `updated_at` timestamps; equal timestamps prefer remote for convergence~~
- ~~Soft delete with tombstone propagation — deleted bookmarks/highlights sync correctly across devices~~
- ~~Settings toggle: "Sync reading progress across devices" (disabled by default, requires backup provider)~~
- ~~Sync status display in Settings: last successful sync timestamp, user-friendly error messages~~
- ~~Activity log integration: sync_pull_success, sync_pull_failed, sync_push_success, sync_push_failed~~
- ~~Local-first device identity (UUID stored in settings, never depends on remote)~~
- ~~Schema-versioned sync files with forward-compatibility (unknown fields ignored, future schema versions rejected gracefully)~~
- Does not sync book files (that's what backup is for)
- No conflict resolution UI (LWW is deterministic)
- No scheduled sync or retry queue (v1 limitation — sync on open/close only)
- No tombstone garbage collection (soft-deleted rows accumulate; acceptable for v1)
- *Depends on: Remote Backup (Phase 3)*

## Phase 4: Discovery & Social

### 16. Reading Stats / Dashboard — **Done**
- ~~Time spent reading (track session duration)~~
- ~~Pages/chapters per day, books finished per month~~
- ~~Reading streaks~~, yearly goal (TBD)
- ~~Visual dashboard with charts (30-day bar chart)~~

### 17. Goodreads / OpenLibrary Integration — **Done** *(Multi-Provider)*
- ~~Pull richer metadata: descriptions, genres, ratings, cover art~~
- ~~Auto-match books by title+author via OpenLibrary search~~
- ~~One-click enrich from search results in edit dialog~~
- ~~New DB columns: description, genres, rating, isbn, openlibrary_key~~
- Goodreads sync not implemented (API deprecated/closed)
- ~~Auto-enrich on import via scan queue (ISBN lookup, title+author search, filename parsing)~~
- ~~Background scan queue with progress indicator and cancel~~
- ~~ComicInfo.xml parsing for CBZ metadata~~
- ~~Settings: auto-scan on import, auto-scan on startup~~
- ~~Per-book scan and "queue for next scan" actions~~
- ~~Multi-provider enrichment architecture (EnrichmentProvider trait)~~
- ~~Google Books API provider (free, good international/French coverage)~~
- ~~Provider settings: enable/disable, API keys, persisted in settings table~~

#### Future Enrichment Improvements
- Extract series/volume data from OpenLibrary and Google Books during enrichment scan
- Currently series data comes only from book file metadata and manual entry
- ~~User-configurable provider priority order (up/down arrow buttons in Settings)~~

#### 17b. Comic Vine Enrichment Provider — **Done**
- ~~Add Comic Vine (comicvine.gamespot.com) as an enrichment provider~~
- ~~Most comprehensive free public API for comics metadata (American, European, manga)~~
- ~~Good coverage of BD/Franco-Belgian comics~~
- ~~Requires free API key (rate-limited), disabled by default~~
- ~~Two-tier search: volumes first, then issues~~
- ~~*Depends on: Multi-Provider Enrichment (#17)*~~

#### 17c. BnF (Bibliothèque Nationale de France) Enrichment Provider — **Done**
- ~~Add BnF as an enrichment provider via their SRU API~~
- ~~Excellent coverage for French editions (books + BD)~~
- ~~Free and open, highly accurate national records, no API key needed~~
- ~~Dublin Core response format (simple XML parsing)~~
- ~~Search by ISBN or title+author with document type filtering~~
- ~~*Depends on: Multi-Provider Enrichment (#17)*~~

#### Future Enrichment Providers
| Provider | Coverage | API Key | Notes |
|----------|----------|---------|-------|
| ~~Comic Vine~~ | ~~Comics (American, some European)~~ | ~~Free key required~~ | ~~see #17b above~~ |
| ~~BnF~~ | ~~French national library~~ | ~~Free~~ | ~~see #17c above~~ |
| Bédéthèque | Franco-Belgian BD (best for French comics) | N/A (scraping) | bedetheque.com — no public API, fragile |
| ISBNdb | Very comprehensive, all formats | Paid | isbndb.com |
| MangaUpdates | Manga | Free | mangaupdates.com |
| AniList | Manga/anime | Free (GraphQL) | anilist.co |
| WorldCat | Library catalog, international | Free | worldcat.org/webservices |
| Hardcover | Modern book social network | Free (GraphQL) | hardcover.app |

### 18. Recently Opened — **Done**
- ~~Quick-access section at the top of the library: last 3-5 books read~~
- ~~One-click to resume where you left off~~

### 19. Share Collections — **Done**
- ~~Export a collection as a shareable reading list (title, author, optional notes)~~
- ~~Format: Markdown, JSON~~ (shareable link TBD)
- Import a shared list to see which books you have/are missing (TBD)

### 20. Book Recommendations — **Partial** *(Discover section)*
- ~~Discover section: popular/new books from configured OPDS catalogs, shown on library home~~
- ~~Cached 24h to avoid slowing down startup; fetched lazily in background~~
- ~~One-click download from Discover cards~~
- "More by this author" — search catalogs for same author (TBD)
- Genre-based suggestions from OpenLibrary subject tags (TBD)
- "If you liked X" personalized recommendations (needs critical mass of books)

## Phase 5: Multi-User

### 21. Multiple Libraries / Profiles — **Done**
- ~~Separate libraries for different users or contexts (work vs. personal)~~
- ~~Each profile has its own library folder, collections, settings, progress~~
- ~~Profile switcher in the app (top nav, next to Folio wordmark)~~
- ~~Create, switch, and delete profiles~~
- ~~Each profile gets its own SQLite database and library folder~~

## Phase 6: Remote Access

### 22. Built-in Web Server for Remote Library Access — **Done**

~~Embed a lightweight HTTP server so the library can be accessed from any device on the local network via a web browser.~~

**Core features:**
- Toggle in settings: "Enable remote access" (off by default)
- Starts a web server on a configurable port (e.g., `http://192.168.x.x:8080`)
- PIN/password protection (required to connect)
- Read-only web UI: browse library, view covers/metadata, read books in-browser
- Display the access URL + QR code in settings for easy connection from phones/tablets
- LAN only (no internet tunneling or port forwarding)

**OPDS server endpoint:**
- Serve the library as an OPDS catalog at `/opds` (e.g., `http://192.168.x.x:8080/opds`)
- Any OPDS-compatible reader app (KOReader, Calibre, Moon+ Reader, etc.) can connect and browse/download books
- Low additional effort — reuses existing `OpdsEntry`/`OpdsFeed` structs from `opds.rs`, just generates XML instead of parsing it
- Supports navigation feeds (by author, collection, format) and acquisition feeds (download links)
- Search endpoint via OpenSearch template

**Implementation notes:**
- Use `axum` or `warp` (async Rust web frameworks) — `tokio` is already a dependency
- Book content served via the same parsing logic used by the Tauri commands (EPUB chapters, PDF page images, comic pages)
- Cover images served from the existing `{app_data_dir}/covers/` directory
- Per-profile: each profile's server runs independently with its own library
- Desktop-only feature (not applicable to mobile builds from Phase 7)

**Out of scope (for now):**
- Internet/WAN access (port forwarding, tunnels, relay servers)
- Write operations from remote (importing books, editing metadata, syncing progress)
- User accounts or multi-user auth (single shared PIN is sufficient for LAN)

## Phase 8: Reader & Library Enhancements

### Quick Wins

#### 24. Sepia / Custom Color Themes — **Done**
- ~~Add a sepia (warm beige) theme preset alongside light and dark~~
- ~~Let users define custom background + text color combinations~~
- ~~Auto-derive remaining 7 tokens from bg + text via color mixing, with advanced overrides~~
- ~~Presets: Light, Sepia, Dark, Auto (system); plus full custom color editor~~

#### 25. OpenDyslexic Font — **Done**
- ~~Bundle the OpenDyslexic font (free, open-source) as a built-in font option~~
- ~~Designed for readers with dyslexia — weighted letterforms prevent visual rotation/flipping~~
- ~~WOFF2 files bundled locally (Regular, Bold, Italic, Bold-Italic); 3-button font selector in settings~~

#### 25b. Context-Aware Library Sections — **Done**
- ~~Hide "Continue Reading" and "Discover" sections when viewing a collection or series~~
- ~~These sections are only relevant in the full library view~~
- ~~When filtered to a collection/series, show only the matching books grid~~

#### 26. Star Ratings — **Done**
- ~~1-5 star rating per book~~
- ~~Interactive star picker in edit dialog; read-only star display on book cards~~
- ~~Sort by rating; filter by minimum rating (1+ through 5 stars)~~
- ~~Reuses existing `rating` column (user rating overrides enrichment value)~~

### Core Reading Gaps

#### 27. Full-Text Search Within a Book — **Done**
- ~~Cmd/Ctrl+F to search text content of the current book~~
- ~~Show results with context snippets, click to navigate to match~~
- ~~Works for EPUB (search chapter HTML); case-insensitive, 200 result cap~~
- ~~Search term highlighted in chapter content~~
- ~~PDF text search: uses pdfium text extraction, same UX as EPUB search (Cmd/Ctrl+F, snippets, click-to-navigate)~~

#### 28. Advanced Typography Controls — **Done**
- ~~Line height / line spacing (1.2-2.4)~~
- ~~Page margins / padding (0-80px)~~
- ~~Text alignment (left, justify)~~
- ~~Paragraph spacing (0-2em)~~
- ~~Hyphenation toggle~~

#### 29. Custom User Fonts — **Done**
- ~~Load user-provided TTF/OTF/WOFF2 font files via file picker~~
- ~~Font picker shows both built-in and user-added fonts in a single list~~
- ~~Fonts copied into app data directory; custom @font-face rules injected dynamically~~
- ~~Add and delete custom fonts from settings~~

#### 30. Continuous Scroll Mode (EPUB) — **Done**
- ~~Alternative to paginated chapter view — scroll through content continuously~~
- ~~Toggle between paginated and scroll modes in reader settings~~
- ~~Global preference stored in localStorage~~
- ~~Chapter dividers with title labels between chapters~~
- ~~Progress tracking: detects visible chapter via scroll position, saves chapter-level progress~~
- Future: lazy-load chapters on scroll instead of loading all upfront (optimization for large books)

#### 31. Estimated Time to Finish — **Done**
- ~~Display "X min left" / "X hrs left" in the reader footer~~
- ~~Word counts computed per chapter (stripped HTML via ammonia + tag stripping)~~
- ~~Uses 250 WPM default reading speed~~
- ~~Correctly handles continuous scroll mode (chapter-local progress)~~
- Future: compute personalized WPM from user's reading session history

### Organization & Format

#### 32. Series Grouping — **Done**
- ~~Automatically group books that share series metadata~~
- ~~Series section in sidebar: click to filter library to a series~~
- ~~"Series" sort option in library grid: groups books under series headers, sorted by volume~~
- ~~Series with 2+ books shown; non-series books displayed after series groups~~

#### 33. Activity Log — **Done**
- ~~Persistent log of data-changing operations: book imports, deletions, metadata enrichments, cover changes, backup/restore, collection edits, profile switches~~
- ~~Stored in a dedicated DB table: `activity_log (id, action, detail, book_id?, timestamp)`~~
- ~~Viewable in a modal panel accessible from settings~~
- ~~Filterable by action type with pagination (load more)~~
- ~~14 data-changing commands instrumented with activity logging~~

#### 34. MOBI/AZW Support — **Done**
- ~~Add MOBI/AZW/AZW3 format parsing (common for older Kindle libraries)~~
- ~~New `BookFormat::Mobi` enum variant, new parser module backed by libmobi~~
- ~~Extract metadata, cover, and chapter content (legacy Mobipocket v6 + KF8)~~
- ~~OPDS download with AZW vs AZW3 disambiguation via URL path~~
- ~~Conditional `.deb` / `.rpm` libmobi depends via Tauri config overlay~~
- ~~Fixture-gated end-to-end smoke tests + CI corpus fetch (SHA-256 pinned, retry-armed, cached)~~
- ~~**Windows MOBI support** via static libmobi linkage — libmobi built from source on the runner with CMake (`USE_ZLIB=OFF` + `USE_LIBXML2=OFF` keeps the static archive self-contained, baked into `folio.exe`). PR CI builds the same `mobi.lib` to catch MSVC regressions before tag-push.~~
- Available on **Linux**, **arm64 macOS**, and **Windows**. The **x86_64 macOS** build is the only release that intentionally ships without MOBI support — the macos-latest runner's Homebrew libmobi is arm64-only and won't link into an x86_64 target. Re-enabling Intel Mac would need a universal libmobi (Rosetta-cross-build or manual fat-dylib).

### Power User & Reader Enhancements

#### 35. Bookmark Naming & Editing — **Done**
- ~~Edit an existing bookmark to change its name (inline editing in bookmarks panel)~~
- ~~Two-step toast flow: quick-create unnamed via `b`, then optionally name from expanding toast~~
- ~~Inline editing in bookmarks panel: click name to edit, Enter/blur saves, Escape cancels~~
- ~~New `name` column in bookmarks table; `note` field preserved for future use~~

#### 36. Navigation History (Back/Forward) — **Done**
- ~~Browser-like back/forward buttons in the reader header (all formats)~~
- ~~`Alt+←` / `Alt+→` keyboard shortcuts (HTML + image/PDF)~~
- ~~Pure `navigationHistory` utility with browser-style stack semantics — `pushEntry` truncates the forward branch, `replaceCurrent` stamps the cursor entry without touching length or forward, capacity-bounded eviction~~
- ~~In-session navigation stack stamps the source's live chapter+scroll on the active entry, then pushes the destination — so back/forward returns to the exact passage the user left~~
- ~~Recorded jumps: TOC click, search-result navigation (same- and cross-chapter), highlight-panel jump, bookmark navigation, "Go to page" submission. Sequential prev/next chapter or page is *not* recorded (reading flow ≠ jump)~~
- ~~Cross-chapter search uses `recordJumpFrom(source, dest)` with an explicit pre-render source capture — destination scroll is committed only after the chapter renders and the match scroll is resolved~~
- ~~Unified paginated scroll save/restore denominator (`scrollHeight - clientHeight`), correcting a latent drift that also affected bookmark restore for long chapters~~

#### 37. Custom CSS Override — **Done**
- ~~Let users inject custom CSS into EPUB rendering~~
- ~~Global stylesheet override via textarea in settings~~
- ~~Applied as a `<style>` tag while reading EPUBs~~
- Per-book CSS override (TBD)

#### 38. Dual-Page Spread / Manga Mode — **Done**
- ~~Side-by-side two-page view for all formats (CBZ/CBR, PDF, EPUB in paginated mode)~~
- ~~Right-to-left page order option for manga (swaps spread order and arrow key direction)~~
- ~~Cover page always displayed solo; subsequent pages paired (2-3, 4-5, etc.)~~
- ~~Quick toggle in reader header bar + persistent setting in SettingsPanel~~
- ~~Global setting (applies to all books)~~
- ~~EPUB: CSS columns approach; page-based formats: two images side by side~~
- ~~Zoom and pan work on the spread as a unit with proper bounds clamping~~
- Future: preload next spread in background for smoother page turns
- Future: auto-detect landscape/wide images and display solo at full width

#### 38b. Settings Panel Reorganization — **Done**
- ~~Grouped settings into focused accordions: Appearance (saved themes + color presets + custom colors + typography + custom CSS), Page Layout (paginated/continuous + dual-page + manga), and others~~
- ~~Typography controls (font, line height, margins, alignment) merged under Appearance in #48~~

#### 39. Multi-Language Support (i18n) — **Done**
- ~~i18next + react-i18next infrastructure with browser locale auto-detection~~
- ~~English and French translations (373 keys)~~
- ~~Flag dropdown language switcher in library toolbar and reader header~~
- ~~All 17 components migrated to use `t()` calls~~
- ~~Error messages translated via `friendlyError(raw, t)`~~
- ~~Architecture supports adding new languages by adding a JSON file~~

#### 40. Page Turn Animations — **Done**
- ~~Optional slide animation when turning pages in PDF/CBZ/CBR formats~~
- ~~Configurable toggle in Settings > Page Layout (on by default)~~
- ~~Web Animations API on spreadRef — no wrapper div, no conflict with zoom/pan~~
- ~~Adjacent page preloading for instant transitions~~
- ~~Navigation locked during animation to prevent stuck states~~
- Future: additional animation styles (fade, curl)

#### 62. Comic Page Cache (CBZ/CBR Performance) — **Done**
- ~~Extract-on-open: extract all pages from archive to disk cache on first open~~
- ~~Subsequent page loads read from disk (~1-5ms vs ~50-500ms from archive)~~
- ~~Three-layer eviction: LRU by book count (5), total size cap (user-configurable, default 500MB), age expiry (7 days)~~
- ~~Settings UI: cache size limit dropdown, current usage display, clear cache button~~
- ~~New `prepare_comic` command for explicit extraction with loading indicator~~
- Future: thumbnail strip — scrollable page preview bar using cached full-res pages as source
- Future: extract-on-demand with prefetch — lazy extraction if upfront cost too high for 100+ page comics
- Future: image resizing/compression — serve at screen resolution, switch base64 to blob URLs
- Future: PDF disk cache — extend page_cache module for rendered PDF pages
- Future: frontend cache tuning — increase 10-entry LRU or make size-aware

#### 40. Split View / Side-by-Side Reading — **P2**
- Open two books simultaneously in a split pane
- Useful for reference material alongside primary reading
- Niche but valuable for academic use

## Phase 9: Hardening & Polish

Improvements identified via codebase audit (April 2026). Security and stability fixes from the audit are already shipped; these are the remaining items that improve robustness, accessibility, and UX polish.

### Robustness

#### 49. Database Migration Versioning — **Done**
- Replace current `ALTER TABLE ... let _ =` pattern with a `schema_version` table
- Track applied migrations by version number
- Enable safe non-additive schema changes (column renames, type changes)
- Implement rollback or backup-before-migrate strategy

#### 50. Transaction Boundaries for Import — **Done**
- ~~Wrap `import_book()` multi-step flow in an explicit DB transaction~~
- ~~Prevents orphaned files in the library folder when DB insert fails after file copy~~
- ~~Apply the same pattern to other multi-step commands (backup restore, bulk operations)~~

#### 51. Archive Decompression Limits (Zip Bomb Protection) — **Done**
- ~~Add `MAX_ARCHIVE_ENTRIES` constant (e.g., 10,000 entries)~~
- ~~Limit decompressed size per entry (e.g., 100 MB)~~
- ~~Stop reading entries if total decompressed size exceeds threshold~~
- ~~Prevents memory/disk exhaustion from maliciously crafted EPUB/CBZ/CBR archives~~

#### 52. PDF Cache Memory Limits — **Done**
- Current LRU cache evicts by count (20 entries) but not by memory
- 20 rendered PDF pages at max resolution could reach 400+ MB
- Add memory-based eviction (e.g., max 200 MB total cache size)
- Consider disk-based caching for older pages

#### 53. Thread Pool for Background Operations — **Done**
- Enrichment scans and backups currently spawn unbounded threads via `std::thread::spawn`
- Large batch operations could spawn 1000+ threads
- Use `rayon::ThreadPool` or Tauri's async runtime with bounded concurrency

#### 54. Backup Secret Atomicity — **Done**
- ~~Verify OS keychain write succeeds before saving non-secret config to DB~~
- ~~If keychain is inaccessible (user denied access, locked screen), return error~~
- ~~Prevents config/secret desync that makes backup permanently broken~~

#### 55. Structured Error Types (Rust) — **Done**
- ~~Replace `Result<T, String>` across all commands with a typed error enum (`FolioError` + `FolioResult<T>` in `src-tauri/src/error.rs`)~~
- ~~Consistent error categorization: `NotFound`, `PermissionDenied`, `InvalidInput`, `Network`, `Database`, `Io`, `Serialization`, `Internal`~~
- ~~`From` conversions for `rusqlite`, `r2d2`, `std::io`, `serde_json`, `reqwest`, `zip`, `quick_xml`, `keyring`, `opendal`, `uuid`, `chrono`, `url`, `image`, `tauri`, `EpubError`, `SyncError`, `PoisonError`~~
- ~~Structured JSON serialization at the Tauri boundary: `{kind, message}` — frontend `friendlyError()` maps by `kind` first, falls back to message matching~~
- ~~All 107 Tauri commands, parser modules, backup, sync, web_server, and `db::create_pool` now return `FolioResult<T>`~~
- ~~Unblocks `folio-core` extraction (#63)~~

### Accessibility

#### 56. Screen Reader Live Regions — **Done**
- ~~Add `aria-live="polite"` regions for dynamic content changes throughout the app~~
- ~~Chapter changes in EPUB reader (current chapter title + progress)~~
- ~~Bookmark/highlight creation and deletion confirmations~~
- ~~Import completion and scan progress updates~~
- ~~Toast notifications~~
- ~~*PageViewer page changes already have aria-live (added in audit)*~~

#### 57. Loading Skeletons — **Done**
- ~~Replace blank loading states with content-weighted skeleton placeholders~~
- ~~Library book grid: skeleton cards matching BookCard dimensions~~
- ~~Reader TOC sidebar: skeleton list items while chapters load~~
- ~~Book cover images: blur-up or placeholder while loading~~
- ~~Improves perceived performance, especially on first launch with large libraries~~

### UX Polish

#### 58. Unified Toast/Notification System — **Done**
- ~~Replace ad-hoc notification patterns with a consistent toast container~~
- ~~Persistent toast area (bottom-center) for non-blocking notifications~~
- ~~Auto-dismiss with pause-on-hover~~

#### 59. Search Results Navigation — **Done**
- ~~Add "1 of 12 matches" counter with prev/next arrows to in-book search (EPUB)~~
- Same pattern for OPDS catalog search results (TBD)

#### 60. Bulk Book Actions — **Done**
- ~~Checkbox selection mode in library grid (dedicated toggle)~~
- ~~Bulk actions: delete, tag, add to collection~~
- ~~Select all / deselect all~~

#### 61. Highlight Popup Smart Positioning — **Done**
- When text selection spans multiple lines, the highlight color picker popup may be offscreen
- Detect viewport bounds and reposition popup to opposite side when it would be clipped
- Same pattern for any floating UI anchored to text selections

## Phase 10: folio-core Refactor & Paid Server

Open-core transition: after Folio 2.0 ships, the free desktop/web app enters maintenance mode. Future development effort pivots to a commercial multi-user server product. The free app stays MIT-licensed; the paid server lives in a **private** repository and depends on `folio-core` as a git dependency pinned to a tag.

**Priority legend** (used throughout this roadmap for unfinished items): **P1** = do first, **P2** = do next, **P3** = planned but not urgent, **P4** = later / nice to have. Unmarked unfinished items default to P4.

### 63. `folio-core` Workspace Refactor — **P2**
- Extract shared library crate from `src-tauri/src/`
- Moves into core: `models`, `db`, parsers (`epub/pdf/cbz/cbr`), `enrichment`, `backup`, `page_cache`, `sync`
- Stays in `folio-desktop`: `commands.rs` (shrinks to thin adapters), Tauri-specific `AppState`, the current embedded web server
- `folio-core` has zero Tauri or axum dependencies — pure library
- Commands collapse to one-liners: `folio_core::library::list(&pool).map_err(Into::into)`
- Extraction is incremental within one focused push: parsers → models → db → enrichment → backup → orchestration. Each step is one reviewable commit.
- *Depends on: #55 Structured Errors (core needs a typed `CoreError`, not `Result<T, String>`)*

### 64. Storage Abstraction Trait — **P2**
- New `Storage` trait in `folio-core`, abstracting where book files, covers, EPUB inline images, and page caches live
- Default implementation: local filesystem (no behavior change for the free app)
- DB `file_path` column becomes a storage key, not a filesystem path
- Paid server adds S3/object-store implementation in its own crate
- Local disk cache layer in front of remote backends — page turns can't be raw S3 GETs
- *Depends on: #63*

### 65. `folio-server` — Headless Multi-User Server — **P3**

Separate binary, private repo. Sold as a self-host license first; managed hosting added later only if demand is validated.

**Scope:**
- Headless HTTP server (axum). Linux primary target; Windows server optional.
- **Multi-user accounts with isolated libraries** — professional model, not family/shared
- Proper auth (password + session, API keys for programmatic access), not PIN-only
- Admin cannot read user content (privacy requirement for professional use)
- User self-service: registration, password reset, email verification
- Per-user authenticated OPDS feeds
- Admin dashboard: users, quotas, storage usage, audit log
- Storage backends: local FS, AWS S3 (more later)
- Deployment artifacts: Docker image (primary), raw Linux binaries
- Audit log + per-user data export (GDPR-adjacent)
- Offline license key validation — phone-home activation only if piracy becomes a real problem

**Out of scope (at least initially):**
- SSO / LDAP / SAML
- Pure-SaaS hosted offering — high operator overhead; revisit only after self-host traction
- Write-from-web (upload, edit metadata) — follows current read-only design

**Distribution model:**
- **Step 1** — ship self-host license. No infra on our side, no uptime obligation, no security SLA.
- **Step 2** — add managed hosting as a premium tier once paying customers request it.
- Launching pure SaaS from day one is too risky for a solo operator (support load, uptime obligation, security exposure, solo SPOF).

*Depends on: #64*

## Recommended Implementation Order

The remaining free-app roadmap items ship first and mark Folio 2.0 as a stable cutoff. After that, development pivots to the refactor and the paid server. The sequence below avoids double-churn on the same code.

1. ~~**#55 Structured Error Types — P1, do first.** Blocks clean `folio-core` extraction. Typed errors must exist before moving functions into the core crate; otherwise every function signature gets rewritten twice.~~ **Done** — `FolioError` enum + `FolioResult<T>` in `src-tauri/src/error.rs`, all commands migrated.
2. **Remaining Phase 8 items** — ~~#34 MOBI~~ ✓, ~~#36 Navigation History~~ ✓, #40 Split View. Finishes the free app's feature set.
3. **Tag Folio 2.0.** Publicly marks the free app as stable — a clean mental and marketing cutoff before the paid pivot.
4. **#63 `folio-core` extraction.** Pure mechanical refactor once errors are typed. One focused push, incremental commits, each independently reviewable.
5. **#64 Storage abstraction trait.** Added *inside* the now-clean `folio-core` crate, with a single local-FS implementation. No user-visible change in the desktop app.
6. **#65 `folio-server` bootstrap** in the private repo. Pulls `folio-core` as a git dependency pinned to a tag.

### Why not storage-trait-first

Designing the `Storage` trait before the workspace refactor would mean touching files in `src-tauri/src/` that are about to be relocated during extraction — double churn on the same lines. The trait's shape also becomes clearer inside a pure library crate, where Tauri orchestration and direct filesystem access aren't mixed into the same modules.

### Free app maintenance mode (post-2.0)

- Bug fixes: yes
- Security patches: yes
- Dependency updates: yes
- Small UX polish: case by case
- New file formats: no
- New feature requests: politely declined

Document this publicly (README, issue template) to set user expectations before the pivot.

## Nice to Have

Lower priority features — high effort, niche audience, or dependent on other work.

### 41. Dictionary / Word Lookup
- Select a word in the reader to get a definition
- Hybrid approach: bundle lightweight offline dictionary (WordNet) + online API fallback (Wiktionary, Free Dictionary API)
- Optional: let users load StarDict dictionary files for full multilingual offline support
- Cross-platform — no dependency on OS-specific dictionary APIs

### 42. Vocabulary Builder
- Log every word looked up via the dictionary into a personal word list
- Record the word, definition, and source sentence/book
- Review screen with flashcard-style quizzing
- *Depends on: Dictionary (#41)*

### 43. Text-to-Speech
- Read current chapter aloud using system TTS
- Play/pause, skip forward/back, speed control
- Highlight current sentence as it's read

### 46. Annotation Export Integrations
- Export highlights and notes to Readwise, Notion, Obsidian via their APIs
- Extends existing Markdown/plain text export with direct service integration
- Readwise is a popular highlight aggregation service used by serious readers

### 47. Plugin / Hook System
- Fire events at key points: `on_import`, `on_book_open`, `on_book_close`, `on_annotation_created`, etc.
- Let user scripts react to events (similar to WordPress/Drupal hooks)
- Lightweight alternative to a full plugin SDK — extensible without modifying core code
- Enables custom automation: auto-tagging, post-import scripts, external sync

### 48. User-Created Themes — **Done**
- ~~Save, name, load, rename, and delete custom visual themes~~
- ~~Each theme captures color tokens, font family, font size, and typography settings~~
- ~~Settings panel restructured: typography controls merged under Appearance accordion~~
- ~~Theme list with color swatches, active theme indicator, inline rename/delete~~
- ~~Up to 50 saved themes, case-insensitive naming, full validation~~
- ~~Accessibility: keyboard navigation, ARIA live announcements, focus-visible rings, semantic list markup~~
- ~~Animated accordion sections with subtle background panels~~
- Import/export themes for sharing (future)

## Deferred: Mobile Apps

Originally Phase 7. **Deprioritized — P4.** Rationale: the built-in web server (Phase 6) already lets phones and tablets access the library from a browser on the LAN, and the paid `folio-server` (Phase 10) extends that further with multi-user auth. That covers the primary mobile use case without the cross-compilation cost. A native mobile port stays technically possible but is no longer a near-term goal.

### 23. Android & iOS App — **P4**

Tauri v2 supports mobile targets. The React frontend renders in a mobile WebView and the Rust backend compiles to mobile via `cargo tauri android init` / `cargo tauri ios init`. ~70% of the codebase works as-is; the work is in dependencies and UX.

**Works out of the box:**
- SQLite (rusqlite bundled) — no changes needed
- EPUB & CBZ parsing (zip, quick-xml, ammonia) — pure Rust
- React frontend — renders in mobile WebView
- Tauri IPC bridge — identical on mobile

**Dependency porting required:**

| Dependency | Effort | Issue |
|------------|--------|-------|
| pdfium-render | High | Needs platform-specific native binaries cross-compiled for Android (ARM64/ARM/x86) and iOS (ARM64) |
| unrar | Medium | C++ library requiring NDK/Xcode cross-compilation toolchain setup |
| keyring | Medium | Desktop credential stores (macOS Keychain, Windows Credential Manager) don't exist on mobile — switch to Android Keystore / iOS Keychain backends |

**Platform adaptation required:**
- **File storage:** `dirs` crate paths won't work on mobile; adapt to Android/iOS sandboxed storage
- **File picker:** `tauri-plugin-dialog` needs mobile-compatible file picker equivalents
- **Library path:** `~/Documents/folio/` assumption must be replaced with platform-appropriate app storage

**UX changes required:**
- Responsive layouts for phone and tablet screens (currently fixed 800x600 window)
- Touch interactions: swipe to turn pages, pinch to zoom
- Touch alternatives for keyboard shortcuts
- Mobile-appropriate navigation patterns

**Suggested approach (if revisited):** Ship an initial mobile version with EPUB + CBZ support only (skip PDF and CBR) to avoid the hardest native dependency work. Add PDF/CBR support in a follow-up once pdfium and unrar cross-compilation is solved.

## Summary

| Phase | Features | Status | Theme |
|-------|----------|--------|-------|
| 1 | Copy-on-Import, Multi-File Picker, Collections, Sort/Filter, Tags | 5 done | Storage & organization |
| 2 | Highlights, Metadata Edit, Keyboard Shortcuts, Focus Mode, Zoom | Done | Reading experience |
| 3 | Remote Files, Bulk Import, Backup, Book Discovery, Linked Books, Position Sync | 5 done, 2 partial | Import & sync |
| 4 | Stats, Goodreads, Recents, Share, Recommendations | 4 done, 1 partial | Discovery & social |
| 5 | Multiple Profiles | Done | Multi-user |
| 6 | Remote Library Access, OPDS Server | Done | Remote access |
| 8 | Sepia Theme, OpenDyslexic, Star Ratings, In-Book Search, Typography, Custom Fonts, Continuous Scroll, Time-to-Finish, Bookmark Naming, Series, Activity Log, MOBI, Nav History, Custom CSS, Dual-Page/Manga, Settings Reorg, i18n (EN+FR), PDF Zoom Quality, Go to Page, Animations, Comic Page Cache, Split View | 19 done | Reader & library enhancements |
| 9 | DB Migration Versioning, Transaction Boundaries, Zip Bomb Protection, PDF Cache Memory Limits, Thread Pool, Backup Secret Atomicity, Screen Reader Live Regions, Loading Skeletons, Toast System, Search Nav, Bulk Actions, Highlight Positioning, Structured Errors | 13 done | Hardening & polish |
| 10 | `folio-core` refactor, Storage trait, `folio-server` (private) | Not started — see Recommended Implementation Order | Open-core + paid server |
| N/H | Dictionary, Vocabulary Builder, TTS, Library-Wide Search, Annotation Exports, Plugins/Hooks | Not started (User Themes done) | Nice to have |
| Deferred | Android & iOS App (was Phase 7) | Deferred — web server covers the primary mobile use case | Mobile |
