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
- Filterable in library view (tags visible in edit dialog; library-level tag filter TBD)

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
- Remember zoom level per book or per format (TBD)

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

### 11b. Linked Books (Read Without Importing)
- Option on import to keep the file in its original location instead of copying to the library folder
- Checkbox in import dialog: "Keep file in original location" (unchecked by default)
- Linked books have full features: progress, bookmarks, highlights, metadata — only the file stays external
- Visual badge on linked book cards to distinguish from library-local books
- Graceful handling when file is missing (drive ejected, path moved): clear error, metadata preserved
- "Copy to library" action to internalize a linked book later
- Useful for: external drives, NAS, network shares, large libraries where disk space matters

### 11c. Library Cleanup
- "Check for missing files" action in Settings > Library
- Scans all books, lists ones where file no longer exists
- Bulk "Remove all broken" or individual removal
- Especially useful alongside linked books (#11b)

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

### 15. Reading Position Sync / Multi-Device Sync
- Sync progress, bookmarks, and highlights across devices
- Current remote backup is single-device (overwrites remote metadata)
- Multi-device support: per-device files or merge-on-push to avoid data loss
- Conflict resolution for divergent progress (last-write-wins or manual merge)
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

#### Future Enrichment Providers
| Provider | Coverage | API Key | Notes |
|----------|----------|---------|-------|
| Comic Vine | Comics (American, some European) | Free key required | comicvine.gamespot.com |
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

### 22. Built-in Web Server for Remote Library Access

Embed a lightweight HTTP server so the library can be accessed from any device on the local network via a web browser.

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

## Phase 7: Mobile

Port Folio to Android and iOS using Tauri v2's mobile support.

### 23. Android & iOS App

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
- **Library path:** `~/Documents/ebook-reader/` assumption must be replaced with platform-appropriate app storage

**UX changes required:**
- Responsive layouts for phone and tablet screens (currently fixed 800x600 window)
- Touch interactions: swipe to turn pages, pinch to zoom
- Touch alternatives for keyboard shortcuts
- Mobile-appropriate navigation patterns

**Suggested approach:** Ship an initial mobile version with EPUB + CBZ support only (skip PDF and CBR) to avoid the hardest native dependency work. Add PDF/CBR support in a follow-up once pdfium and unrar cross-compilation is solved.

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
- PDF text search not yet implemented (TBD)

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

#### 34. MOBI/AZW Support
- Add MOBI/AZW/AZW3 format parsing (common for older Kindle libraries)
- New `BookFormat` enum variant, new parser module
- Extract metadata, cover, and chapter content

### Power User & Reader Enhancements

#### 35. Bookmark Naming & Editing — **Done**
- ~~Edit an existing bookmark to change its name (inline editing in bookmarks panel)~~
- ~~Two-step toast flow: quick-create unnamed via `b`, then optionally name from expanding toast~~
- ~~Inline editing in bookmarks panel: click name to edit, Enter/blur saves, Escape cancels~~
- ~~New `name` column in bookmarks table; `note` field preserved for future use~~

#### 36. Navigation History (Back/Forward)
- Browser-like back/forward buttons after following TOC links or internal references in EPUBs
- Maintain a navigation stack per reading session

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
- ~~Grouped 7 accordions into 3: Appearance (theme + custom CSS), Text & Typography (font + line height + margins + alignment), Page Layout (paginated/continuous + dual-page + manga)~~

#### 39. Multi-Language Support (i18n) — **Done**
- ~~i18next + react-i18next infrastructure with browser locale auto-detection~~
- ~~English and French translations (373 keys)~~
- ~~Flag dropdown language switcher in library toolbar and reader header~~
- ~~All 17 components migrated to use `t()` calls~~
- ~~Error messages translated via `friendlyError(raw, t)`~~
- ~~Architecture supports adding new languages by adding a JSON file~~

#### 40. Page Turn Animations
- Optional visual effects when turning pages (curl, slide, fade)
- Configurable or disableable in settings
- Pure polish feature

#### 40. Split View / Side-by-Side Reading
- Open two books simultaneously in a split pane
- Useful for reference material alongside primary reading
- Niche but valuable for academic use

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

### 44. PDF Text Reflow
- Extract text from PDF pages and re-render as flowing text (like EPUB)
- Respects font size and screen width settings
- Imperfect for complex layouts (tables, columns, images) but major readability win for text-heavy PDFs

### 46. Annotation Export Integrations
- Export highlights and notes to Readwise, Notion, Obsidian via their APIs
- Extends existing Markdown/plain text export with direct service integration
- Readwise is a popular highlight aggregation service used by serious readers

### 47. Plugin / Hook System
- Fire events at key points: `on_import`, `on_book_open`, `on_book_close`, `on_annotation_created`, etc.
- Let user scripts react to events (similar to WordPress/Drupal hooks)
- Lightweight alternative to a full plugin SDK — extensible without modifying core code
- Enables custom automation: auto-tagging, post-import scripts, external sync

### 48. User-Created Themes
- Custom color schemes beyond built-in presets (light, dark, sepia)
- Define background, text, accent, and UI colors
- Import/export themes for sharing

## Summary

| Phase | Features | Status | Theme |
|-------|----------|--------|-------|
| 1 | Copy-on-Import, Multi-File Picker, Collections, Sort/Filter, Tags | 5 done | Storage & organization |
| 2 | Highlights, Metadata Edit, Keyboard Shortcuts, Focus Mode, Zoom | Done | Reading experience |
| 3 | Remote Files, Bulk Import, Backup, Book Discovery, Position Sync | 3 done, 2 partial, 1 not started | Import & sync |
| 4 | Stats, Goodreads, Recents, Share, Recommendations | 4 done, 1 partial | Discovery & social |
| 5 | Multiple Profiles | Done | Multi-user |
| 6 | Remote Library Access, OPDS Server | Not started | Remote access |
| 7 | Android & iOS App | Not started | Mobile |
| 8 | Sepia Theme, OpenDyslexic, Star Ratings, In-Book Search, Typography, Custom Fonts, Continuous Scroll, Time-to-Finish, Bookmark Naming, Series, Activity Log, MOBI, Nav History, Custom CSS, Dual-Page/Manga, Settings Reorg, i18n (EN+FR), Animations, Split View | 15 done | Reader & library enhancements |
| N/H | Dictionary, Vocabulary Builder, TTS, PDF Reflow, Library-Wide Search, Annotation Exports, Plugins/Hooks, User Themes | Not started | Nice to have |
