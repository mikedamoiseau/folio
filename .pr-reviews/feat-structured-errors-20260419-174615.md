# PR Review: feat-structured-errors
**Date:** 2026-04-19 17:46
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 6417
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: the patch fails `npm run type-check` because the new test file contains unused `@ts-expect-error` directives.

**Finding 1**

- **File**: `src/lib/errors.sync.test.ts:1` and `src/lib/errors.sync.test.ts:3`
- **What**: `npm run type-check` fails with `TS2578: Unused '@ts-expect-error' directive.`
- **Why**: The comments claim the Node imports are expected to error, but TypeScript is resolving them cleanly in this project. `@ts-expect-error` is itself an error when no diagnostic is produced.
- **Impact**: This cannot merge as-is if the documented CI/pre-push checks are enforced; frontend type checking fails before tests run.
- **Fix**: Remove both `@ts-expect-error` comments. If the intent is to document why Node imports are used in Vitest, replace them with normal comments.
- **Severity**: BLOCKING
- **Fixable**: YES

**Finding 2**

- **File**: `src/screens/Reader.tsx:112-115`; related backend mapping at `src-tauri/src/error.rs:298-303`
- **What**: The reader now treats any structured `NotFound` error as “the book file is missing.” A corrupt EPUB that is missing an internal chapter/resource can produce `EpubError::MissingFile`, which is converted to `FolioError::NotFound`; the reader will then show the missing-file recovery dialog even though the source `.epub` still exists.
- **Why**: `isFileNotFound()` checks `kind === "NotFound"` broadly, but `NotFound` is now used for many missing entities, including missing archive entries, missing profile/config data, missing pages, and missing files.
- **Impact**: Users get the wrong recovery path for malformed EPUBs or missing internal resources. They may waste time reconnecting drives or cleaning up a library entry when the real issue is a corrupt/invalid book archive.
- **Fix**: Narrow the reader check to the specific file-missing message, or add a more specific backend kind/code for missing local book files. For example, keep `isFileNotFound()` message-based for `"Book file not found"` and do not treat all `NotFound` errors as local-file loss.
- **Severity**: SUGGESTION
- **Fixable**: YES

Verification run:
- `npm run type-check` fails with the unused `@ts-expect-error` diagnostics above.
- `cargo check` passes.

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

Both fixes verified. Tests pass.

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Unused `@ts-expect-error` directives in `errors.sync.test.ts` fail type-check | Codex | Fixed — replaced with a normal comment | Confirmed via `npm run type-check`; blocks CI/pre-push hook |
| `isFileNotFound()` treats any `NotFound` as file-missing, triggering wrong recovery dialog for corrupt EPUBs / missing pages / missing profiles | Codex | Fixed — narrowed the check to the specific `"book file not found"` message | Real bug: `NotFound` is used broadly across the backend (EPUB internal entries, comic pages, profiles, settings). Narrowing to the message keeps the recovery dialog scoped to on-disk book files |
| Gemini error | Gemini | N/A | Reviewer failed to produce findings this round |

Verification: `npm run type-check` clean, all 176 frontend tests pass, all Rust error-module tests pass.

---

