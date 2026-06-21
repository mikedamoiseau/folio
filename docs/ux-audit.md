# Folio UX Audit — real path, first launch → read

_Audited: 2026-06-21. Path walked: first run → import → grid → organize → open book → read → finish → catalog/settings._

> **Correction:** an earlier pass claimed "OnboardingWizard is never rendered." This is **false** — it renders at `Library.tsx:1050`, gated by `isActive`, with welcome + skip + 4 steps. That finding was dropped. Everything below holds.

## Top 8 (fix first)

| # | Problem | Where | Sev | Fix |
|---|---------|-------|-----|-----|
| 1 | **No undo on any destructive action** — delete book, bulk delete, remove-from-collection, delete profile all permanent | Library.tsx:353, 1786; ProfileSwitcher:80 | **Critical** | 5s undo toast + soft-delete/restore endpoint |
| 2 | **Profile delete: no confirm + active profile deletable** → undefined app state | ProfileSwitcher:80-88,137 | **Critical** | Confirm dialog; disable delete on active profile |
| 3 | **Bulk edit silently mass-overwrites** mixed fields, no warning, no per-field opt-in | BulkEditDialog.tsx:39-58 | **Critical** | Banner "different values — will overwrite all N"; checkbox to enable each field |
| 4 | **No save confirmation** — EditBookDialog, most settings toggles, custom CSS close with no toast | EditBookDialog:152; SettingsPanel:1114,1278 | **High** | `addToast("Saved")` on success across save paths |
| 5 | **Import errors = raw backend string, no retry** — "IO: permission denied", batch fails halfway, vanishes in 4s | ImportStatusBar:25-28; ImportContext:119 | **High** | i18n friendly msg; persist summary; "Retry failed" button |
| 6 | **Reader header 15+ buttons, no grouping** — nav/content/display/app all flat | ReaderPane:1704-1975 | **High** | Group: Navigate / Content / Display / App; overflow menu |
| 7 | **Settings: 80+ items dumped flat** across 12 accordions, no priority, no search | SettingsPanel:1112-2325 | **High** | Group by frequency (Reading/Appearance/Backup/Advanced); add search |
| 8 | **Catalog add: no URL validation, no connection test** → broken feed found only on browse | CatalogBrowser:153-164,374 | **High** | Pre-flight fetch+parse test before save; show result |

## Per-flow detail

### 1. First run + import
- **Import-step auto-advance silent on cancel/empty/error** — pick folder w/ no ebooks, onboarding step 3 stuck, no message. ImportContext:101 / Wizard:383-393. **High**. → show banner + retry when phase `empty`/`error`/`cancelled`.
- **URL import dialog: no error feedback** — bad URL, nothing happens. ImportButton:145-191. **High**. → try/catch + inline error.
- **Partial batch failure not visually distinct** — "15 imported, 2 failed" equal weight, gone in 4s. ImportStatusBar:20. **Medium**. → color error count, persist if errors>0.
- **Copy vs Link choice unexplained** in onboarding. Wizard:340. **Medium**. → one-line help text (disk space vs reads-in-place).

### 2. Grid + organize
- **Drag book→collection: no toast, grid stale** until next action. Library:1724. **High**. → optimistic update + toast.
- **Bulk delete uses browser `confirm()`** — unstyled, no count/preview. Library:1786. **High**. → styled modal w/ count.
- **Delete confirm modal: no cover/full title** context. BookCard:316. **Medium**. → thumbnail + full title.
- **Select-mode toggle wipes selection** silently. Library:923. **Medium**. → preserve selectedIds.
- **Select checkbox overlays action buttons** top-left. Library:1448,1852. **Medium**. → move to corner badge.
- **No-results vs filters-too-strict** indistinguishable. Library:1530. **Low**. → separate copy per cause.
- **Tag filter counts ignore active filters** → misleading. TagFilter:63. **Medium**. → count against filtered set.
- **EditBookDialog error tiny + bottom** of long form. EditBookDialog:453. **Medium**. → sticky top banner.

### 3. Reader
- **Chapter load error: no retry button**, just red text. ReaderPane:2244. **High**. → recoverable card w/ "Try again" (PageViewer:689 already does this — copy it).
- **Missing-file dialog rendered twice**, two-stage. ReaderPane:1517 + 2361. **High**. → consolidate one dialog, detect upfront.
- **Continuous scroll: "Loading 280 chapters", no progress**. ReaderPane:2278. **High**. → "Loaded 45/280" counter/bar.
- **No content skeleton on chapter load** — blank area + spinner. ReaderPane:2284 (ReaderSkeleton exists, unused on load). **Medium**. → render skeleton.
- **Highlight: no immediate undo/remove** after wrong color. ReaderPane:2220. **Medium**. → always show remove, or undo toast.
- **Completion rating: no save confirm**, reopen shows nothing. BookCompletionModal:135. **Medium**. → toast on star click.
- **Empty bookmarks/highlights panels: no how-to CTA**. BookmarksPanel:151, HighlightsPanel:127. **Low**. → "Select text or press B".
- **Settings button no open-state highlight**. ReaderPane:1957. **Low**. → highlight when panel open.

### 4. Catalog + settings
- **Catalog removal: no confirm/undo**. CatalogBrowser:166. **High**. → confirm + 5s undo.
- **PIN save: explicit button, no auto-save** — close panel mid-type = lost. SettingsPanel:1957. **High**. → save on blur or "unsaved" indicator.
- **Backup "Save and test" one button** — can't tell save-fail from test-fail. SettingsPanel:2126. **High**. → split Save / Test Connection.
- **Download progress: spinner only, no size/%/ETA**. CatalogBrowser:128. **Medium**. → size + progress.
- **Port input caps silently** out-of-range to boundary. SettingsPanel:1986. **Medium**. → inline range error.
- **Empty "no catalogs" state never built** — blank panel. CatalogBrowser:335. **Medium**. → CTA to preset picker.
- **Plugin reload/install: no feedback**; folder-permission grant never checks writable. PluginsPanel:122,99. **Medium/Low**. → toasts; test writability.
- **Profile switch: no loading state** during library re-scan. ProfileSwitcher:51. **Low**. → spinner.

## Three patterns behind most of it

1. **Mutations don't confirm.** Save/delete/reorder/toggle change state, UI gives no success signal. User trusts "modal vanished = worked." Add toasts + optimistic refresh everywhere.
2. **No undo + raw `confirm()`.** Destructive ops irreversible and unstyled. Standardize: styled confirm for big ops, undo toast for reversible ones.
3. **Errors/empties unbuilt.** Raw backend strings, missing states, no retry. Build: friendly error → cause → recovery action, for every async call.

**Suggested start:** #1 (undo) + #4 (save toasts) — highest trust impact, touches most flows.
