# Folio — User Guide

How to install, import books, and read them. Covers all formats, collections, highlights, catalog browsing, and more.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Managing Your Library](#2-managing-your-library)
3. [Collections](#3-collections)
4. [Reading a Book](#4-reading-a-book)
5. [Highlights and Bookmarks](#5-highlights-and-bookmarks)
6. [Book Metadata and Enrichment](#6-book-metadata-and-enrichment)
7. [Catalog Browsing (OPDS)](#7-catalog-browsing-opds)
8. [Profiles](#8-profiles)
9. [Customizing Your Reading Experience](#9-customizing-your-reading-experience)
10. [Backup and Restore](#10-backup-and-restore)
11. [Reading Stats](#11-reading-stats)
12. [Remote Access](#12-remote-access)
13. [Language](#13-language)
14. [Keyboard Shortcuts](#14-keyboard-shortcuts)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Getting Started

### System requirements

| Platform | Minimum version |
|----------|----------------|
| macOS    | 10.15 Catalina or later |
| Windows  | Windows 10 (64-bit) or later |
| Linux    | Ubuntu 20.04 or equivalent |

No extra runtimes or dependencies needed. The installer is self-contained.

### Downloading

Go to the [GitHub Releases page](https://github.com/mikedamoiseau/folio/releases) and grab the package for your OS:

- macOS: `.dmg`
- Windows: `.msi`
- Linux: `.AppImage` or `.deb`

### Installing

**macOS:** Open the `.dmg`, drag Folio into your Applications folder, then double-click to launch it.

> **macOS Gatekeeper — "damaged" or "unidentified developer" warning**
>
> Because this app is not notarized, macOS 14 (Sonoma) and later may block it with a _"Folio.app is damaged and can't be opened"_ message.
>
> **Fix:** open Terminal and run:
> ```bash
> xattr -cr /Applications/Folio.app
> ```
> Then launch the app as normal. This removes the quarantine flag and only needs to be done once after each install or update.

**Windows:** Run the `.msi` installer and follow the prompts.

**Linux (AppImage):** Make the file executable (`chmod +x Folio.AppImage`), then run it.

**Linux (.deb):** Run `sudo dpkg -i folio.deb`.

### First launch

The first time you open the app, you'll see an empty library with a prompt to import your first book. Your data stays on your machine — nothing is sent to the cloud.

---

## 2. Managing Your Library

### Supported formats

| Format | Type |
|--------|------|
| EPUB 2 and EPUB 3 | Reflowable ebooks |
| PDF | Fixed-layout documents |
| CBZ | Comic book archives (ZIP) |
| CBR | Comic book archives (RAR) |

### Importing books

Click the **+ Add books** button in the top-right corner to open the import menu:

- **Add files:** Opens a file picker for one or more files in any supported format.
- **Import folder:** Scans an entire directory for supported files and imports them in batch, with a progress indicator.
- **Import from URL:** Paste a direct link to an EPUB, PDF, CBZ, or CBR file. Folio downloads and imports it.

**Drag and drop:** You can also drag files from Finder or File Explorer directly onto the library window. A "Drop to import" overlay appears. Release to import them.

When you import a book, Folio copies the file into its own managed library folder (default `~/Documents/folio/`). The original file is not modified or moved. Duplicate files are detected by content hash and skipped automatically.

### Viewing your books

Books are shown as a cover grid. Each card displays the cover image, title, author, star rating (if set), a progress percentage badge, and a format badge for non-EPUB books.

In the full library view, a **"Continue Reading"** row at the top shows your most recently read books, and a **"Discover"** row shows popular titles from your configured OPDS catalogs. Both sections are hidden when viewing a collection or series, so you see only the relevant books.

### Searching and filtering

- **Search:** Type in the search bar to filter by title or author. Results update as you type.
- **Format filter:** Filter by All, EPUB, PDF, CBZ, or CBR.
- **Status filter:** Filter by All, Unread, In Progress, or Finished.
- **Rating filter:** Filter by minimum star rating (1+ through 5 stars).
- **Sorting:** Sort by date added, title, author, last read, progress, rating, or series — ascending or descending.
- **Source filter:** Filter by All, Imported, or Linked books.

All filters combine, so you can search for "asimov" within "epub" books that are "in progress."

### Editing and removing books

Hover over a book card to reveal action buttons:

- **Edit:** Opens a dialog to change the title, author, cover image, and tags. See [Book Metadata and OpenLibrary](#6-book-metadata-and-openlibrary).
- **Delete:** Removes the book from your library (with a confirmation prompt).

### Bulk actions

To act on multiple books at once, click the **selection icon** in the toolbar (grid icon next to the import button). This enters selection mode:

- Click book cards to select or deselect them. A checkbox appears on each card.
- A floating action bar appears at the bottom showing the selection count.
- **Select all / Deselect all** — toggle between selecting all visible books or clearing the selection.
- **Delete** — remove all selected books (with a confirmation prompt).
- **Cancel** — exit selection mode.

Selection mode disables drag-and-drop to prevent accidental actions.

---

## 3. Collections

Collections let you organize books into groups. Open the collections sidebar by clicking the collections icon or pressing `C`.

### Manual collections

Create a collection, then drag book cards onto it to add them. You can remove books from a manual collection via the book card's context actions.

### Automated collections

Define rules and Folio populates the collection automatically. Available rule types:

| Field | Operators |
|-------|-----------|
| Author | contains |
| Title | contains |
| Series | contains, is |
| Language | is, contains |
| Publisher | contains |
| Description | contains |
| Format | is (epub, pdf, cbz, cbr) |
| Tag | is, contains |
| Date added | within last N days |
| Reading progress | is unread / in progress / finished |

Multiple rules are combined with AND logic — a book must match all rules to appear in the collection.

### Collection options

- Custom icon (choose from preset emoji)
- Custom color (choose from preset palette)
- Export as Markdown
- Delete collection

### Series grouping

Books with series metadata are automatically grouped in two ways:

- **Sidebar:** A "Series" section appears below collections, showing each series with its book count. Click a series to filter the library to just those books, sorted by volume order.
- **Sort by Series:** Select the "Series" sort option in the library toolbar. Books are grouped under series headers, sorted by volume within each group. Books without series data appear at the bottom.

Series data comes from book file metadata (EPUB/CBZ). You can also set or edit series info manually via the edit dialog on any book.

---

## 4. Reading a Book

### Opening a book

Click any book card to open it. If you've read it before, Folio picks up where you left off — same chapter (or page), same scroll position.

### EPUB reading

Folio offers two reading modes for EPUBs, selectable in **Settings > Page Layout**:

**Paginated mode** (default) — read one chapter at a time:

- **Chapter navigation:** Use the Previous/Next buttons at the bottom, press the left/right arrow keys, or pick a chapter from the Table of Contents.
- Floating chapter arrows appear on the left/right edges when you scroll past the bottom navigation bar.

**Continuous scroll mode** — all chapters in one long scrollable document:

- All chapters are loaded and rendered as a single scrollable page with chapter title dividers between them.
- Scroll naturally through the entire book — no prev/next buttons needed.
- The Table of Contents still works: clicking a chapter scrolls directly to it.
- The footer progress bar shows your position in the entire book (not just the current chapter).

**Common to both modes:**

- **Table of Contents:** Click the list icon in the header or press `T`. The sidebar shows a searchable, hierarchical chapter list. The current chapter is highlighted.
- **Focus mode:** Press `D` to hide all UI and read distraction-free. Move the mouse to the top or bottom edge to temporarily reveal controls.
- **Progress tracking:** Your reading position is saved automatically and restored when you reopen the book, regardless of which mode you use.

### PDF and comic book reading (PDF, CBZ, CBR)

These formats use a page-by-page viewer. Navigate with the Previous/Next buttons or arrow keys. The footer shows the current page number and total page count.

**Go to page:** Click the page label (e.g., "Page 5 / 45") in the footer bar. It turns into a number input — type the page you want and press Enter. Press Escape or click away to cancel.

**Page cache (CBZ/CBR):** When you open a comic for the first time, Folio extracts all pages from the archive to a disk cache. Subsequent page turns read from disk and are near-instant (~1-5ms). The cache persists between sessions — reopening the same comic skips extraction entirely. Cache is managed automatically via eviction (max 5 books, configurable size cap, 7-day expiry). You can adjust the cache size limit or clear it in Settings > Library.

**Zoom quality:** When you zoom into any page-based format, Folio keeps images sharp. PDFs are re-rendered at the target resolution (like native PDF viewers), and comic pages (CBZ/CBR) are displayed using physical DOM resizing so the browser resamples at full resolution instead of blurring. PDF pages are rendered as high-quality JPEG images with an in-memory cache for fast navigation.

**Slow page loading:** Some PDF pages with complex content may take longer to render. If a page takes more than 8 seconds, Folio shows a "taking longer than usual" hint while continuing to load. If it exceeds 30 seconds, a retry button appears. Retrying is often instant since the render may have completed in the background and been cached.

### Reading progress

Progress is saved automatically as you read. The library shows a percentage on each book card. When you reopen a book, you return to exactly where you stopped.

Folio also records reading sessions (time spent, pages read) for the reading stats dashboard.

### Returning to the library

Click the back arrow in the top-left corner or press `Escape`. Your progress is saved when you exit.

---

## 5. Highlights and Bookmarks

### Highlights (EPUB only)

Select text while reading to see a color picker popup. Choose from five colors: yellow, green, blue, pink, or orange. The highlighted text is saved with its position.

Open the highlights panel (pen icon in the reader header) to:

- View all highlights grouped by chapter
- Add or edit notes on any highlight — notes use a multi-line text area, press Cmd/Ctrl+Enter to save
- Click a highlight to jump to that chapter
- Delete individual highlights
- Export all highlights as Markdown (copied to clipboard)

### Bookmarks

Press `B` in the reader to bookmark the current position. Bookmarks are listed alongside your reading progress.

---

## 6. Book Metadata and Enrichment

Click the edit button on any book card to open the metadata editor.

### Editable fields

- Title
- Author
- Series and volume number
- Language
- Publisher and publish year
- Cover image (upload a JPG, PNG, or WebP)
- Star rating (1-5 stars — click a star to rate, click the same star again to clear)
- Tags (with autocomplete from your existing tags)

### Enrichment providers

Folio can look up metadata from multiple sources. Providers are tried in order — the first one that finds a match wins. Configure which providers are active in **Settings > Metadata Scan > Enrichment Sources**.

| Provider | Coverage | API Key | Default |
|----------|----------|---------|---------|
| **Google Books** | General books, good international coverage | Optional (for higher rate limits) | Enabled |
| **OpenLibrary** | Open data, ratings, subjects | None | Enabled |
| **Comic Vine** | Comics, BD, manga — the most comprehensive free comics database | Free key from comicvine.gamespot.com/api | Disabled (needs key) |
| **BnF** | French national library — excellent for French editions | None | Enabled |

Providers are tried in the order shown. Use the ▲/▼ buttons next to each provider to change the priority — the first provider to return a match wins.

Click "Search" in the edit dialog to look up your book by title and author. From the results you can pull in description, genres, and ratings.

### Automatic metadata scanning

Folio can automatically look up metadata for your books. The scan uses multiple strategies in order of confidence:

1. **ISBN lookup** — if the book contains an ISBN in its metadata, Folio does a direct lookup (highest accuracy)
2. **Title + Author search** — searches providers and auto-applies if the match is strong
3. **Filename parsing** — for CBR/CBZ comics and files with no embedded metadata, Folio parses the filename to extract title, author, and year

**Scan controls:**

- **Scan Library** button in the toolbar (magnifying glass icon) — scans all unenriched books. Also retries previously skipped books (they may match with newly enabled providers).
- **Per-book scan** — click the scan icon in the book detail popup to enrich a single book. The popup updates immediately with the new metadata.
- **Progress indicator** — shows "Enriching 3/12: Book Title" with a cancel button

**Settings** (in Settings > Metadata Scan):

- **Auto-scan on import** (default: on) — newly imported books are automatically queued for metadata lookup
- **Auto-scan on startup** (default: off) — scan unenriched books when the app launches

### Comics metadata

Comics (CBZ and CBR) get metadata from two sources:

- **ComicInfo.xml** — if present inside the archive, Folio extracts writer, title, series, volume, year, language, publisher, genre, and summary automatically at import time.
- **Enrichment providers** — Comic Vine is recommended for comics. Get a free API key from comicvine.gamespot.com/api, enable it in Settings, then run a scan.

---

## 7. Catalog Browsing (OPDS)

Folio can browse online book catalogs that use the OPDS protocol (Open Publication Distribution System). This includes sources like Project Gutenberg, Standard Ebooks, and self-hosted Calibre servers.

### Browsing

Open the catalog browser from the library. Pick a catalog to browse its categories and entries. Each entry shows the title, author, summary, and cover when available.

### Searching

**Unified search:** From the catalog list, type a query in the "Search all catalogs" bar. Folio searches every configured catalog in parallel and shows aggregated results — one search, all sources.

**Per-catalog search:** When browsing inside a catalog that supports search, a "Search this catalog" bar appears at the top.

### Downloading

Click a download link to grab a book (EPUB or PDF) and import it directly into your library.

### Custom catalogs

Add your own OPDS catalog by URL (useful for self-hosted Calibre or COPS servers). Custom catalogs can be removed at any time.

---

## 8. Profiles

Profiles give you completely separate libraries. Each profile has its own books, reading progress, collections, and highlights.

Create and switch profiles from the profile dropdown in the library header. The dropdown only appears once you have more than one profile. Non-default profiles can be deleted.

---

## 9. Customizing Your Reading Experience

Click the gear icon in the reader header (or library toolbar) to open Settings.

### Theme

Choose from four presets or create your own:

- **Light** — warm off-white with brown text (default)
- **Sepia** — deeper amber/parchment background with rich brown text, designed for comfortable extended reading
- **Dark** — dark background with light text for low-light environments
- **Auto** — follows your operating system's light/dark setting

**Custom colors:** Click the "Custom colors" button to open the color editor. Pick a background and text color — the remaining UI colors (borders, accents, muted text, etc.) are automatically derived. Expand "Advanced" to fine-tune individual color tokens. Preset buttons let you reset to the sepia or light palette.

### Saved themes

Save your current visual setup as a named theme to quickly switch between different reading moods. A saved theme captures colors, font family, font size, and all typography settings (line height, margins, alignment, spacing, hyphenation).

**Saving a theme:**

1. Configure your preferred appearance — colors, font, and typography settings
2. In **Settings > Appearance > Saved Themes**, click **+ Save as theme**
3. Enter a name (e.g., "Night Reading", "Beach Mode") and click **Save**
4. If the name already exists, you'll be asked to confirm overwriting

**Loading a theme:** Click any saved theme in the list to apply it instantly. The active theme is highlighted with an accent background. Loading a theme switches to custom color mode and applies all saved settings.

**Managing themes:**

- **Rename:** Hover over a theme and click the pencil icon. Edit the name inline and press Enter to confirm.
- **Delete:** Hover over a theme and click the X icon. Confirm the deletion when prompted.
- Up to 50 themes can be saved. Names are case-insensitive ("Dark" and "dark" are treated as the same name).

**What is NOT saved in a theme:** Custom CSS is a global override layer and is not included in saved themes. A note below the save button reminds you of this.

### Font size

Adjust between 14px and 24px using the slider, the +/- buttons in Settings, or the A-/A+ buttons in the reader header.

### Reading font

Choose from four built-in fonts for EPUB reading content:

- **Lora** — elegant serif font (default)
- **Literata** — a serif font designed for e-reading (created by Google for Play Books)
- **DM Sans** — clean sans-serif font
- **OpenDyslexic** — a font designed for readers with dyslexia, with weighted letterforms that prevent visual rotation and flipping

You can also add your own fonts: click **Add font...** at the bottom of the font list and select a `.ttf`, `.otf`, or `.woff2` file. Custom fonts appear alongside the built-in options. To remove a custom font, hover over it and click the X icon.

A live preview sentence shows the selected font. Built-in fonts are bundled locally — no internet connection required.

### EPUB reading mode

Toggle between two modes for how EPUB content is displayed:

- **Paginated** (default) — one chapter at a time with prev/next navigation
- **Continuous** — all chapters in one long scrollable document with chapter dividers

This is a global preference that applies to all EPUB books.

### Dual-page spread

Show two pages side by side, like an open book. Works for all formats: comics (CBZ/CBR), PDFs, and EPUBs in paginated mode.

**Toggling on/off:**

- **Reader header:** Click the dual-page icon (two rectangles) in the header bar. When active, the icon highlights.
- **Settings > Page Layout:** Toggle "Dual-page spread" on or off.

**Page pairing:** The cover page (page 1) always displays solo. Subsequent pages are paired: 2-3, 4-5, 6-7, etc. If the last page has no partner, it displays solo.

**Manga mode (right-to-left):** When dual-page is active, a second button appears in the header bar (left arrow icon). Toggle it to swap the page order within each spread — the right page displays on the left and vice versa. This also reverses the arrow key direction so that left-arrow advances forward, matching the RTL reading direction. For EPUBs, manga mode flows the text columns right-to-left.

**Zoom and pan:** In dual-page mode, zoom and pan apply to both pages as a unit. Pan is bounded so you can't drag the content off-screen.

Both settings are global (apply to all books) and persist between sessions. Dual-page is automatically hidden when EPUB is in continuous scroll mode.

### Page turn animation

A slide animation plays when turning pages in PDF and comic (CBZ/CBR) formats. The new page slides in from the side with a brief fade, giving a natural sense of direction when navigating forward or backward.

**Toggle:** Settings > Page Layout > "Page turn animation" — enabled by default. Turn it off for instant page changes with no animation.

**Performance:** Adjacent pages are preloaded in the background after you pause on a page, so the animation plays smoothly. During fast navigation, preloads are deferred to keep the current page responsive.

This setting does not affect EPUB, which uses its own chapter-based navigation.

### Full-text search (EPUB)

Search the full text of any EPUB book:

- Click the **magnifying glass** icon in the reader header or press **⌘/Ctrl+F** to open the search bar.
- Type at least 2 characters to see results. Matches appear with chapter name and a text snippet.
- Click a result to jump to that chapter. Search highlights appear in blue in the text.
- Results are capped at 200 matches. If you hit the cap, try a more specific query.
- Press **Escape** to close the search panel.

### Advanced typography

Fine-tune your reading experience under **Settings > Appearance > Typography**:

- **Line height** — adjust spacing between lines (1.2× to 2.4×)
- **Page margins** — control horizontal padding (0px to 80px)
- **Text alignment** — choose between left-aligned or justified text
- **Paragraph spacing** — set the gap between paragraphs (0em to 2em)
- **Hyphenation** — toggle automatic word breaking at line endings for tidier justified text

All typography settings apply to EPUB content only and are saved globally.

### Custom CSS

For advanced customization, you can inject your own CSS that applies to EPUB reading content:

1. Open **Settings > Appearance** and scroll to the Custom CSS section
2. Type or paste CSS rules in the text area
3. Changes apply immediately with a live preview
4. Use the **Clear** button to remove all custom CSS

Example uses: adjusting heading sizes, hiding specific elements, changing link colors, or modifying list styles.

### Time-to-finish

While reading an EPUB, the footer shows an estimated reading time:

- **"X min left"** — estimated time remaining for the entire book, based on 250 words per minute
- Hover over the time to see a tooltip with both chapter-level and book-level estimates

The estimate updates as you scroll through the content.

### Activity log

Folio keeps a log of data-changing actions (imports, edits, deletes, collection changes, etc.):

- Open **Settings > View Activity Log** to browse recent activity
- Filter by action type (e.g., only imports, only edits)
- Each entry shows the action, affected item, and timestamp

### Library folder and import mode

In Settings > Library, you can view your current library folder path, file count, and total storage used. You can change the library folder — Folio will offer to move existing files to the new location or keep them in place.

**Import mode:** Choose between two modes for how books are added:

- **Copy** (default) — the file is copied into Folio's managed library folder. Safe and self-contained.
- **Link** — Folio references the file at its original location without copying. Useful for large libraries on external drives or NAS. Linked books show a link badge on their card.

**Page cache:** Folio caches extracted comic pages (CBZ/CBR) on disk for faster reading. The cache size limit controls the maximum disk space used (default 500 MB). You can choose 250 MB, 500 MB, 1 GB, or 2 GB. The current cache usage and a "Clear cache" button are shown below the setting.

---

## 10. Backup and Restore

### Local backup

From **Settings > Backup & Restore** you can export and restore library backups.

**Export options:**

- **Metadata only** — small file containing your reading progress, collections, tags, and highlights.
- **Full backup** — includes all book files alongside the metadata.

**Restore from backup:** Click "Restore from backup" to open the restore picker:

- **Automatic backups** — Folio creates automatic backups before destructive operations like library cleanup. These are listed with their date, type, and file size. Click "Restore" on any entry.
- **From file** — Click "Choose file" to select a backup ZIP you exported previously.

Restoring a backup imports books and metadata. Existing data is not deleted — it's a non-destructive merge.

### Library cleanup

From **Settings > Library**, click "Check for missing files" to scan your library for books whose files no longer exist on disk (moved, deleted, or on a disconnected drive). Folio automatically creates a metadata backup before removing any broken entries. The result shows how many books were removed and where the backup was saved.

If you try to open a book whose file is missing, Folio shows a dialog offering to remove it from your library.

### Remote backup

Folio can sync your library to a remote storage provider for off-site backup. Configure in **Settings > Remote Backup**.

**Supported providers:**

| Provider | Auth | Notes |
|----------|------|-------|
| AWS S3 | Access key + secret | Any S3-compatible service (MinIO, Backblaze B2, etc.) |
| FTP | Username + password | FTP and FTPS (TLS) |
| SFTP (SSH) | Username + SSH key | Key-based auth via system ssh |
| WebDAV | Username + password | Nextcloud, ownCloud, etc. |

**How it works:**

1. Select a provider and fill in connection details
2. Click **Save Configuration** (passwords are stored in your OS keychain, not in the database)
3. Click **Backup Now** to start a sync

**What gets synced:** Book files, covers, reading progress, bookmarks, highlights, and collections. Metadata files (JSON) always contain the full library. Book files are uploaded incrementally — only new or changed files are transferred.

**Progress:** During backup, the button shows real-time status like "Uploading books 3/12" or "Syncing bookmarks".

**Reliability:**
- If a backup is interrupted, the next run picks up where it left off — already-uploaded files are detected by size comparison and skipped
- Both successful and failed backups are logged in the activity log
- Only one backup can run at a time (a second click is blocked while one is in progress)

### Multi-device sync

Folio can sync your reading progress, bookmarks, and highlights across multiple devices. Sync uses the same remote storage provider you configure for backup.

**Enabling sync:**

1. Configure a remote backup destination (S3, FTP, SFTP, or WebDAV) as described above
2. In **Settings > Remote Backup**, toggle **"Sync reading progress across devices"** on

**How it works:**

- **When you open a book:** Folio silently checks the remote storage for sync data from other devices. If another device has newer reading progress, bookmarks, or highlights, they are merged into your local library. This happens in the background with a 5-second timeout — your book opens immediately regardless.
- **When you close a book:** Folio pushes your current reading state to the remote storage in the background. Other devices will pick up these changes next time they open the same book.
- **Book matching:** Books are matched by content hash (SHA-256), so the same file on different devices syncs correctly even if the filenames differ.

**What syncs:**

- Reading position (chapter and scroll position)
- Bookmarks (including names and notes)
- Highlights (including colors and notes)
- Deletions — if you remove a bookmark or highlight on one device, it's removed on others too

**What does not sync:**

- Book files themselves (use backup for that)
- Collections, tags, or star ratings
- Reading statistics
- Settings or theme preferences

**Conflict resolution:** When the same item is edited on two devices, the most recent edit wins (based on timestamps). If timestamps are equal, the remote version is preferred. This is automatic — there's no manual conflict resolution.

**Sync status:** When sync is enabled, the Settings panel shows the time of the last successful sync. If a sync fails (network issues, server unreachable), a user-friendly error message is displayed. Errors clear automatically after the next successful sync.

**Sync and backup are independent:** Sync is a lightweight, per-book data exchange for reading state. Backup is a full library export. You can use one without the other, though both require a remote storage provider. Enabling sync does not trigger a backup and vice versa.

---

## 11. Reading Stats

Open the reading stats dashboard from the library toolbar (bar chart icon).

**Tracked metrics:**

- **Time Reading** — total time spent in the reader
- **Sessions** — number of reading sessions
- **Pages Read** — total pages turned (PDF/CBZ/CBR)
- **Books Finished** — books read to completion
- **Current Streak** — consecutive days with reading activity
- **Longest Streak** — your all-time record

A **30-day bar chart** shows your daily reading time over the past month.

Stats are tracked automatically — reading sessions are recorded when you open and close a book.

---

## 12. Remote Access

Browse and read your library from any device on the same WiFi network — phone, tablet, or another computer — without installing anything.

### Setting up

1. Open **Settings** and scroll to the **Remote Access** section
2. Enter a **PIN** (this is the password for web access) and click **Save PIN**
3. Click **Start Server**
4. A URL and QR code appear — scan the QR code with your phone or type the URL in any browser

The server runs on port 7788 by default. You can change the port before starting.

### Using the web interface

On your phone or tablet, open the URL in a browser. You'll see:

- **Login screen** — enter the PIN you set in the desktop app
- **Library** — a grid of book covers with a search bar. Tap any book to see its details.
- **Book detail** — shows cover, title, author, and format. Tap **Read** to open the book or **Download** to save it to your device.
- **Reader** — EPUBs show chapter content with prev/next navigation. PDFs and comics show page images with prev/next buttons.

The web interface works entirely on your local network. No internet connection needed, no data leaves your WiFi.

### OPDS for reader apps

If you use an ebook reader app that supports OPDS (KOReader, Calibre, Moon+ Reader, etc.), you can connect it directly:

1. In the reader app, add a new OPDS catalog
2. Enter the URL: `http://<your-ip>:7788/opds`
3. For authentication, use HTTP Basic Auth with any username and your PIN as the password
4. Browse your library and download books directly into the reader app

### Auto-start

If the server was running when you last closed Folio, it starts automatically next time you open the app. Stop the server from Settings to disable auto-start.

### Security

- Your PIN is hashed (SHA-256) and stored in your operating system's keychain
- Web sessions expire after 24 hours
- Login attempts are rate-limited (5 tries per 5 minutes per device)
- The server is read-only — nobody can modify your library from the web interface
- All served content is sanitized to prevent malicious scripts in EPUB files

### Stopping the server

Click **Stop Server** in Settings. The server also stops automatically when you close the Folio app.

---

## 13. Language

Folio supports multiple interface languages. Currently available: **English** and **French**.

**Switching language:** Click the flag icon in the library toolbar or reader header. A dropdown shows available languages with flag emojis. Select one to switch immediately — no restart needed.

**Auto-detection:** On first launch, Folio detects your operating system language. If it matches a supported language, that language is used. Otherwise, English is the default.

**Persistence:** Your language choice is saved and remembered across sessions.

**Adding languages:** Folio's translation architecture supports community contributions. Each language is a single JSON file.

---

## 14. Keyboard Shortcuts

Press `?` at any time to see the shortcut reference.

### Library

| Shortcut | Action |
|----------|--------|
| `/` | Focus search bar |
| `C` | Toggle collections sidebar |
| `Escape` | Clear search / close panels |
| `?` | Toggle shortcut help |

### Reader

| Shortcut | Action |
|----------|--------|
| `←` | Previous chapter / page |
| `→` | Next chapter / page |
| `⌘/Ctrl+F` | Search in book (EPUB only) |
| `T` | Toggle Table of Contents |
| `B` | Add bookmark |
| `D` | Toggle focus mode |
| `Escape` | Close panel / exit focus mode / back to library |
| `?` | Toggle shortcut help |

---

## 15. Troubleshooting

### "Failed to load book"

The file is probably corrupted or uses a format variant the parser can't handle. Try re-downloading the file, or open it in another reader to check if the file itself is the problem.

### Supported formats

Folio supports **EPUB** (versions 2 and 3), **PDF**, **CBZ**, and **CBR**. Other formats such as MOBI, AZW, and DjVu are not supported.

### Where is my data stored?

**Library database and app data:**

| Platform | Location |
|----------|----------|
| macOS    | `~/Library/Application Support/com.mike.folio/` |
| Windows  | `%APPDATA%\com.mike.folio\` |
| Linux    | `~/.local/share/com.mike.folio/` |

**Book files:** Imported books are copied to the library folder, which defaults to `~/Documents/folio/`. You can change this in Settings. Since Folio keeps its own copy of each book, moving or deleting the original file has no effect on your library.

### The app won't start

Check that your OS meets the minimum version listed in [Getting Started](#1-getting-started).

**macOS — "damaged and can't be opened" or "unidentified developer":** This is a Gatekeeper quarantine flag on unsigned apps. Run the following in Terminal, then try launching again:

```bash
xattr -cr /Applications/Folio.app
```

Alternatively go to **System Settings > Privacy & Security** and click **Open Anyway** after the first blocked launch attempt.
