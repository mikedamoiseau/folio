# Ebook Reader — User Guide

How to install, import books, and read them. Settings and shortcuts are at the bottom.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Managing Your Library](#2-managing-your-library)
3. [Reading a Book](#3-reading-a-book)
4. [Customizing Your Reading Experience](#4-customizing-your-reading-experience)
5. [Keyboard Shortcuts](#5-keyboard-shortcuts)
6. [Troubleshooting](#6-troubleshooting)

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

**macOS:** Open the `.dmg`, drag Ebook Reader into your Applications folder, then double-click to launch it.

**Windows:** Run the `.msi` installer and follow the prompts.

**Linux (AppImage):** Make the file executable (`chmod +x ebook-reader.AppImage`), then run it.

**Linux (.deb):** Run `sudo dpkg -i ebook-reader.deb`.

### First launch

The first time you open the app, you'll see an empty library with a prompt to import your first book. Your data stays on your machine.

![Screenshot](screenshots/empty-library.png)

---

## 2. Managing Your Library

### Importing EPUB files

**File picker:** Click the Import button in the top-right corner of the library screen. A file dialog opens; pick any `.epub` file and confirm. The book appears in your library within a few seconds.

![Screenshot](screenshots/import-button.png)

**Drag and drop:** Drag one or more `.epub` files from Finder or File Explorer directly onto the library window. A blue "Drop to import" overlay appears. Release to import them.

![Screenshot](screenshots/drag-drop.png)

> **Note:** Only `.epub` files are accepted. Dragging other formats does nothing.

### Viewing your books

Books are shown as a cover grid. Each card shows the cover image (when the EPUB includes one), the title and author, and a small progress indicator.

### Searching

Type in the search bar at the top to filter by title or author. Results update as you type. If nothing matches, you'll see a "No results" message.

![Screenshot](screenshots/search.png)

### Removing a book

Hover over a book card and click the trash icon. The book is removed from your library, but the original file on disk stays untouched. Only the library entry and saved progress are deleted.

![Screenshot](screenshots/remove-book.png)

---

## 3. Reading a book

### Opening a book

Click any book card to open it. If you've read it before, the app picks up where you left off — same chapter, same scroll position.

### Navigating chapters

- Click the Previous / Next buttons at the bottom of the page
- Press the left or right arrow keys
- Open the Table of Contents and click a chapter directly

### Using the Table of Contents

Click the list icon (☰) in the top-left of the reader header. The TOC sidebar slides open with all chapters listed; the current one is highlighted. Click any entry to jump there. Press Escape or click outside the sidebar to close it.

![Screenshot](screenshots/toc-sidebar.png)

### Reading progress

Progress is saved automatically as you read. The footer shows your current chapter number and a scroll-position bar for that chapter. The next time you open the book, you land in exactly the same spot.

### Returning to the library

Click the back arrow (←) in the top-left corner. Your progress is saved when you exit.

---

## 4. Customizing your reading experience

Click the gear icon (⚙) in the top-right of the reader header to open Settings.

![Screenshot](screenshots/settings-panel.png)

### Theme

Light, Dark, or System. System mode tracks your OS setting automatically.

### Font size

Use the slider or the +/- buttons to pick a size between 14px and 24px. The A- / A+ buttons in the reader header do the same thing if you want a quick adjustment without opening Settings.

### Font family

Pick Serif (Georgia) or Sans-serif (system font). A live preview sentence shows you what it looks like before you close the panel.

---

## 5. Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `→` | Next chapter |
| `←` | Previous chapter |
| `Escape` | Close Table of Contents sidebar |

---

## 6. Troubleshooting

### "Failed to load book"

The EPUB is probably corrupted or uses a spec the parser can't handle. Try re-downloading the file, or open it in another reader to check if the file itself is the problem.

### Supported formats

EPUB 2 and EPUB 3 only. The app does not open PDF, MOBI, AZW, CBZ, or any other format.

### Where is library data stored?

| Platform | Location |
|----------|----------|
| macOS    | `~/Library/Application Support/ebook-reader/` |
| Windows  | `%APPDATA%\ebook-reader\` |
| Linux    | `~/.local/share/ebook-reader/` |

The app stores a path reference to each book, not a copy of the file itself. If you move or delete an EPUB from its original location, the library entry stays but the book won't open.

### The app won't start

Check that your OS meets the minimum version listed in [Getting Started](#1-getting-started). On macOS, a Gatekeeper security warning is normal for unsigned apps. Go to System Settings > Privacy & Security and click Open Anyway.
