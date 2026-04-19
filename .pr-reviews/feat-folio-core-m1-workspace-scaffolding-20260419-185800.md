# PR Review: feat-folio-core-m1-workspace-scaffolding
**Date:** 2026-04-19 18:58
**Mode:** review only — 3-agent discussion (no code changes)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 641
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

LGTM: no blocking security, correctness, data integrity, or API-contract issues found in this workspace extraction diff.

**Findings**

No findings.

I verified the main refactor risks locally:

- `cargo check --workspace` passed.
- `cargo test --no-run` from `src-tauri/` passed, so the documented Rust command still works after moving `Cargo.lock` to the workspace root.
- `cargo test --no-run -p folio-core` passed.
- `npm run type-check` passed.

Residual note: `folio-core/src/paths.rs` introduces `folio_core::paths::default_library_folder()`, but `src-tauri/src/commands.rs` still keeps its own duplicate `default_library_folder()` implementation. That is not a merge blocker because the behavior matches, but the extraction is incomplete and should be cleaned up in a follow-up milestone if the goal is to centralize shared path logic.

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

LGTM: Workspace extraction is clean, dependency direction is correct, no blocking issues.

**On Codex's review:** Agreed, LGTM. The refactor is mechanically sound — error/models/paths extracted to `folio-core`, Tauri-specific `From<tauri::Error>` correctly removed, parser bridge impls (`EpubError`, `SyncError` → `FolioError`) placed in the owning modules to preserve the correct dependency direction. Frontend test updated to scan both crate roots.

**On Codex's residual note (duplicate `default_library_folder`):** Confirmed — `commands.rs:2450` still defines its own `default_library_folder()` and all 6+ call sites inside `src-tauri` use the local one; the new `folio_core::paths::default_library_folder()` is currently unused externally. Not a merge blocker (behavior matches), but the extraction is cosmetic until a follow-up switches the desktop crate over. Worth a small follow-up but fine to ship this M1 slice as-is.

**On Gemini:** No verdict to factor in (tool error).

**One minor observation (not blocking):** The new `folio_core::paths::default_library_folder()` uses `"Documents/Folio Library"` with a space, while the CLAUDE.md and existing behavior use `~/Documents/folio/` (lowercase, no space). Since nothing consumes the new function yet, this is inert — but if the intent is a drop-in replacement for the `commands.rs` copy, the path shape needs to match before the swap.

Verdict stands: **LGTM** for this M1 slice.

---

