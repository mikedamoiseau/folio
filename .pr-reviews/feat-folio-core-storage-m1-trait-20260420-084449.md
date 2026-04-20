# PR Review: feat-folio-core-storage-m1-trait
**Date:** 2026-04-20 08:44
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 451
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: Storage writes can corrupt an existing object on partial write/copy failure.

**Findings**

1. **File:** `folio-core/src/storage.rs:142-148`, `folio-core/src/storage.rs:197-203`  
   **Severity:** BLOCKING  
   **Fixable:** YES  
   **What can go wrong:** If `put()` or `put_path()` overwrites an existing stored book/cover and the write fails midway, for example due to disk full, permission change, interrupted network filesystem, or source read error during `fs::copy`, the previous object can be truncated or replaced with partial bytes while the database still points at the same key/path.  
   **Why:** `fs::write()` creates/truncates the destination before `write_all`, and `fs::copy()` also overwrites the destination directly. Neither path writes to a temporary file first, so failure is not atomic.  
   **Impact:** Existing library artifacts can be silently corrupted after a failed overwrite. A book may become unreadable, a cover may break, or later parsers may operate on partial EPUB/PDF/CBZ data even though the storage operation returned an error.  
   **Fix:** Implement overwrite as an atomic replace: create a unique temp file in the same parent directory, write/copy the full contents into it, flush/sync it, then rename/persist it over the destination only after the full write succeeds. Add tests that pre-create a destination and simulate a failing source/write path to verify the old object remains intact.

2. **File:** `folio-core/src/storage.rs:93-104`, `folio-core/src/storage.rs:131-136`  
   **Severity:** SUGGESTION  
   **Fixable:** YES  
   **What can go wrong:** A key like `books\\x.epub` passes validation, but on Unix-like systems `resolve()` treats it as a single filename containing a backslash, not as `books/x.epub`. `list("books/")` then will not return that object, and another backend may interpret the same key differently.  
   **Why:** `validate_key()` splits on both `/` and `\\`, but `resolve()` only splits on `/`. The module docs say keys use `/` as the separator, yet backslashes are accepted as if they were separators.  
   **Impact:** The storage abstraction is not backend-stable: the same accepted key can be stored under different logical paths depending on platform/backend, making listing, migration, and future remote storage behavior inconsistent.  
   **Fix:** Reject any `\\` in storage keys, or normalize backslashes to `/` before validation and resolution. Given the documented key scheme, rejecting backslashes is the cleaner contract.

---

## [Gemini — Reviewer] Round 1

LGTM: The new `Storage` trait and `LocalStorage` implementation are robust and well-tested, with strong defenses against path traversal.

No critical issues found. The implementation adheres to good practices for file system operations and security. The `validate_key` function and its application throughout the `LocalStorage` methods effectively prevent path traversal vulnerabilities. The test suite is comprehensive and covers essential functionality and edge cases.

---


## [Claude — Implementer] Round 1

NEEDS_FIX: Issue 2 is a real inconsistency in key handling; issue 1 is a legitimate atomicity concern worth addressing in this layer.

## Issue 1 — Non-atomic overwrites (Codex, SUGGESTION-bordering-BLOCKING)

**Agree, with a scope caveat.** The concern is real: `fs::write` truncates before writing and `fs::copy` overwrites in place, so a mid-write failure can leave a partial book/cover on disk while the DB still references the same key. Since the whole point of introducing `Storage` is to be the durable artifact layer (and to later back it with S3/remote stores where write semantics matter even more), getting atomicity right once here is better than patching callers later.

Fix I'd make:
- Introduce a small helper `write_atomic(dest: &Path, write: impl FnOnce(&mut File) -> io::Result<()>)` that creates a temp file in the same parent (e.g. via `tempfile::NamedTempFile::new_in(parent)`), writes, `sync_all()`, then `persist()` over `dest`.
- Use it in both `put` (write bytes into the temp) and `put_path` (`io::copy` from src into the temp).
- Add tests: pre-create a destination with known content, then (a) simulate write failure by passing a non-existent source to `put_path` and (b) verify the original bytes remain.

Caveat: the module docs claim "behavior identical to the pre-refactor code." Atomicity is a behavior *improvement*, not a regression — worth a one-line note in the module doc that overwrites are now atomic. Gemini missed this; I'm the deciding vote and I side with Codex.

## Issue 2 — Backslash inconsistency (Codex, SUGGESTION)

**Agree, clearly a real bug.** `validate_key` splits on `['/', '\\']` but `resolve()` only splits on `/`. So `books\x.epub` validates fine but on Unix is stored as a single filename containing a literal backslash, and `list("books/")` won't find it. The module doc says `/` is *the* separator, so the contract is clear — accepting `\` was a validation leak.

Fix I'd make: reject `\` outright in `validate_key` rather than treat it as a separator. Drop the `\\` branches from the absolute-path check and segment split; add an explicit check `if key.contains('\\') { return Err(...) }`. Update the test `validate_key_rejects_absolute` (the `\books\x` case still errors, just via the new rule) and the list-prefix check can drop its `\\` handling too. This matches the documented contract with one clean rule.

## Summary

Both issues fixable in a follow-up commit on this branch. Issue 2 is a straightforward contract tightening; issue 1 is the more meaningful change but fits cleanly behind a small `write_atomic` helper.

---


## [Codex — Reviewer] Round 2

LGTM: Claude accepted both reviewer concerns and proposed technically appropriate fixes.

No unresolved review concerns from my side. Claude did not dismiss the atomic overwrite risk; the proposed same-directory temp write plus `sync_all()` and atomic persist/rename addresses the corruption scenario. Claude also accepted the backslash key-contract issue and picked the right direction: reject `\` outright because the documented storage key separator is `/`.

The only nuance is wording: issue 1 should remain treated as required before merge if this storage layer is meant to preserve existing artifacts safely. But Claude’s reasoning and proposed fix are aligned with that, so there’s nothing further to dispute in the discussion-only review.

---

## [Gemini — Reviewer] Round 2

LGTM: Claude's reasoning addresses the concerns regarding atomic writes and key validation consistency.

---

