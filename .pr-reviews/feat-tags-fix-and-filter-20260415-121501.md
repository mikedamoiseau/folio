# PR Review: feat-tags-fix-and-filter
**Date:** 2026-04-15 12:15
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 678
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: tag-save failures are silently dropped, and a persisted tag filter can blank the library with no way to clear it after tag-load failure

1. **File**: [src/components/EditBookDialog.tsx](/Users/mike/Documents/www/folio/src/components/EditBookDialog.tsx:107)  
   **Line number(s)**: 107-124, 136-155  
   **What** can go wrong: if adding one of the pending tags fails during save, the dialog still proceeds to `update_book_metadata()`, closes, and reports success. The user can leave the dialog believing all typed tags were saved when some or all were not.  
   **Why** the code is vulnerable to this: `handleAddTag()` catches every failure and ignores it. `handleSave()` awaits `handleAddTag(tagInput)`, but because errors are swallowed, it cannot detect tag-save failure and continues with `update_book_metadata()` and `onSaved()`.  
   **Impact** if it happens: silent data loss / partial writes. A user typing multiple tags before clicking Save can lose tags without any error or retry path.  
   **Fix** recommendation: make `handleAddTag()` return failure to the caller instead of swallowing it. In `handleSave()`, abort the metadata save if any tag addition fails, surface an error toast/message, and keep the dialog open. If partial success is possible, report exactly which tags failed.  
   **Severity**: BLOCKING  
   **Fixable**: YES

2. **File**: [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:63), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:152), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:429), [src/components/TagFilter.tsx](/Users/mike/Documents/www/folio/src/components/TagFilter.tsx:16)  
   **Line number(s)**: `Library.tsx` 63-78, 152-167, 429-433; `TagFilter.tsx` 16-21 and implicit `if (allTags.length === 0) return null` block  
   **What** can go wrong: if the user has a saved tag filter in localStorage and tag loading later fails, the library view can become empty and the tag filter UI disappears, leaving no in-app way to clear the active filter.  
   **Why** the code is vulnerable to this: `filterTagIds` is restored from localStorage on startup. On tag-load failure, the catch block does nothing, so `allTags` stays `[]` and `bookTagMap` stays empty. The book filter then rejects every book when `filterTagIds.length > 0` because no book has tags in the empty map. At the same time, `TagFilter` returns `null` when `allTags.length === 0`, so the control needed to clear the filter is hidden.  
   **Impact** if it happens: the library can look completely empty after a transient IPC/DB failure, which is effectively a lockout from the main screen until the user manually clears localStorage.  
   **Fix** recommendation: on tag-load failure, clear `filterTagIds` or disable tag-based filtering for that render and show an error. Also keep a visible “clear filters” path even when tags failed to load. More defensively, validate restored tag IDs against the fetched tag set and drop unknown IDs.  
   **Severity**: BLOCKING  
   **Fixable**: YES

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

All 293 Rust tests pass too. Here's the summary:

---

## Verdict

Both issues from Codex are valid. I agree with both and have applied fixes.

### Issue 1: Silent tag-save failures in EditBookDialog

**Fix applied:** Changed `handleAddTag` to return `Promise<boolean>` — `true` on success, `false` on failure (with the error surfaced via `setError`). In `handleSave`, the return value is checked: if tag saving fails, the save is aborted, the error is shown, and the dialog stays open. The inline callers (onChange, onKeyDown) are unaffected — they fire-and-forget, and errors now display in the dialog's error UI instead of being swallowed.

### Issue 2: Persisted tag filter blanks library after tag-load failure

**Fix applied:** In the tag-load `catch` block, `setFilterTagIds([])` clears the active tag filter. This prevents the scenario where persisted tag IDs in localStorage cause every book to be filtered out when the tag data fails to load, which would leave the user with an empty library and no visible control to clear the filter.

---

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Silent tag-save failures in EditBookDialog | Codex | **Fixed** | Agree — `handleAddTag` now returns success/failure; `handleSave` aborts and shows error on tag failure |
| Persisted tag filter blanks library on tag-load failure | Codex | **Fixed** | Agree — tag-load catch block now clears `filterTagIds` to prevent empty-library lockout |

---

