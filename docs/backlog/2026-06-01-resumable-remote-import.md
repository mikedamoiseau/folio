# Backlog: resumable / cheap re-import for large remote-folder imports

> Captured 2026-06-01. Not yet brainstormed or planned — this is a ready-to-use
> prompt + the investigation that backs it. Paste the prompt block into a fresh
> session when ready to pick this up.

## Prompt

```
Feature: resumable / cheap re-import for large folder imports from remote filesystems.

PROBLEM
Importing a big folder (thousands of books) from a remote/network mount. If it
stops partway (mount drops, crash, cancel), I want to resume without paying to
re-process everything.

CURRENT BEHAVIOR (already verified — don't re-investigate from scratch)
- Folder import runs in src-tauri/src/commands.rs: run_import_task (~line 4600)
  uses a worker pool over a queue of paths.
- Per-file errors do NOT abort the batch: on Err it logs warn + errors += 1 and
  continues (commands.rs ~4659). A true halt needs a hard failure (mount drop
  during scan/canonicalize, crash, kill, or user cancel via cancel_import).
- Dedup: import_book_inner (commands.rs ~593-620) SHA-256 hashes EVERY file
  (full read, 64KB chunks), then db::get_book_by_file_hash; if present returns
  Duplicate (skipped, counted). So re-running the same folder already skips
  done books = a de-facto resume.
- import_mode setting: "import" (copy into library) vs "link" (reference
  original path). Hash is computed in both modes.

THE GAP
Re-import is idempotent but EXPENSIVE on remote FS: dedup re-reads the full
bytes of every file (incl. already-imported ones) over the network just to
hash and discover it's a dup. No (path,size,mtime) fast-path, no path skip, no
import manifest/checkpoint. Resuming a 5000-book remote set re-streams all
5000 files.

WHAT I WANT
Brainstorm + design (use the brainstorming skill first, then a plan), then
implement. Two candidate directions — evaluate both, recommend one:
  1. Fast skip-before-hash: before hashing, check (canonical_path, size, mtime)
     against a lightweight index; skip unchanged files without reading bytes.
     Highest value for remote folders, low risk.
  2. Import manifest/checkpoint: persist processed paths per import session;
     resume only queues the remainder.
Consider correctness vs the existing hash-dedup (must not create duplicates or
miss content changes when a file is replaced in place), the link vs copy modes,
and what happens when the remote mount is unavailable at resume time.

Start by re-reading the import path in commands.rs to confirm the above still
holds, then brainstorm.
```

## Notes / open questions to weigh during brainstorming

- **Correctness vs hash-dedup:** a (path, size, mtime) fast-path can wrongly skip
  a file that was edited in place but kept the same size, or whose mtime didn't
  change. Decide whether the fast-path is a *skip* (assume unchanged) or just a
  *cheap pre-filter* that still hashes on mismatch. Hash stays the source of truth.
- **Link mode:** linked books reference the original remote path. If the mount is
  gone at resume time, even listing/scanning fails — surface a clear error rather
  than counting everything as failed.
- **Where to store the index/manifest:** new SQLite table vs reuse of `books`
  (path + size + mtime columns). Books already carry `file_hash`.
- **Scope:** option 1 alone likely covers the real pain (remote re-read cost).
  Option 2 adds complexity; only pursue if interrupted-scan resume (not just
  per-file skip) is actually needed.
