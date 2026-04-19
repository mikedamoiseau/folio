# PR Review: feat-folio-core-m4-enrichment
**Date:** 2026-04-19 19:41
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 108
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

LGTM: the module move preserves existing call sites through `src-tauri` re-exports and the workspace still compiles.

No blocking findings.

Verification performed:
- `cargo check -p folio-core` passed
- `cargo check` passed for the workspace

Residual risk: I reviewed this as a diff-focused change. I did not run the full CI suite (`cargo test`, `cargo clippy -- -D warnings`, frontend checks), so test-only regressions or lint issues outside compilation are not ruled out.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: The `ISBN_RE` regular expression is referenced but not defined or re-exported from `folio-core::isbn`.

**Detailed Findings:**

1.  **File and line number(s)**: `folio-core/src/enrichment.rs`, line 1: `use crate::isbn::ISBN_RE;` and the removed definition from lines 13-14.
    **What can go wrong**: The `enrichment.rs` module attempts to `use crate::isbn::ISBN_RE;` and previously used it internally for validation (`is_valid_isbn` function, though that part of the diff is truncated). With the removal of the local `ISBN_RE` definition, and the `ISBN_RE` not being found in `folio-core/src/isbn.rs`, the code will fail to compile.
    **Why the code is vulnerable to this**: The refactoring moved the `enrichment.rs` file into the `folio-core` crate. The intent was to centralize the `ISBN_RE` definition in `folio_core::isbn`. However, `ISBN_RE` was removed from `enrichment.rs` but not added or publicly re-exported from `folio-core/src/isbn.rs`, leading to an unresolved import.
    **Impact if it happens**: Compilation failure for the `folio-core` crate, specifically the `enrichment` module.
    **Fix recommendation**: Define `ISBN_RE` as a `pub static LazyLock<Regex>` within `folio-core/src/isbn.rs`, making it accessible to other modules within the `folio-core` crate that depend on it.

    ```rust
    // folio-core/src/isbn.rs
    // ... existing content ...
    use regex::Regex;
    use std::sync::LazyLock;

    pub static ISBN_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(97[89]\d{10}|\d{9}[\dXx])$").unwrap());
    // ... rest of the file ...
    ```

    **Severity**: BLOCKING
    **Fixable**: YES

---


## [Claude — Implementer] Round 1

LGTM: `ISBN_RE` is already defined as `pub static` in `folio-core/src/isbn.rs:11` and the workspace compiles cleanly.

## Analysis

**Gemini's finding (ISBN_RE missing): INVALID.**

Gemini is wrong. I verified directly:
- `folio-core/src/isbn.rs:11` already contains `pub static ISBN_RE: LazyLock<Regex> = ...`
- `cargo check -p folio-core` passes cleanly

The `use crate::isbn::ISBN_RE;` import in `folio-core/src/enrichment.rs:1` resolves correctly. Gemini appears to have assumed the definition wasn't added to `isbn.rs` based only on the diff, but the definition was added in an earlier milestone (M1 — the `isbn.rs` module already existed before M4 and already exported `ISBN_RE` as `pub`). The M4 diff only needed to switch the `use` site.

**Codex's finding: LGTM.** Agrees with my verification — pure module move, re-exports preserve `src-tauri` call sites, workspace compiles.

## Verdict

Siding with Codex. Gemini's blocking issue is based on a false premise — the symbol it claims is missing is already present and public. No fix needed.

---

