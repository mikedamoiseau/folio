# PR Review: feat-folio-core-storage-m2-book-files
**Date:** 2026-04-20 09:03
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 170
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: `remove_book` can return an error after it has already deleted the database row, leaving a partial deletion state.

**Finding 1**

- **File**: [src-tauri/src/commands.rs](/Users/mike/Documents/www/folio/src-tauri/src/commands.rs:804), [src-tauri/src/commands.rs](/Users/mike/Documents/www/folio/src-tauri/src/commands.rs:827)
- **Severity**: BLOCKING
- **Fixable**: YES
- **What can go wrong**: If `active_storage()` fails after `db::delete_book()` succeeds, the command returns `Err` even though the book row is already gone. For example, if the configured `library_folder` has become invalid, is now a regular file, or cannot be created due to permissions, `LocalStorage::new()` fails during cleanup. The caller sees a failed delete, but retrying cannot find the book anymore, and the imported file may remain orphaned on disk.
- **Why vulnerable**: The code deletes the DB row at line 804, then uses fallible `?` cleanup setup at line 827. `active_storage()` constructs `LocalStorage`, whose constructor calls `create_dir_all` and can fail before file deletion is attempted.
- **Impact**: Partial failure state: metadata is deleted, activity may already be logged, cache may be evicted, but file cleanup is skipped and the API reports failure. This violates the expected delete contract and makes recovery ambiguous for the UI/user.
- **Fix**: Do not perform fallible cleanup initialization after the DB mutation. Either resolve `storage` and `library_folder` before `db::delete_book()`, or treat post-delete storage setup failures like the old file deletion failures: log them and still return `Ok(())` once the database delete has succeeded. A concrete shape:

```rust
let cleanup = if is_imported {
    file_path
        .as_ref()
        .map(|path| {
            let library_folder = state.active_library_folder();
            let storage = state.active_storage();
            (path.clone(), library_folder, storage)
        })
} else {
    None
};

// then delete/log transactionally as appropriate

// after db::delete_book succeeds, cleanup best-effort only; no `?`
```

Better still, compute `library_folder` once and build `LocalStorage` from that same value before deleting the row, so the key derivation and storage root cannot diverge.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Potential for unexpected data loss when deleting books if the library folder path has changed.

### Detailed Findings

#### 1. Design Flaw: Ambiguous Deletion Behavior on Library Folder Change

*   **File** and **line number(s)**: `src-tauri/src/commands.rs`, lines 822-828
*   **What** can go wrong:
    When a user deletes an "imported" book, and the `library_folder` setting has been changed since that book was imported, the application might unintentionally delete the book file from its *original* absolute path on the filesystem, even if that path is now outside the currently configured `active_library_folder`.
*   **Why** the code is vulnerable to this:
    The `remove_book` function first checks `is_imported`. If true, it attempts to derive a storage key using `book_key_from_path(&path, &library_folder)`. This function returns `None` if `path` (the absolute path from the database) is not prefixed by the *current* `library_folder`. In such a case, the code falls back to `std::fs::remove_file(&path)`, directly deleting the file at its absolute, potentially "old" or external location. While the previous implementation had similar behavior, the introduction of the `Storage` trait, which is rooted in the `active_library_folder`, highlights this fallback as a potential design oversight. The `Storage` trait is intended to manage files within its defined scope, but the fallback reaches outside that scope to delete files that are no longer "managed" by the active storage instance.
*   **Impact** if it happens:
    This can lead to unexpected data loss. Users might change their library folder, forget about previous imports, and then delete a book, unknowingly deleting a file from a location they might not expect or intend the application to manage globally. This violates the principle of least surprise and can lead to frustration.
*   **Fix** recommendation:
    The application needs a clear policy for handling "imported" files whose `file_path` in the database no longer falls under the `active_library_folder`.
    1.  **Option 1 (Recommended): Explicit User Confirmation.** If `is_imported` is true, but `book_key_from_path` returns `None`, the application should *not* proceed with `std::fs::remove_file`. Instead, it should inform the user (e.g., via a dialog) that the file is located outside the current library folder and ask for explicit confirmation before deleting it.
    2.  **Option 2 (Less disruptive, but less safe): Forget, Don't Delete.** If `is_imported` is true, but `book_key_from_path` returns `None`, the application should *only* remove the book's entry from the database, effectively "forgetting" about it, but leaving the physical file untouched on the filesystem. This prevents data loss but might leave orphaned files.
    3.  **Option 3 (Requires migration): Data Migration.** During a `library_folder` change, explicitly migrate (move) all imported files from the old location to the new one, updating their `file_path` in the database. This would ensure `book_key_from_path` always works for imported books.
    For the immediate diff, if no user interaction or migration is desired, the `else` block containing `std::fs::remove_file(&path)` should be removed. If a file is truly "managed" by the storage, it should be deleted via the storage. If it's outside the active storage's purview, the application should not assume it has global deletion rights, even for previously imported files.
*   **Severity**: BLOCKING
*   **Fixable**: NO (Requires a design decision and potentially user interaction logic or a migration strategy).

---


## [Claude — Implementer] Round 1

NEEDS_FIX: Codex's partial-delete-state bug is real; Gemini's design concern is a pre-existing behavior out of scope for M2.

## Codex — AGREE (blocking)

Confirmed at `src-tauri/src/commands.rs:804` vs `:827-828`:

```rust
db::delete_book(&conn, &book_id)?;           // line 804: DB row gone
...
let storage = state.active_storage()?;        // line 827: fallible after DB delete
let library_folder = state.active_library_folder()?;  // line 828: also fallible
```

If `active_storage()` fails (e.g., `library_folder` setting now points to a regular file, permissions error in `create_dir_all`), the command returns `Err` even though the book row and activity log are already committed. Retry from the UI fails because the book no longer exists, and the physical file is orphaned.

**Fix I'd make:** Resolve `library_folder` and `storage` *before* `db::delete_book()`, and downgrade any cleanup failures to `eprintln!` warnings (matching the existing pattern for `storage.delete` / `remove_file` errors):

```rust
let cleanup = if is_imported {
    match (state.active_library_folder(), state.active_storage()) {
        (Ok(folder), Ok(storage)) => Some((folder, storage)),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("Warning: could not resolve library storage for delete: {}", e);
            None
        }
    }
} else {
    None
};

db::delete_book(&conn, &book_id)?;
// ... then use `cleanup` best-effort, no `?`
```

## Gemini — DISAGREE (out of scope)

Gemini acknowledges "the previous implementation had similar behavior" — the pre-M2 code did `std::fs::remove_file(&path)` unconditionally for imported books. M2's charter is routing I/O through the `Storage` trait, not redesigning deletion semantics for stale paths. The fallback branch is explicitly documented as preserving pre-refactor behavior, and Gemini itself marks this `Fixable: NO` requiring user-confirmation UI, a migration, or a policy decision.

That design question belongs in its own issue (likely tied to M4's `file_path` → storage key migration). Not a blocker for this PR. Deciding vote: do not fix here.

## Summary

One confirmed blocker (Codex), fix by reordering the storage resolution before `db::delete_book` and making cleanup non-fallible.

---


## [Codex — Reviewer] Round 2

LGTM: Claude correctly accepts the real blocker and rejects the stale-path concern as out of scope for this PR.

Claude’s reasoning addresses the reviewers’ concerns:

- The partial-delete-state issue remains a valid blocker for the code, and Claude did not dispute it. The proposed direction is technically sound: resolve storage before the DB delete, and keep post-delete file cleanup best-effort so the command cannot report failure after the row is already gone.
- Gemini’s concern is reasonably dropped for this review round. It describes a pre-existing deletion policy rather than a regression introduced by this storage refactor, and fixing it would require a product/design decision around stale imported paths, folder migration, or user confirmation.

No additional unresolved review findings from Claude’s response.

---

## [Gemini — Reviewer] Round 2

LGTM: Claude's reasoning addresses the blocking issue and appropriately defers the out-of-scope design concern.

---

