# Library Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan the library for books whose files no longer exist on disk and remove them, both as a bulk Settings action and as an on-demand prompt when opening a broken book.

**Architecture:** New `cleanup_library` Tauri command iterates all books, checks file existence, deletes broken entries + covers + cache, emits progress events. Frontend adds a button in Settings > Library with a confirmation → progress → result modal flow. Reader error handling upgraded from a dead-end error page to an actionable "Remove from library?" dialog.

**Tech Stack:** Rust (Tauri v2 commands, events), React 19, Tailwind CSS v4, i18next

---

### Task 1: Add CleanupResult and CleanupProgress types to models.rs

**Files:**
- Modify: `src-tauri/src/models.rs:155-159` (append after SeriesInfo)

- [ ] **Step 1: Add the new structs**

Add after the `SeriesInfo` struct at the end of `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_count: u32,
    pub removed_books: Vec<CleanupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub id: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupProgress {
    pub current: u32,
    pub total: u32,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/models.rs
git commit -m "feat(models): add CleanupResult, CleanupEntry, CleanupProgress types"
```

---

### Task 2: Implement `cleanup_library` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs` (import new types, add command after `check_file_exists`)
- Modify: `src-tauri/src/lib.rs:200` (register new command)

- [ ] **Step 1: Update imports in commands.rs**

In `src-tauri/src/commands.rs` line 8-11, update the models import to include the new types:

```rust
use crate::models::{
    Book, BookFormat, Bookmark, CleanupEntry, CleanupProgress, CleanupResult, Collection,
    CollectionRule, CollectionType, CustomFont, Highlight, NewRuleInput, ReadingProgress,
    SeriesInfo,
};
```

- [ ] **Step 2: Add the cleanup_library command**

Add after `check_file_exists` (after line 3160) in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn cleanup_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CleanupResult, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    let books = db::list_books(&conn).map_err(|e| e.to_string())?;
    let total = books.len() as u32;

    let mut removed_books: Vec<CleanupEntry> = Vec::new();

    for (i, book) in books.iter().enumerate() {
        let _ = app.emit(
            "cleanup-progress",
            CleanupProgress {
                current: (i + 1) as u32,
                total,
            },
        );

        if std::path::Path::new(&book.file_path).exists() {
            continue;
        }

        // Book file is missing — remove from database.
        db::delete_book(&conn, &book.id).map_err(|e| e.to_string())?;

        // Evict EPUB cache entry.
        if let Ok(mut cache) = state.epub_cache.lock() {
            cache.remove(&book.file_path);
        }
        if let Ok(mut order) = state.epub_cache_order.lock() {
            order.retain(|k| k != &book.file_path);
        }

        // Remove cover directory.
        let cover_dir = state.data_dir.join("covers").join(&book.id);
        if cover_dir.exists() {
            let _ = std::fs::remove_dir_all(&cover_dir);
        }

        // Remove extracted image cache.
        let image_cache_dir = state.data_dir.join("images").join(&book.id);
        if image_cache_dir.exists() {
            let _ = std::fs::remove_dir_all(&image_cache_dir);
        }

        log_activity(
            &conn,
            "book_removed_cleanup",
            "book",
            Some(&book.id),
            Some(&book.title),
            None,
        );

        removed_books.push(CleanupEntry {
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
        });
    }

    Ok(CleanupResult {
        removed_count: removed_books.len() as u32,
        removed_books,
    })
}
```

- [ ] **Step 3: Register command in lib.rs**

In `src-tauri/src/lib.rs`, add `commands::cleanup_library` to the invoke_handler list. Insert after `commands::check_file_exists,` (line 200):

```rust
    commands::cleanup_library,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add cleanup_library command for scanning and removing broken books"
```

---

### Task 3: Add i18n keys for cleanup feature

**Files:**
- Modify: `src/locales/en.json` (add settings.cleanup.* and reader.* keys)
- Modify: `src/locales/fr.json` (same keys, French translations)

- [ ] **Step 1: Add English translation keys**

In `src/locales/en.json`, inside the `"settings"` object, after the `"changeFolder2"` key (around line 268), add:

```json
    "checkMissingFiles": "Check for missing files",
    "cleanupConfirmTitle": "Library Cleanup",
    "cleanupConfirmMessage": "This will scan your library and remove any books whose files can no longer be found. This cannot be undone.",
    "cleanupConfirmContinue": "Continue",
    "cleanupScanning": "Scanning\u2026 {{current}} / {{total}}",
    "cleanupDoneRemoved": "Removed {{count}} books with missing files.",
    "cleanupDoneNone": "All books are accounted for. No issues found.",
    "cleanupDone": "Done",
```

In the `"reader"` object, add:

```json
    "missingFileTitle": "File Not Found",
    "missingFileMessage": "This book\u2019s file could not be found. It may have been moved or deleted.",
    "removeFromLibrary": "Remove from library",
```

- [ ] **Step 2: Add French translation keys**

In `src/locales/fr.json`, inside the `"settings"` object, after the `"changeFolder2"` key, add:

```json
    "checkMissingFiles": "V\u00e9rifier les fichiers manquants",
    "cleanupConfirmTitle": "Nettoyage de la biblioth\u00e8que",
    "cleanupConfirmMessage": "Ceci va analyser votre biblioth\u00e8que et supprimer les livres dont les fichiers sont introuvables. Cette action est irr\u00e9versible.",
    "cleanupConfirmContinue": "Continuer",
    "cleanupScanning": "Analyse\u2026 {{current}} / {{total}}",
    "cleanupDoneRemoved": "{{count}} livres avec des fichiers manquants supprim\u00e9s.",
    "cleanupDoneNone": "Tous les livres sont en ordre. Aucun probl\u00e8me trouv\u00e9.",
    "cleanupDone": "Termin\u00e9",
```

In the `"reader"` object, add:

```json
    "missingFileTitle": "Fichier introuvable",
    "missingFileMessage": "Le fichier de ce livre est introuvable. Il a peut-\u00eatre \u00e9t\u00e9 d\u00e9plac\u00e9 ou supprim\u00e9.",
    "removeFromLibrary": "Retirer de la biblioth\u00e8que",
```

- [ ] **Step 3: Verify frontend type-checks**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add translation keys for library cleanup and missing file dialog"
```

---

### Task 4: Add cleanup button and modal to SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add state variables**

In `src/components/SettingsPanel.tsx`, near the other state declarations (around line 278), add:

```typescript
  const [cleanupState, setCleanupState] = useState<
    "idle" | "confirm" | "scanning" | "done"
  >("idle");
  const [cleanupProgress, setCleanupProgress] = useState({ current: 0, total: 0 });
  const [cleanupResult, setCleanupResult] = useState<{
    removedCount: number;
  } | null>(null);
```

- [ ] **Step 2: Add the cleanup handler function**

Add a new handler near the other handlers (after `handleRunBackup` around line 628):

```typescript
  const handleCleanup = async () => {
    setCleanupState("scanning");
    setCleanupProgress({ current: 0, total: 0 });
    const unlisten = await listen<{ current: number; total: number }>(
      "cleanup-progress",
      (event) => {
        setCleanupProgress(event.payload);
      }
    );
    try {
      const result = await invoke<{ removedCount: number; removedBooks: { id: string; title: string; author: string }[] }>(
        "cleanup_library"
      );
      setCleanupResult({ removedCount: result.removedCount });
      setCleanupState("done");
    } catch (err) {
      setCleanupResult(null);
      setCleanupState("idle");
    } finally {
      unlisten();
    }
  };
```

- [ ] **Step 3: Add the cleanup button in the Library accordion**

In the Library accordion section, after the "Change folder" button (after line 1056), add:

```tsx
              <button
                onClick={() => setCleanupState("confirm")}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                {t("settings.checkMissingFiles")}
              </button>
```

- [ ] **Step 4: Add the cleanup modal dialog**

Add the modal JSX at the end of the component's return statement, inside the outermost fragment (before the closing `</>`, near the other dialogs like `migrationDialog`):

```tsx
      {cleanupState !== "idle" && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 z-[60]"
            onClick={() => cleanupState !== "scanning" && setCleanupState("idle")}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("settings.cleanupConfirmTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.cleanupConfirmTitle")}
              </h3>

              {cleanupState === "confirm" && (
                <>
                  <p className="text-sm text-ink-muted">
                    {t("settings.cleanupConfirmMessage")}
                  </p>
                  <div className="flex gap-3 justify-end pt-1">
                    <button
                      onClick={() => setCleanupState("idle")}
                      className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      onClick={handleCleanup}
                      className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium"
                    >
                      {t("settings.cleanupConfirmContinue")}
                    </button>
                  </div>
                </>
              )}

              {cleanupState === "scanning" && (
                <p className="text-sm text-ink-muted">
                  {t("settings.cleanupScanning", {
                    current: cleanupProgress.current,
                    total: cleanupProgress.total,
                  })}
                </p>
              )}

              {cleanupState === "done" && (
                <>
                  <p className="text-sm text-ink-muted">
                    {cleanupResult && cleanupResult.removedCount > 0
                      ? t("settings.cleanupDoneRemoved", { count: cleanupResult.removedCount })
                      : t("settings.cleanupDoneNone")}
                  </p>
                  <div className="flex justify-end pt-1">
                    <button
                      onClick={() => {
                        setCleanupState("idle");
                        loadLibraryFolder();
                      }}
                      className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium"
                    >
                      {t("settings.cleanupDone")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 5: Verify frontend type-checks**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): add library cleanup button with confirmation, progress, and result modal"
```

---

### Task 5: Add missing-file dialog to Reader

**Files:**
- Modify: `src/screens/Reader.tsx`

- [ ] **Step 1: Add state for the missing-file dialog**

In `src/screens/Reader.tsx`, near the other state declarations (around line 86), add:

```typescript
  const [missingFileDialog, setMissingFileDialog] = useState(false);
```

- [ ] **Step 2: Create a helper to detect file-not-found errors**

Add a helper function inside the component (after the state declarations, before the first useEffect):

```typescript
  const isFileNotFound = (err: unknown): boolean => {
    const msg = String(err).toLowerCase();
    return msg.includes("book file not found");
  };
```

- [ ] **Step 3: Update init error handler to show dialog**

In the `init()` function's outer catch block (around line 155-158), change:

```typescript
        if (!cancelled) {
          setError(friendlyError(String(err), t));
        }
```

to:

```typescript
        if (!cancelled) {
          if (isFileNotFound(err)) {
            setMissingFileDialog(true);
          }
          setError(friendlyError(String(err), t));
        }
```

- [ ] **Step 4: Update chapter loading error handler to show dialog**

In the `loadChapter()` catch block (around line 282-285), change:

```typescript
        if (!cancelled) {
          setChapterError(friendlyError(String(err), t));
        }
```

to:

```typescript
        if (!cancelled) {
          if (isFileNotFound(err)) {
            setMissingFileDialog(true);
          }
          setChapterError(friendlyError(String(err), t));
        }
```

- [ ] **Step 5: Add the missing-file dialog JSX**

Add the dialog JSX near the end of the component's return, before the final closing tag. This should be rendered regardless of other state (i.e., at the top level of the returned JSX):

```tsx
      {missingFileDialog && (
        <>
          <div className="fixed inset-0 bg-ink/40 z-[80]" aria-hidden="true" />
          <div
            role="dialog"
            aria-label={t("reader.missingFileTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("reader.missingFileTitle")}
              </h3>
              <p className="text-sm text-ink-muted">
                {t("reader.missingFileMessage")}
              </p>
              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => {
                    setMissingFileDialog(false);
                    navigate("/");
                  }}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await invoke("remove_book", { bookId });
                    } catch {
                      // Already gone or other error — navigate away regardless
                    }
                    navigate("/");
                  }}
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors font-medium"
                >
                  {t("reader.removeFromLibrary")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 6: Verify frontend type-checks**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Reader.tsx
git commit -m "feat(reader): show removal dialog when opening a book with missing file"
```

---

### Task 6: Run full CI checks

**Files:** None (verification only)

- [ ] **Step 1: Run Rust checks**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

Expected: All pass.

- [ ] **Step 2: Run frontend checks**

```bash
npm run type-check && npm run test
```

Expected: All pass.

- [ ] **Step 3: Fix any issues found**

If any linting, formatting, or test failures, fix them and re-run.

- [ ] **Step 4: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix: address CI issues from library cleanup implementation"
```
