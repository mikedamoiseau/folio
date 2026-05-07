# Folder-Import Progress Feedback

**Date:** 2026-05-06
**Status:** Design — pending implementation
**Author:** Mike

## Problem

When importing a folder, the user sees only a generic spinner. On a slow
source (network share, large library) this produces minutes of silence with
no way to tell whether the app crashed, the network dropped, or the scan
is still running. The existing import-progress overlay only appears once
the scan completes and the per-file import loop begins — so the slow
phase (recursive scan) has no UI signal at all.

## Goal

Surface two pieces of feedback during folder import:

1. **Scan phase** — show the folder currently being walked and a running
   count of supported files found.
2. **Import phase** — show the filename of the file currently being
   imported, in addition to the existing `current / total` count.

Out of scope: cancelling the scan phase, persistent activity log of every
file imported, throttling event rate.

## Architecture

Two phases, two signals:

| Phase  | Trigger                           | Signal                                                                                                |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Scan   | Backend recurses into a directory | `scan_progress` Tauri event with `{ folder, files_found }`                                            |
| Import | Frontend loop iterates a path     | Existing `importProgress` state extended to `{ current, total, filename }` (no event needed)          |

The bottom overlay in `Library.tsx` gains two visual states keyed off the
state combination:

- `importing && scanProgress && !importProgress` → scan UI (folder +
  running count, indeterminate bar).
- `importing && importProgress` → import UI (existing count + percent +
  current filename).

## Backend changes — `src-tauri/src/commands.rs`

`scan_folder_for_books` is currently a leaf command with no `AppHandle`.
Add the handle so the function can emit events.

New struct in the same module:

```rust
#[derive(Clone, serde::Serialize)]
struct ScanProgress {
    folder: String,
    files_found: usize,
}
```

Signature change:

```rust
#[tauri::command]
pub async fn scan_folder_for_books(
    folder_path: String,
    app: AppHandle,
) -> FolioResult<Vec<String>>
```

`walk()` becomes a closure or takes `&AppHandle` and emits on each
directory entry:

```rust
app.emit("scan_progress", ScanProgress {
    folder: dir.to_string_lossy().to_string(),
    files_found: results.len(),
}).ok();
```

The emit is `.ok()`-discarded — a failed emit must not abort the scan.

`lib.rs` already registers the command in `invoke_handler`; no change.

## Frontend changes — `src/screens/Library.tsx`

### State

```ts
const [scanProgress, setScanProgress] = useState<{
    folder: string;
    filesFound: number;
} | null>(null);

// importProgress extended:
const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
    filename: string;
} | null>(null);
```

### Listener wiring

`handleImportFolder` registers `scan_progress` listener BEFORE calling
`scan_folder_for_books` and unsubscribes after:

```ts
const unlisten = await listen<{ folder: string; files_found: number }>(
    "scan_progress",
    (e) => setScanProgress({
        folder: e.payload.folder,
        filesFound: e.payload.files_found,
    })
);
try {
    const files = await invoke<string[]>("scan_folder_for_books", { folderPath });
    // ...
} finally {
    unlisten();
    setScanProgress(null);
}
```

### Import-loop change

In `importFiles`, set `filename` (basename of `paths[i]`) when updating
`importProgress`:

```ts
const filename = paths[i].split(/[\\/]/).pop() ?? paths[i];
setImportProgress({ current: i + 1, total: paths.length, filename });
```

### Overlay rendering (Library.tsx:1309)

The existing single-state block becomes a two-state block:

- **Scan state** (no progressbar percent — indeterminate):
  - Heading: `t("library.scanningFolder", { folder, count: filesFound })`
  - Progress bar: indeterminate / pulsing.
- **Import state** (existing + filename line):
  - Heading: `t("library.importingProgress", { current, total })` (unchanged).
  - Sub-line: `t("library.importingFile", { filename })`, single-line CSS truncate.

Long paths use `direction: rtl` + `text-overflow: ellipsis` so the
meaningful tail (filename or deepest folder) stays visible.

## i18n keys

`src/locales/en.json`:

```json
"library": {
  "scanningFolder": "Scanning {{folder}}… {{count}} files found",
  "importingFile": "Importing {{filename}}"
}
```

`src/locales/fr.json`:

```json
"library": {
  "scanningFolder": "Analyse de {{folder}}… {{count}} fichiers trouvés",
  "importingFile": "Importation de {{filename}}"
}
```

Existing `library.importingProgress` is untouched.

## Edge cases

- **Empty folder**: scan ends, no events, `scanProgress` stays null,
  flow falls through to existing `noSupportedFiles` error. Unchanged.
- **Drag-drop import**: bypasses `scan_folder_for_books`. Scan overlay
  never appears; filename in import overlay still works because the
  import loop is shared.
- **High event rate (fast local recursion)**: payload is tiny, Tauri
  IPC handles thousands/sec without issue. No throttling for v1.
- **Long folder/filename**: CSS truncation with RTL direction preserves
  the visually meaningful tail.
- **Emit failure**: discarded with `.ok()`. The scan continues even if
  the frontend never receives an event.
- **Scan cancellation**: out of scope. The existing cancel button still
  applies only to the import loop.

## Testing

- **Backend unit**: `scan_folder_for_books` keeps its `Vec<String>`
  return shape, so the existing tempfile-based tests stay green. Event
  emission requires a Tauri runtime — not unit-tested.
- **Frontend**: filename derivation is a one-liner (`split('/').pop()`)
  exercised via manual import. No new automated test.
- **Manual**:
  - Import a small local folder — verify scan overlay flickers briefly,
    import overlay shows filename per file.
  - Import a slow network folder — verify scan overlay updates with
    folder paths and rising file count over a multi-second window.
  - Import an empty folder — verify "no supported files" error fires
    cleanly.
  - Drag-drop a folder of files — verify import overlay shows filename.

## Files touched

- `src-tauri/src/commands.rs` — `scan_folder_for_books` signature and
  `walk()` body, new `ScanProgress` struct.
- `src/screens/Library.tsx` — `scanProgress` state, `importProgress`
  shape extension, listener wiring, overlay rendering.
- `src/locales/en.json`, `src/locales/fr.json` — two new keys each.

No DB migration. No new dependencies.
