# Folder-Import Progress Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface scanned folder + running file count during recursive scan, and current filename during per-file import — replacing the silent spinner that gave network-folder users no signal of progress.

**Architecture:** Backend adds a `folder-scan-progress` Tauri event emitted from `scan_folder_for_books` on every directory entry. Frontend `Library.tsx` listens during scan and stores `scanProgress`. The existing per-file `importProgress` shape gains a `filename` field. The bottom overlay renders two phases: scan (folder + count, indeterminate bar) and import (count + percent + filename).

**Tech Stack:** Rust + Tauri v2 (`Emitter`, `AppHandle`), React 19 + TypeScript, `@tauri-apps/api/event` for `listen`, `react-i18next` for strings, Tailwind for the overlay.

**Spec:** `docs/superpowers/specs/2026-05-06-folder-import-progress-feedback-design.md`

**Naming caveat:** A `scan-progress` event and `ScanProgress` struct already exist for metadata enrichment (`commands.rs:3837`). The new event is `folder-scan-progress` and the new struct is `FolderScanProgress` to avoid collision.

---

## Task 1: Add `FolderScanProgress` struct and emit during walk

**Files:**
- Modify: `src-tauri/src/commands.rs:1145-1192` (`scan_folder_for_books` and inner `walk` fn)

The existing function takes only `folder_path`. We add an `AppHandle`
parameter so the inner walker can emit events. The struct lives
alongside the function (private; only this command uses it).

- [ ] **Step 1: Add `FolderScanProgress` struct above `scan_folder_for_books`**

Insert immediately above the `// --- Folder Scan ---` comment block, or
just inside the function-level region above `pub async fn scan_folder_for_books`:

```rust
#[derive(Clone, serde::Serialize)]
struct FolderScanProgress {
    folder: String,
    files_found: usize,
}
```

- [ ] **Step 2: Add `app: AppHandle` parameter to `scan_folder_for_books`**

Replace the signature at line 1146:

```rust
#[tauri::command]
pub async fn scan_folder_for_books(
    folder_path: String,
    app: AppHandle,
) -> FolioResult<Vec<String>> {
```

`AppHandle` and `Emitter` are already imported at `commands.rs:1`. No
new `use` line needed.

- [ ] **Step 3: Thread `&AppHandle` through `walk`**

Replace the inner `fn walk(...)` definition (around line 1167) and its
call site (around line 1189):

```rust
fn walk(
    dir: &std::path::Path,
    extensions: &[&str],
    results: &mut Vec<String>,
    app: &AppHandle,
) {
    let _ = app.emit(
        "folder-scan-progress",
        FolderScanProgress {
            folder: dir.to_string_lossy().to_string(),
            files_found: results.len(),
        },
    );
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if !name.starts_with('.') && name != "__MACOSX" {
                    walk(&path, extensions, results, app);
                }
            }
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let lower = ext.to_lowercase();
            if extensions.iter().any(|&s| s == lower) {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }
}

walk(dir, supported, &mut found, &app);
```

The emit happens once per directory entry (start of `walk`), and the
`results.len()` gives a running count of files found so far.

- [ ] **Step 4: Verify backend compiles and clippy is clean**

Run from repo root:

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings
```

Expected: no warnings, no errors.

- [ ] **Step 5: Verify existing tests still pass**

Run from repo root:

```bash
cd src-tauri && cargo test
```

The function's return type (`Vec<String>`) is unchanged, so any
existing callers of `scan_folder_for_books` outside the Tauri runtime
(none exist today, but the contract is preserved) keep working.

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(import): emit folder-scan-progress events during recursive scan

Add FolderScanProgress struct and AppHandle parameter to
scan_folder_for_books so the recursive walk can emit a Tauri event
(folder-scan-progress) on every directory entry. Each event carries
the folder path and the running count of supported files found."
```

---

## Task 2: Add i18n keys for scan-folder and importing-file

**Files:**
- Modify: `src/locales/en.json` (library namespace, after `importingProgress`)
- Modify: `src/locales/fr.json` (library namespace, same position)

Both locale files mirror each other key-for-key. Insert in alphabetical
position within the `library` block; the existing `importingProgress`
key sits at line 57 in both files.

- [ ] **Step 1: Add two keys to `src/locales/en.json` library block**

Edit the `library` block to insert two new keys immediately after
`importingProgress` (line 57). Replace this exact block:

```json
    "importingProgress": "Processing {{current}} of {{total}}…",
    "dropToAdd": "Drop to add books",
```

with:

```json
    "importingProgress": "Processing {{current}} of {{total}}…",
    "scanningFolder": "Scanning {{folder}}… {{count}} files found",
    "importingFile": "Importing {{filename}}",
    "dropToAdd": "Drop to add books",
```

- [ ] **Step 2: Add two keys to `src/locales/fr.json` library block**

Replace this exact block:

```json
    "importingProgress": "Traitement de {{current}} sur {{total}}…",
    "dropToAdd": "Déposer pour ajouter des livres",
```

with:

```json
    "importingProgress": "Traitement de {{current}} sur {{total}}…",
    "scanningFolder": "Analyse de {{folder}}… {{count}} fichiers trouvés",
    "importingFile": "Importation de {{filename}}",
    "dropToAdd": "Déposer pour ajouter des livres",
```

- [ ] **Step 3: Verify both locale files have the same key sets**

```bash
node -e "const en=require('./src/locales/en.json').library, fr=require('./src/locales/fr.json').library; const ek=Object.keys(en).sort(), fk=Object.keys(fr).sort(); console.log(JSON.stringify(ek)===JSON.stringify(fk) ? 'OK' : 'MISMATCH'); const diff = ek.filter(k=>!fk.includes(k)).concat(fk.filter(k=>!ek.includes(k))); console.log(diff);"
```

Expected: `OK` and `[]`.

- [ ] **Step 4: Verify JSON parses cleanly**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json'))" && \
node -e "JSON.parse(require('fs').readFileSync('src/locales/fr.json'))" && \
echo "JSON OK"
```

Expected: `JSON OK`.

- [ ] **Step 5: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "i18n(library): add scanningFolder and importingFile keys

Two new keys (en + fr) for the folder-import overlay: scanningFolder
shows the current directory and running file count during recursive
scan; importingFile shows the filename of the file being imported."
```

---

## Task 3: Wire scan-event listener and extend importProgress in Library.tsx

**Files:**
- Modify: `src/screens/Library.tsx` — multiple sections (state, `importFiles`, `handleImportFolder`, overlay JSX)

Five edits in one file, then commit.

- [ ] **Step 1: Add `scanProgress` state and extend `importProgress` shape**

Find the existing `importing` state declaration (line 91):

```ts
  const [importing, setImporting] = useState(false);
```

Locate the existing `importProgress` declaration nearby (search for
`useState<{ current: number; total: number }`). Replace:

```ts
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
```

with:

```ts
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; filename: string } | null>(null);
  const [scanProgress, setScanProgress] = useState<{ folder: string; filesFound: number } | null>(null);
```

If the existing type signature differs slightly (e.g. is on multiple
lines), preserve formatting but ensure the resulting type is exactly:
`{ current: number; total: number; filename: string } | null`.

- [ ] **Step 2: Set `filename` in the import loop**

Find `importFiles` (line 330). Locate the existing line:

```ts
        setImportProgress({ current: i + 1, total: paths.length });
```

Replace with:

```ts
        const filename = paths[i].split(/[\\/]/).pop() ?? paths[i];
        setImportProgress({ current: i + 1, total: paths.length, filename });
```

The split handles both POSIX and Windows path separators, falling back
to the full path if the basename can't be derived.

- [ ] **Step 3: Wire the `folder-scan-progress` listener in `handleImportFolder`**

Find `handleImportFolder` (line 376). Replace the entire function body:

```ts
  const handleImportFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected) return;
      const folderPath = typeof selected === "string" ? selected : selected[0];
      if (!folderPath) return;
      setImporting(true);
      setError(null);
      const files = await invoke<string[]>("scan_folder_for_books", { folderPath });
      if (files.length === 0) {
        setError(t("library.noSupportedFiles"));
        setImporting(false);
        return;
      }
      await importFiles(files);
    } catch (err) {
      setError(friendlyError(err, t));
      setImporting(false);
    }
  }, [importFiles]);
```

with:

```ts
  const handleImportFolder = useCallback(async () => {
    let unlisten: (() => void) | undefined;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected) return;
      const folderPath = typeof selected === "string" ? selected : selected[0];
      if (!folderPath) return;
      setImporting(true);
      setError(null);
      unlisten = await listen<{ folder: string; files_found: number }>(
        "folder-scan-progress",
        (e) =>
          setScanProgress({
            folder: e.payload.folder,
            filesFound: e.payload.files_found,
          })
      );
      const files = await invoke<string[]>("scan_folder_for_books", { folderPath });
      if (files.length === 0) {
        setError(t("library.noSupportedFiles"));
        setImporting(false);
        return;
      }
      await importFiles(files);
    } catch (err) {
      setError(friendlyError(err, t));
      setImporting(false);
    } finally {
      unlisten?.();
      setScanProgress(null);
    }
  }, [importFiles, t]);
```

Key changes:
- `let unlisten` declared outside `try` so `finally` can call it.
- Listener registered AFTER `setImporting(true)` (so the overlay is
  already showing) but BEFORE the `invoke()` call.
- `finally` always unsubscribes and clears `scanProgress`. If
  `importFiles` runs, by the time we reach `finally` the import phase
  is over and clearing scan state is a no-op (it was already null).
- Added `t` to the dependency array (the existing version omitted it,
  but `t` is referenced inside via `friendlyError` and `t(...)`).

`listen` is already imported at the top of the file (line 6).

- [ ] **Step 4: Update the overlay to render two phases**

Find the existing overlay block (around line 1308):

```tsx
      {/* Import progress overlay */}
      {importing && importProgress && (
        <div className="absolute inset-x-0 bottom-0 z-30 bg-surface border-t border-warm-border px-6 py-4 shadow-[0_-4px_24px_-4px_rgba(44,34,24,0.10)]">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-ink">
                  {t("library.importingProgress", { current: importProgress.current, total: importProgress.total })}
                </span>
                <span className="text-xs text-ink-muted tabular-nums">
                  {Math.round((importProgress.current / importProgress.total) * 100)}%
                </span>
              </div>
              <div className="h-2 bg-warm-subtle rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => { importCancelledRef.current = true; }}
              className="shrink-0 px-3 py-1.5 text-sm text-ink-muted hover:text-red-600 dark:hover:text-red-400 bg-warm-subtle hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
```

Replace with a two-phase block:

```tsx
      {/* Import progress overlay */}
      {importing && (importProgress || scanProgress) && (
        <div className="absolute inset-x-0 bottom-0 z-30 bg-surface border-t border-warm-border px-6 py-4 shadow-[0_-4px_24px_-4px_rgba(44,34,24,0.10)]">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              {importProgress ? (
                <>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium text-ink">
                      {t("library.importingProgress", { current: importProgress.current, total: importProgress.total })}
                    </span>
                    <span className="text-xs text-ink-muted tabular-nums">
                      {Math.round((importProgress.current / importProgress.total) * 100)}%
                    </span>
                  </div>
                  <div className="h-2 bg-warm-subtle rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all duration-300"
                      style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                    />
                  </div>
                  <div
                    className="mt-1.5 text-xs text-ink-muted truncate"
                    style={{ direction: "rtl", textAlign: "left" }}
                    title={importProgress.filename}
                  >
                    {t("library.importingFile", { filename: importProgress.filename })}
                  </div>
                </>
              ) : scanProgress ? (
                <>
                  <div
                    className="text-sm font-medium text-ink truncate mb-1.5"
                    style={{ direction: "rtl", textAlign: "left" }}
                    title={scanProgress.folder}
                  >
                    {t("library.scanningFolder", { folder: scanProgress.folder, count: scanProgress.filesFound })}
                  </div>
                  <div className="h-2 bg-warm-subtle rounded-full overflow-hidden">
                    <div className="h-full w-1/3 bg-accent rounded-full animate-pulse" />
                  </div>
                </>
              ) : null}
            </div>
            {importProgress && (
              <button
                type="button"
                onClick={() => { importCancelledRef.current = true; }}
                className="shrink-0 px-3 py-1.5 text-sm text-ink-muted hover:text-red-600 dark:hover:text-red-400 bg-warm-subtle hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      )}
```

Notes on the changes:
- Outer guard becomes `importing && (importProgress || scanProgress)`
  so the overlay shows during scan too.
- `importProgress` branch keeps the original layout and adds a third
  line (`importingFile`) under the bar with RTL truncation so the
  filename tail stays visible on long paths.
- `scanProgress` branch shows the folder + count and an indeterminate
  pulsing bar (one-third width with `animate-pulse`).
- Cancel button only renders during the import phase (scan has no
  cancel mechanism — out of scope per the spec).

- [ ] **Step 5: Verify TypeScript compiles**

From repo root:

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step 6: Verify frontend tests pass**

```bash
npm run test
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(import): show scanned folder and current filename in overlay

Wire folder-scan-progress listener around scan_folder_for_books, store
scanProgress state, and extend importProgress with filename. Overlay
now renders two phases: scan (folder + running file count, pulsing
bar) and import (count + percent + filename, RTL-truncated)."
```

---

## Task 4: Manual end-to-end verification

No automated test exists for Tauri event emission (requires a Tauri
runtime), so manual smoke tests confirm the wiring.

- [ ] **Step 1: Start dev environment**

```bash
npm run tauri dev
```

Wait for the window to open.

- [ ] **Step 2: Test fast-local folder import**

Click *Import folder* → pick a small local folder containing a few
EPUBs (e.g. `~/Documents/folio` or any test directory).

Expected:
- Bottom overlay flickers showing `Scanning <path>… N files found` for
  a brief moment with a pulsing bar.
- Then transitions to `Processing 1 of N…` with percent + filename
  below the bar.
- Filename updates per file.

- [ ] **Step 3: Test slow / network folder if available**

If a slow network share is reachable, repeat with that path. If not,
simulate via a deeply nested local folder structure.

Expected:
- Scan overlay updates with subfolder paths and a rising file count
  over multiple seconds.
- Folder-path display truncates the head (RTL ellipsis on the left)
  rather than the meaningful tail.

- [ ] **Step 4: Test empty folder**

Pick an empty directory or one without supported book formats.

Expected: The "no supported files" error fires cleanly. The scan
overlay disappears. No console errors.

- [ ] **Step 5: Test drag-and-drop import**

Drag a folder of books onto the Library window.

Expected:
- No scan overlay (drag-drop bypasses `scan_folder_for_books`).
- Import overlay shows count + percent + filename per file.
- Filename truncation works correctly.

- [ ] **Step 6: Test cancel during import**

Click *Cancel* on the import overlay mid-import.

Expected: Loop stops at the next iteration, summary toast/message
shows imported + cancelled counts.

- [ ] **Step 7: Run full pre-push CI suite**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && npm run type-check && npm run test
```

Expected: all green.

- [ ] **Step 8 (optional): Push branch / open PR**

Only if the user explicitly requests it. Per project memory: feature
branches for new implementations, never push to main, and the PR
description must NOT include the "Generated with Claude Code" badge.

---

## Self-Review

**Spec coverage:**
- Backend `FolderScanProgress` struct + `app: AppHandle` param + emit in `walk` → Task 1.
- `folder-scan-progress` event name (renamed from `scan_progress` to avoid collision) → Task 1.
- `library.scanningFolder` + `library.importingFile` i18n keys (en + fr) → Task 2.
- Frontend `scanProgress` state + listener + cleanup → Task 3 Steps 1, 3.
- `importProgress.filename` extension → Task 3 Steps 1, 2.
- Two-phase overlay rendering → Task 3 Step 4.
- RTL truncation for long paths → Task 3 Step 4.
- Drag-drop bypass behavior → Task 4 Step 5 (manual verify).
- Empty-folder fall-through → Task 4 Step 4 (manual verify).
- Cancel scope (import only) → Task 3 Step 4 (cancel button gated on `importProgress`).

**Placeholder scan:** No TBD/TODO. Every step has exact paths, exact
code, exact commands, expected output.

**Type consistency:** `FolderScanProgress { folder, files_found }` in
Rust → JSON `{ folder, files_found }` (Tauri's default Serialize uses
snake_case from struct fields) → TypeScript `listen<{ folder: string;
files_found: number }>` → frontend state `{ folder: string; filesFound:
number }` (camelCase mapped at the listener boundary). Consistent across
all three tasks.

`importProgress` shape `{ current: number; total: number; filename: string }`
used identically in Task 3 Steps 1, 2, 4.

Event name `folder-scan-progress` used identically in Task 1 (emit) and
Task 3 (listen).
