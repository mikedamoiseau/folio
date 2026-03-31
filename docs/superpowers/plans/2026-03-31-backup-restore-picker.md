# Backup Restore Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Import from backup" file picker with a unified restore modal that lets users pick from auto-backups or browse for a file.

**Architecture:** New `list_auto_backups` Tauri command reads `{app_data}/backups/` and returns parsed backup metadata. Frontend replaces the import button with a modal containing an auto-backup list and a file picker fallback. Restore uses the existing `import_library_backup` command.

**Tech Stack:** Rust (Tauri v2 commands), React 19, Tailwind CSS v4, i18next

---

### Task 1: Add AutoBackup type to models.rs

**Files:**
- Modify: `src-tauri/src/models.rs` (append after CleanupProgress struct, before `#[cfg(test)]`)

- [ ] **Step 1: Add the new struct**

Add after the `CleanupProgress` struct at line 180 in `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackup {
    pub path: String,
    pub label: String,
    pub timestamp: i64,
    pub size_bytes: u64,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/models.rs
git commit -m "feat(models): add AutoBackup type for backup restore picker"
```

---

### Task 2: Implement `list_auto_backups` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add import, add command after `cleanup_library`)
- Modify: `src-tauri/src/lib.rs` (register new command)

- [ ] **Step 1: Update imports in commands.rs**

In `src-tauri/src/commands.rs` lines 8-11, add `AutoBackup` to the models import. The current import is:

```rust
use crate::models::{
    Book, BookFormat, Bookmark, CleanupEntry, CleanupProgress, CleanupResult, Collection,
    CollectionRule, CollectionType, CustomFont, Highlight, NewRuleInput, ReadingProgress,
    SeriesInfo,
};
```

Change to:

```rust
use crate::models::{
    AutoBackup, Book, BookFormat, Bookmark, CleanupEntry, CleanupProgress, CleanupResult,
    Collection, CollectionRule, CollectionType, CustomFont, Highlight, NewRuleInput,
    ReadingProgress, SeriesInfo,
};
```

- [ ] **Step 2: Add the list_auto_backups command**

Add after the `cleanup_library` function (after its closing brace, before `get_series`) in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn list_auto_backups(state: State<'_, AppState>) -> Result<Vec<AutoBackup>, String> {
    let backups_dir = state.data_dir.join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut backups: Vec<AutoBackup> = Vec::new();

    let entries = std::fs::read_dir(&backups_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }

        let filename = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Parse known prefixes: "pre-cleanup-{timestamp}"
        let (label, timestamp) = if let Some(ts_str) = filename.strip_prefix("pre-cleanup-") {
            match ts_str.parse::<i64>() {
                Ok(ts) => ("Pre-cleanup".to_string(), ts),
                Err(_) => continue,
            }
        } else {
            continue; // Skip unknown files
        };

        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        backups.push(AutoBackup {
            path: path.to_string_lossy().to_string(),
            label,
            timestamp,
            size_bytes,
        });
    }

    // Sort newest first
    backups.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(backups)
}
```

- [ ] **Step 3: Register command in lib.rs**

In `src-tauri/src/lib.rs`, add `commands::list_auto_backups` to the invoke_handler list. Insert after `commands::cleanup_library,` (line 201):

```rust
            commands::list_auto_backups,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add list_auto_backups command"
```

---

### Task 3: Add i18n keys for restore picker

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English translation keys**

In `src/locales/en.json`, inside the `"settings"` object, replace the existing `"importFromBackup"` key and add new keys after it. Find:

```json
    "importFromBackup": "Import from backup\u2026",
```

Replace with:

```json
    "restoreFromBackup": "Restore from backup\u2026",
    "restoreTitle": "Restore from Backup",
    "autoBackups": "Automatic backups",
    "noAutoBackups": "No automatic backups yet.",
    "fromFile": "From file",
    "chooseFile": "Choose file\u2026",
    "restoreConfirmMessage": "This will import books and metadata from the backup. Existing data will not be deleted.",
    "restore": "Restore",
```

- [ ] **Step 2: Add French translation keys**

In `src/locales/fr.json`, inside the `"settings"` object, replace the existing `"importFromBackup"` key and add new keys after it. Find:

```json
    "importFromBackup": "Importer depuis une sauvegarde\u2026",
```

Replace with:

```json
    "restoreFromBackup": "Restaurer depuis une sauvegarde\u2026",
    "restoreTitle": "Restaurer depuis une sauvegarde",
    "autoBackups": "Sauvegardes automatiques",
    "noAutoBackups": "Aucune sauvegarde automatique pour le moment.",
    "fromFile": "Depuis un fichier",
    "chooseFile": "Choisir un fichier\u2026",
    "restoreConfirmMessage": "Ceci importera les livres et m\u00e9tadonn\u00e9es depuis la sauvegarde. Les donn\u00e9es existantes ne seront pas supprim\u00e9es.",
    "restore": "Restaurer",
```

- [ ] **Step 3: Verify frontend type-checks**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add translation keys for backup restore picker"
```

---

### Task 4: Replace import button with restore modal in SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add state variables**

Near the other backup-related state declarations (around line 278), add:

```typescript
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [autoBackups, setAutoBackups] = useState<{ path: string; label: string; timestamp: number; sizeBytes: number }[]>([]);
  const [restoreConfirmPath, setRestoreConfirmPath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
```

- [ ] **Step 2: Add handler functions**

Add near the other handlers (after `handleImportBackup`, around line 564):

```typescript
  const loadAutoBackups = async () => {
    try {
      const list = await invoke<{ path: string; label: string; timestamp: number; sizeBytes: number }[]>(
        "list_auto_backups"
      );
      setAutoBackups(list);
    } catch {
      setAutoBackups([]);
    }
  };

  const handleOpenRestoreModal = async () => {
    setRestoreModalOpen(true);
    setBackupMessage(null);
    await loadAutoBackups();
  };

  const handleRestoreFromFile = async () => {
    try {
      const selected = await openFilePicker({
        multiple: false,
        filters: [{ name: "Backup", extensions: ["zip"] }],
      } as Parameters<typeof openFilePicker>[0]);
      if (!selected) return;
      const path = typeof selected === "string" ? selected : selected[0];
      setRestoreConfirmPath(path);
    } catch {
      // User cancelled
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreConfirmPath) return;
    setRestoring(true);
    try {
      const count = await invoke<number>("import_library_backup", { archivePath: restoreConfirmPath });
      setBackupMessage(t("settings.importedBooks", { count }));
      setRestoreConfirmPath(null);
      setRestoreModalOpen(false);
    } catch (err) {
      setBackupMessage(t("settings.importFailed", { error: String(err) }));
      setRestoreConfirmPath(null);
    } finally {
      setRestoring(false);
    }
  };
```

- [ ] **Step 3: Replace the import button in the Backup & Restore accordion**

In the Backup & Restore accordion (around line 1148-1154), replace the current import button:

```tsx
              <button
                onClick={handleImportBackup}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                {t("settings.importFromBackup")}
              </button>
```

with:

```tsx
              <button
                onClick={handleOpenRestoreModal}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                {t("settings.restoreFromBackup")}
              </button>
```

- [ ] **Step 4: Add the restore modal dialog**

Add the modal JSX at the end of the component's return statement, inside the outermost fragment (before the closing `</>`), near the other dialogs:

```tsx
      {restoreModalOpen && !restoreConfirmPath && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 z-[60]"
            onClick={() => !restoring && setRestoreModalOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("settings.restoreTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.restoreTitle")}
              </h3>

              <div>
                <p className="text-xs font-medium text-ink-muted mb-2">{t("settings.autoBackups")}</p>
                {autoBackups.length === 0 ? (
                  <p className="text-sm text-ink-muted/70 italic">{t("settings.noAutoBackups")}</p>
                ) : (
                  <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                    {autoBackups.map((backup) => (
                      <div
                        key={backup.path}
                        className="flex items-center justify-between gap-2 bg-warm-subtle rounded-xl px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-ink truncate">
                            {backup.label} — {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(backup.timestamp * 1000))}
                          </p>
                          <p className="text-xs text-ink-muted">{formatBytes(backup.sizeBytes)}</p>
                        </div>
                        <button
                          onClick={() => setRestoreConfirmPath(backup.path)}
                          className="shrink-0 px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors font-medium"
                        >
                          {t("settings.restore")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-medium text-ink-muted mb-2">{t("settings.fromFile")}</p>
                <button
                  onClick={handleRestoreFromFile}
                  className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
                >
                  {t("settings.chooseFile")}
                </button>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setRestoreModalOpen(false)}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {restoreConfirmPath && (
        <>
          <div className="fixed inset-0 bg-ink/40 z-[80]" aria-hidden="true" />
          <div
            role="dialog"
            aria-label={t("settings.restoreTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.restoreTitle")}
              </h3>
              <p className="text-sm text-ink-muted">
                {t("settings.restoreConfirmMessage")}
              </p>
              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => setRestoreConfirmPath(null)}
                  disabled={restoring}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleConfirmRestore}
                  disabled={restoring}
                  className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium disabled:opacity-40"
                >
                  {restoring ? t("common.working") : t("settings.restore")}
                </button>
              </div>
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
git commit -m "feat(settings): replace import button with restore modal for auto-backups and file picker"
```

---

### Task 5: Run full CI checks

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
git commit -m "fix: address CI issues from backup restore picker implementation"
```
