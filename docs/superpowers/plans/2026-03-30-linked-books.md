# Linked Books Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow importing books without copying them to the library folder, keeping the file at its original location with full library features.

**Architecture:** New `is_imported` column (default 1) in the books table distinguishes copied vs linked books. A `import_mode` setting controls the default behavior. The `import_book` command conditionally skips the file copy. Backup and export skip linked book files. Frontend shows a linked badge, source filter, error toast for missing files, and a "Copy to library" action.

**Tech Stack:** Rust (rusqlite), React 19, TypeScript, Tailwind CSS v4, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src-tauri/src/db.rs` | `is_imported` column migration, updated `insert_book` |
| `src-tauri/src/models.rs` | `is_imported: bool` field on `Book` struct |
| `src-tauri/src/commands.rs` | Conditional file copy in `import_book`, skip file delete for linked in `remove_book`, new `copy_to_library` command |
| `src-tauri/src/backup.rs` | Skip file upload for linked books |
| `src/locales/en.json` | New English translation keys |
| `src/locales/fr.json` | New French translation keys |
| `src/components/BookCard.tsx` | Linked badge icon |
| `src/screens/Library.tsx` | Source filter dropdown, file-not-available toast |
| `src/components/EditBookDialog.tsx` | "Copy to library" button for linked books |
| `src/components/SettingsPanel.tsx` | Import mode toggle in Library section |
| `src/types.ts` | `isImported` field on Book type |

---

### Task 1: Add `is_imported` column and update Book model (TDD)

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`

- [ ] **Step 1: Write failing test for `is_imported` column**

Add to `src-tauri/src/db.rs` in the `#[cfg(test)] mod tests` section:

```rust
#[test]
fn test_books_have_is_imported() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let conn = Connection::open(&db_path).unwrap();
    run_schema(&conn);

    // Insert a book and verify is_imported defaults to 1
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b1', 'Test', 'Author', '/tmp/test.epub', 1, 0, 'epub', 1)",
        [],
    ).unwrap();

    let is_imported: i32 = conn
        .query_row("SELECT is_imported FROM books WHERE id = 'b1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(is_imported, 1);

    // Insert a linked book with is_imported = 0
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b2', 'Linked', 'Author', '/mnt/nas/book.epub', 1, 0, 'epub', 0)",
        [],
    ).unwrap();

    let is_imported: i32 = conn
        .query_row("SELECT is_imported FROM books WHERE id = 'b2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(is_imported, 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_books_have_is_imported -- --nocapture`
Expected: FAIL — column `is_imported` does not exist

- [ ] **Step 3: Add migration and update model**

In `src-tauri/src/db.rs`, add to the migration section (after the last `ALTER TABLE` line):

```rust
let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 1;");
```

In `src-tauri/src/models.rs`, add to the `Book` struct after `publish_year`:

```rust
pub is_imported: bool,
```

- [ ] **Step 4: Update `insert_book` to include `is_imported`**

In `src-tauri/src/db.rs`, update the `insert_book` function's SQL and params to include `is_imported`:

Add `is_imported` to the column list in the INSERT statement, and add `book.is_imported` to the params (as integer: `book.is_imported as i32`).

- [ ] **Step 5: Update all Book struct constructions in `commands.rs`**

Every place a `Book { ... }` is constructed (EPUB, CBZ, CBR, PDF handlers in `import_book`), add:
```rust
is_imported: true,
```

Also update `get_book` and `list_books` query result mappings in `db.rs` to read `is_imported` from the row.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_books_have_is_imported -- --nocapture`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `cd src-tauri && cargo test`
Expected: All tests PASS (existing tests should work since `is_imported` defaults to 1)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/commands.rs
git commit -m "feat(linked-books): add is_imported column and update Book model"
```

---

### Task 2: Modify `import_book` to support link mode (TDD)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/db.rs` (for `get_setting`)

- [ ] **Step 1: Write failing test for import mode setting**

Add test in `src-tauri/src/db.rs` tests:

```rust
#[test]
fn test_import_mode_setting() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let conn = Connection::open(&db_path).unwrap();
    run_schema(&conn);

    // Default: no setting means "import" mode
    let mode = get_setting(&conn, "import_mode").unwrap();
    assert!(mode.is_none());

    // Set to "link"
    set_setting(&conn, "import_mode", "link").unwrap();
    let mode = get_setting(&conn, "import_mode").unwrap();
    assert_eq!(mode.as_deref(), Some("link"));
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_import_mode_setting`
Expected: PASS (uses existing `get_setting`/`set_setting` — no new code needed for this)

- [ ] **Step 3: Modify `import_book` to check `import_mode`**

In `src-tauri/src/commands.rs`, in the `import_book` function, replace the file copy block (lines 231-235) with conditional logic:

```rust
// Step 4: Copy or link based on import mode setting.
let import_mode = db::get_setting(&conn, "import_mode")
    .ok()
    .flatten()
    .unwrap_or_else(|| "import".to_string());
let is_url_import = file_path.starts_with("http://") || file_path.starts_with("https://");
let should_copy = import_mode != "link" || is_url_import;

let (final_path, is_imported) = if should_copy {
    let library_path = format!("{}/{}.{}", library_folder, book_id, extension);
    std::fs::copy(&file_path, &library_path)
        .map_err(|e| format!("Failed to copy file to library: {e}"))?;
    (library_path, true)
} else {
    // Link mode: use original path, no copy
    (file_path.clone(), false)
};
```

Then update all 4 Book struct constructions to use `final_path` instead of `library_path.clone()` for `file_path`, and `is_imported` for the new field.

Also update the error cleanup paths to only remove the file if `is_imported` is true.

- [ ] **Step 4: Modify `remove_book` to skip file deletion for linked books**

In the `remove_book` function, before the file deletion block, check `is_imported`:

```rust
// Remove the physical file only if it was imported (copied to library).
// Linked books: file belongs to the user, don't delete it.
let is_imported = existing_book.as_ref().map(|b| b.is_imported).unwrap_or(true);
if is_imported {
    if let Some(path) = file_path {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Warning: could not delete library file '{}': {}", path, e);
            }
        }
    }
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/db.rs
git commit -m "feat(linked-books): import_book supports link mode, remove_book skips linked files"
```

---

### Task 3: Add `copy_to_library` command (TDD)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src-tauri/src/db.rs` (add `update_book_path` function)

- [ ] **Step 1: Write the DB update function with test**

Add to `src-tauri/src/db.rs`:

```rust
pub fn update_book_path(conn: &Connection, book_id: &str, new_path: &str, is_imported: bool) -> Result<()> {
    conn.execute(
        "UPDATE books SET file_path = ?1, is_imported = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_path, is_imported as i32, chrono::Utc::now().timestamp(), book_id],
    )?;
    Ok(())
}
```

Add test:

```rust
#[test]
fn test_update_book_path() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let conn = Connection::open(&db_path).unwrap();
    run_schema(&conn);

    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b1', 'Test', 'Author', '/mnt/nas/book.epub', 1, 0, 'epub', 0)",
        [],
    ).unwrap();

    update_book_path(&conn, "b1", "/library/b1.epub", true).unwrap();

    let (path, imported): (String, i32) = conn
        .query_row("SELECT file_path, is_imported FROM books WHERE id = 'b1'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(path, "/library/b1.epub");
    assert_eq!(imported, 1);
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test test_update_book_path`
Expected: PASS

- [ ] **Step 3: Add `copy_to_library` Tauri command**

In `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn copy_to_library(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Book not found".to_string())?;

    if book.is_imported {
        return Err("Book is already in the library".to_string());
    }

    // Verify source file exists
    if !std::path::Path::new(&book.file_path).exists() {
        return Err("Source file not available. Reconnect the drive and try again.".to_string());
    }

    let library_folder = db::get_setting(&conn, "library_folder")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| default_library_folder().unwrap_or_default());

    let ext = std::path::Path::new(&book.file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("epub");
    let library_path = format!("{}/{}.{}", library_folder, book.id, ext);

    std::fs::copy(&book.file_path, &library_path)
        .map_err(|e| format!("Failed to copy file to library: {e}"))?;

    db::update_book_path(&conn, &book.id, &library_path, true)
        .map_err(|e| e.to_string())?;

    log_activity(&conn, "book_updated", "book", Some(&book.id), Some(&book.title), Some("Copied to library"));

    db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Book not found after update".to_string())
}
```

- [ ] **Step 4: Register in `lib.rs`**

Add `copy_to_library` to the `invoke_handler` list in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run full Rust checks**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/db.rs src-tauri/src/lib.rs
git commit -m "feat(linked-books): add copy_to_library command"
```

---

### Task 4: Skip linked book files in backup and export

**Files:**
- Modify: `src-tauri/src/backup.rs`
- Modify: `src-tauri/src/commands.rs` (export_library function)

- [ ] **Step 1: Skip linked books in remote backup file upload**

In `src-tauri/src/backup.rs`, in the `run_incremental_backup_with_progress` function, wrap the file upload block with an `is_imported` check:

```rust
for (i, book) in changed_books.iter().enumerate() {
    on_progress("Uploading books", (i + 1) as u32, total_files);
    // Skip file upload for linked books — they're not in the library folder
    if !book.is_imported {
        continue;
    }
    if let Some(ref hash) = book.file_hash {
        // ... existing upload logic
    }
    // ... existing cover logic
}
```

- [ ] **Step 2: Skip linked books in local ZIP export**

In `src-tauri/src/commands.rs`, in the `export_library` function, find where book files are added to the ZIP (the `if include_files` block). Add a filter:

```rust
if include_files {
    let mut linked_count = 0u32;
    for book in &books {
        if !book.is_imported {
            linked_count += 1;
            continue;
        }
        // ... existing file-adding logic
    }
    // The linked_count can be included in the summary message
}
```

Update the summary message at the end to include linked books excluded count if > 0.

- [ ] **Step 3: Run Rust checks**

Run: `cd src-tauri && cargo clippy -- -D warnings && cargo test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/backup.rs src-tauri/src/commands.rs
git commit -m "feat(linked-books): skip linked book files in backup and export"
```

---

### Task 5: Add translation keys

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English keys**

Add to `src/locales/en.json`:

```json
"settings.importMode": "Import mode",
"settings.importModeCopy": "Copy to library",
"settings.importModeLink": "Link to original file",
"settings.importModeHelp": "Copied books are self-contained. Linked books save disk space but require the original file to remain accessible.",
"library.filterBySource": "Filter by source",
"library.allBooks": "All books",
"library.imported": "Imported",
"library.linked": "Linked",
"bookCard.linkedBadge": "Linked \u2014 file at original location",
"bookCard.fileNotAvailable": "File not available. Reconnect the drive or remove this book.",
"editor.copyToLibrary": "Copy to library",
"editor.copyingToLibrary": "Copying...",
"editor.fileNotAvailable": "File not available",
"backup.linkedBooksExcluded": "{{count}} linked books excluded (files not in library)"
```

- [ ] **Step 2: Add French keys**

Add to `src/locales/fr.json`:

```json
"settings.importMode": "Mode d'importation",
"settings.importModeCopy": "Copier dans la bibliotheque",
"settings.importModeLink": "Lier au fichier original",
"settings.importModeHelp": "Les livres copies sont autonomes. Les livres lies economisent de l'espace disque mais necessitent que le fichier original reste accessible.",
"library.filterBySource": "Filtrer par source",
"library.allBooks": "Tous les livres",
"library.imported": "Importes",
"library.linked": "Lies",
"bookCard.linkedBadge": "Lie \u2014 fichier a l'emplacement d'origine",
"bookCard.fileNotAvailable": "Fichier non disponible. Reconnectez le disque ou supprimez ce livre.",
"editor.copyToLibrary": "Copier dans la bibliotheque",
"editor.copyingToLibrary": "Copie en cours...",
"editor.fileNotAvailable": "Fichier non disponible",
"backup.linkedBooksExcluded": "{{count}} livres lies exclus (fichiers hors de la bibliotheque)"
```

- [ ] **Step 3: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(linked-books): add translation keys for linked books UI"
```

---

### Task 6: Update frontend Book type and add source filter

**Files:**
- Modify: `src/types.ts`
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add `isImported` to frontend Book type**

In `src/types.ts`, add to the `Book` interface (or wherever the Book type is defined):

```typescript
isImported?: boolean;  // undefined/true = copied, false = linked
```

Note: existing books from the DB will have `is_imported = 1`, which serializes as `true`. The field is optional for backwards compatibility.

- [ ] **Step 2: Add source filter state to Library.tsx**

Add new filter state alongside existing filters:

```typescript
const [filterSource, setFilterSource] = useState<string>(() => localStorage.getItem("folio-library-filter-source") ?? "all");
useEffect(() => { localStorage.setItem("folio-library-filter-source", filterSource); }, [filterSource]);
```

- [ ] **Step 3: Add source filter dropdown in the toolbar**

After the rating filter dropdown, add:

```tsx
{/* Filter: source */}
<select
  value={filterSource}
  onChange={(e) => setFilterSource(e.target.value)}
  className="shrink-0 h-9 px-2 bg-warm-subtle rounded-lg text-xs text-ink border border-transparent focus:border-accent/40 focus:outline-none"
  aria-label={t("library.filterBySource")}
>
  <option value="all">{t("library.allBooks")}</option>
  <option value="imported">{t("library.imported")}</option>
  <option value="linked">{t("library.linked")}</option>
</select>
```

- [ ] **Step 4: Apply source filter to the book list**

In the filter chain (where format/status/rating are applied), add:

```typescript
if (filterSource !== "all") {
  if (filterSource === "imported" && book.isImported === false) return false;
  if (filterSource === "linked" && book.isImported !== false) return false;
}
```

- [ ] **Step 5: Add file-not-available toast when opening a linked book**

In the `handleOpenBook` function (or wherever book opening is handled), before navigating to the reader, add a check for linked books:

```typescript
const handleOpenBook = async (bookId: string) => {
  const book = books.find((b) => b.id === bookId);
  if (book && book.isImported === false) {
    try {
      await invoke("validate_file_exists", { filePath: book.filePath });
    } catch {
      setError(t("bookCard.fileNotAvailable"));
      setFileNotAvailableBookId(bookId);
      return;
    }
  }
  navigate(`/reader/${bookId}`);
};
```

Add state for the toast and a "Remove" button that triggers the delete confirmation flow.

- [ ] **Step 6: Include `filterSource` in the "Clear all filters" logic**

Where the "Clear all filters" button resets filters, add:

```typescript
setFilterSource("all");
```

- [ ] **Step 7: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/screens/Library.tsx
git commit -m "feat(linked-books): add source filter and file-not-available toast"
```

---

### Task 7: Add linked badge to BookCard

**Files:**
- Modify: `src/components/BookCard.tsx`

- [ ] **Step 1: Accept `isImported` prop**

Add to the BookCard props (wherever the component receives its props):

```typescript
isImported?: boolean;
```

- [ ] **Step 2: Add linked badge next to format badge**

After the format badge block (the `{format && format !== "epub" && ...}` span), add:

```tsx
{/* Linked badge — shown for linked (non-imported) books */}
{isImported === false && !confirming && (
  <span
    className="absolute top-2 left-2 bg-ink/70 text-paper text-[9px] px-1.5 py-0.5 rounded backdrop-blur-sm"
    title={t("bookCard.linkedBadge")}
  >
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="inline-block mr-0.5 -mt-px">
      <path d="M6.5 9.5L9.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 5L12.5 3.5a2.12 2.12 0 00-3-3L8 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 11L3.5 12.5a2.12 2.12 0 003 3L8 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
)}
```

If both format badge and linked badge would show (non-EPUB linked book), position the linked badge at `top-2 left-2` and shift the format badge down to `bottom-2 left-2` (it's already there).

- [ ] **Step 3: Pass `isImported` from Library.tsx**

Where BookCard is rendered in Library.tsx, add the prop:

```tsx
<BookCard
  // ... existing props
  isImported={book.isImported}
/>
```

- [ ] **Step 4: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/BookCard.tsx src/screens/Library.tsx
git commit -m "feat(linked-books): add linked badge icon on BookCard"
```

---

### Task 8: Add "Copy to library" in Edit Book dialog and import mode toggle in Settings

**Files:**
- Modify: `src/components/EditBookDialog.tsx`
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add "Copy to library" button in EditBookDialog**

In `src/components/EditBookDialog.tsx`, the component needs access to `isImported` from the book data. Add it to the props or fetch it from the book object.

Before the Save/Cancel button row, add a conditional block for linked books:

```tsx
{/* Copy to library — only for linked books */}
{book.isImported === false && (
  <div className="px-5 py-3 border-t border-warm-border">
    <button
      type="button"
      onClick={handleCopyToLibrary}
      disabled={copyingToLibrary || fileUnavailable}
      className="w-full py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors disabled:opacity-40"
      title={fileUnavailable ? t("editor.fileNotAvailable") : undefined}
    >
      {copyingToLibrary ? t("editor.copyingToLibrary") : t("editor.copyToLibrary")}
    </button>
  </div>
)}
```

The `handleCopyToLibrary` function:

```typescript
const handleCopyToLibrary = async () => {
  setCopyingToLibrary(true);
  try {
    await invoke("copy_to_library", { bookId: book.id });
    onSave(); // refresh the book data
  } catch (err) {
    // handle error
  } finally {
    setCopyingToLibrary(false);
  }
};
```

Check file availability on dialog open to set `fileUnavailable` state.

- [ ] **Step 2: Add import mode toggle in SettingsPanel**

In `src/components/SettingsPanel.tsx`, inside the Library accordion, after the "Change folder" button, add:

```tsx
{/* Import mode */}
<div className="mt-3 pt-3 border-t border-warm-border/50">
  <label className="text-xs font-medium text-ink-muted mb-2 block">{t("settings.importMode")}</label>
  <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
    {(["import", "link"] as const).map((option) => (
      <button
        type="button"
        key={option}
        onClick={() => handleSetImportMode(option)}
        className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
          importMode === option
            ? "bg-surface text-ink shadow-sm font-medium"
            : "text-ink-muted hover:text-ink"
        }`}
      >
        {option === "import" ? t("settings.importModeCopy") : t("settings.importModeLink")}
      </button>
    ))}
  </div>
  <p className="mt-2 text-xs text-ink-muted">{t("settings.importModeHelp")}</p>
</div>
```

Add state and handler:

```typescript
const [importMode, setImportMode] = useState<string>("import");

useEffect(() => {
  invoke<string | null>("get_setting", { key: "import_mode" }).then((val) => {
    if (val) setImportMode(val);
  });
}, []);

const handleSetImportMode = async (mode: string) => {
  setImportMode(mode);
  await invoke("set_setting", { key: "import_mode", value: mode });
};
```

Note: this uses the existing `get_setting`/`set_setting` Tauri commands.

- [ ] **Step 3: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/EditBookDialog.tsx src/components/SettingsPanel.tsx
git commit -m "feat(linked-books): add Copy to library action and import mode settings toggle"
```

---

### Task 9: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full frontend test suite**

Run: `npm run test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Run full Rust checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`
Expected: All PASS

- [ ] **Step 4: Manual smoke test**

Run `npm run tauri dev` and verify:
1. Settings > Library shows import mode toggle (default: "Copy to library")
2. Switch to "Link to original file", import a book — book appears with linked badge, original file not copied
3. Source filter works: "All books" / "Imported" / "Linked"
4. Opening a linked book when file exists works normally
5. Ejecting the drive / moving the file, then clicking the linked book shows error toast with "Remove" option
6. Edit dialog shows "Copy to library" button for linked books
7. Clicking "Copy to library" copies the file and removes the linked badge
8. Backup: linked books metadata is backed up, files are skipped
9. Switch back to "Copy to library" mode — new imports copy as before
