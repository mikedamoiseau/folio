# Multi-Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add i18n infrastructure with English and French translations, OS locale auto-detection, and a flag-based language switcher.

**Architecture:** i18next + react-i18next with browser language detection. One JSON file per language under `src/locales/`. Translation keys use dot-notation grouping (`library.*`, `reader.*`, `settings.*`, etc.). A `LanguageSwitcher` component shows flag buttons in the library toolbar and reader header. Components migrate incrementally from hardcoded strings to `t()` calls.

**Tech Stack:** i18next, react-i18next, i18next-browser-languagedetector, React 19, TypeScript

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/i18n.ts` | i18next initialization, language detection config, resource registration |
| `src/locales/en.json` | English translations (~250 keys) |
| `src/locales/fr.json` | French translations (~250 keys) |
| `src/components/LanguageSwitcher.tsx` | Flag dropdown for switching language |
| `src/main.tsx` | Import `./i18n` before App |
| `src/screens/Library.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/ImportButton.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/EmptyState.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/BookCard.tsx` | Migrate hardcoded strings to `t()` |
| `src/screens/Reader.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/BookmarksPanel.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/HighlightsPanel.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/SettingsPanel.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/CollectionsSidebar.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/CatalogBrowser.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/EditBookDialog.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/ActivityLog.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/ProfileSwitcher.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/BookDetailModal.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/ReadingStats.tsx` | Migrate hardcoded strings to `t()` |
| `src/components/KeyboardShortcutsHelp.tsx` | Migrate hardcoded strings to `t()` |
| `src/lib/errors.ts` | Accept `t` function for translated error messages |

---

### Task 1: Install dependencies and set up i18next infrastructure

**Files:**
- Modify: `package.json` (via npm install)
- Create: `src/i18n.ts`
- Create: `src/locales/en.json` (initial subset — common keys + a few library strings to prove it works)
- Create: `src/locales/fr.json` (matching French subset)
- Modify: `src/main.tsx`

- [ ] **Step 1: Install i18next packages**

```bash
npm install i18next react-i18next i18next-browser-languagedetector
```

- [ ] **Step 2: Create initial English locale file**

Create `src/locales/en.json` with the complete set of all translation keys. This is the authoritative key list — French will mirror it exactly.

```json
{
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.back": "Back",
  "common.loading": "Loading...",
  "common.search": "Search",
  "common.remove": "Remove",
  "common.edit": "Edit",
  "common.open": "Open",
  "common.export": "Export",
  "common.import": "Import",
  "common.add": "Add",
  "common.create": "Create",
  "common.saving": "Saving...",
  "common.dismiss": "Dismiss",
  "common.clear": "Clear",
  "common.show": "Show",
  "common.hide": "Hide",

  "library.addBooks": "+ Add books",
  "library.addFiles": "Add files",
  "library.importFolder": "Import folder",
  "library.importFromUrl": "Import from URL",
  "library.importUrlPlaceholder": "https://example.com/book.epub",
  "library.importUrlHelp": "Direct link to an EPUB, PDF, CBZ, or CBR file.",
  "library.searchPlaceholder": "Search by title or author...",
  "library.allFormats": "All formats",
  "library.allStatus": "All status",
  "library.unread": "Unread",
  "library.inProgress": "In progress",
  "library.finished": "Finished",
  "library.allRatings": "All ratings",
  "library.starsPlus": "{{count}}+ stars",
  "library.stars5": "5 stars",
  "library.filterByFormat": "Filter by format",
  "library.filterByStatus": "Filter by status",
  "library.filterByRating": "Filter by rating",
  "library.continueReading": "Continue Reading",
  "library.discover": "Discover",
  "library.addToLibrary": "+ Add to library",
  "library.showDescription": "Show description",
  "library.otherBooks": "Other Books",
  "library.booksCount": "{{count}} books",
  "library.noResults": "No books match the current filters",
  "library.noSearchResults": "No results for \"{{query}}\". Try a different search term.",
  "library.noFilterResults": "Try adjusting your sort, format, or status filters.",
  "library.clearAllFilters": "Clear all filters",
  "library.importingProgress": "Importing {{current}} of {{total}}...",
  "library.importing": "Importing...",
  "library.dropToAdd": "Drop to add books",
  "library.loadingLibrary": "Loading library...",
  "library.collections": "Collections",
  "library.openCollections": "Open collections",
  "library.emptyCollection": "This collection is empty",
  "library.emptyManualHint": "Drag books onto this collection to add them.",
  "library.emptySmartHint": "No books match this collection's rules yet.",
  "library.backToAllBooks": "Back to all books",
  "library.noSupportedFiles": "No supported book files (.epub, .pdf, .cbz, .cbr) found in that folder.",
  "library.scanLibrary": "Scan library",
  "library.scanLibraryTitle": "Scan library for metadata",
  "library.enrichingProgress": "Enriching {{current}}/{{total}}: {{title}}",
  "library.cancelScan": "Cancel scan",
  "library.dismissError": "Dismiss error",

  "library.sortDateAdded": "Date added",
  "library.sortTitle": "Title",
  "library.sortAuthor": "Author",
  "library.sortLastRead": "Last read",
  "library.sortProgress": "Progress",
  "library.sortRating": "Rating",
  "library.sortSeries": "Series",

  "import.addBooks": "+ Add books",
  "import.addFiles": "Add files",
  "import.importFolder": "Import folder",
  "import.importFromUrl": "Import from URL",
  "import.importUrlTitle": "Import from URL",
  "import.urlPlaceholder": "https://example.com/book.epub",
  "import.urlHelp": "Direct link to an EPUB, PDF, CBZ, or CBR file.",
  "import.importingProgress": "Importing {{current}} of {{total}}...",
  "import.importing": "Importing...",

  "empty.title": "Your shelf awaits",
  "empty.description": "Add your first book and begin your reading journey.",
  "empty.addBooks": "Add books",
  "empty.importFolder": "Import folder",
  "empty.dragHint": "or drag & drop files anywhere",

  "bookCard.coverAlt": "Cover of {{title}}",
  "bookCard.editTitle": "Edit {{title}}",
  "bookCard.scanMetadata": "Scan for metadata",
  "bookCard.detailsTitle": "Details for {{title}}",
  "bookCard.removeTitle": "Remove {{title}}",
  "bookCard.removeFromCollection": "Remove from collection",
  "bookCard.confirmDeletion": "Confirm deletion",
  "bookCard.deleteConfirm": "Delete \"{{title}}\"?",

  "reader.loading": "Loading...",
  "reader.loadingPages": "Loading pages...",
  "reader.loadingChapters": "Loading {{count}} chapters...",
  "reader.failedToLoad": "Failed to load book",
  "reader.failedToLoadChapter": "Failed to load chapter: {{error}}",
  "reader.backToLibrary": "Back to Library",
  "reader.contents": "Contents",
  "reader.closeToc": "Close table of contents",
  "reader.openToc": "Open table of contents",
  "reader.searchInBook": "Search in book",
  "reader.searchShortcut": "Search (\u2318F)",
  "reader.searchPlaceholder": "Search in book...",
  "reader.searching": "Searching...",
  "reader.matchCount": "{{count}} match",
  "reader.matchCountPlural": "{{count}} matches",
  "reader.closeSearch": "Close search",
  "reader.noMatches": "No matches found for \u201c{{query}}\u201d",
  "reader.resultsCapped": "Results capped at 200. Try a more specific query.",
  "reader.highlights": "Highlights",
  "reader.bookmarks": "Bookmarks",
  "reader.decreaseFont": "Decrease font size",
  "reader.fontSmaller": "A\u2212",
  "reader.increaseFont": "Increase font size",
  "reader.fontLarger": "A+",
  "reader.dualPage": "Dual-page spread",
  "reader.toggleDualPage": "Toggle dual-page spread",
  "reader.mangaMode": "Manga mode (RTL)",
  "reader.toggleManga": "Toggle manga mode (right-to-left)",
  "reader.focusMode": "Focus mode (d)",
  "reader.toggleFocus": "Toggle focus mode",
  "reader.openSettings": "Open settings",
  "reader.previous": "Previous",
  "reader.next": "Next",
  "reader.previousChapter": "Previous chapter",
  "reader.nextChapter": "Next chapter",
  "reader.chapterOf": "{{current}} / {{total}}",
  "reader.chapterFallback": "Chapter {{index}}",
  "reader.pageOf": "Page {{current}} / {{total}}",
  "reader.pagesOf": "Pages {{start}}\u2013{{end}} / {{total}}",
  "reader.timeLeft": "{{time}} left",
  "reader.timeLeftTooltip": "{{chapter}} left in chapter, {{book}} left in book",
  "reader.highlightColor": "Highlight {{color}}",
  "reader.clearHighlight": "Clear highlight",
  "reader.removeHighlight": "Remove highlight",
  "reader.progressSaved": "Progress saved",
  "reader.progressNotSaved": "Progress not saved",

  "bookmarks.title": "Bookmarks",
  "bookmarks.close": "Close bookmarks",
  "bookmarks.empty": "No bookmarks yet. Press <key>b</key> while reading to add one.",
  "bookmarks.namePlaceholder": "Bookmark name...",
  "bookmarks.clickToEdit": "Click to edit name",
  "bookmarks.percentThrough": "{{percent}}% through",
  "bookmarks.deleteBookmark": "Delete bookmark",

  "highlights.title": "Highlights",
  "highlights.copyMarkdown": "Copy all as Markdown",
  "highlights.close": "Close highlights",
  "highlights.empty": "No highlights yet. Select text while reading to create one.",
  "highlights.chapterN": "Chapter {{index}}",
  "highlights.addNote": "Add a note...",
  "highlights.addNoteButton": "+ Add note",
  "highlights.deleteHighlight": "Delete highlight",

  "settings.title": "Settings",
  "settings.close": "Close settings",
  "settings.appearance": "Appearance",
  "settings.customColors": "Custom colors",
  "settings.resetSepia": "Reset to sepia",
  "settings.resetLight": "Reset to light",
  "settings.customCss": "Custom CSS",
  "settings.customCssHelp": "Applied as a global stylesheet while reading EPUBs. Target <code>.reader-content</code> and its children.",
  "settings.clearCss": "Clear custom CSS",
  "settings.textTypography": "Text & Typography",
  "settings.readingFont": "Reading font",
  "settings.addFont": "+ Add font...",
  "settings.fontWarning": "Adding many fonts may slow down the app",
  "settings.fontPreview": "The quick brown fox jumps over the lazy dog.",
  "settings.lineHeight": "Line height",
  "settings.pageMargins": "Page margins",
  "settings.paragraphSpacing": "Paragraph spacing",
  "settings.textAlignment": "Text alignment",
  "settings.alignLeft": "Left",
  "settings.alignJustify": "Justify",
  "settings.hyphenation": "Hyphenation",
  "settings.hyphenationHelp": "Automatically break long words at line endings for a tidier text block.",
  "settings.pageLayout": "Page Layout",
  "settings.paginated": "Paginated",
  "settings.continuous": "Continuous",
  "settings.paginatedHelp": "Read one chapter at a time with prev/next navigation. Switch to continuous scroll for a seamless reading experience.",
  "settings.continuousHelp": "Scroll through all chapters in one continuous flow. Large books may take a moment to load.",
  "settings.dualPage": "Dual-page spread",
  "settings.dualPageHelp": "Show two pages side by side, like an open book.",
  "settings.mangaMode": "Manga mode (right-to-left)",
  "settings.mangaHelp": "Swap page order so the right page comes first, for manga and RTL comics.",
  "settings.library": "Library",
  "settings.storageFolder": "Storage folder",
  "settings.changeFolder": "Change folder...",
  "settings.includeFiles": "Include book files",
  "settings.fullBackupHelp": "Full backup \u2014 metadata + all book files (can be large)",
  "settings.metadataOnlyHelp": "Metadata only \u2014 progress, collections, tags, highlights (small)",
  "settings.exportBackup": "Export library backup...",
  "settings.importBackup": "Import from backup...",
  "settings.working": "Working...",
  "settings.backupRestore": "Backup & Restore",
  "settings.metadataScan": "Metadata Scan",
  "settings.autoScanImport": "Auto-scan on import",
  "settings.autoScanImportHelp": "Automatically look up metadata when importing new books",
  "settings.autoScanStartup": "Auto-scan on startup",
  "settings.autoScanStartupHelp": "Scan unenriched books when the app starts",
  "settings.enrichmentSources": "Enrichment Sources",
  "settings.apiKeyPlaceholder": "API key (optional)",
  "settings.activity": "Activity",
  "settings.viewActivityLog": "View activity log",
  "settings.remoteBackup": "Remote Backup",
  "settings.provider": "Provider",
  "settings.saveConfig": "Save Configuration",
  "settings.savingConfig": "Saving...",
  "settings.backupNow": "Backup Now",
  "settings.lastBackup": "Last backup: {{date}}",
  "settings.device": "Device: {{id}}",
  "settings.changeFolderTitle": "Change Library Folder",
  "settings.currentFolder": "Current folder",
  "settings.newFolder": "New folder",
  "settings.dontMoveFiles": "Don't move existing files \u2014 only use new folder for future imports",
  "settings.changeAndMove": "Move & Update",
  "settings.changeOnly": "Change Folder",
  "settings.removeFont": "Remove {{name}}",
  "settings.skipHostKey": "Skip host key verification (insecure)",

  "collections.title": "Collections",
  "collections.close": "Close collections",
  "collections.allBooks": "All Books",
  "collections.series": "Series",
  "collections.newCollection": "New Collection",
  "collections.editCollection": "Edit Collection",
  "collections.name": "Name",
  "collections.namePlaceholder": "Collection name",
  "collections.type": "Type",
  "collections.iconOptional": "Icon (optional)",
  "collections.color": "Color",
  "collections.colorLabel": "Color {{color}}",
  "collections.rules": "Rules",
  "collections.addRule": "+ Add rule",
  "collections.removeRule": "Remove rule",
  "collections.noMatch": "No books match these rules",
  "collections.matchCount": "{{count}} book matches these rules",
  "collections.matchCountPlural": "{{count}} books match these rules",
  "collections.valuePlaceholder": "value",
  "collections.auto": "auto",
  "collections.deleteConfirm": "Delete {{name}}?",
  "collections.shareTitle": "Share {{name}}",
  "collections.exportCollection": "Export collection",
  "collections.copyMarkdown": "Copy as Markdown",
  "collections.copyJson": "Copy as JSON",
  "collections.copiedMarkdown": "Copied as Markdown!",
  "collections.copiedJson": "Copied as JSON!",
  "collections.exportFailed": "Export failed",
  "collections.editTitle": "Edit {{name}}",
  "collections.deleteTitle": "Delete {{name}}",

  "collections.fieldAuthor": "Author",
  "collections.fieldTitle": "Title",
  "collections.fieldSeries": "Series",
  "collections.fieldLanguage": "Language",
  "collections.fieldPublisher": "Publisher",
  "collections.fieldDescription": "Description",
  "collections.fieldFormat": "Format",
  "collections.fieldTag": "Tag",
  "collections.fieldDateAdded": "Date Added",
  "collections.fieldProgress": "Reading Progress",
  "collections.opContains": "contains",
  "collections.opIs": "is",
  "collections.opWithinDays": "within last (days)",
  "collections.progressUnread": "Unread",
  "collections.progressInProgress": "In Progress",
  "collections.progressFinished": "Finished",

  "catalog.title": "Book Catalogs",
  "catalog.searchAll": "Search all catalogs...",
  "catalog.searchingAll": "Searching all catalogs...",
  "catalog.noResults": "No results found.",
  "catalog.addedToLibrary": "Added to library",
  "catalog.downloading": "Downloading...",
  "catalog.removeCatalog": "Remove {{name}}",
  "catalog.removeCatalogTitle": "Remove catalog",
  "catalog.catalogName": "Catalog name",
  "catalog.feedUrl": "OPDS feed URL",
  "catalog.addCustom": "Add custom OPDS catalog",
  "catalog.catalog": "Catalog",
  "catalog.searchCatalog": "Search this catalog...",
  "catalog.noEntries": "No entries found.",
  "catalog.loadMore": "Load more...",

  "editor.title": "Edit Book",
  "editor.bookTitle": "Title",
  "editor.author": "Author",
  "editor.series": "Series",
  "editor.seriesPlaceholder": "e.g. Aria",
  "editor.volume": "Vol.",
  "editor.volumePlaceholder": "#",
  "editor.language": "Language",
  "editor.languagePlaceholder": "e.g. fr, en",
  "editor.year": "Year",
  "editor.yearPlaceholder": "2024",
  "editor.publisher": "Publisher",
  "editor.rating": "Rating",
  "editor.ratingDisplay": "Rating: {{rating}} / 5",
  "editor.tags": "Tags",
  "editor.removeTag": "Remove tag {{name}}",
  "editor.addTag": "Add a tag...",
  "editor.changeCover": "Change cover image...",
  "editor.openLibrary": "Metadata from OpenLibrary",
  "editor.searching": "Searching...",
  "editor.lookUp": "Look up on OpenLibrary",

  "activity.title": "Activity Log",
  "activity.close": "Close activity log",
  "activity.empty": "No activity recorded yet.",
  "activity.loadMore": "Load more",
  "activity.justNow": "Just now",
  "activity.minutesAgo": "{{count}}m ago",
  "activity.hoursAgo": "{{count}}h ago",
  "activity.daysAgo": "{{count}}d ago",
  "activity.bookImported": "Book Imported",
  "activity.bookDeleted": "Book Deleted",
  "activity.bookUpdated": "Book Updated",
  "activity.bookEnriched": "Book Enriched",
  "activity.bookScanned": "Metadata Scan",
  "activity.collectionCreated": "Collection Created",
  "activity.collectionDeleted": "Collection Deleted",
  "activity.collectionModified": "Collection Modified",
  "activity.libraryExported": "Library Exported",
  "activity.libraryImported": "Library Imported",
  "activity.backupCompleted": "Backup Completed",
  "activity.backupFailed": "Backup Failed",
  "activity.profileSwitched": "Profile Switched",

  "profiles.manage": "Manage profiles",
  "profiles.namePlaceholder": "Profile name",
  "profiles.newProfile": "New profile",

  "detail.series": "Series",
  "detail.language": "Language",
  "detail.year": "Year",
  "detail.publisher": "Publisher",
  "detail.scanMetadata": "Scan for metadata",
  "detail.coverAlt": "Cover of {{title}}",
  "detail.detailsFor": "Details for {{title}}",

  "stats.title": "Reading Stats",
  "stats.timeReading": "Time Reading",
  "stats.sessions": "Sessions",
  "stats.pagesRead": "Pages Read",
  "stats.booksFinished": "Books Finished",
  "stats.currentStreak": "Current Streak",
  "stats.longestStreak": "Longest Streak",
  "stats.daysCount": "{{count}} days",
  "stats.last30Days": "Last 30 Days",

  "shortcuts.title": "Keyboard Shortcuts",
  "shortcuts.library": "Library",
  "shortcuts.reader": "Reader",
  "shortcuts.focusSearch": "Focus search",
  "shortcuts.clearClose": "Clear search / close panels",
  "shortcuts.toggleCollections": "Toggle collections sidebar",
  "shortcuts.toggleHelp": "Toggle this help",
  "shortcuts.prevNext": "Previous / Next chapter",
  "shortcuts.toggleToc": "Toggle table of contents",
  "shortcuts.addBookmark": "Add bookmark",
  "shortcuts.toggleFocus": "Toggle focus mode",
  "shortcuts.closeExit": "Close panels / Exit focus / Back to library",

  "errors.pdfium": "PDF support is not available. The pdfium library could not be loaded.",
  "errors.fileNotFound": "This book file could not be found. It may have been moved or deleted.",
  "errors.permissionDenied": "Permission denied. Check that the file is accessible.",
  "errors.invalidFormat": "This file format is not supported.",
  "errors.duplicate": "This book is already in your library.",
  "errors.chapterLoad": "Could not load this chapter. Try restarting the reader.",
  "errors.corrupt": "This file appears to be damaged and cannot be opened.",
  "errors.generic": "Something went wrong. Please try again.",

  "language.en": "English",
  "language.fr": "Francais"
}
```

- [ ] **Step 3: Create French locale file**

Create `src/locales/fr.json` with the same keys, all values translated to French:

```json
{
  "common.save": "Enregistrer",
  "common.cancel": "Annuler",
  "common.delete": "Supprimer",
  "common.close": "Fermer",
  "common.back": "Retour",
  "common.loading": "Chargement...",
  "common.search": "Rechercher",
  "common.remove": "Retirer",
  "common.edit": "Modifier",
  "common.open": "Ouvrir",
  "common.export": "Exporter",
  "common.import": "Importer",
  "common.add": "Ajouter",
  "common.create": "Creer",
  "common.saving": "Enregistrement...",
  "common.dismiss": "Fermer",
  "common.clear": "Effacer",
  "common.show": "Afficher",
  "common.hide": "Masquer",

  "library.addBooks": "+ Ajouter des livres",
  "library.addFiles": "Ajouter des fichiers",
  "library.importFolder": "Importer un dossier",
  "library.importFromUrl": "Importer depuis une URL",
  "library.importUrlPlaceholder": "https://exemple.com/livre.epub",
  "library.importUrlHelp": "Lien direct vers un fichier EPUB, PDF, CBZ ou CBR.",
  "library.searchPlaceholder": "Rechercher par titre ou auteur...",
  "library.allFormats": "Tous les formats",
  "library.allStatus": "Tous les statuts",
  "library.unread": "Non lu",
  "library.inProgress": "En cours",
  "library.finished": "Termine",
  "library.allRatings": "Toutes les notes",
  "library.starsPlus": "{{count}}+ etoiles",
  "library.stars5": "5 etoiles",
  "library.filterByFormat": "Filtrer par format",
  "library.filterByStatus": "Filtrer par statut",
  "library.filterByRating": "Filtrer par note",
  "library.continueReading": "Continuer la lecture",
  "library.discover": "Decouvrir",
  "library.addToLibrary": "+ Ajouter a la bibliotheque",
  "library.showDescription": "Afficher la description",
  "library.otherBooks": "Autres livres",
  "library.booksCount": "{{count}} livres",
  "library.noResults": "Aucun livre ne correspond aux filtres",
  "library.noSearchResults": "Aucun resultat pour \"{{query}}\". Essayez un autre terme.",
  "library.noFilterResults": "Essayez d'ajuster vos filtres de tri, format ou statut.",
  "library.clearAllFilters": "Effacer tous les filtres",
  "library.importingProgress": "Importation {{current}} sur {{total}}...",
  "library.importing": "Importation...",
  "library.dropToAdd": "Deposer pour ajouter des livres",
  "library.loadingLibrary": "Chargement de la bibliotheque...",
  "library.collections": "Collections",
  "library.openCollections": "Ouvrir les collections",
  "library.emptyCollection": "Cette collection est vide",
  "library.emptyManualHint": "Glissez des livres sur cette collection pour les ajouter.",
  "library.emptySmartHint": "Aucun livre ne correspond encore aux regles de cette collection.",
  "library.backToAllBooks": "Retour a tous les livres",
  "library.noSupportedFiles": "Aucun fichier compatible (.epub, .pdf, .cbz, .cbr) trouve dans ce dossier.",
  "library.scanLibrary": "Scanner la bibliotheque",
  "library.scanLibraryTitle": "Scanner la bibliotheque pour les metadonnees",
  "library.enrichingProgress": "Enrichissement {{current}}/{{total}} : {{title}}",
  "library.cancelScan": "Annuler le scan",
  "library.dismissError": "Fermer l'erreur",

  "library.sortDateAdded": "Date d'ajout",
  "library.sortTitle": "Titre",
  "library.sortAuthor": "Auteur",
  "library.sortLastRead": "Derniere lecture",
  "library.sortProgress": "Progression",
  "library.sortRating": "Note",
  "library.sortSeries": "Serie",

  "import.addBooks": "+ Ajouter des livres",
  "import.addFiles": "Ajouter des fichiers",
  "import.importFolder": "Importer un dossier",
  "import.importFromUrl": "Importer depuis une URL",
  "import.importUrlTitle": "Importer depuis une URL",
  "import.urlPlaceholder": "https://exemple.com/livre.epub",
  "import.urlHelp": "Lien direct vers un fichier EPUB, PDF, CBZ ou CBR.",
  "import.importingProgress": "Importation {{current}} sur {{total}}...",
  "import.importing": "Importation...",

  "empty.title": "Votre etagere vous attend",
  "empty.description": "Ajoutez votre premier livre et commencez votre aventure de lecture.",
  "empty.addBooks": "Ajouter des livres",
  "empty.importFolder": "Importer un dossier",
  "empty.dragHint": "ou glissez-deposez des fichiers n'importe ou",

  "bookCard.coverAlt": "Couverture de {{title}}",
  "bookCard.editTitle": "Modifier {{title}}",
  "bookCard.scanMetadata": "Scanner les metadonnees",
  "bookCard.detailsTitle": "Details de {{title}}",
  "bookCard.removeTitle": "Supprimer {{title}}",
  "bookCard.removeFromCollection": "Retirer de la collection",
  "bookCard.confirmDeletion": "Confirmer la suppression",
  "bookCard.deleteConfirm": "Supprimer \"{{title}}\" ?",

  "reader.loading": "Chargement...",
  "reader.loadingPages": "Chargement des pages...",
  "reader.loadingChapters": "Chargement de {{count}} chapitres...",
  "reader.failedToLoad": "Echec du chargement du livre",
  "reader.failedToLoadChapter": "Echec du chargement du chapitre : {{error}}",
  "reader.backToLibrary": "Retour a la bibliotheque",
  "reader.contents": "Sommaire",
  "reader.closeToc": "Fermer la table des matieres",
  "reader.openToc": "Ouvrir la table des matieres",
  "reader.searchInBook": "Rechercher dans le livre",
  "reader.searchShortcut": "Rechercher (\u2318F)",
  "reader.searchPlaceholder": "Rechercher dans le livre...",
  "reader.searching": "Recherche...",
  "reader.matchCount": "{{count}} resultat",
  "reader.matchCountPlural": "{{count}} resultats",
  "reader.closeSearch": "Fermer la recherche",
  "reader.noMatches": "Aucun resultat pour \u201c{{query}}\u201d",
  "reader.resultsCapped": "Resultats limites a 200. Essayez une recherche plus precise.",
  "reader.highlights": "Surlignages",
  "reader.bookmarks": "Signets",
  "reader.decreaseFont": "Reduire la taille de police",
  "reader.fontSmaller": "A\u2212",
  "reader.increaseFont": "Augmenter la taille de police",
  "reader.fontLarger": "A+",
  "reader.dualPage": "Double page",
  "reader.toggleDualPage": "Activer/desactiver la double page",
  "reader.mangaMode": "Mode manga (DTG)",
  "reader.toggleManga": "Activer/desactiver le mode manga (droite a gauche)",
  "reader.focusMode": "Mode concentration (d)",
  "reader.toggleFocus": "Activer/desactiver le mode concentration",
  "reader.openSettings": "Ouvrir les parametres",
  "reader.previous": "Precedent",
  "reader.next": "Suivant",
  "reader.previousChapter": "Chapitre precedent",
  "reader.nextChapter": "Chapitre suivant",
  "reader.chapterOf": "{{current}} / {{total}}",
  "reader.chapterFallback": "Chapitre {{index}}",
  "reader.pageOf": "Page {{current}} / {{total}}",
  "reader.pagesOf": "Pages {{start}}\u2013{{end}} / {{total}}",
  "reader.timeLeft": "{{time}} restant",
  "reader.timeLeftTooltip": "{{chapter}} restant dans le chapitre, {{book}} restant dans le livre",
  "reader.highlightColor": "Surligner en {{color}}",
  "reader.clearHighlight": "Effacer le surlignage",
  "reader.removeHighlight": "Supprimer le surlignage",
  "reader.progressSaved": "Progression enregistree",
  "reader.progressNotSaved": "Progression non enregistree",

  "bookmarks.title": "Signets",
  "bookmarks.close": "Fermer les signets",
  "bookmarks.empty": "Aucun signet. Appuyez sur <key>b</key> pendant la lecture pour en ajouter un.",
  "bookmarks.namePlaceholder": "Nom du signet...",
  "bookmarks.clickToEdit": "Cliquer pour modifier le nom",
  "bookmarks.percentThrough": "{{percent}}% du livre",
  "bookmarks.deleteBookmark": "Supprimer le signet",

  "highlights.title": "Surlignages",
  "highlights.copyMarkdown": "Copier en Markdown",
  "highlights.close": "Fermer les surlignages",
  "highlights.empty": "Aucun surlignage. Selectionnez du texte pendant la lecture pour en creer un.",
  "highlights.chapterN": "Chapitre {{index}}",
  "highlights.addNote": "Ajouter une note...",
  "highlights.addNoteButton": "+ Ajouter une note",
  "highlights.deleteHighlight": "Supprimer le surlignage",

  "settings.title": "Parametres",
  "settings.close": "Fermer les parametres",
  "settings.appearance": "Apparence",
  "settings.customColors": "Couleurs personnalisees",
  "settings.resetSepia": "Reinitialiser en sepia",
  "settings.resetLight": "Reinitialiser en clair",
  "settings.customCss": "CSS personnalise",
  "settings.customCssHelp": "Applique comme feuille de style globale pour les EPUB. Ciblez <code>.reader-content</code> et ses enfants.",
  "settings.clearCss": "Effacer le CSS personnalise",
  "settings.textTypography": "Texte et typographie",
  "settings.readingFont": "Police de lecture",
  "settings.addFont": "+ Ajouter une police...",
  "settings.fontWarning": "Ajouter beaucoup de polices peut ralentir l'application",
  "settings.fontPreview": "Portez ce vieux whisky au juge blond qui fume.",
  "settings.lineHeight": "Interligne",
  "settings.pageMargins": "Marges de page",
  "settings.paragraphSpacing": "Espacement des paragraphes",
  "settings.textAlignment": "Alignement du texte",
  "settings.alignLeft": "Gauche",
  "settings.alignJustify": "Justifie",
  "settings.hyphenation": "Cesure",
  "settings.hyphenationHelp": "Couper automatiquement les mots longs en fin de ligne pour un bloc de texte plus soigne.",
  "settings.pageLayout": "Mise en page",
  "settings.paginated": "Pagine",
  "settings.continuous": "Continu",
  "settings.paginatedHelp": "Lire un chapitre a la fois avec navigation precedent/suivant. Passez au defilement continu pour une experience de lecture fluide.",
  "settings.continuousHelp": "Faire defiler tous les chapitres d'un seul flux. Les gros livres peuvent prendre un moment a charger.",
  "settings.dualPage": "Double page",
  "settings.dualPageHelp": "Afficher deux pages cote a cote, comme un livre ouvert.",
  "settings.mangaMode": "Mode manga (droite a gauche)",
  "settings.mangaHelp": "Inverser l'ordre des pages pour que la page droite soit affichee en premier, pour les mangas et BD en sens inverse.",
  "settings.library": "Bibliotheque",
  "settings.storageFolder": "Dossier de stockage",
  "settings.changeFolder": "Changer de dossier...",
  "settings.includeFiles": "Inclure les fichiers de livres",
  "settings.fullBackupHelp": "Sauvegarde complete \u2014 metadonnees + tous les fichiers (peut etre volumineux)",
  "settings.metadataOnlyHelp": "Metadonnees uniquement \u2014 progression, collections, tags, surlignages (leger)",
  "settings.exportBackup": "Exporter la sauvegarde...",
  "settings.importBackup": "Importer une sauvegarde...",
  "settings.working": "En cours...",
  "settings.backupRestore": "Sauvegarde et restauration",
  "settings.metadataScan": "Scan des metadonnees",
  "settings.autoScanImport": "Scanner automatiquement a l'import",
  "settings.autoScanImportHelp": "Rechercher automatiquement les metadonnees lors de l'importation de nouveaux livres",
  "settings.autoScanStartup": "Scanner automatiquement au demarrage",
  "settings.autoScanStartupHelp": "Scanner les livres non enrichis au lancement de l'application",
  "settings.enrichmentSources": "Sources d'enrichissement",
  "settings.apiKeyPlaceholder": "Cle API (optionnel)",
  "settings.activity": "Activite",
  "settings.viewActivityLog": "Voir le journal d'activite",
  "settings.remoteBackup": "Sauvegarde distante",
  "settings.provider": "Fournisseur",
  "settings.saveConfig": "Enregistrer la configuration",
  "settings.savingConfig": "Enregistrement...",
  "settings.backupNow": "Sauvegarder maintenant",
  "settings.lastBackup": "Derniere sauvegarde : {{date}}",
  "settings.device": "Appareil : {{id}}",
  "settings.changeFolderTitle": "Changer le dossier de la bibliotheque",
  "settings.currentFolder": "Dossier actuel",
  "settings.newFolder": "Nouveau dossier",
  "settings.dontMoveFiles": "Ne pas deplacer les fichiers existants \u2014 utiliser le nouveau dossier uniquement pour les futurs imports",
  "settings.changeAndMove": "Deplacer et mettre a jour",
  "settings.changeOnly": "Changer le dossier",
  "settings.removeFont": "Supprimer {{name}}",
  "settings.skipHostKey": "Ignorer la verification de la cle hote (non securise)",

  "collections.title": "Collections",
  "collections.close": "Fermer les collections",
  "collections.allBooks": "Tous les livres",
  "collections.series": "Series",
  "collections.newCollection": "Nouvelle collection",
  "collections.editCollection": "Modifier la collection",
  "collections.name": "Nom",
  "collections.namePlaceholder": "Nom de la collection",
  "collections.type": "Type",
  "collections.iconOptional": "Icone (optionnel)",
  "collections.color": "Couleur",
  "collections.colorLabel": "Couleur {{color}}",
  "collections.rules": "Regles",
  "collections.addRule": "+ Ajouter une regle",
  "collections.removeRule": "Supprimer la regle",
  "collections.noMatch": "Aucun livre ne correspond a ces regles",
  "collections.matchCount": "{{count}} livre correspond a ces regles",
  "collections.matchCountPlural": "{{count}} livres correspondent a ces regles",
  "collections.valuePlaceholder": "valeur",
  "collections.auto": "auto",
  "collections.deleteConfirm": "Supprimer {{name}} ?",
  "collections.shareTitle": "Partager {{name}}",
  "collections.exportCollection": "Exporter la collection",
  "collections.copyMarkdown": "Copier en Markdown",
  "collections.copyJson": "Copier en JSON",
  "collections.copiedMarkdown": "Copie en Markdown !",
  "collections.copiedJson": "Copie en JSON !",
  "collections.exportFailed": "Echec de l'exportation",
  "collections.editTitle": "Modifier {{name}}",
  "collections.deleteTitle": "Supprimer {{name}}",

  "collections.fieldAuthor": "Auteur",
  "collections.fieldTitle": "Titre",
  "collections.fieldSeries": "Serie",
  "collections.fieldLanguage": "Langue",
  "collections.fieldPublisher": "Editeur",
  "collections.fieldDescription": "Description",
  "collections.fieldFormat": "Format",
  "collections.fieldTag": "Tag",
  "collections.fieldDateAdded": "Date d'ajout",
  "collections.fieldProgress": "Progression de lecture",
  "collections.opContains": "contient",
  "collections.opIs": "est",
  "collections.opWithinDays": "dans les derniers (jours)",
  "collections.progressUnread": "Non lu",
  "collections.progressInProgress": "En cours",
  "collections.progressFinished": "Termine",

  "catalog.title": "Catalogues de livres",
  "catalog.searchAll": "Rechercher dans tous les catalogues...",
  "catalog.searchingAll": "Recherche dans tous les catalogues...",
  "catalog.noResults": "Aucun resultat.",
  "catalog.addedToLibrary": "Ajoute a la bibliotheque",
  "catalog.downloading": "Telechargement...",
  "catalog.removeCatalog": "Retirer {{name}}",
  "catalog.removeCatalogTitle": "Retirer le catalogue",
  "catalog.catalogName": "Nom du catalogue",
  "catalog.feedUrl": "URL du flux OPDS",
  "catalog.addCustom": "Ajouter un catalogue OPDS personnalise",
  "catalog.catalog": "Catalogue",
  "catalog.searchCatalog": "Rechercher dans ce catalogue...",
  "catalog.noEntries": "Aucune entree trouvee.",
  "catalog.loadMore": "Charger plus...",

  "editor.title": "Modifier le livre",
  "editor.bookTitle": "Titre",
  "editor.author": "Auteur",
  "editor.series": "Serie",
  "editor.seriesPlaceholder": "ex. Aria",
  "editor.volume": "Vol.",
  "editor.volumePlaceholder": "#",
  "editor.language": "Langue",
  "editor.languagePlaceholder": "ex. fr, en",
  "editor.year": "Annee",
  "editor.yearPlaceholder": "2024",
  "editor.publisher": "Editeur",
  "editor.rating": "Note",
  "editor.ratingDisplay": "Note : {{rating}} / 5",
  "editor.tags": "Tags",
  "editor.removeTag": "Supprimer le tag {{name}}",
  "editor.addTag": "Ajouter un tag...",
  "editor.changeCover": "Changer l'image de couverture...",
  "editor.openLibrary": "Metadonnees depuis OpenLibrary",
  "editor.searching": "Recherche...",
  "editor.lookUp": "Rechercher sur OpenLibrary",

  "activity.title": "Journal d'activite",
  "activity.close": "Fermer le journal d'activite",
  "activity.empty": "Aucune activite enregistree.",
  "activity.loadMore": "Charger plus",
  "activity.justNow": "A l'instant",
  "activity.minutesAgo": "Il y a {{count}} min",
  "activity.hoursAgo": "Il y a {{count}} h",
  "activity.daysAgo": "Il y a {{count}} j",
  "activity.bookImported": "Livre importe",
  "activity.bookDeleted": "Livre supprime",
  "activity.bookUpdated": "Livre modifie",
  "activity.bookEnriched": "Livre enrichi",
  "activity.bookScanned": "Scan des metadonnees",
  "activity.collectionCreated": "Collection creee",
  "activity.collectionDeleted": "Collection supprimee",
  "activity.collectionModified": "Collection modifiee",
  "activity.libraryExported": "Bibliotheque exportee",
  "activity.libraryImported": "Bibliotheque importee",
  "activity.backupCompleted": "Sauvegarde terminee",
  "activity.backupFailed": "Echec de la sauvegarde",
  "activity.profileSwitched": "Profil change",

  "profiles.manage": "Gerer les profils",
  "profiles.namePlaceholder": "Nom du profil",
  "profiles.newProfile": "Nouveau profil",

  "detail.series": "Serie",
  "detail.language": "Langue",
  "detail.year": "Annee",
  "detail.publisher": "Editeur",
  "detail.scanMetadata": "Scanner les metadonnees",
  "detail.coverAlt": "Couverture de {{title}}",
  "detail.detailsFor": "Details de {{title}}",

  "stats.title": "Statistiques de lecture",
  "stats.timeReading": "Temps de lecture",
  "stats.sessions": "Sessions",
  "stats.pagesRead": "Pages lues",
  "stats.booksFinished": "Livres termines",
  "stats.currentStreak": "Serie en cours",
  "stats.longestStreak": "Plus longue serie",
  "stats.daysCount": "{{count}} jours",
  "stats.last30Days": "30 derniers jours",

  "shortcuts.title": "Raccourcis clavier",
  "shortcuts.library": "Bibliotheque",
  "shortcuts.reader": "Lecteur",
  "shortcuts.focusSearch": "Rechercher",
  "shortcuts.clearClose": "Effacer / fermer les panneaux",
  "shortcuts.toggleCollections": "Afficher/masquer les collections",
  "shortcuts.toggleHelp": "Afficher/masquer cette aide",
  "shortcuts.prevNext": "Chapitre precedent / suivant",
  "shortcuts.toggleToc": "Afficher/masquer la table des matieres",
  "shortcuts.addBookmark": "Ajouter un signet",
  "shortcuts.toggleFocus": "Mode concentration",
  "shortcuts.closeExit": "Fermer / Quitter / Retour a la bibliotheque",

  "errors.pdfium": "Le support PDF n'est pas disponible. La bibliotheque pdfium n'a pas pu etre chargee.",
  "errors.fileNotFound": "Ce fichier de livre est introuvable. Il a peut-etre ete deplace ou supprime.",
  "errors.permissionDenied": "Permission refusee. Verifiez que le fichier est accessible.",
  "errors.invalidFormat": "Ce format de fichier n'est pas pris en charge.",
  "errors.duplicate": "Ce livre est deja dans votre bibliotheque.",
  "errors.chapterLoad": "Impossible de charger ce chapitre. Essayez de redemarrer le lecteur.",
  "errors.corrupt": "Ce fichier semble endommage et ne peut pas etre ouvert.",
  "errors.generic": "Une erreur est survenue. Veuillez reessayer.",

  "language.en": "English",
  "language.fr": "Francais"
}
```

- [ ] **Step 4: Create i18n configuration**

Create `src/i18n.ts`:

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const LANGUAGES = [
  { code: "en", flag: "\uD83C\uDDEC\uD83C\uDDE7", label: "English" },
  { code: "fr", flag: "\uD83C\uDDEB\uD83C\uDDF7", label: "Fran\u00e7ais" },
] as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "folio-language",
      caches: ["localStorage"],
    },
  });

export default i18n;
```

- [ ] **Step 5: Import i18n in main.tsx**

Add `import "./i18n";` as the first app import in `src/main.tsx`, before `import App`:

```typescript
import React from "react";
import ReactDOM from "react-dom/client";

// Local font imports
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/dm-sans/wght-italic.css";
import "@fontsource-variable/lora";
import "@fontsource-variable/lora/wght-italic.css";
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/playfair-display";

import "./i18n";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/i18n.ts src/locales/en.json src/locales/fr.json src/main.tsx package.json package-lock.json
git commit -m "feat(i18n): add i18next infrastructure with English and French locales"
```

---

### Task 2: Create LanguageSwitcher component

**Files:**
- Create: `src/components/LanguageSwitcher.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/LanguageSwitcher.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n";

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 text-ink-muted hover:text-ink transition-colors rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        aria-label="Change language"
        title="Change language"
      >
        <span className="text-base leading-none">{current.flag}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface border border-warm-border rounded-xl shadow-lg py-1 z-50 min-w-[140px]">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => {
                i18n.changeLanguage(lang.code);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                lang.code === i18n.language
                  ? "text-accent bg-accent-light/50 font-medium"
                  : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
              }`}
            >
              <span>{lang.flag}</span>
              <span>{lang.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/LanguageSwitcher.tsx
git commit -m "feat(i18n): add LanguageSwitcher flag dropdown component"
```

---

### Task 3: Add LanguageSwitcher to Library toolbar and Reader header

**Files:**
- Modify: `src/screens/Library.tsx`
- Modify: `src/screens/Reader.tsx`

- [ ] **Step 1: Add to Library toolbar**

In `src/screens/Library.tsx`, import the component and add it next to the settings gear button. Find the area with the stats/catalog/settings icons in the toolbar and add `<LanguageSwitcher />` before the settings button.

Add import at top:
```tsx
import LanguageSwitcher from "../components/LanguageSwitcher";
```

Insert `<LanguageSwitcher />` in the toolbar, between the existing icon buttons and the settings gear.

- [ ] **Step 2: Add to Reader header**

In `src/screens/Reader.tsx`, import and add `<LanguageSwitcher />` in the reader header, before the settings button (after the focus mode button).

Add import at top:
```tsx
import LanguageSwitcher from "../components/LanguageSwitcher";
```

Insert `<LanguageSwitcher />` before the settings button in the header.

- [ ] **Step 3: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/screens/Library.tsx src/screens/Reader.tsx
git commit -m "feat(i18n): add language switcher to Library toolbar and Reader header"
```

---

### Task 4: Migrate Batch 1 — Library, ImportButton, EmptyState, BookCard

**Files:**
- Modify: `src/screens/Library.tsx`
- Modify: `src/components/ImportButton.tsx`
- Modify: `src/components/EmptyState.tsx`
- Modify: `src/components/BookCard.tsx`

- [ ] **Step 1: Migrate each component**

For each file:
1. Add `import { useTranslation } from "react-i18next";`
2. Add `const { t } = useTranslation();` at the top of the component function
3. Replace every hardcoded string with the corresponding `t("key")` call
4. For strings with variables, use interpolation: `t("key", { var: value })`
5. For template literals like `` `Importing ${current} of ${total}…` ``, use `t("import.importingProgress", { current, total })`

Use the keys defined in `src/locales/en.json` from Task 1.

- [ ] **Step 2: Run type-check and tests**

Run: `npm run type-check && npm run test -- --run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/screens/Library.tsx src/components/ImportButton.tsx src/components/EmptyState.tsx src/components/BookCard.tsx
git commit -m "feat(i18n): migrate Library, ImportButton, EmptyState, BookCard to i18n"
```

---

### Task 5: Migrate Batch 2 — Reader, BookmarksPanel, HighlightsPanel

**Files:**
- Modify: `src/screens/Reader.tsx`
- Modify: `src/components/BookmarksPanel.tsx`
- Modify: `src/components/HighlightsPanel.tsx`

- [ ] **Step 1: Migrate each component**

Same pattern as Task 4: add `useTranslation` import, get `t` from hook, replace all hardcoded strings with `t()` calls using the keys from `en.json`.

Special cases in Reader.tsx:
- `{searchResults.length === 1 ? "match" : "matches"}` becomes `t(searchResults.length === 1 ? "reader.matchCount" : "reader.matchCountPlural", { count: searchResults.length })`
- Template literals with variables: `t("reader.chapterOf", { current: chapterIndex + 1, total: totalChapters })`
- The `friendlyError` calls will be migrated in Task 8 — for now leave those as-is

- [ ] **Step 2: Run type-check and tests**

Run: `npm run type-check && npm run test -- --run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/screens/Reader.tsx src/components/BookmarksPanel.tsx src/components/HighlightsPanel.tsx
git commit -m "feat(i18n): migrate Reader, BookmarksPanel, HighlightsPanel to i18n"
```

---

### Task 6: Migrate Batch 3 — SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Migrate SettingsPanel**

Same pattern. This is the largest file (~60 strings). Key areas:
- Accordion titles: `t("settings.appearance")`, `t("settings.textTypography")`, etc.
- Setting labels: `t("settings.lineHeight")`, `t("settings.hyphenation")`, etc.
- Help text descriptions
- Button labels: `t("settings.saveConfig")`, `t("settings.backupNow")`, etc.
- Interpolated text: `t("settings.lastBackup", { date: new Date(backupStatus.lastSyncAt * 1000).toLocaleString() })`

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(i18n): migrate SettingsPanel to i18n"
```

---

### Task 7: Migrate Batch 4 — remaining components

**Files:**
- Modify: `src/components/CollectionsSidebar.tsx`
- Modify: `src/components/CatalogBrowser.tsx`
- Modify: `src/components/EditBookDialog.tsx`
- Modify: `src/components/ActivityLog.tsx`
- Modify: `src/components/ProfileSwitcher.tsx`
- Modify: `src/components/BookDetailModal.tsx`
- Modify: `src/components/ReadingStats.tsx`
- Modify: `src/components/KeyboardShortcutsHelp.tsx`

- [ ] **Step 1: Migrate all remaining components**

Same pattern for each. Key specifics:

**CollectionsSidebar.tsx** — field labels and operator labels are currently in arrays. Replace with `t()` calls:
```tsx
// Before: { value: "author", label: "Author" }
// After:  { value: "author", label: t("collections.fieldAuthor") }
```

**ActivityLog.tsx** — action label map becomes:
```tsx
const ACTION_LABELS: Record<string, string> = {
  book_imported: t("activity.bookImported"),
  book_deleted: t("activity.bookDeleted"),
  // ...
};
```

**ReadingStats.tsx** — stat card labels use `t("stats.timeReading")`, etc.

**KeyboardShortcutsHelp.tsx** — shortcut descriptions use `t("shortcuts.focusSearch")`, etc.

- [ ] **Step 2: Run type-check and tests**

Run: `npm run type-check && npm run test -- --run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/CollectionsSidebar.tsx src/components/CatalogBrowser.tsx src/components/EditBookDialog.tsx src/components/ActivityLog.tsx src/components/ProfileSwitcher.tsx src/components/BookDetailModal.tsx src/components/ReadingStats.tsx src/components/KeyboardShortcutsHelp.tsx
git commit -m "feat(i18n): migrate remaining components to i18n"
```

---

### Task 8: Migrate error messages

**Files:**
- Modify: `src/lib/errors.ts`
- Modify: any files that call `friendlyError()` (to pass `t`)

- [ ] **Step 1: Update friendlyError to accept t function**

Update `src/lib/errors.ts`:

```typescript
import type { TFunction } from "i18next";

const ERROR_KEYS: Record<string, string> = {
  pdfium: "errors.pdfium",
  "cannot open file": "errors.fileNotFound",
  "no such file or directory": "errors.fileNotFound",
  "book file not found": "errors.fileNotFound",
  "permission denied": "errors.permissionDenied",
  "invalid format": "errors.invalidFormat",
  duplicate: "errors.duplicate",
  "chapter index": "errors.chapterLoad",
  corrupt: "errors.corrupt",
};

export function friendlyError(raw: string, t: TFunction): string {
  const lower = raw.toLowerCase();
  for (const [key, translationKey] of Object.entries(ERROR_KEYS)) {
    if (lower.includes(key)) return t(translationKey);
  }
  return t("errors.generic");
}
```

- [ ] **Step 2: Update all callers**

Search for `friendlyError(` in the codebase and update each call to pass `t`:

```tsx
// Before:
friendlyError(err)
// After:
friendlyError(String(err), t)
```

The callers are in `Reader.tsx` and `Library.tsx` — both already have `t` from `useTranslation`.

- [ ] **Step 3: Run type-check and tests**

Run: `npm run type-check && npm run test -- --run`
Expected: PASS (update any tests that reference `friendlyError` to pass a mock `t`)

- [ ] **Step 4: Commit**

```bash
git add src/lib/errors.ts src/screens/Reader.tsx src/screens/Library.tsx
git commit -m "feat(i18n): migrate error messages to i18n"
```

---

### Task 9: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm run test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Run Rust checks** (no Rust changes, but verify nothing broke)

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd ..
```
Expected: All PASS

- [ ] **Step 4: Manual smoke test**

Run `npm run tauri dev` and verify:
1. App loads in detected language (or English by default)
2. Flag switcher appears in Library toolbar and Reader header
3. Switching to French updates all UI text instantly
4. Switching back to English restores all text
5. Reloading the app remembers the language choice
6. All interpolated strings render correctly (page counts, progress, etc.)
