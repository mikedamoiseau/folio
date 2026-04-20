# PR Review: feat-folio-core-storage-m3-covers
**Date:** 2026-04-20 09:24
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 630
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: backup restore silently drops supported `.jpeg`/`.svg` covers and can leave restored books pointing at stale cover paths.

**Finding 1**

- **File**: [src-tauri/src/commands.rs](/Users/mike/Documents/www/folio/src-tauri/src/commands.rs:2962), [src-tauri/src/commands.rs](/Users/mike/Documents/www/folio/src-tauri/src/commands.rs:2964), [folio-core/src/epub.rs](/Users/mike/Documents/www/folio/folio-core/src/epub.rs:550)
- **Severity**: BLOCKING
- **Fixable**: YES
- **What can go wrong**: Import an EPUB whose cover href ends in `.jpeg` or `.svg`. The new EPUB extraction path preserves that sanitized extension, so the app stores `covers/<book_id>/cover.jpeg` or `cover.svg`. `export_library` then writes that same extension into the backup zip. During restore, `import_library_backup` only searches for `jpg`, `png`, `webp`, and `gif`, so it never extracts the cover. Worse, `cover_path` starts as `book.cover_path.clone()`, so the restored row can keep an absolute path from the source installation that does not exist on the target machine.
- **Why the code is vulnerable**: The supported extension set is inconsistent. `sanitize_cover_ext` accepts `jpeg` and `svg`, and `export_library` derives the archive extension from the actual stored cover path, but restore has a hard-coded incomplete allow-list at line 2964.
- **Impact**: Full backups are not faithful for supported cover formats. Restored libraries can show missing covers and persist stale filesystem paths in the database.
- **Fix**: Use one shared cover-extension allow-list for extraction/export/restore, including at least `jpeg` and `svg`, or derive the restore candidate from the archived entries under `covers/{book.id}/cover.*` after validating the final extension. Also initialize restored `cover_path` to `None` and set it only after successfully materializing a cover in the current app data directory. 

Checked: `cargo check` in `src-tauri/` passes, so this is a behavioral restore bug rather than a compile break.

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

LGTM: M3 storage-routing goal is met correctly; the restore allow-list and stale `cover_path` issues Codex flagged are real but pre-existing and outside M3's scope.

## Analysis of Codex's finding

Codex identified two sub-issues in `import_library_backup`:

**1. Allow-list mismatch (`.jpeg`/`.svg` covers not restored)** — **Valid bug, but pre-existing.**

Verified:
- `folio-core/src/epub.rs:550` — `sanitize_cover_ext` accepts `jpg`, `jpeg`, `png`, `gif`, `webp`, `svg`.
- `src-tauri/src/commands.rs:2964` — restore loop: `["jpg", "png", "webp", "gif"]`.

The inconsistency existed before this PR. Looking at the diff, the `sanitize_cover_ext` function wasn't touched in M3, and the restore allow-list (`["jpg", "png", "webp", "gif"]`) was already hard-coded identically before M3 — this PR only swapped `fs::write` → `storage.put`. Codex's framing ("the new EPUB extraction path preserves that sanitized extension") is slightly misleading: the old path did the same via the same `sanitize_cover_ext`.

**2. Stale `cover_path` persists on restore** — **Valid bug, but pre-existing.**

`let mut cover_path = book.cover_path.clone();` at `commands.rs:2962` is unchanged by this PR (same line, same semantics). If the restore loop doesn't match an entry, the DB row keeps a source-machine absolute path.

## Verdict

Both sub-issues are real and worth fixing — but neither was introduced by this PR. M3's stated scope ("route cover images through Storage trait") is delivered cleanly: the writes, the cleanup on error (via new `delete_book_covers`), and the tests all look correct. The `covers_storage()` helper, the `ExtractedCover` decoupling, and the `cover_saved` error-cleanup tracking are well-structured.

Per CLAUDE.md's "Surgical changes only" rule, expanding this PR to fix restore semantics would be scope creep. I'd recommend opening a follow-up issue for:
- Unify the cover-extension allow-list across extract/export/restore (include `jpeg`, `svg`).
- Initialize `cover_path = None` on restore and set it only after successful materialization.

Minor nit (non-blocking, not raised): `covers_storage()` is called inside the per-book loop in `import_library_backup` (line 2963) — hoisting it above the loop would be marginally tidier, but it's cheap and matches the existing per-iteration pattern for other state.

With Gemini erroring out, my deciding vote breaks the tie toward LGTM for this PR on the understanding that the flagged bugs get a follow-up ticket before users exercise backup/restore with `.jpeg`/`.svg` covers.

---


## [Codex — Reviewer] Round 2

LGTM: Claude correctly shows the flagged restore issues are real but not introduced by this storage-routing PR.

Claude’s pushback is technically sound: the `.jpeg` / `.svg` restore allow-list mismatch and stale restored `cover_path` both existed before this diff. This PR changes the persistence mechanism from direct filesystem writes to `Storage`, but it does not newly create the backup/restore extension mismatch or the stale-path behavior.

I would not keep that as a blocking finding for this PR. A follow-up issue is still warranted because the restore behavior is user-visible data fidelity breakage, but it should not block this narrowly scoped M3 storage-routing change unless the project’s policy is to block on nearby pre-existing defects.

---

## [Gemini — Reviewer] Round 2

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 2

LGTM: Codex now agrees the flagged restore issues are pre-existing; M3 storage-routing goal is delivered cleanly and Gemini erred out both rounds.

## Vote tally

- **Codex Round 2**: LGTM — accepts the pre-existing-bug argument, agrees it shouldn't block M3.
- **Gemini**: erred out both rounds, no vote cast.
- **My vote**: LGTM.

With Codex converting to LGTM in Round 2 and Gemini absent, there is no remaining blocking finding on this PR.

## Standing analysis (unchanged from Round 1)

The two sub-issues Codex originally flagged (`.jpeg`/`.svg` restore allow-list mismatch at `commands.rs:2964`, and stale `cover_path` carryover at `commands.rs:2962`) are real user-visible backup-fidelity bugs, but both predate this diff. M3 only swapped `fs::write` → `storage.put` at those sites; the hard-coded allow-list and the `book.cover_path.clone()` initializer are unchanged semantics.

Per CLAUDE.md's "Surgical changes only" rule, fixing them here would be scope creep. They deserve a follow-up ticket:

- Unify the cover-extension allow-list across `sanitize_cover_ext` / `export_library` / `import_library_backup` (include `jpeg` and `svg`).
- Initialize restored `cover_path = None` and set it only after successful materialization on the current machine.

The M3 implementation itself — `covers_storage()` helper, `ExtractedCover` decoupling in `folio-core/src/epub.rs`, `cover_saved` tracking for error-path cleanup, the new `delete_book_covers` helper, and the expanded test coverage — is clean and meets the stated milestone scope.

---

