# PR Review: feat-folio-core-m3-parsers
**Date:** 2026-04-19 19:29
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 283
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

LGTM: no blocking issues found in this parser extraction diff

No actionable findings.

I checked the moved parser/page-cache modules against their remaining call sites and verified both crates compile:

- `cargo check -p folio-core`
- `cargo check -p folio`

The `src-tauri` compatibility re-exports cover the existing `crate::epub`, `crate::pdf`, `crate::cbz`, `crate::cbr`, and `crate::page_cache` call sites, and the new `folio_core::isbn::extract_isbn` preserves the previous extraction behavior from `enrichment.rs`.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Duplicated ISBN regex and validation logic violates "single source of truth" principle.

### Duplicated ISBN Regex and Validation Logic

*   **File**: `src-tauri/src/enrichment.rs`, `folio-core/src/isbn.rs`
*   **What** can go wrong:
    The regular expression for ISBN validation (`ISBN_RE`) is duplicated in `src-tauri/src/enrichment.rs` and `folio-core/src/isbn.rs`. Consequently, the `is_valid_isbn` function in `src-tauri/src/enrichment.rs` uses its local, duplicated `ISBN_RE`. This means that if the ISBN validation logic needs to be updated (e.g., to support new ISBN formats or correct a bug in the regex), developers would need to remember to update it in *two* distinct locations.
*   **Why** the code is vulnerable to this:
    The refactoring moved the `extract_isbn` function to `folio-core::isbn`, but it did not move the `ISBN_RE` static variable or the `is_valid_isbn` function from `enrichment.rs`. The comment in `folio-core/src/isbn.rs` explicitly states that the regex and extractor should reside there to serve as a "single source of truth," a principle currently violated by the presence of a separate `ISBN_RE` and validation function in `src-tauri/src/enrichment.rs`.
*   **Impact** if it happens:
    1.  **Maintenance Overhead**: Any future changes to the ISBN validation logic will incur increased maintenance effort, as modifications must be applied consistently across multiple files. This significantly raises the risk of errors, inconsistencies, or omissions during updates.
    2.  **Inconsistent Behavior**: Over time, it is highly probable that `src-tauri/src/enrichment.rs::is_valid_isbn` and `folio_core::isbn::extract_isbn` could diverge in their behavior if their underlying regexes or cleaning logic are not updated simultaneously and identically. This inconsistency can lead to subtle bugs where ISBNs are validated differently depending on which module performs the check.
*   **Fix** recommendation:
    1.  Remove the `ISBN_RE` static variable from `src-tauri/src/enrichment.rs`.
    2.  Make the `ISBN_RE` in `folio-core/src/isbn.rs` publicly accessible by changing its declaration to `pub static ISBN_RE: LazyLock<Regex> = ...`.
    3.  Update the `is_valid_isbn` function in `src-tauri/src/enrichment.rs` to utilize `folio_core::isbn::ISBN_RE` for its validation.
    4.  **Alternatively and preferably**, move the `is_valid_isbn` function into `folio-core::isbn` alongside `extract_isbn`. Then, `src-tauri/src/enrichment.rs` can `pub use folio_core::isbn::is_valid_isbn;` similar to how `extract_isbn` is handled. This centralizes all ISBN-related logic in one module within `folio-core`.
*   **Severity**: BLOCKING
*   **Fixable**: YES

---


## [Claude — Implementer] Round 1

LGTM: Gemini's duplication concern is technically valid but out of scope for M3 — the enrichment module is explicitly slated for M4.

## Analysis

### Gemini's duplication finding — disagree (scope)

Gemini is factually right that `ISBN_RE` still exists in `src-tauri/src/enrichment.rs:13` alongside `is_valid_isbn` at line 101, while `extract_isbn` now delegates to `folio_core::isbn`. But this is deliberate:

1. **The isbn.rs doc comment says so explicitly**: "enrichment module (currently in the desktop crate, scheduled for core in #63 M4)". The duplication is a known transitional state bounded by the next milestone.

2. **Scope discipline**: This PR is M3 (parsers + page_cache). `extract_isbn` had to move because `epub.rs` uses it. `is_valid_isbn` is consumed only by enrichment code still living in `src-tauri`. Moving it now would pull enrichment-adjacent logic into core ahead of M4's migration plan and violate the "surgical changes only" rule in CLAUDE.md.

3. **Risk is low and bounded**: The regex is 30 chars and both copies are byte-identical. M4 will collapse them when the whole enrichment module relocates — that's the right moment to unify, since the call sites also move.

Gemini's "alternatively and preferably" fix (move `is_valid_isbn` to core) is the right end-state but belongs in M4, not M3.

### Codex — agree

Parser relocations preserve behavior, re-exports in `src-tauri/src/lib.rs` keep call sites compiling, and the `#[macro_export]` + `pub use page_dbg` change correctly surfaces the macro across the crate boundary.

**Verdict**: LGTM. Ship M3; the ISBN consolidation lands naturally in M4.

---

