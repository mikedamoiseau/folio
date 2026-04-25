# Folio

A local-first desktop app for people who want to read and organize the books they already own.

![Folio library](screenshots/01-library-light.png)

Folio is a cross-platform reader for EPUB, MOBI / AZW / AZW3, PDF, CBZ, and CBR. It keeps your library on your machine and gives you the tools to actually use it well: solid reading controls, sensible organization, metadata cleanup, highlights, profiles, backup, and OPDS catalog support.

## Why Folio?

A lot of reading apps try to funnel you into a store, an account, or somebody else's ecosystem.

Folio is for the opposite case: you already have the files, and you want a better home for them.

- Local-first: your books and reading data stay on your machine
- Built for owned files: EPUBs, PDFs, and comics without vendor lock-in
- Good to read in: typography, themes, focus mode, highlights, bookmarks, and progress tracking
- Good to manage: collections, tags, metadata editing, profiles, ratings, backups, and activity history

## Highlights

### Reading
- EPUB 2 & 3 reader with sanitized HTML rendering
- PDF support via bundled Pdfium
- CBZ and CBR comic reading
- EPUB paginated mode and continuous scroll mode
- Table of contents sidebar and chapter navigation
- Full-text search inside EPUB books (`⌘/Ctrl+F`)
- Focus mode for distraction-free reading
- Bookmarks, highlights, and highlight notes
- Time-to-finish estimate for EPUB books
- Adjustable font size and advanced typography controls
- Built-in themes: Light, Sepia, Dark, Auto
- Custom fonts and custom CSS override for EPUB content

### Library
- Import via file picker, drag-and-drop, direct URL, or folder scan
- Copy-on-import into an app-managed library folder
- Duplicate detection using SHA-256 file hashing
- Search by title or author
- Sort by date added, last read, title, author, progress, or rating
- Filter by format, reading status, and minimum rating
- Manual and rule-based collections
- Tags with autocomplete
- Metadata editing: title, author, series, language, publisher, cover, rating, tags
- Recently opened books for quick resume
- Multiple profiles with separate libraries

### Catalogs, metadata, and backup
- OPDS catalog browsing
- Built-in catalogs such as Project Gutenberg and Standard Ebooks
- Add custom OPDS catalog URLs
- One-click download from catalogs into your library
- Metadata enrichment via OpenLibrary and provider-based scanning
- Library export and backup
- Restore from backup archive
- Activity log for imports, edits, deletes, collection changes, and more
- Reading stats dashboard

## Screenshots

<details open>
<summary>Dark mode</summary>

![Library in dark mode](screenshots/03-library-dark.png)
</details>

<details>
<summary>EPUB reader</summary>

![Reading an EPUB](screenshots/10-reader-epub.png)
</details>

<details>
<summary>Highlights & annotations</summary>

![Highlights panel](screenshots/12-reader-highlights.png)
</details>

<details>
<summary>Reading stats</summary>

![Reading statistics](screenshots/07-reading-stats.png)
</details>

<details>
<summary>Collections</summary>

![Collections sidebar](screenshots/09-collections.png)
</details>

<details>
<summary>Book details</summary>

![Book detail modal](screenshots/15-book-detail.png)
</details>

<details>
<summary>OPDS catalogs</summary>

![Book catalogs](screenshots/08-catalogs.png)
</details>

<details>
<summary>Keyboard shortcuts</summary>

![Keyboard shortcuts](screenshots/14-keyboard-shortcuts.png)
</details>

## Docs

- User guide: [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Installation

Pre-built binaries are available on the [GitHub Releases page](https://github.com/mikedamoiseau/folio/releases).

### macOS

Open the `.dmg`, drag **Folio.app** to **Applications**, then launch it.

#### macOS Gatekeeper: "damaged" / "unidentified developer" warning

Because Folio is not currently notarized with an Apple Developer certificate, macOS may block it on first launch.

Run this once after installing:

```bash
xattr -cr /Applications/Folio.app
```

Then launch the app normally.

### Windows

Run the `.msi` installer and follow the prompts. MOBI support is statically linked into `folio.exe` — no separate libmobi install is needed.

### Linux

Use the provided `.AppImage` or `.deb` release artifact. For MOBI support, install libmobi via your package manager (`sudo apt install libmobi0` on Debian/Ubuntu — the `.deb` package declares this as a dependency).

## Supported formats

| Format | Notes |
|---|---|
| EPUB 2 / EPUB 3 | Reflowable reading with search, themes, typography, highlights |
| MOBI / AZW / AZW3 | Mobipocket and Kindle formats via libmobi (Linux, arm64 macOS, Windows; not Intel macOS) |
| PDF | Page-based reading via Pdfium |
| CBZ | Comic archive (ZIP) |
| CBR | Comic archive (RAR) |

## Tech stack

### Backend
- Rust
- Tauri v2
- SQLite (`rusqlite` + `r2d2`)
- `ammonia` for EPUB sanitization
- `pdfium-render` for PDF support
- `unrar` for CBR support
- `reqwest` for network operations

### Frontend
- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- DOMPurify

## Development

### Requirements
- [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- Node.js 18+
- Rust stable

### Install dependencies

```bash
npm install
```

### Pdfium setup

PDF support requires Pdfium binaries. Download them before running the app in development:

```bash
./scripts/download-pdfium.sh
```

### Run the app

```bash
npm run tauri dev
```

### Build for production

```bash
npm run tauri build
```

### Useful commands

```bash
npm run type-check
npm run build
npm run test
```

Rust-only commands from `src-tauri/`:

```bash
cargo test
cargo clippy -- -D warnings
cargo fmt --check
```

### MOBI test fixtures

MOBI / AZW / AZW3 tests are gated on a public-domain test corpus that is
**not** checked into the repository — the fixtures live under
`src-tauri/test-fixtures/` (gitignored). Populate them once before running
the MOBI tests:

```bash
./scripts/fetch-mobi-test-corpus.sh
```

The script downloads Alice's Adventures in Wonderland from Project
Gutenberg in both legacy Mobipocket (v6) and KF8 (v8 / AZW3) form. Tests
that require a fixture skip with a clear message when it is absent, so the
suite stays green on fresh clones.

## Project structure

- `src/` - React frontend
- `src-tauri/src/commands.rs` - Tauri command handlers / IPC surface
- `src-tauri/src/db.rs` - SQLite access layer
- `src-tauri/src/models.rs` - shared data models
- `src-tauri/src/epub.rs`, `pdf.rs`, `cbz.rs`, `cbr.rs` - format-specific parsing
- `docs/` - user-facing docs and roadmap

## CI

![CI](https://github.com/mikedamoiseau/folio/actions/workflows/ci.yml/badge.svg)

## License

MIT
