# PR Review: fix-review-team-critical-findings
**Date:** 2026-04-13 13:07
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 162
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: Closing the detail modal while `get_book` is still in flight can leave a blocking full-screen overlay over the library until the IPC call finishes.

1. **File**: [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:420), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:1244), [src/screens/Library.tsx](/Users/mike/Documents/www/folio/src/screens/Library.tsx:1253), [src/components/BookDetailModal.tsx](/Users/mike/Documents/www/folio/src/components/BookDetailModal.tsx:45)
   **What** can go wrong: If the user opens book details and then dismisses the modal before `invoke("get_book")` resolves, the modal closes but the new loading overlay immediately becomes visible and intercepts the whole UI. The library stays blocked until the backend call returns.
   **Why** the code is vulnerable to this: `handleShowBookDetail()` sets `detailLoading=true` before the async fetch starts, but `onClose` only clears `detailBook` and does not cancel/invalidate the request or clear `detailLoading`. The overlay renders whenever `detailLoading && !detailBook`, so closing the modal during an in-flight request guarantees the blocking overlay appears.
   **Impact** if it happens: Users can temporarily lose control of the library UI on every slow detail fetch, especially on large libraries or slower disks. This is a real interaction regression, not just a cosmetic flash.
   **Fix** recommendation: On close, invalidate the in-flight request and clear loading state, for example by setting `latestDetailRequestRef.current = null; setDetailLoading(false); setDetailBook(null);`. Alternatively, clear `detailLoading` whenever the modal is dismissed and only show the overlay for the initial open path.
   **Severity**: BLOCKING
   **Fixable**: YES

No other defensible blocking issues stood out in the Rust query split; the new `get_books_in_collection_grid` path matches the existing collection query behavior closely enough from the provided context.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Potential SQL injection in `db.rs` due to direct string formatting of dynamic query parts.

**File**: `src-tauri/src/db.rs`
**Line number(s)**: 1358-1361 (for manual collection), 1369-1373 (for rule-based collection)
**What** can go wrong: An attacker could craft specific collection rules or collection IDs (if `collection_id` were used in the `format!` strings, which it is not, but `joins` and `where_str` are) that manipulate the SQL query structure, leading to unauthorized data access, modification, or deletion. This is a classic SQL injection vulnerability.
**Why** the code is vulnerable to this: In `get_books_in_collection_grid`, the SQL query for rule-based collections uses `format!` to directly insert `joins` and `where_str` into the query string:
```rust
let sql = format!(
    "SELECT DISTINCT {cols}
     FROM books b
     {joins}
     {where_str}
     ORDER BY b.added_at DESC",
    cols = GRID_COLUMNS_B
);
```
While `param_values` are correctly parameterized for the `WHERE` clause values, the `joins` and `where_str` components themselves are string-interpolated. If the `build_rule_query` function (which constructs these strings) includes any unsanitized, user-controlled input, or if there's any way for a user to influence the structure of `joins` or `where_str` through collection rule definitions that don't enforce strict sanitization, this becomes an SQL injection vector. Even if `build_rule_query` is currently safe, this pattern is inherently fragile as a future change to rule parsing could introduce a vulnerability.
**Impact** if it happens: High. Complete compromise of the database is possible, including exfiltration of all book data, user data (if stored in the same DB), or deletion of data.
**Fix** recommendation: Avoid constructing SQL query parts like `joins` and `where_str` by direct string concatenation or formatting if they can be influenced by user input. Instead, use a SQL query builder library that handles these complexities safely, or strictly validate and sanitize all components that are interpolated into the query string. Ideally, `build_rule_query` should return not just string fragments but also corresponding parameter values that can be passed to `rusqlite::params_from_iter`, and the query should be built in a way that allows `rusqlite` to handle all dynamic parts securely. If dynamic table/column names are truly needed, map them to a hardcoded allow-list.

Given the current code, at a minimum, ensure that `build_rule_query` is rigorously reviewed to guarantee that `joins` and `where_str` cannot contain any user-controlled characters that would alter the SQL structure. However, the best practice is to avoid dynamic SQL string generation in this manner.
**Severity**: BLOCKING
**Fixable**: NO (Requires design judgment to choose a safer SQL construction method or rigorous validation/sanitization logic in `build_rule_query`).

---


## [Claude — Implementer] Round 1

All green. Here's my analysis and summary:

---

## Issue 1 — Loading overlay blocks UI on modal close (Codex)

**Verdict: AGREE — fixed.**

Codex correctly identified that closing the `BookDetailModal` while `get_book` is in-flight leaves `detailLoading=true` with `detailBook=null`, causing the full-screen loading overlay to trap the UI. The `onClose` handler now invalidates the in-flight request ref, clears loading state, and clears the book — preventing the overlay from appearing after dismissal. The `finally` block in `handleShowBookDetail` is already guarded by `latestDetailRequestRef.current === id`, so setting the ref to `null` on close also prevents a stale response from resurrecting the modal.

## Issue 2 — SQL injection via `build_rule_query` (Gemini, Fixable: NO)

**Verdict: DISAGREE — push back. Not fixing.**

This is a false positive. `build_rule_query` uses a closed `match` on `(rule.field, rule.operator)` where:

- **Every SQL structural component** (table names, column names, JOIN clauses, aliases) comes from hardcoded string literals and monotonic counters (`bt1`, `rp1`, etc.). No user input flows into SQL structure.
- **All user-controlled values** (`rule.value`) are placed into `param_values` and bound via `rusqlite::params_from_iter` — standard parameterized queries.
- **Unrecognized field/operator pairs** fall through the match silently — there's no catch-all that could inject arbitrary SQL.

The new `get_books_in_collection_grid` is a direct mirror of the existing `get_books_in_collection` (lines 1313–1342) which uses the identical pattern. This is not fragile — it's a well-bounded allowlist pattern. A query builder library would add a dependency for no practical safety gain here.

Additionally, Gemini marked this as **Fixable: NO** (requires design judgment), so per the review protocol I'm acknowledging it but not attempting a code change.

---

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Loading overlay blocks UI on modal close | Codex | **Fixed** | Real bug — `onClose` didn't clear `detailLoading` or invalidate in-flight request, trapping the UI |
| SQL injection via `build_rule_query` | Gemini | **Push back** | False positive — `build_rule_query` uses a closed match with hardcoded SQL structure; all user values are parameterized. Also marked Fixable: NO |

---


## [Codex — Reviewer] Round 2

LGTM: the modal-close loading race is fixed, and the remaining SQL injection concern is not supported by the current `build_rule_query` implementation.

No remaining defensible findings in the patched code from the provided diff. The `Library.tsx` close handler now clears `detailLoading` and invalidates the in-flight detail request, so the blocking overlay no longer persists after dismissing the modal. I also accept the pushback on the SQL issue: in [src-tauri/src/db.rs](/Users/mike/Documents/www/folio/src-tauri/src/db.rs:1382), the dynamic SQL structure comes from a closed allowlist of hardcoded fragments, while user-controlled values are still bound through parameters.

I also verified the `react-window` API concern against the installed `react-window` 2.2.7 types; `cellComponent`, `cellProps`, and `ariaAttributes` are valid for this repo’s version, so that earlier objection does not hold here. `npm run type-check` passes on the current state.

---

## [Gemini — Reviewer] Round 2

LGTM: All blocking issues from previous rounds have been addressed or successfully mitigated.

---

