# Ebook Reader — Feature Roadmap

## Phase 1: Foundation (Storage & Organization)

These features fix core limitations and unlock future work.

### 1. Copy-on-Import with Configurable Library Folder — **Done**
- ~~On import, copy the file into an app-managed library directory~~
- ~~Add a setting for the destination folder (default: `~/Documents/Folio Library/` or platform equivalent)~~
- ~~Allow changing the folder in settings — existing files should be migrated when the folder changes~~
- Existing books imported by path-reference should be migrated on first run (or offer a one-time prompt)
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

### 9. Dictionary / Word Lookup
- Select a word in the reader to get a definition
- Use an offline dictionary or system dictionary API
- Optional: link to online dictionaries

### 10a. Do Not Disturb / Focus Mode — **Done**
- ~~Toggle in reader to hide all UI chrome (header, footer, progress bar) for distraction-free reading~~
- Suppress system notifications while active (macOS Focus/DND API — TBD)
- ~~Minimal edge-reveal controls — move mouse to top/bottom edge to briefly show header/footer~~
- ~~Hide cursor after 2s of inactivity~~
- ~~Keyboard shortcut: `d` to toggle, `Escape` to exit~~
- ~~Toggle button in reader header (clock icon)~~

### 10. Text-to-Speech
- Read current chapter aloud using system TTS
- Play/pause, skip forward/back, speed control
- Highlight current sentence as it's read

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

### 12. Bulk Import — **Done**
- ~~Scan a folder recursively for supported formats (.epub, .cbz, .cbr, .pdf)~~
- ~~skip duplicates~~ *(hash-based dedup silently returns existing book)*
- ~~Progress indicator for large imports~~

### 13. Library Export / Backup — **Done**
- ~~Export full library: metadata-only (small) or full backup with book files~~
- ~~Import from a backup archive~~
- ~~Useful for migration between machines~~

### 13b. Remote Backup Destinations
- Backup to external services beyond local folder: FTP/SFTP, AWS S3, Google Drive, Dropbox, WebDAV, network share
- Scheduled automatic backups (daily/weekly)
- Configurable destinations in settings — add/remove targets, test connection
- Incremental backups (only changed files since last backup)
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

### 17. Goodreads / OpenLibrary Integration — **Done** *(OpenLibrary)*
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

## Summary

| Phase | Features | Status | Theme |
|-------|----------|--------|-------|
| 1 | Copy-on-Import, Multi-File Picker, Collections, Sort/Filter, Tags | 5 done | Storage & organization |
| 2 | Highlights, Metadata Edit, Keyboard Shortcuts, Dictionary, TTS | 3 done, 2 not started | Reading experience |
| 3 | Remote Files, Bulk Import, Backup, Book Discovery, Position Sync | 3 done, 1 partial, 1 not started | Import & sync |
| 4 | Stats, Goodreads, Recents, Share, Recommendations | 4 done, 1 partial | Discovery & social |
| 5 | Multiple Profiles | Done | Multi-user |
