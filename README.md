# Folio — Ebook Reader

A cross-platform desktop ebook reader built with Tauri v2 (Rust) and React.

## Features

### Library Management
- Import EPUB, PDF, CBZ, and CBR files via file picker, drag-and-drop, or folder scan
- Multi-file import with progress bar and cancel support
- Duplicate detection via SHA-256 file hashing
- Sort by date added, last read, title, author, progress, or rating
- Filter by format, reading status (unread / in progress / finished), and minimum star rating
- Search by title or author
- Collections (manual and rule-based automated — rules for author, title, series, language, publisher, format, tag, date, and reading status)
- Tags with autocomplete
- 1-5 star ratings per book (displayed on cards, editable in metadata dialog)
- Book metadata editing (title, author, series, language, publisher, cover image, rating, tags)
- Recently opened section for quick resume
- Multiple profiles with separate libraries

### Reading Experience
- EPUB 2 & 3 with sanitized HTML rendering (ammonia + DOMPurify)
- PDF rendering via bundled pdfium
- CBZ (ZIP) and CBR (RAR) comic reader
- Chapter navigation with Table of Contents sidebar
- Continuous scroll mode for EPUB (all chapters in one scrollable document, with chapter dividers)
- Floating prev/next arrows for EPUB chapters (paginated mode)
- Mouse wheel page navigation for PDF/CBZ/CBR
- Page zoom (Ctrl+scroll, 50%–400%) with drag-to-pan
- Reading progress auto-saved across sessions
- Bookmarks
- Text highlighting with color choices and notes
- Highlights panel with markdown export
- Full-text search in EPUB books (⌘/Ctrl+F) with result snippets and chapter navigation
- Time-to-finish estimates based on word count (250 WPM) in EPUB footer
- Focus mode (hides UI chrome, auto-hides cursor)
- Theme presets: Light, Sepia, Dark, Auto (system) — plus full custom color editor
- Advanced typography: line height, page margins, text alignment, paragraph spacing, hyphenation
- Custom CSS override for EPUB content (with length limit and live preview)
- Reading fonts: Lora (serif), DM Sans (sans-serif), OpenDyslexic (accessibility)
- Adjustable font size (14-24px)
- All fonts bundled locally (works offline)
- Keyboard shortcuts with help overlay (`?` key)

### Import & Sync
- OPDS catalog browsing (Project Gutenberg, Standard Ebooks, ManyBooks, Feedbooks)
- Add custom OPDS catalog URLs (Calibre servers, etc.)
- One-click download from catalogs into library
- Library export/backup (metadata-only or full with book files)
- Import from backup archive

### Stats & Activity
- Reading session tracking with stats dashboard
- Daily reading chart, streaks, books finished
- Activity log tracking imports, edits, deletes, and collection changes
- Share collections as Markdown (copy to clipboard)

## Tech Stack
- **Backend:** Rust, Tauri v2, SQLite (rusqlite + r2d2), ammonia, pdfium-render, unrar, reqwest
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, DOMPurify

## Requirements
- [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- Node.js 18+
- Rust (stable)

## Development
```bash
npm install
./scripts/download-pdfium.sh   # required for PDF support
npm run tauri dev
```

## Build
```bash
npm run tauri build
```

## Installation

Pre-built binaries are on the [GitHub Releases page](https://github.com/mikedamoiseau/ebook-reader/releases).

### macOS — Gatekeeper "damaged" warning

Because this app is not code-signed or notarized with an Apple Developer certificate, macOS 14+ may refuse to open it with a _"damaged and can't be opened"_ error.

**One-time fix — run this in Terminal after installing:**

```bash
xattr -cr /Applications/ebook-reader.app
```

Then double-click the app as normal. You only need to do this once per install.

## CI Status
![CI](https://github.com/mikedamoiseau/ebook-reader/actions/workflows/ci.yml/badge.svg)

## License
MIT
