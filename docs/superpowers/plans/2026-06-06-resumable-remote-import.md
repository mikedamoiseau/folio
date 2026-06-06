# Fast Skip-Before-Hash Re-Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make re-importing a large remote folder cheap by skipping unchanged files on a `(source_path, size, mtime)` match — no byte read, no network re-stream — while the content hash stays the source of truth on every mismatch.

**Architecture:** Source tracking is **import-only metadata**, kept off the `Book` domain struct (per the chosen leaner approach). Three additive columns on `books` (`source_path`, `source_size`, `source_mtime`) + a non-unique index. A dedicated `db::set_book_source` UPDATE records them in the same insert transaction; a dedicated `db::get_book_by_source_path` query powers the fast-path. `import_book_inner` gains a fast-path check after its existing Step-1 stat and before its Step-3 hash read, reusing the already-fetched `source_metadata` (zero new round trips). On a confirmed size+mtime match it loads the full existing book via `db::get_book` and returns `ImportOutcome::Duplicate`.

**Tech Stack:** Rust, rusqlite, r2d2; `std::fs::Metadata::modified` for mtime (no new crate). Tests via `tempfile` DB fixtures.

**Spec:** `docs/superpowers/specs/2026-06-01-resumable-remote-import-design.md` (data model adapted: import-only metadata instead of `Book` fields).

**Baseline (verified in code 2026-06-06):**
- `import_book_inner` (src-tauri/src/commands.rs:657): Step 1 stats via `std::fs::metadata` (size + mtime in hand cheaply, ~668); Step 3 streams every byte through SHA-256 then `db::get_book_by_file_hash`, returns `ImportOutcome::Duplicate` on hit (~688-710). The full byte read is the cost we are eliminating for unchanged files.
- `books` table schema at folio-core/src/db.rs:101; additive `ALTER TABLE … ADD COLUMN` migrations at ~246-266; `file_hash` UNIQUE index pattern at ~248.
- `insert_book` (db.rs:421), `BOOK_COLUMNS`/`BOOK_COLUMNS_B`/`row_to_book` (db.rs:1023-1056), `get_book` (db.rs:453). These stay **untouched** (Book struct unchanged).

---

### Task 1: Schema migration — three source columns + index

**Files:**
- Modify: `folio-core/src/db.rs:266` (append after the `publish_year` migration line, before the `updated_at` block at ~268)
- Test: `folio-core/src/db.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `folio-core/src/db.rs`:

```rust
#[test]
fn source_columns_exist_after_migration() {
    let dir = tempfile::tempdir().unwrap();
    let conn = init_db(&dir.path().join("library.db")).unwrap();
    // Inserting with the new columns must succeed (proves columns exist).
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at, source_path, source_size, source_mtime)
         VALUES ('s1', 'T', 'A', '/storage/s1.epub', 0, 100, 'epub', 100, '/mnt/nas/T.epub', 1234, 1700000000)",
        [],
    ).unwrap();
    let (sp, ss, sm): (String, i64, i64) = conn
        .query_row(
            "SELECT source_path, source_size, source_mtime FROM books WHERE id = 's1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(sp, "/mnt/nas/T.epub");
    assert_eq!(ss, 1234);
    assert_eq!(sm, 1700000000);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core source_columns_exist_after_migration`
Expected: FAIL — `no such column: source_path` (or the INSERT errors on unknown columns).

- [ ] **Step 3: Add the migration**

In `folio-core/src/db.rs`, immediately after the `publish_year` ALTER (line ~266) and before the `// Incremental backup` block, add:

```rust
    // Fast skip-before-hash re-import: cheap (path, size, mtime) match avoids
    // re-streaming unchanged files over a remote mount. Hash stays the source
    // of truth on every mismatch. Index is intentionally NON-unique.
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN source_path TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN source_size INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN source_mtime INTEGER;");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_books_source_path ON books(source_path);",
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core source_columns_exist_after_migration`
Expected: PASS.

- [ ] **Step 5: Verify migration is idempotent (re-run on existing DB)**

The `ALTER TABLE … ADD COLUMN` lines fail silently if the column exists (existing pattern). No extra test needed — `run_schema` is already called on every open. Confirm the full suite still builds:

Run: `cargo test -p folio-core --no-run`
Expected: Compiles.

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add source_path/size/mtime columns for fast re-import"
```

---

### Task 2: `db::set_book_source` and `db::get_book_by_source_path`

**Files:**
- Modify: `folio-core/src/db.rs` (add two pub fns near the other Book CRUD, after `get_book_by_file_path` at ~473; add a small struct)
- Test: `folio-core/src/db.rs` (inline tests module)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `folio-core/src/db.rs`:

```rust
#[test]
fn set_and_get_book_source_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let conn = init_db(&dir.path().join("library.db")).unwrap();
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at)
         VALUES ('b1', 'T', 'A', '/storage/b1.epub', 0, 100, 'epub', 100)",
        [],
    ).unwrap();

    set_book_source(&conn, "b1", "/mnt/nas/T.epub", 4096, 1700000000).unwrap();

    let found = get_book_by_source_path(&conn, "/mnt/nas/T.epub").unwrap().unwrap();
    assert_eq!(found.id, "b1");
    assert_eq!(found.source_size, Some(4096));
    assert_eq!(found.source_mtime, Some(1700000000));
}

#[test]
fn get_book_by_source_path_missing_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let conn = init_db(&dir.path().join("library.db")).unwrap();
    assert!(get_book_by_source_path(&conn, "/nope/x.epub").unwrap().is_none());
}

#[test]
fn get_book_by_source_path_ignores_legacy_null_rows() {
    let dir = tempfile::tempdir().unwrap();
    let conn = init_db(&dir.path().join("library.db")).unwrap();
    // Legacy row: no source_path written.
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at)
         VALUES ('legacy', 'T', 'A', '/storage/legacy.epub', 0, 100, 'epub', 100)",
        [],
    ).unwrap();
    // Querying by the storage path must not match a NULL source_path row.
    assert!(get_book_by_source_path(&conn, "/storage/legacy.epub").unwrap().is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p folio-core book_source`
Expected: FAIL — `cannot find function set_book_source` / `get_book_by_source_path`.

- [ ] **Step 3: Implement the struct and two functions**

In `folio-core/src/db.rs`, after `get_book_by_file_path` (ends ~473), add:

```rust
/// Lightweight source-tracking row for the fast skip-before-hash re-import
/// path. Deliberately NOT part of the `Book` domain struct — this is import
/// bookkeeping, not a book property.
pub struct BookSourceRef {
    pub id: String,
    pub source_size: Option<i64>,
    pub source_mtime: Option<i64>,
}

/// Record where a book was imported from (the exact path string the folder
/// walk produced) plus its size and mtime, for cheap re-import skipping.
pub fn set_book_source(
    conn: &Connection,
    book_id: &str,
    source_path: &str,
    source_size: i64,
    source_mtime: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET source_path = ?1, source_size = ?2, source_mtime = ?3 WHERE id = ?4",
        params![source_path, source_size, source_mtime, book_id],
    )?;
    Ok(())
}

/// Look up a book by the import source path. Returns `None` for legacy rows
/// (NULL `source_path`) and unknown paths. Used by the fast-path before
/// hashing — never the duplicate backstop (that remains `file_hash`).
pub fn get_book_by_source_path(
    conn: &Connection,
    source_path: &str,
) -> Result<Option<BookSourceRef>> {
    let mut stmt = conn
        .prepare("SELECT id, source_size, source_mtime FROM books WHERE source_path = ?1")?;
    let mut rows = stmt.query(params![source_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(BookSourceRef {
            id: row.get(0)?,
            source_size: row.get(1)?,
            source_mtime: row.get(2)?,
        }))
    } else {
        Ok(None)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p folio-core book_source`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): set_book_source + get_book_by_source_path for fast re-import"
```

---

### Task 3: Wire fast-path and source recording into `import_book_inner`

**Files:**
- Modify: `src-tauri/src/commands.rs:657-710` (compute source size/mtime once at Step 1; add fast-path before Step 3 hash) and `:1135-1160` (record source after successful insert, in the same tx)
- Test: `src-tauri/src/commands.rs` (inline tests — same module as the existing import tests)

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src-tauri/src/commands.rs` (mirror the existing import-test helpers — reuse whatever pool/storage setup the current import tests use; pseudocode placeholders below marked `// HELPER:` must be replaced with the real local helpers found in that module):

```rust
#[test]
fn reimport_same_path_fast_skips_without_rehash() {
    // HELPER: build a temp DB pool + storage exactly like existing import tests.
    let (db_pool, storage, covers) = test_import_env();
    let src = write_fixture_epub(); // HELPER: a real, valid .epub temp file; returns PathBuf

    // First import: real import, records source_path/size/mtime.
    let first = import_book_inner(
        src.to_string_lossy().to_string(),
        db_pool.clone(),
        storage.clone(),
        covers.clone(),
        "link",
        false,
    )
    .unwrap();
    let first_id = first.into_book().id;

    // Sanity: the source row was recorded.
    {
        let conn = db_pool.get().unwrap();
        let meta = std::fs::metadata(&src).unwrap();
        let rec = db::get_book_by_source_path(&conn, &src.to_string_lossy())
            .unwrap()
            .unwrap();
        assert_eq!(rec.id, first_id);
        assert_eq!(rec.source_size, Some(meta.len() as i64));
    }

    // Second import of the SAME path: must return the same book as Duplicate.
    let second = import_book_inner(
        src.to_string_lossy().to_string(),
        db_pool.clone(),
        storage.clone(),
        covers.clone(),
        "link",
        false,
    )
    .unwrap();
    match second {
        ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
        _ => panic!("expected Duplicate outcome"),
    }

    // Exactly one row exists.
    let conn = db_pool.get().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
```

> Note: this test proves the *Duplicate* outcome and single-row invariant. It does not directly assert "no bytes were read" (hard to observe without instrumentation); the fast-path is exercised because the source row matches size+mtime exactly. If the existing import tests already expose a hashing counter or similar, assert on it; otherwise the Duplicate-by-source-path outcome is the behavioral proof.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio reimport_same_path_fast_skips_without_rehash` (from `src-tauri/`, or `cargo test --manifest-path src-tauri/Cargo.toml`)
Expected: FAIL — second import does not currently match by source_path (no source recorded / no fast-path), so it either re-hashes to Duplicate-by-hash (test still green only by luck) OR the source row sanity assertion fails first. The sanity block (`get_book_by_source_path` returns the row) MUST fail before the fast-path is wired.

- [ ] **Step 3: Compute source size/mtime once at Step 1**

In `src-tauri/src/commands.rs`, right after the size-guard block (after line ~675, `source_metadata` is already in scope), add:

```rust
    // Source identity for the fast skip-before-hash re-import path. mtime is
    // best-effort: if the platform/FS can't report it, treat as absent and
    // fall through to hashing (never skip without a confirmed size+mtime match).
    let source_size = source_metadata.len() as i64;
    let source_mtime: Option<i64> = source_metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
```

- [ ] **Step 4: Add the fast-path before Step 3 hashing**

Immediately before the `let hash: Option<String> = {` block (line ~688), add:

```rust
    // Fast skip-before-hash: if this exact source path was imported before and
    // its size + mtime are unchanged, return the existing book without reading
    // a single byte. Any mismatch / path-miss falls through to the hash, which
    // remains the duplicate source of truth.
    if let Some(src_ref) = {
        let conn = db_pool.get()?;
        db::get_book_by_source_path(&conn, &file_path)?
    } {
        if src_ref.source_size == Some(source_size)
            && source_mtime.is_some()
            && src_ref.source_mtime == source_mtime
        {
            let conn = db_pool.get()?;
            if let Some(existing) = db::get_book(&conn, &src_ref.id)? {
                return Ok(ImportOutcome::Duplicate(existing));
            }
        }
    }
```

- [ ] **Step 5: Record the source after successful insert**

In the same transaction as `insert_book`, after the `db::insert_book(&tx, &book)` succeeds and before `log_event` (around line ~1160, after the error-handling `if let Err(e) = db::insert_book(...) { ... }` block closes), add:

```rust
    if let Err(e) = db::set_book_source(&tx, &book.id, &file_path, source_size, source_mtime.unwrap_or(0)) {
        if should_copy {
            let _ = std::fs::remove_file(&final_path);
        }
        if cover_saved {
            let _ = delete_book_covers(&*covers_storage, &book.id);
        }
        return Err(e.into());
    }
```

> `source_mtime.unwrap_or(0)`: when mtime is unavailable we store 0, which can never equal a real file's mtime, so the fast-path will correctly never skip on it (it also requires `source_mtime.is_some()` on the read side). `file_path` here is the original source path argument — still in scope and unchanged (the storage key lives in `file_path_value`).

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test -p folio reimport_same_path_fast_skips_without_rehash`
Expected: PASS.

- [ ] **Step 7: Add a changed-mtime fall-through test**

```rust
#[test]
fn reimport_with_changed_mtime_falls_through_to_hash() {
    let (db_pool, storage, covers) = test_import_env();
    let src = write_fixture_epub();

    let first = import_book_inner(
        src.to_string_lossy().to_string(),
        db_pool.clone(), storage.clone(), covers.clone(), "link", false,
    ).unwrap();
    let first_id = first.into_book().id;

    // Corrupt the stored mtime so the fast-path cannot match.
    {
        let conn = db_pool.get().unwrap();
        conn.execute(
            "UPDATE books SET source_mtime = 1 WHERE id = ?1",
            rusqlite::params![first_id],
        ).unwrap();
    }

    // Re-import: fast-path misses (mtime differs) -> hashes -> identical content
    // -> still Duplicate by hash, still one row.
    let second = import_book_inner(
        src.to_string_lossy().to_string(),
        db_pool.clone(), storage.clone(), covers.clone(), "link", false,
    ).unwrap();
    match second {
        ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
        _ => panic!("expected Duplicate by hash"),
    }
    let conn = db_pool.get().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 8: Run both tests**

Run: `cargo test -p folio reimport_`
Expected: PASS (both).

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(import): fast skip-before-hash on unchanged source path+size+mtime"
```

---

### Task 4: Full local verification before push

**Files:** None (verification only)

- [ ] **Step 1: Rust format + lint + tests (folio crate)**

Run (from `src-tauri/`):
```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```
Expected: All pass, no clippy warnings.

- [ ] **Step 2: folio-core test binary (separate invocation per CLAUDE.md)**

Run (from workspace root):
```bash
cargo test -p folio-core
```
Expected: PASS (includes the new db tests). MOBI is untouched here; the import path is shared parser code, so also run:
```bash
cargo test -p folio-core --features mobi
```
Expected: PASS.

- [ ] **Step 3: Frontend gates (no frontend change, but CI runs them)**

Run (from root):
```bash
npm run type-check && npm run test
```
Expected: PASS (unchanged).

- [ ] **Step 4: Update spec note**

Edit `docs/superpowers/specs/2026-06-01-resumable-remote-import-design.md`: under "Data model", add a one-line note that implementation kept source tracking as **import-only metadata** (3 columns + `set_book_source`/`get_book_by_source_path`) rather than fields on `Book`, for a smaller surface. Commit:
```bash
git add docs/superpowers/specs/2026-06-01-resumable-remote-import-design.md
git commit -m "docs(import): note import-only metadata data-model choice"
```

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin feat/resumable-remote-import
gh pr create --fill
```
(Omit any "Generated with Claude Code" badge per project preference. Check CI with `gh run list` after pushing.)

---

## Self-Review

**Spec coverage:**
- Skip semantics (path+size+mtime match → Duplicate, no byte read) → Task 3 Steps 3-4.
- Data model (3 columns + non-unique index) → Task 1 (adapted: columns only, not on `Book`).
- Recorded for both import modes at insert time → Task 3 Step 5 (`set_book_source` runs for every successful insert regardless of mode).
- `source_path` = exact walk path string, no canonicalize → Task 3 uses `file_path` arg verbatim.
- mtime in seconds, best-effort → Task 3 Step 3.
- Fast-path reuses Step-1 stat, zero new round trips for the stat itself → Task 3 Step 3 reuses `source_metadata`.
- Edge: legacy NULL rows never match → Task 2 Step 1 test 3.
- Edge: changed file falls through to hash → Task 3 Step 7.
- Edge: mtime unavailable → never skip → Task 3 Steps 3-4 (`source_mtime.is_some()` guard) + store 0 on write.
- `file_hash` UNIQUE backstop unchanged → not modified.
- Out of scope (manifest/checkpoint, backfill, run_import_task changes) → not touched.

**Placeholder scan:** Test helpers in Task 3 are marked `// HELPER:` — the executor must bind them to the real helpers already present in the commands.rs test module (the import-atomics tests, recently serialized per commit a5cf253, set up exactly such an env). This is the one intentional lookup, flagged explicitly, not a silent TODO.

**Type consistency:** `BookSourceRef { id, source_size: Option<i64>, source_mtime: Option<i64> }` defined in Task 2 and consumed identically in Task 3. `set_book_source(conn, &str, &str, i64, i64)` signature matches both call sites. `get_book(conn, &str) -> Result<Option<Book>>` is the existing fn (db.rs:453), used unchanged in Task 3 Step 4.
