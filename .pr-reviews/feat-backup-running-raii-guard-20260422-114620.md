# PR Review: feat-backup-running-raii-guard
**Date:** 2026-04-22 11:46
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 148
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: `run_backup` guards one profile name but can execute against a different active profile if the user switches profiles during setup.

**Finding 1**

- **File:** `src-tauri/src/commands.rs:3231`, `src-tauri/src/commands.rs:3236`, `src-tauri/src/commands.rs:3239`, `src-tauri/src/commands.rs:3248`
- **Severity:** BLOCKING
- **Fixable:** NO
- **What can go wrong:** `run_backup` snapshots `profile_name`, acquires `BACKUP_RUNNING` for that name, then calls `state.active_db()` and `state.active_storage()`, both of which re-read the mutable active profile. If the user switches from profile A to profile B between line 3231 and lines 3239/3248, the guard records “A is backing up” while the actual DB/config/storage used for the backup come from B. A second backup for B can then start because `BACKUP_RUNNING` does not contain B.
- **Why vulnerable:** the lock key and the resources being protected are not captured atomically from the same profile state. `switch_profile` mutates `profile_state.active`, and `active_db()` / `active_storage()` resolve against the current active profile at call time.
- **Impact:** concurrent backups can run against the same real profile, which can corrupt or race remote backup manifests/uploads. It can also run/log a backup for a different profile than the UI action intended.
- **Fix:** capture the profile resources for the same `profile_name` used by the guard. For example, add profile-specific helpers that resolve the DB pool and library folder by explicit profile name, then use that captured pool/connection/storage throughout `run_backup`, including activity logging. Do not call `state.active_db()` or `state.active_storage()` again after acquiring the guard unless profile switching is explicitly blocked for the duration.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: BackupLockGuard's Drop implementation silently fails to release lock on mutex poisoning, leading to indefinitely wedged profiles.

**File**: `src-tauri/src/commands.rs`
**Line number(s)**: 3226-3230 (within `impl Drop for BackupLockGuard`)
**What** can go wrong: If the `BACKUP_RUNNING` mutex becomes "poisoned" (meaning a thread holding the mutex panicked), the `BackupLockGuard::drop` implementation will fail to acquire the lock (`BACKUP_RUNNING.lock()` returns `Err(PoisonError)`). Because this error is silently ignored (`if let Ok(...)`), the `profile_name` will not be removed from the `BACKUP_RUNNING` set.
**Why** the code is vulnerable to this: The `if let Ok(...)` construct explicitly handles the `Ok` variant but implicitly ignores the `Err` variant of the `Result` returned by `lock()`. While panics are exceptional, they can happen, and a poisoned mutex indicates a severe unrecoverable state where cleanup is critical.
**Impact** if it happens: The profile associated with the backup will remain indefinitely marked as "backup running" until the application is restarted. This prevents any further backup operations for that profile, effectively wedging the user's ability to back up their data for that profile. This can lead to user frustration and data inconsistency if users believe backups are running when they are not.
**Fix** recommendation: The `Drop` implementation should at least log an error if it fails to acquire the mutex due to poisoning. While panicking within a `Drop` implementation is generally discouraged due to potential double-panic issues, silently failing to perform a critical cleanup operation is worse. Logging provides visibility into this severe failure mode.

```rust
impl Drop for BackupLockGuard {
    fn drop(&mut self) {
        match BACKUP_RUNNING.lock() {
            Ok(mut running) => {
                running.remove(&self.profile_name);
            }
            Err(e) => {
                // Log the error: a poisoned mutex indicates a serious, unrecoverable state.
                // Silently failing to remove the profile would lead to it being permanently
                // wedged until app restart.
                eprintln!(
                    "CRITICAL ERROR: Failed to release backup lock for profile '{}' due to poisoned mutex: {:?}",
                    self.profile_name, e
                );
            }
        }
    }
}
```
**Severity**: BLOCKING
**Fixable**: YES

---


## [Claude — Implementer] Round 1

Clippy clean, fmt clean, all 4 RAII guard tests pass.

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Profile-switching race between `BACKUP_RUNNING` key and `active_db()`/`active_storage()` calls | Codex | **No change** | Marked `Fixable: NO` (requires human judgment). Also pre-existing — this refactor preserves the original profile-resolution sequence verbatim. Fix requires profile-scoped resource helpers, which is a separate architectural change out of scope for a lock-release refactor. Flagging for follow-up. |
| `Drop` silently ignores poisoned mutex | Gemini | **Partial fix** (added `log::error!`) | Pushed back on BLOCKING severity — the failure mode is benign (new `acquire` calls also fail, so no backup runs with stale state) and this is a pre-existing pattern, not a regression. But added a log line matching the codebase's style (`log::error!`, not `eprintln!`) because `src-tauri/src/lib.rs:205` already uses this pattern for the same class of failure. |

Diff added 11 lines in `commands.rs:3221-3234` (Drop impl) to log poisoning instead of silently swallowing it. No other changes.

---


## [Codex — Reviewer] Round 2

NEEDS_FIX: `run_backup` still guards one profile name while resolving the actual DB/storage from the mutable active profile.

**Finding 1**

- **File:** `src-tauri/src/commands.rs:3243`, `src-tauri/src/commands.rs:3247`, `src-tauri/src/commands.rs:3256`
- **Severity:** BLOCKING
- **Fixable:** NO
- **What can go wrong:** `run_backup` snapshots `profile_name`, acquires `BACKUP_RUNNING` for that name, then calls `state.active_db()` and later resolves active-profile resources again. If the user starts a backup for profile A and switches to profile B during this setup window, the guard says profile A is running while the backup can operate on profile B’s database/config/storage.
- **Why vulnerable:** the lock key and the resources being protected are not captured from the same immutable profile state. `profile_name` is copied from `profile_state.active`, but `state.active_db()` and other active-resource helpers resolve against whatever profile is active at call time.
- **Impact:** two backups can run concurrently against the same real profile because the running set may contain A while the actual backup is using B. That can race remote manifest writes/uploads and log backup activity under the wrong profile.
- **Fix:** resolve all backup resources by the same explicit profile identity used for `BackupLockGuard::acquire`. Add profile-scoped helpers for DB pool/storage/library path lookup by `profile_name`, then use those captured resources throughout `run_backup`. Alternatively, hold a profile-switch-preventing lock for the whole resource capture, but do not call active-profile helpers after acquiring a guard keyed by an earlier snapshot.

The mutex-poisoning concern is addressed enough for this patch: `Drop` now logs the failed cleanup path, and acquire paths already surface poisoned-lock failures instead of silently allowing another backup.

---

## [Gemini — Reviewer] Round 2

NEEDS_FIX: Profile-switching race condition in `run_backup` can lead to backups of incorrect profiles.

**Finding 1**

- **File:** `src-tauri/src/commands.rs:3243`, `src-tauri/src/commands.rs:3248` (lines where `state.active_db()` and `state.active_storage()` are called)
- **What** can go wrong: The `run_backup` function acquires a `BackupLockGuard` for a specific `profile_name` derived from the active profile at the beginning of the function. However, subsequent calls to `state.active_db()` and `state.active_storage()` implicitly retrieve resources for the *currently* active profile. If the active profile changes between the acquisition of the guard and these later resource retrievals (e.g., via a user action like `switch_profile` or another process), the backup operation will proceed using database and storage resources belonging to a *different* profile than the one for which the lock was acquired. This means the `BackupLockGuard` could protect profile 'A' from concurrent backups, while the actual backup operation runs against profile 'B', potentially leading to data corruption or inconsistencies for profile 'B', or an incorrect backup for 'A'.
- **Why** the code is vulnerable to this: The `profile_name` used for the `BackupLockGuard` is captured once, but the critical resources (`DbPool` connection, `Storage` instance) are dynamically resolved based on the *current* active profile state later in the function. There's a temporal coupling that is not guaranteed to be atomic. The `BackupLockGuard` is local to the `profile_name` string, but the `AppState`'s active profile is mutable and global.
- **Impact** if it happens:
    1. **Data Corruption/Inconsistency:** A backup intended for profile A might modify or read from profile B's database and storage, leading to corrupt backup manifests or an incomplete/incorrect backup for profile B.
    2. **Incorrect Backup:** The user might believe they have backed up profile A, but the data backed up is actually from profile B.
    3. **Race Conditions:** If another backup for profile B starts (because `BACKUP_RUNNING` doesn't contain B), two backups could run concurrently against profile B's resources.
    4. **Misleading UI:** The UI will show a backup running for the intended profile, while the backend is operating on a different one.
- **Fix** recommendation: The `run_backup` function must consistently use profile-specific resources associated with the `profile_name` for which the lock was acquired. This requires modifying `state.active_db()` and `state.active_storage()` (or introducing new helper functions) to accept a `profile_name` argument and retrieve the corresponding resources for *that specific profile*, rather than relying on the globally mutable `state.active` profile.
    - Example: Instead of `state.active_db()`, use `state.db_for_profile(&profile_name)`. Similarly for `state.active_storage()`.
    - This ensures that all operations within `run_backup` are scoped to the profile initially locked.
- **Severity**: BLOCKING
- **Fixable**: NO (Requires design changes to how `AppState` resolves profile-specific resources, which is an architectural decision.)

---

## [Claude — Implementer] Round 2

No code changes this round. Deferring the one remaining finding to the human.

### Position on the profile-switching race (Codex + Gemini, both Rounds 1 & 2)

Both reviewers are correct that this is a real race. Both also explicitly mark it `Fixable: NO` because the fix requires new `AppState` helpers (`db_for_profile(name)`, `storage_for_profile(name)`) plus downstream changes in `run_backup`'s activity logging path. Per this workflow's rules, `Fixable: NO` means I acknowledge and defer — I do not attempt an architectural fix on a blocking-but-human-call finding.

Two additional facts that inform the decision:

1. **Pre-existing, not a regression.** Commit `4f1bdcb` only changed *how the `BACKUP_RUNNING` lock is released* (explicit cleanup → RAII). The `profile_name` snapshot + later `active_db()` / `active_storage()` sequence is identical to what existed on `main` before this branch. Merging this PR does not widen the race window; the race has been there since `run_backup` was written.
2. **Scope mismatch.** This branch is a 148-line lock-release refactor. Fixing the profile race means touching `AppState`, at minimum two new resolver methods, and every call site in `run_backup` that currently uses `active_*`. That is a separate concern and deserves its own branch, commit message, and review — bundling it here would violate the "surgical changes only" rule in `CLAUDE.md`.

### Recommendation to the human

- **Merge this PR as-is** — the RAII refactor is correct, tested (4 unit tests), and addresses the *actual* regression risk (fallible setup steps wedging the profile).
- **Open a follow-up issue** titled something like "run_backup: resolve DB/storage by locked profile_name, not active profile" and track Codex's fix suggestion there. That change should also cover `backup_activity_log` writes and any other `active_*` calls inside the function body.

If you disagree and want the race fixed on this branch before merge, say the word and I'll design the `*_for_profile` helpers and redo the `run_backup` body in a separate commit on top of `8e8a9c3`.

---


## [Claude — Implementer] Round 2

Review report updated. No code changes this round.

### Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Profile-switching race: `BACKUP_RUNNING` keyed on `profile_name` snapshot while `active_db()` / `active_storage()` re-read the mutable active profile | Codex + Gemini (both rounds) | **No change — deferred to human** | Both reviewers marked `Fixable: NO`. Per workflow rules, `Fixable: NO` findings are not auto-fixed even when majority-confirmed. It's also pre-existing (not introduced by commit `4f1bdcb`) and out of scope for a lock-release refactor — the fix needs new `AppState::{db,storage}_for_profile(name)` helpers plus updates across all `active_*` call sites in `run_backup`, which warrants its own branch. Recommending merge-as-is + follow-up issue. |

The lock-release refactor itself (commit `4f1bdcb` + round-1 `log::error!` addition in `8e8a9c3`) has no outstanding fixable findings. Decision on whether to expand this branch into the architectural fix is yours.

---

