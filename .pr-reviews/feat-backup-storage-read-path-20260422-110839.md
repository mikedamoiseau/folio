# PR Review: feat-backup-storage-read-path
**Date:** 2026-04-22 11:08
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 378
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: key-form backup reads the entire book before checking whether upload can be skipped

**Finding 1**

- **File**: `folio-core/src/backup.rs:635-637`, `folio-core/src/backup.rs:497-503`
- **Severity**: BLOCKING
- **Fixable**: YES
- **What can go wrong**: Editing only book metadata, such as title or rating, bumps `updated_at`, so the book enters `changed_books`. If the remote backup already has `files/<hash>.<ext>` with the same size, the upload should be skipped, but this code still calls `storage.get(&book.file_path)` first and reads the whole book into memory. With large PDFs/CBRs, or a future remote `Storage` backend, backup can spend minutes downloading unchanged blobs or fail with memory pressure before it ever discovers the remote file is already present.
- **Why vulnerable**: `push_file_if_missing` checks local size and remote `stat` before `std::fs::read`, but the new trait path materializes `Vec<u8>` before `push_bytes_if_missing` can compare sizes. The skip check happens after the expensive full read.
- **Impact**: Incremental backup no longer behaves incrementally for key-form imported books. It can become very slow, bandwidth-heavy, or fail on large unchanged files, especially for the backend-agnostic storage path this refactor is meant to support.
- **Fix**: Replace this with a storage-aware helper, for example `push_storage_file_if_missing(op, remote_path, storage, key)`, that calls `storage.size(key)?`, compares it with `op.stat(remote_path)`, and only calls `storage.get(key)?` when upload is actually needed. Add a regression test where the remote file already exists with matching size and assert `Storage::get` is not called.

**Finding 2**

- **File**: `src-tauri/src/commands.rs:3208-3225`
- **Severity**: SUGGESTION
- **Fixable**: YES
- **What can go wrong**: If `state.active_storage()?` fails after `BACKUP_RUNNING` has inserted the profile, `run_backup` returns early and never removes the profile from `BACKUP_RUNNING`. For example, a stored `library_folder` pointing at an inaccessible path can make `LocalStorage::new` fail. Every later backup attempt for that profile then returns “A backup is already in progress for this profile” until the app restarts.
- **Why vulnerable**: The cleanup only runs after `rx.recv()?`, but the new fallible storage construction is added after the running marker is set and before the cleanup path.
- **Impact**: A transient storage setup error can permanently wedge backup for that profile in the current process.
- **Fix**: Use an RAII guard for the `BACKUP_RUNNING` entry so every early return removes it, or move all fallible setup including `active_storage()` before inserting into `BACKUP_RUNNING`, then keep a guard active through the spawned backup and logging path.

---

## [Gemini — Reviewer] Round 1

LGTM: The refactoring correctly routes book file reads through the `Storage` trait during backup, enhancing modularity and testability.

No issues found that meet the criteria for BLOCKING or SUGGESTION. The changes are well-implemented and include new tests to verify the behavior.

---


## [Claude — Implementer] Round 1

All tests pass, formatting is clean, and CI clippy passes. Here's the summary:

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Key-form backup reads full book before size check (BLOCKING) | Codex | **Fixed** | Real regression introduced by this PR. Replaced `push_bytes_if_missing` with `push_storage_file_if_missing` which calls `storage.size(key)` and compares against remote `stat()` before reading any bytes via `storage.get()`. Added regression test `incremental_backup_skips_storage_get_when_remote_file_matches` that pre-populates remote with matching-size file and asserts `MockStorage.get_calls()` stays empty. |
| `BACKUP_RUNNING` wedges on `active_storage()?` failure (SUGGESTION) | Codex | **Pushed back** | Pre-existing behavior — there are already 6 fallible calls (`active_db()?`, `get_setting()?`, `ok_or_else`, `serde_json::from_str()?`, `load_secrets()?`, `build_operator()?`) between the `BACKUP_RUNNING.insert()` and the cleanup block. The new `active_storage()?` is the 7th instance of the same pattern, not a new bug class. Codex marked it SUGGESTION, Gemini didn't flag it, and the recommended fix (RAII guard) is a broader refactor of pre-existing code that violates CLAUDE.md's "surgical changes only" rule. Worth a separate follow-up PR. |

### Changes
- `folio-core/src/backup.rs:493-513` — replaced `push_bytes_if_missing` with size-first `push_storage_file_if_missing`
- `folio-core/src/backup.rs:635-637` — call site now uses the new helper, passing storage + key directly
- `folio-core/src/backup.rs` — added regression test asserting `Storage::get` is not called when remote size matches

### Verification
- `cargo fmt --check` ✓
- `cargo clippy -- -D warnings` (CI command) ✓
- `cargo test` — 14/14 backup tests pass, 61/61 src-tauri tests pass

---


## [Codex — Reviewer] Round 2

LGTM: the storage-backed backup path now checks size before reading bytes, and I found no remaining merge-blocking issues in the current diff.

No findings.

The prior blocking concern is addressed by `push_storage_file_if_missing`, which calls `storage.size()` and compares remote `stat()` before calling `storage.get()`. The new regression test covers the key case where a changed metadata row should skip reading the book when the remote file already has the matching size.

I’m accepting the pushback on the `BACKUP_RUNNING` cleanup issue for this round because the fallible setup-before-cleanup pattern was already present, and the new storage call is another instance of that broader existing design rather than a new regression introduced by the fix.

---

## [Gemini — Reviewer] Round 2

LGTM: All critical findings addressed, and the push-back on the suggestion is justified by project conventions.

---

