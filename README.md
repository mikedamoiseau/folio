# Folio — Ebook Reader

A cross-platform desktop ebook reader built with Tauri v2 (Rust) and React.

## Features

### Library Management
- Import EPUB, PDF, CBZ, and CBR files via file picker, drag-and-drop, or folder scan
- Multi-file import with progress bar and cancel support
- Duplicate detection via SHA-256 file hashing
- Sort by date added, last read, title, author, or progress
- Filter by format and reading status (unread / in progress / finished)
- Search by title or author
- Collections (manual and rule-based automated)
- Tags with autocomplete
- Book metadata editing (title, author, cover image)
- Recently opened section for quick resume
- Multiple profiles with separate libraries

### Reading Experience
- EPUB 2 & 3 with sanitized HTML rendering (ammonia + DOMPurify)
- PDF rendering via bundled pdfium
- CBZ (ZIP) and CBR (RAR) comic reader
- Chapter navigation with Table of Contents sidebar
- Floating prev/next arrows for EPUB chapters
- Mouse wheel page navigation for PDF/CBZ/CBR
- Page zoom (Ctrl+scroll, 50%–400%) with drag-to-pan
- Reading progress auto-saved across sessions
- Bookmarks
- Text highlighting with color choices and notes
- Highlights panel with markdown export
- Focus mode (hides UI chrome, auto-hides cursor)
- Light / dark / system theme, adjustable font size and family
- Keyboard shortcuts with help overlay (`?` key)

### Import & Sync
- OPDS catalog browsing (Project Gutenberg, Standard Ebooks, ManyBooks, Feedbooks)
- Add custom OPDS catalog URLs (Calibre servers, etc.)
- One-click download from catalogs into library
- Library export/backup (metadata-only or full with book files)
- Import from backup archive

### Stats & Social
- Reading session tracking with stats dashboard
- Daily reading chart, streaks, books finished
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
