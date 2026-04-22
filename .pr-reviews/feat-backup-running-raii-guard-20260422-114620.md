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

