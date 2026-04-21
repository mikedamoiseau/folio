# PR Review: feat-folio-core-storage-m5-page-cache
**Date:** 2026-04-21 23:24
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 808
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

LGTM: I did not find a defensible blocking regression in the page-cache Storage refactor.

Detailed findings: none.

I checked the changed cache key construction against `LocalStorage`’s key validation and listing behavior. The new keys still map to the same physical layout under `{app_cache_dir}/page-cache/{book_hash}/...`, and the deletion/listing paths operate on storage keys rather than raw filesystem paths. I also did not find a new path traversal issue from archive entry names because cached page filenames are regenerated as numeric names plus an extracted image extension, and `Storage` rejects traversal segments in manifest-derived page keys.

---

## [Gemini — Reviewer] Round 1

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 1

Both reviewers effectively produced no actionable findings:
- Codex: LGTM with specific verification notes (key construction, path traversal, storage-level deletion semantics).
- Gemini: errored out, no findings.

I did my own spot-check of the diff:

- `CACHE_PREFIX` and `book_prefix(hash)` both end with `/`, so `list()` calls scope correctly to their intended subtrees.
- `collect_cached_books` using a `HashSet` to dedupe hashes across all cache keys is correct — previously the filesystem walker gave one entry per directory; now multiple keys per book collapse to one manifest read.
- `evict_book` via list+delete replaces `remove_dir_all`, which matches the Storage trait's key-based contract.
- `ensure_cached` still regenerates numeric page filenames with extracted extensions (`{:03}{ext}`), so archive-entry path traversal cannot leak into storage keys — Codex verified this too.
- The `page_cache_storage(&app)?` call is invoked twice in `prepare_comic` (once for the main op, once for the eviction task). Constructing a second `LocalStorage` is cheap — it's just a rooted path wrapper — and avoids sharing a non-`Send` value across the `spawn_blocking` boundary. Not a defect.
- Tests now cover the new `list`-based enumeration (`collect_cached_books_groups_keys_by_hash`), selective eviction (`evict_book_removes_only_that_books_keys`), and the last-accessed bump path.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM; Gemini errored; own review found nothing to fix |

---


## [Codex — Reviewer] Round 2

LGTM: I did not find any remaining defensible blocking issue in the current page-cache Storage refactor.

Detailed findings: none.

I rechecked the current code against `Storage` and `LocalStorage` behavior. The cache keys remain relative and validated, `list(CACHE_PREFIX)` returns normalized storage keys as expected, per-book eviction is scoped with `page-cache/{hash}/`, and `clear_cache` removes all listed cache artifacts under the page-cache prefix. I also did not find a concrete regression in the Tauri command wiring; the cache read path still falls back to direct archive reads on cache misses or cache storage failures.

---

## [Gemini — Reviewer] Round 2

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 2

Both reviewers produced no actionable findings this round:
- **Codex Round 2:** LGTM with explicit re-verification of key validation, `list()` scoping, per-book eviction, `clear_cache` coverage, and command-site fallback behavior.
- **Gemini Round 2:** errored out again, no findings.

My own Round 1 spot-check stands — I re-verified the key areas:
- `CACHE_PREFIX` / `book_prefix(hash)` trailing slashes correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books into one manifest entry.
- `evict_book` list+delete matches the Storage trait's key-based contract.
- Numeric page filenames (`{:03}{ext}`) prevent archive-entry path traversal from reaching storage keys.
- Constructing a second `LocalStorage` for the `spawn_blocking` eviction task is cheap (just a rooted path wrapper) and sidesteps any `Send` concerns — intentional, not a defect.
- New tests (`collect_cached_books_groups_keys_by_hash`, `evict_book_removes_only_that_books_keys`, `ensure_cached_hit_updates_last_accessed`) cover the `list`-based enumeration paths.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM (both rounds); Gemini errored (both rounds); own review found nothing |

---


## [Codex — Reviewer] Round 3

LGTM: I did not find any remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I rechecked the live code paths that matter for this diff: cache key construction, `LocalStorage::list()` prefix filtering, per-book eviction, full cache clearing, cache-read fallback in `get_comic_page`, and background eviction wiring in `prepare_comic`. The current implementation keeps page-cache operations scoped under `page-cache/{book_hash}/`, deletes only listed storage keys, and falls back to archive reads when cache lookup fails.

---

## [Gemini — Reviewer] Round 3

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 3

Both reviewers produced no actionable findings this round:
- **Codex Round 3:** LGTM with explicit re-verification of cache key construction, `LocalStorage::list()` prefix filtering, per-book eviction, full cache clearing, and command-site fallback behavior.
- **Gemini Round 3:** errored out again, no findings.

My Round 1/2 spot-checks stand — re-verified the same areas (trailing-slash prefix scoping, HashSet dedup, list+delete eviction, numeric filename regeneration blocking traversal, intentional second `LocalStorage` construction for `spawn_blocking`). Three consecutive rounds of LGTM from Codex with no new code changes since Round 1 — this is stable.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all three rounds; Gemini errored all three rounds; own review found nothing |

---


## [Codex — Reviewer] Round 4

LGTM: I found no remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I checked the changed `page_cache` paths against the actual `Storage` / `LocalStorage` behavior. The cache keys remain scoped under `page-cache/{book_hash}/`, `LocalStorage::list()` returns normalized keys and filters by prefix, `evict_book` and `clear_cache` delete only listed storage keys, and `get_comic_page` still falls back to direct archive reads if cache lookup fails. The Tauri command wiring is consistent with the refactor.

---

## [Gemini — Reviewer] Round 4

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 4

## [Claude — Implementer] Round 4

Both reviewers produced no actionable findings this round:
- **Codex Round 4:** LGTM with the same verification notes (cache key scoping, `LocalStorage::list()` prefix filtering, scoped `evict_book` / `clear_cache`, archive-read fallback in `get_comic_page`, consistent Tauri command wiring).
- **Gemini Round 4:** errored out again, no findings.

Four consecutive LGTM rounds from Codex with no code changes since the initial diff. My Round 1–3 spot-checks all stand:
- Trailing-slash `CACHE_PREFIX` / `book_prefix(hash)` correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books.
- `evict_book` list+delete matches the Storage trait contract.
- Numeric regenerated filenames (`{:03}{ext}`) block archive-entry path traversal.
- Second `LocalStorage` for `spawn_blocking` is a cheap rooted-path wrapper, intentional for `Send` safety.
- New tests cover list-based enumeration, selective eviction, and last-accessed bump.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all four rounds; Gemini errored all four rounds; own review found nothing |

---


## [Codex — Reviewer] Round 5

LGTM: I found no remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I rechecked the changed paths against the actual `Storage` / `LocalStorage` implementation. The page-cache keys stay under `page-cache/{book_hash}/`, `LocalStorage::list()` returns relative normalized keys and filters by prefix, and the refactored `get_cached_page`, `ensure_cached`, `run_eviction`, `get_cache_stats`, and `clear_cache` call sites are consistent with the storage contract. I did not find a concrete security, correctness, data integrity, or error-handling regression that is grounded in the supplied code.

---

## [Gemini — Reviewer] Round 5

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 5

Both reviewers again produced no actionable findings this round:
- **Codex Round 5:** LGTM — same verification notes (cache key scoping under `page-cache/{book_hash}/`, `LocalStorage::list()` prefix filtering, scoped `evict_book` / `clear_cache`, consistent command-site wiring).
- **Gemini Round 5:** errored out again, no findings.

Five consecutive LGTM rounds from Codex, Gemini errored every round, and no code changes since the initial diff. My Round 1–4 spot-checks stand — I re-verified the same areas (trailing-slash prefix scoping, HashSet dedup, list+delete eviction matching Storage contract, numeric regenerated filenames blocking archive-entry traversal, intentional second `LocalStorage` for `spawn_blocking`).

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all five rounds; Gemini errored all five rounds; own review found nothing |

---


## [Codex — Reviewer] Round 6

LGTM: I found no remaining concrete regression in the current page-cache Storage refactor.

Detailed findings: none.

I re-reviewed the current diff for security, correctness, data integrity, error handling, and API contract issues. The storage keys remain scoped under `page-cache/{book_hash}/`, per-book eviction and full-cache clearing operate through listed storage keys, manifest and page reads use the same key construction paths, and the Tauri command wiring is consistent with the refactor. I do not see a defensible issue that should block merge.

---

## [Gemini — Reviewer] Round 6

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 6

Both reviewers again produced no actionable findings this round:
- **Codex Round 6:** LGTM — same verification notes (storage keys scoped under `page-cache/{book_hash}/`, per-book eviction and full-cache clearing via listed storage keys, consistent manifest/page key construction, consistent Tauri command wiring).
- **Gemini Round 6:** errored out again, no findings.

Six consecutive LGTM rounds from Codex, Gemini errored every round, no code changes since the initial diff. My Round 1–5 spot-checks all stand:
- Trailing-slash `CACHE_PREFIX` / `book_prefix(hash)` correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books into one manifest entry.
- `evict_book` list+delete matches the Storage trait key-based contract.
- Numeric regenerated filenames (`{:03}{ext}`) block archive-entry path traversal.
- Second `LocalStorage` for `spawn_blocking` is a cheap rooted-path wrapper, intentional for `Send` safety.
- New tests cover list-based enumeration, selective eviction, and last-accessed bump.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all six rounds; Gemini errored all six rounds; own review found nothing |

---


## [Codex — Reviewer] Round 7

LGTM: I found no remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I checked the current files, not just the supplied diff. The page-cache keys are consistently generated under `page-cache/{book_hash}/`, `LocalStorage::list()` returns normalized relative keys and filters by prefix, and `evict_book` / `clear_cache` only delete keys returned by the storage layer. The Tauri command wiring also matches the refactor: cache reads fall back to archive reads on miss/failure, and `prepare_comic` uses the same storage root for extraction and eviction.

---

## [Gemini — Reviewer] Round 7

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 7

Both reviewers again produced no actionable findings this round:
- **Codex Round 7:** LGTM — same verification notes (page-cache keys scoped under `page-cache/{book_hash}/`, `LocalStorage::list()` normalized-key prefix filtering, scoped `evict_book`/`clear_cache`, consistent `get_comic_page` fallback and `prepare_comic` storage-root wiring).
- **Gemini Round 7:** errored out again, no findings.

Seven consecutive LGTM rounds from Codex, Gemini errored every round, no code changes since the initial diff. My Round 1–6 spot-checks all stand — trailing-slash prefix scoping, HashSet dedup, list+delete eviction matching the Storage contract, numeric regenerated filenames blocking traversal, intentional second `LocalStorage` for `spawn_blocking`, new tests covering list-based enumeration.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all seven rounds; Gemini errored all seven rounds; own review found nothing |

---


## [Codex — Reviewer] Round 8

LGTM: I found no remaining defensible blocking issue in the current page-cache Storage refactor.

Detailed findings: none.

I reviewed the current working tree, including `CLAUDE.md`, `folio-core/src/page_cache.rs`, `folio-core/src/storage.rs`, and the Tauri command wiring in `src-tauri/src/commands.rs`. The refactor consistently routes page-cache artifacts through `Storage`, keeps keys scoped under `page-cache/{book_hash}/`, relies on `LocalStorage` validation for traversal protection, and preserves cache-read fallback behavior for comic pages. I did not find a concrete security, correctness, data integrity, or error-handling regression that should block merge.

---

## [Gemini — Reviewer] Round 8

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 8

## [Claude — Implementer] Round 8

Both reviewers again produced no actionable findings this round:
- **Codex Round 8:** LGTM — same verification notes (Storage-routed page-cache artifacts, keys scoped under `page-cache/{book_hash}/`, `LocalStorage` traversal protection, preserved cache-read fallback for comic pages).
- **Gemini Round 8:** errored out again, no findings.

Eight consecutive LGTM rounds from Codex, Gemini errored every round, no code changes since the initial diff. My Round 1–7 spot-checks all stand:
- Trailing-slash `CACHE_PREFIX` / `book_prefix(hash)` correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books into one manifest entry.
- `evict_book` list+delete matches the Storage trait key-based contract.
- Numeric regenerated filenames (`{:03}{ext}`) block archive-entry path traversal.
- Second `LocalStorage` for `spawn_blocking` is a cheap rooted-path wrapper, intentional for `Send` safety.
- New tests cover list-based enumeration, selective eviction, and last-accessed bump.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all eight rounds; Gemini errored all eight rounds; own review found nothing |

---


## [Codex — Reviewer] Round 9

LGTM: I found no remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I reviewed the current files against the supplied diff and project conventions: `folio-core/src/page_cache.rs`, `folio-core/src/storage.rs`, and the command wiring in `src-tauri/src/commands.rs`. The cache keys stay scoped under `page-cache/{book_hash}/`, `LocalStorage` validates traversal-sensitive keys, `list()` returns normalized relative keys for prefix filtering, and `evict_book` / `clear_cache` only delete keys returned by the storage layer. The command paths preserve the cache-miss fallback to direct archive reads, and `prepare_comic` uses the same app cache root for extraction and background eviction.

I did not find a concrete security, correctness, data-integrity, error-handling, or API-contract regression that should block merge.

---

## [Gemini — Reviewer] Round 9

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 9

## [Claude — Implementer] Round 9

Both reviewers again produced no actionable findings this round:
- **Codex Round 9:** LGTM — same verification notes (cache keys scoped under `page-cache/{book_hash}/`, `LocalStorage` traversal validation, `list()` normalized-key prefix filtering, scoped `evict_book`/`clear_cache`, preserved archive-read fallback in `get_comic_page`, consistent `prepare_comic` storage-root wiring).
- **Gemini Round 9:** errored out again, no findings.

Nine consecutive LGTM rounds from Codex, Gemini errored every round, no code changes since the initial diff. My Round 1–8 spot-checks all stand:
- Trailing-slash `CACHE_PREFIX` / `book_prefix(hash)` correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books into one manifest entry.
- `evict_book` list+delete matches the Storage trait key-based contract.
- Numeric regenerated filenames (`{:03}{ext}`) block archive-entry path traversal.
- Second `LocalStorage` for `spawn_blocking` is a cheap rooted-path wrapper, intentional for `Send` safety.
- New tests cover list-based enumeration, selective eviction, and last-accessed bump.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all nine rounds; Gemini errored all nine rounds; own review found nothing |

---


## [Codex — Reviewer] Round 10

LGTM: I found no remaining defensible issue in the current page-cache Storage refactor.

Detailed findings: none.

I reviewed the live repository state against `CLAUDE.md`, including `folio-core/src/page_cache.rs`, `folio-core/src/storage.rs`, and the Tauri command wiring in `src-tauri/src/commands.rs`. The cache artifacts are consistently routed through `Storage`, keys remain scoped under `page-cache/{book_hash}/`, `LocalStorage` validates traversal-sensitive keys, list/delete operations are prefix-scoped, and comic page reads still fall back to direct archive access when the cache path misses or fails.

I did not find a concrete security, correctness, data integrity, error-handling, or API-contract regression that should block merge.

---

## [Gemini — Reviewer] Round 10

(Gemini encountered an error this round)

---


## [Claude — Implementer] Round 10

## [Claude — Implementer] Round 10

Both reviewers again produced no actionable findings this round:
- **Codex Round 10:** LGTM — same verification notes (Storage-routed page-cache artifacts, keys scoped under `page-cache/{book_hash}/`, `LocalStorage` traversal validation, prefix-scoped list/delete, preserved archive-read fallback in `get_comic_page`).
- **Gemini Round 10:** errored out again, no findings.

Ten consecutive LGTM rounds from Codex, Gemini errored every round, no code changes since the initial diff. My Round 1–9 spot-checks all stand:
- Trailing-slash `CACHE_PREFIX` / `book_prefix(hash)` correctly scope `list()` calls.
- `collect_cached_books` HashSet dedup correctly collapses multi-key books into one manifest entry.
- `evict_book` list+delete matches the Storage trait key-based contract.
- Numeric regenerated filenames (`{:03}{ext}`) block archive-entry path traversal.
- Second `LocalStorage` for `spawn_blocking` is a cheap rooted-path wrapper, intentional for `Send` safety.
- New tests cover list-based enumeration, selective eviction, and last-accessed bump.

No critical issues missed. **LGTM.**

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| (none) | — | — | Codex LGTM across all ten rounds; Gemini errored all ten rounds; own review found nothing |

---

