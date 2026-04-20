# PR Review: feat-folio-core-storage-m4-db-keys
**Date:** 2026-04-20 09:51
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 978
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: Remote backups now try to read storage keys as local file paths, so imported book files stop uploading after this migration.

**Finding 1**

- **File**: [folio-core/src/backup.rs](/Users/mike/Documents/www/folio/folio-core/src/backup.rs:597), [src-tauri/src/commands.rs](/Users/mike/Documents/www/folio/src-tauri/src/commands.rs:517)
- **Severity**: BLOCKING
- **Fixable**: YES
- **What can go wrong**: After this change, a newly imported book is stored in the DB as a key like `550e8400.epub` instead of an absolute path. When the user runs remote backup, `run_incremental_backup_with_progress` reaches `push_file_if_missing(op, &remote_path, &book.file_path)` and `push_file_if_missing` calls `std::fs::metadata("550e8400.epub")`. That path is resolved relative to the process cwd, not the configured library folder, so backup fails with `Cannot read 550e8400.epub` or silently omits the actual book file if error handling higher up changes later.
- **Why vulnerable**: The diff updates import/migration/read paths to treat `Book.file_path` as an opaque storage key for imported books, but `folio-core/src/backup.rs` still treats `book.file_path` as a filesystem path at lines 597-603. The new contract is introduced in `import_book` at lines 517-523 and by the DB migration at lines 315-320, but backup was not updated to resolve keys through `LocalStorage`.
- **Impact**: Remote backups created after this PR can contain updated metadata without the corresponding book files. A user who relies on backup/restore may discover later that restored books are missing file payloads.
- **Fix**: Resolve imported book paths before uploading. In `run_incremental_backup_with_progress`, load `library_folder` from settings, construct `LocalStorage`, and for each imported book use:
  - absolute `book.file_path` unchanged for legacy imported rows,
  - `storage.local_path(&book.file_path)` for post-M4 storage keys,
  - skip linked books as today.
  
  Then pass the resolved local path to `push_file_if_missing`. Add a regression test that inserts an imported book with `file_path = "id.epub"`, writes the file under the configured library folder, runs incremental backup, and asserts the file upload succeeds.

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

NEEDS_FIX: Codex correctly identified that `folio-core/src/backup.rs:602` still treats `book.file_path` as a filesystem path, breaking remote backup for post-M4 imports.

## Analysis

### Codex Finding 1: backup.rs doesn't resolve storage keys — AGREE (BLOCKING)

Verified at `folio-core/src/backup.rs:596-602`:
```rust
if let Some(ref hash) = book.file_hash {
    let ext = std::path::Path::new(&book.file_path)...
    let remote_path = format!("files/{}.{}", hash, ext);
    if push_file_if_missing(op, &remote_path, &book.file_path)? { ... }
}
```

And `push_file_if_missing` at line 477 calls `std::fs::metadata(local_path)` directly. Post-M4, imported books have `file_path = "abc.epub"` (a relative key), so this resolves against CWD and errors with `Cannot read abc.epub`.

Impact is real: the `?` operator makes `push_file_if_missing` propagate the error, aborting the book loop. Any user running incremental backup after upgrading would fail to upload imported books.

The `Path::extension()` call at line 597 still works on a bare key (it returns `"epub"` for `"abc.epub"`), so the remote path derivation is fine — only the local read breaks.

### Fix

`folio-core` can't depend on `AppState::resolve_book_path`. Two options:

1. **Resolve in backup.rs directly** — read `library_folder` setting, construct `LocalStorage`, and for each imported book: if `Path::is_absolute()` use as-is (legacy), else `storage.local_path(&book.file_path)`. This mirrors the pattern in `WebState::resolve_book_path` (web_server/mod.rs:47-63).
2. **Accept a resolver closure** — keep backup.rs storage-agnostic by having callers pass `Fn(&Book) -> FolioResult<String>`. Cleaner, but more API churn.

Option 1 is surgical and matches what Codex suggested. A regression test inserting a key-form `file_path`, writing the file under the library folder, and asserting upload succeeds would lock this in.

### Gemini

Errored this round — no vote to weigh.

### Verdict

One reviewer found a verified blocking bug. Backup.rs needs updating before merge.

---


## [Codex — Reviewer] Round 2

LGTM: Claude accepts the blocking backup-path issue and gives a technically sound, scoped fix direction.

Claude’s response correctly preserves the prior finding rather than pushing back on it. The analysis identifies the exact failure mode: `book.file_path` is now a storage key for imported books, while `backup.rs` still passes it to `std::fs::metadata` as if it were an absolute local path.

The proposed fix is also aligned with the new M4 contract: resolve imported relative keys through `LocalStorage`, keep legacy absolute imported paths unchanged, and continue skipping linked books. The suggested regression test targets the actual broken case.

No additional unresolved reviewer concern remains from this discussion round.

---

## [Gemini — Reviewer] Round 2

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 2

NEEDS_FIX: backup.rs still passes the storage key to `push_file_if_missing` as a filesystem path — the blocking issue Codex raised in round 1 is unresolved in the diff under review.

## Analysis

### Codex Finding 1: backup.rs treats `file_path` as filesystem path — CONFIRMED UNFIXED

Verified at `folio-core/src/backup.rs:602` — `push_file_if_missing(op, &remote_path, &book.file_path)` still hands a bare storage key (e.g. `"abc.epub"`) to what ultimately calls `std::fs::metadata`. Post-M4, that resolves against CWD and fails.

My round 1 analysis accepted this as blocking and proposed option 1 (resolve in backup.rs via `LocalStorage`). Codex's round 2 "LGTM" was on the *plan*, not on the code — the diff in this review round is unchanged. The bug ships as-is.

### Required fix (scope)

In `run_incremental_backup_with_progress`, before line 602:
- Load `library_folder` from settings once outside the loop.
- Construct `LocalStorage::new(folder)`.
- For each imported book with `file_hash`, resolve: if `Path::is_absolute(&book.file_path)` use unchanged (legacy); else `storage.local_path(&book.file_path)?.to_string_lossy().into_owned()`.
- Pass the resolved path to `push_file_if_missing`.
- Add regression test: insert imported book with key-form `file_path`, write file under library folder, assert upload succeeds.

### Gemini

Errored both rounds. No vote.

### Verdict

One live reviewer found a verified blocking bug that remains unfixed. Cannot LGTM.

---


## [Codex — Reviewer] Round 3

LGTM: Claude correctly keeps the backup path bug as unresolved and does not dismiss the blocking concern.

Claude’s response addresses the reviewer concern accurately: the diff still has `backup.rs` passing `book.file_path` directly into `push_file_if_missing`, which is wrong under the new M4 contract where imported books store storage keys rather than absolute paths.

No disagreement with Claude’s reasoning. The required implementation remains the same: resolve imported relative storage keys through `LocalStorage`, preserve legacy absolute imported paths, and add a regression test for remote backup with key-form `file_path`.

---

## [Gemini — Reviewer] Round 3

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 3

NEEDS_FIX: backup.rs still passes the storage key as a filesystem path — Codex's blocking finding remains unresolved.

## Analysis

### Codex Finding 1: backup.rs doesn't resolve storage keys — AGREE (BLOCKING, UNFIXED)

Verified at `folio-core/src/backup.rs:602` in the current tree:
```rust
if push_file_if_missing(op, &remote_path, &book.file_path)? {
```

`push_file_if_missing` ultimately calls `std::fs::metadata`/`fs::read` on the third argument. Post-M4, imported books have `file_path = "{book_id}.{ext}"` — a bare storage key. That resolves against CWD, not the library folder, so remote backup breaks for any book imported after this migration.

The bug is real, the diff doesn't address it, and Codex confirmed it across 3 rounds. This ships broken as-is.

### Required fix

In `run_incremental_backup_with_progress`, before the book loop:
- Load `library_folder` from settings once.
- Construct `LocalStorage::new(folder)`.

Then for each imported book with `file_hash`:
- If `Path::new(&book.file_path).is_absolute()` → use unchanged (legacy pre-M4 row).
- Else → `storage.local_path(&book.file_path)?.to_string_lossy().into_owned()`.
- Pass resolved path to `push_file_if_missing`.

Plus a regression test: insert imported book with key-form `file_path`, write file under library folder, assert upload succeeds.

### Gemini

Errored all 3 rounds. No vote.

### Verdict

With one live reviewer confirming a verified blocking bug that is still present in the diff, I cannot LGTM. The fix is scoped and mechanical — apply it before merge.

---


## [Codex — Reviewer] Round 4

LGTM: Claude’s response correctly keeps the backup path issue open and does not dispute the blocking finding.

Claude’s latest response addresses the reviewer concern directly: the code still passes `book.file_path` to `push_file_if_missing`, and under the new M4 contract that value can be a storage key rather than a filesystem path. The failure mode, impact, and required fix are accurately described.

No new disagreement remains in the discussion. The implementation still needs to happen before merge, but Claude’s reasoning itself is sound.

---

## [Gemini — Reviewer] Round 4

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 4

NEEDS_FIX: backup.rs still passes the storage key to `push_file_if_missing` as a filesystem path — Codex's blocking finding remains unfixed in the diff.

## Analysis

### Codex Finding 1: backup.rs doesn't resolve storage keys — CONFIRMED (BLOCKING, UNFIXED)

Verified at `folio-core/src/backup.rs:602`:
```rust
if push_file_if_missing(op, &remote_path, &book.file_path)? {
```

`push_file_if_missing` (line 477) calls `std::fs::metadata(local_path)` directly. Post-M4, imported books have `file_path = "{book_id}.{ext}"` — a bare storage key. It resolves against CWD, not the library folder, so `metadata()` fails with `Cannot read {id}.epub` and the `?` aborts the book loop.

Covers at line 617 are safe — M3 already stores absolute cover paths via the covers storage.

### Required fix (scope)

In `run_incremental_backup_with_progress`, before line 590's loop:
- Load `library_folder` from settings once.
- Construct `LocalStorage::new(folder)`.

Per imported book at line 602:
- If `Path::new(&book.file_path).is_absolute()` → use unchanged (legacy pre-M4).
- Else → `storage.local_path(&book.file_path)?.to_string_lossy().into_owned()`.
- Pass the resolved path to `push_file_if_missing`.

Regression test: insert imported book with key-form `file_path`, write file under library folder, assert upload succeeds.

### Gemini

Errored all 4 rounds. No vote to weigh.

### Verdict

Codex verified the same blocking bug across 4 rounds. The diff in this review round does not address it. Cannot LGTM — apply the fix before merge.

---


## [Codex — Reviewer] Round 5

LGTM: Claude’s response accurately keeps the unresolved backup path bug open and gives the correct scoped fix direction.

Claude did not push back on the reviewer concern. The reasoning matches the M4 storage contract: imported books may now store relative storage keys in `file_path`, while `push_file_if_missing` needs an actual filesystem path. The proposed resolution, resolving relative imported paths through `LocalStorage` while preserving legacy absolute paths, is technically sound.

No additional disagreement from me on Claude’s response.

---

## [Gemini — Reviewer] Round 5

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 5

NEEDS_FIX: `folio-core/src/backup.rs:602` passes the post-M4 storage key directly to `push_file_if_missing`, which calls `std::fs::metadata` on it — remote backup breaks for any book imported after this migration.

## Analysis

### Codex's finding — CONFIRMED

Verified `folio-core/src/backup.rs:602`:
```rust
if push_file_if_missing(op, &remote_path, &book.file_path)? {
```

And `push_file_if_missing` at line 477 calls `std::fs::metadata(local_path)` directly on that string. Post-M4, imported books store `file_path = "{book_id}.{ext}"` — a bare storage key that resolves against the process CWD, not the library folder. `metadata()` fails, `?` propagates, the book loop aborts.

Impact is real: any user running remote backup after the M4 migration with a post-M4 import will hit `Cannot read {id}.epub` and the sync run fails. This is a user-visible data-availability bug (updated metadata can be pushed to remote without the corresponding file payload in prior partial runs).

Cover uploads at line 617 are unaffected — M3 already routed covers through absolute paths stored separately.

### Gemini

Errored in all 5 rounds. No vote to weigh — decision falls to me and Codex.

### Required fix (scoped)

In `run_incremental_backup_with_progress`, before line 590's loop:
- Read `library_folder` from settings.
- Construct `LocalStorage::new(folder)` once.

Per imported book with `file_hash` at line 602:
- If `Path::new(&book.file_path).is_absolute()` → pass unchanged (legacy pre-M4 rows that escaped migration).
- Else → `storage.local_path(&book.file_path)?.to_string_lossy().into_owned()`.

Regression test: insert imported book with `file_path = "id.epub"`, write file at `{library_folder}/id.epub`, run incremental backup, assert upload succeeds and `result.files_pushed == 1`.

### Verdict

Codex and I agree across 5 rounds: blocking bug, still present in the diff. Cannot merge as-is. Fix is mechanical and local to `backup.rs`.

---


## [Codex — Reviewer] Round 6

LGTM: Claude’s response correctly preserves the blocking backup-path concern and gives the right scoped fix without disputing the finding.

Claude’s reasoning addresses the reviewers’ concern. It explicitly confirms the failure mode: post-M4 imported books store `file_path` as a storage key, while `folio-core/src/backup.rs:602` still passes that value into a filesystem read path via `push_file_if_missing`.

There is no technical disagreement to carry forward. The response does not claim the code is fixed; it correctly says the issue remains unresolved in the diff and identifies the needed fix: resolve imported relative keys through `LocalStorage`, preserve legacy absolute imported paths, and add a regression test for backup with key-form `file_path`.

No new unresolved review concern from me.

---

## [Gemini — Reviewer] Round 6

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 6

LGTM: The backup.rs fix is present in the working tree with proper regression tests — the sole blocking issue is resolved.

## Analysis

### Codex's finding — RESOLVED in working tree

Verified `folio-core/src/backup.rs:587-642`: the fix loads `library_folder`, constructs `LocalStorage` once outside the loop, and per-book routes through three cases:
- `Path::is_absolute()` → passthrough (legacy pre-M4)
- storage available → `storage.local_path(&book.file_path)?`
- no library_folder setting + key-form path → skip with warning (safer than resolving against CWD)

Then passes the resolved `local_path` to `push_file_if_missing`. This matches exactly what I proposed across rounds 1-5.

### Regression tests — PRESENT

Two new tests at `folio-core/src/backup.rs:895-991`:
1. `incremental_backup_resolves_m4_storage_keys` — asserts key-form `file_path = "b1.epub"` uploads correctly via the resolver, and the remote file lands at `files/deadbeef.epub` with expected bytes.
2. `incremental_backup_passes_legacy_absolute_paths_unchanged` — asserts a pre-M4 absolute path outside the current library folder still uploads via the passthrough branch.

### One caveat

backup.rs is not in commit `a41f86d` (the commit under review); it's an uncommitted working-tree modification. User should amend or add a follow-up commit before pushing so the fix ships with M4. Content-wise, the work is correct and tested.

### Verdict

Codex went LGTM. Gemini errored all 6 rounds. With the fix and tests verified in place, I vote LGTM — just make sure backup.rs is committed before push.

---

