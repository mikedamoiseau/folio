# Folio — User Guide

How to install, import books, and read them. Covers all formats, collections, highlights, catalog browsing, and more.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Managing Your Library](#2-managing-your-library)
3. [Collections](#3-collections)
4. [Reading a Book](#4-reading-a-book)
5. [Highlights and Bookmarks](#5-highlights-and-bookmarks)
6. [Book Metadata and OpenLibrary](#6-book-metadata-and-openlibrary)
7. [Catalog Browsing (OPDS)](#7-catalog-browsing-opds)
8. [Profiles](#8-profiles)
9. [Customizing Your Reading Experience](#9-customizing-your-reading-experience)
10. [Backup and Restore](#10-backup-and-restore)
11. [Keyboard Shortcuts](#11-keyboard-shortcuts)
12. [Troubleshooting](#12-troubleshooting)

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

Go to the [GitHub Releases page](https://github.com/mikedamoiseau/ebook-reader/releases) and grab the package for your OS:

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

When you import a book, Folio copies the file into its own managed library folder (default `~/Documents/ebook-reader/`). The original file is not modified or moved. Duplicate files are detected by content hash and skipped automatically.

### Viewing your books

Books are shown as a cover grid. Each card displays the cover image, title, author, star rating (if set), a progress percentage badge, and a format badge for non-EPUB books. A "Continue Reading" row at the top shows your 5 most recently read books.

### Searching and filtering

- **Search:** Type in the search bar to filter by title or author. Results update as you type.
- **Format filter:** Filter by All, EPUB, PDF, CBZ, or CBR.
- **Status filter:** Filter by All, Unread, In Progress, or Finished.
- **Rating filter:** Filter by minimum star rating (1+ through 5 stars).
- **Sorting:** Sort by date added, title, author, last read, progress, or rating — ascending or descending.

All filters combine, so you can search for "asimov" within "epub" books that are "in progress."

### Editing and removing books

Hover over a book card to reveal action buttons:

- **Edit:** Opens a dialog to change the title, author, cover image, and tags. See [Book Metadata and OpenLibrary](#6-book-metadata-and-openlibrary).
- **Delete:** Removes the book from your library (with a confirmation prompt).

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

Folio offers two reading modes for EPUBs, selectable in **Settings > EPUB Reading Mode**:

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

### Reading progress

Progress is saved automatically as you read. The library shows a percentage on each book card. When you reopen a book, you return to exactly where you stopped.

Folio also records reading sessions (time spent, pages read) for the reading stats dashboard.

### Returning to the library

Click the back arrow in the top-left corner or press `Escape`. Your progress is saved when you exit.

---

## 5. Highlights and Bookmarks

### Highlights (EPUB only)

Select text while reading to see a color picker popup. Choose from five colors: yellow, green, blue, pink, or orange. The highlighted text is saved with its position.

Open the highlights panel to:

- View all highlights grouped by chapter
- Add or edit notes on any highlight
- Click a highlight to jump to that chapter
- Delete individual highlights
- Export all highlights as Markdown

### Bookmarks

Press `B` in the reader to bookmark the current position. Bookmarks are listed alongside your reading progress.

---

## 6. Book Metadata and OpenLibrary

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

### OpenLibrary enrichment

Click "Search OpenLibrary" in the edit dialog to look up your book by title and author. From the results you can pull in:

- Description
- Genres
- Community rating (0-5 stars)

This is a one-click operation — select a match and the metadata is applied to your book.

### Automatic metadata scanning

Folio can automatically look up metadata for your books via OpenLibrary. The scan uses multiple strategies in order of confidence:

1. **ISBN lookup** — if the EPUB contains an ISBN in its metadata, Folio does a direct lookup (highest accuracy)
2. **Title + Author search** — searches OpenLibrary and auto-applies if the match is strong
3. **Filename parsing** — for CBR/CBZ comics and files with no embedded metadata, Folio parses the filename to extract title, author, and year

**Scan controls:**

- **Scan Library** button in the toolbar (magnifying glass icon) — scans all unenriched books
- **Per-book scan** — hover over a book card and click the scan icon
- **Progress indicator** — shows "Enriching 3/12: Book Title" with a cancel button

**Settings** (in Settings > Metadata Scan):

- **Auto-scan on import** (default: on) — newly imported books are automatically queued for metadata lookup
- **Auto-scan on startup** (default: off) — scan unenriched books when the app launches

Comics with `ComicInfo.xml` inside the CBZ archive will have writer and title extracted automatically.

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
- **Settings > Reading Layout:** Toggle "Dual-page spread" on or off.

**Page pairing:** The cover page (page 1) always displays solo. Subsequent pages are paired: 2-3, 4-5, 6-7, etc. If the last page has no partner, it displays solo.

**Manga mode (right-to-left):** When dual-page is active, a second button appears in the header bar (left arrow icon). Toggle it to swap the page order within each spread — the right page displays on the left and vice versa. This also reverses the arrow key direction so that left-arrow advances forward, matching the RTL reading direction. For EPUBs, manga mode flows the text columns right-to-left.

**Zoom and pan:** In dual-page mode, zoom and pan apply to both pages as a unit. Pan is bounded so you can't drag the content off-screen.

Both settings are global (apply to all books) and persist between sessions. Dual-page is automatically hidden when EPUB is in continuous scroll mode.

### Full-text search (EPUB)

Search the full text of any EPUB book:

- Click the **magnifying glass** icon in the reader header or press **⌘/Ctrl+F** to open the search bar.
- Type at least 2 characters to see results. Matches appear with chapter name and a text snippet.
- Click a result to jump to that chapter. Search highlights appear in blue in the text.
- Results are capped at 200 matches. If you hit the cap, try a more specific query.
- Press **Escape** to close the search panel.

### Advanced typography

Fine-tune your reading experience under **Settings > Typography**:

- **Line height** — adjust spacing between lines (1.2× to 2.4×)
- **Page margins** — control horizontal padding (0px to 80px)
- **Text alignment** — choose between left-aligned or justified text
- **Paragraph spacing** — set the gap between paragraphs (0em to 2em)
- **Hyphenation** — toggle automatic word breaking at line endings for tidier justified text

All typography settings apply to EPUB content only and are saved globally.

### Custom CSS

For advanced customization, you can inject your own CSS that applies to EPUB reading content:

1. Open **Settings > Custom CSS Override**
2. Type or paste CSS rules in the text area (up to 10,000 characters)
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

### Library folder

In Settings, you can view your current library folder path, file count, and total storage used. You can change the library folder — Folio will offer to move existing files to the new location or keep them in place.

---

## 10. Backup and Restore

From Settings you can export and import library backups as ZIP files.

**Export options:**

- **Metadata only** — small file containing your reading progress, collections, tags, and highlights.
- **Full backup** — includes all book files alongside the metadata.

**Import:** Select a backup ZIP to restore your library.

---

## 11. Keyboard Shortcuts

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

## 12. Troubleshooting

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

**Book files:** Imported books are copied to the library folder, which defaults to `~/Documents/ebook-reader/`. You can change this in Settings. Since Folio keeps its own copy of each book, moving or deleting the original file has no effect on your library.

### The app won't start

Check that your OS meets the minimum version listed in [Getting Started](#1-getting-started).

**macOS — "damaged and can't be opened" or "unidentified developer":** This is a Gatekeeper quarantine flag on unsigned apps. Run the following in Terminal, then try launching again:

```bash
xattr -cr /Applications/Folio.app
```

Alternatively go to **System Settings > Privacy & Security** and click **Open Anyway** after the first blocked launch attempt.
