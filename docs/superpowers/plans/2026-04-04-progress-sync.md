# Multi-Device Progress Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync reading progress, bookmarks, and highlights across devices using the existing remote backup infrastructure (OpenDAL + configured provider), with true last-write-wins merge and soft delete.

**Architecture:** New `sync.rs` module handles all sync logic (structs, merge, remote I/O). `db.rs` gets migration + soft-delete queries. `commands.rs` wires thin entry points. Frontend gets a settings toggle and event listeners for async sync results.

**Tech Stack:** Rust (rusqlite, opendal, serde_json, uuid), React 19, Tauri v2 IPC + events

**Spec:** `docs/superpowers/specs/2026-04-04-progress-sync-design.md`

**Implementation note:** This plan contains code snippets that serve as **implementation sketches**, not mandatory literal code. Follow the task order, sync invariants, architectural boundaries, and test discipline — but simplify or adjust the exact implementation where repo realities suggest a cleaner equivalent. In particular, Tasks 8 and 10 describe **behavioral requirements** (timeouts, non-blocking, fire-and-forget, event-driven refresh) — the threading/React patterns shown are one way to achieve them, not the only way.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/models.rs` | Modify | Add `updated_at`/`deleted_at` to Bookmark and Highlight structs |
| `src-tauri/src/db.rs` | Modify | Migration, backfill, soft-delete queries, sync-inclusive queries, device_id + sync_enabled helpers |
| `src-tauri/src/sync.rs` | Create | Sync structs, error types, merge engine, orchestration helpers |
| `src-tauri/src/commands.rs` | Modify | Soft-delete commands, sync entry points (thin wiring only) |
| `src-tauri/src/lib.rs` | Modify | Register new commands, add `pub mod sync;` |
| `src/components/SettingsPanel.tsx` | Modify | Sync toggle + status display in Remote Backup section |
| `src/screens/Reader.tsx` | Modify | Listen for `sync-applied` and `sync-progress-updated` events |

---

## Task 1: Add `updated_at` and `deleted_at` to Bookmark and Highlight structs

**Files:**
- Modify: `src-tauri/src/models.rs:70-93`

- [ ] **Step 1: Write failing test — Bookmark struct has updated_at and deleted_at fields**

In `src-tauri/src/models.rs`, add to the existing tests at the bottom:

```rust
#[test]
fn bookmark_serde_with_timestamps() {
    let bm = Bookmark {
        id: "bm-1".to_string(),
        book_id: "book-1".to_string(),
        chapter_index: 2,
        scroll_position: 0.5,
        name: None,
        note: None,
        created_at: 1000,
        updated_at: 2000,
        deleted_at: Some(3000),
    };
    let json = serde_json::to_string(&bm).unwrap();
    let back: Bookmark = serde_json::from_str(&json).unwrap();
    assert_eq!(back.updated_at, 2000);
    assert_eq!(back.deleted_at, Some(3000));
}

#[test]
fn highlight_serde_with_timestamps() {
    let hl = Highlight {
        id: "hl-1".to_string(),
        book_id: "book-1".to_string(),
        chapter_index: 1,
        text: "hello".to_string(),
        color: "#f6c445".to_string(),
        note: None,
        start_offset: 0,
        end_offset: 5,
        created_at: 1000,
        updated_at: 2000,
        deleted_at: None,
    };
    let json = serde_json::to_string(&hl).unwrap();
    let back: Highlight = serde_json::from_str(&json).unwrap();
    assert_eq!(back.updated_at, 2000);
    assert_eq!(back.deleted_at, None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test bookmark_serde_with_timestamps -- --nocapture 2>&1 | head -20`
Expected: FAIL — `Bookmark` has no field `updated_at`

- [ ] **Step 3: Add fields to Bookmark struct**

In `src-tauri/src/models.rs`, replace the Bookmark struct (lines 70-79):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub name: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}
```

- [ ] **Step 4: Add fields to Highlight struct**

In `src-tauri/src/models.rs`, replace the Highlight struct (lines 81-93):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub text: String,
    pub color: String,
    pub note: Option<String>,
    pub start_offset: u32,
    pub end_offset: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}
```

- [ ] **Step 5: Fix all compilation errors from the new fields**

Every place that constructs a `Bookmark` or `Highlight` now needs `updated_at` and `deleted_at`. Update these:

**`commands.rs` — `add_bookmark` (~line 1151):** Add `updated_at: bookmark.created_at` to the constructed Bookmark (set equal to created_at per mutation discipline). Add `deleted_at: None`.

The full struct construction becomes:
```rust
let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs() as i64;
let bookmark = Bookmark {
    id: Uuid::new_v4().to_string(),
    book_id,
    chapter_index,
    scroll_position,
    name: None,
    note,
    created_at: now,
    updated_at: now,
    deleted_at: None,
};
```

**`commands.rs` — `add_highlight` (~line 1405):** Same pattern — add `updated_at: now` and `deleted_at: None`.

```rust
let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs() as i64;
let highlight = Highlight {
    id: Uuid::new_v4().to_string(),
    book_id,
    chapter_index,
    text,
    color,
    note,
    start_offset,
    end_offset,
    created_at: now,
    updated_at: now,
    deleted_at: None,
};
```

**`db.rs` — `list_bookmarks` (~line 525):** Update SELECT to include `updated_at` and `deleted_at`, and map them in the closure:

```rust
pub fn list_bookmarks(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at
         FROM bookmarks WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            scroll_position: row.get(3)?,
            name: row.get(4)?,
            note: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            deleted_at: row.get(8)?,
        })
    })?;
    rows.collect()
}
```

Note: `AND deleted_at IS NULL` added — this is the soft-delete filter for UI queries.

**`db.rs` — `list_highlights` (~line 907):** Same pattern:

```rust
pub fn list_highlights(conn: &Connection, book_id: &str) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY chapter_index ASC, start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}
```

**`db.rs` — `get_chapter_highlights` (~line 928):** Same pattern — add `updated_at, deleted_at` to SELECT, add `AND deleted_at IS NULL`, map fields.

```rust
pub fn get_chapter_highlights(
    conn: &Connection,
    book_id: &str,
    chapter_index: u32,
) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 AND chapter_index = ?2 AND deleted_at IS NULL ORDER BY start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id, chapter_index], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}
```

**`db.rs` tests — any test that constructs Bookmark or Highlight:** Add `updated_at` and `deleted_at` fields. For test fixtures, use `updated_at: created_at` and `deleted_at: None`.

For example, in `test_bookmark_crud` (~line 1468):
```rust
let bookmark = Bookmark {
    id: "bm-1".to_string(),
    book_id: "book-3".to_string(),
    chapter_index: 2,
    scroll_position: 0.3,
    name: None,
    note: Some("Great quote".to_string()),
    created_at: 1700000200,
    updated_at: 1700000200,
    deleted_at: None,
};
```

Apply the same pattern to all test Bookmark/Highlight constructions.

- [ ] **Step 6: Run all tests to verify they pass**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 7: Run clippy and fmt**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: No warnings

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/models.rs src-tauri/src/db.rs src-tauri/src/commands.rs
git commit -m "feat(sync): add updated_at/deleted_at to Bookmark and Highlight structs

Adds timestamp fields needed for sync merge and soft delete.
All UI-facing queries now filter out soft-deleted rows.
Create operations set updated_at = created_at per sync discipline."
```

---

## Task 2: Database migration — add `deleted_at` column and backfill

**Files:**
- Modify: `src-tauri/src/db.rs:14-219` (run_schema function)
- Test: `src-tauri/src/db.rs` (tests module)

- [ ] **Step 1: Write failing test — deleted_at column exists after migration**

```rust
#[test]
fn test_migration_adds_deleted_at_columns() {
    let (_dir, conn) = setup();
    // After setup (which runs run_schema), deleted_at should exist
    let bm = Bookmark {
        id: "bm-del".to_string(),
        book_id: "book-del".to_string(),
        chapter_index: 0,
        scroll_position: 0.0,
        name: None,
        note: None,
        created_at: 1000,
        updated_at: 1000,
        deleted_at: None,
    };
    let book = sample_book("book-del");
    insert_book(&conn, &book).unwrap();
    insert_bookmark(&conn, &bm).unwrap();

    // Soft-delete should work
    conn.execute(
        "UPDATE bookmarks SET deleted_at = 2000, updated_at = 2000 WHERE id = 'bm-del'",
        [],
    ).unwrap();

    // Should not appear in normal list
    let visible = list_bookmarks(&conn, "book-del").unwrap();
    assert!(visible.is_empty());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_migration_adds_deleted_at_columns -- --nocapture 2>&1 | head -20`
Expected: FAIL — column `deleted_at` does not exist

- [ ] **Step 3: Add migration to run_schema**

In `src-tauri/src/db.rs`, after the existing `updated_at` migrations (after line 174), add:

```rust
// Sync: add deleted_at for soft-delete support
let _ = conn.execute_batch("ALTER TABLE bookmarks ADD COLUMN deleted_at INTEGER;");
let _ = conn.execute_batch("ALTER TABLE highlights ADD COLUMN deleted_at INTEGER;");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_migration_adds_deleted_at_columns -- --nocapture 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Write test — backfill sets updated_at from created_at**

**Important:** The backfill SQL already exists in `run_schema()` at lines 170-174 of `db.rs`:
```sql
UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;
UPDATE highlights SET updated_at = created_at WHERE updated_at = 0;
```
This test validates the existing backfill works correctly. Do NOT add duplicate backfill SQL.

```rust
#[test]
fn test_backfill_updated_at_from_created_at() {
    let (_dir, conn) = setup();
    let book = sample_book("book-bf");
    insert_book(&conn, &book).unwrap();

    // Manually insert a bookmark with updated_at = 0 (simulating pre-migration row)
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, created_at, updated_at)
         VALUES ('bm-bf', 'book-bf', 0, 0.0, 5000, 0)",
        [],
    ).unwrap();

    // Re-run the backfill (idempotent — already in run_schema, but verify it works)
    conn.execute_batch("UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;").unwrap();

    let updated_at: i64 = conn.query_row(
        "SELECT updated_at FROM bookmarks WHERE id = 'bm-bf'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(updated_at, 5000);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_backfill_updated_at_from_created_at -- --nocapture 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(sync): add deleted_at migration for bookmarks and highlights

Additive migration adds nullable deleted_at column to both tables.
Existing backfill already sets updated_at = created_at for rows with updated_at = 0."
```

---

## Task 3: Soft-delete bookmark and highlight commands

**Files:**
- Modify: `src-tauri/src/db.rs:544-547` (delete_bookmark), `src-tauri/src/db.rs:965-967` (delete_highlight)
- Test: `src-tauri/src/db.rs` (tests module)

- [ ] **Step 1: Write failing test — soft delete sets deleted_at and hides from list**

```rust
#[test]
fn test_soft_delete_bookmark() {
    let (_dir, conn) = setup();
    let book = sample_book("book-sd");
    insert_book(&conn, &book).unwrap();

    let bm = Bookmark {
        id: "bm-sd".to_string(),
        book_id: "book-sd".to_string(),
        chapter_index: 0,
        scroll_position: 0.0,
        name: None,
        note: None,
        created_at: 1000,
        updated_at: 1000,
        deleted_at: None,
    };
    insert_bookmark(&conn, &bm).unwrap();

    // Soft-delete
    soft_delete_bookmark(&conn, "bm-sd").unwrap();

    // Should not appear in normal list
    let visible = list_bookmarks(&conn, "book-sd").unwrap();
    assert!(visible.is_empty());

    // Should still exist in DB (not hard-deleted)
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bookmarks WHERE id = 'bm-sd'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 1);

    // deleted_at should be set
    let deleted_at: Option<i64> = conn.query_row(
        "SELECT deleted_at FROM bookmarks WHERE id = 'bm-sd'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert!(deleted_at.is_some());
}

#[test]
fn test_soft_delete_bookmark_idempotent() {
    let (_dir, conn) = setup();
    let book = sample_book("book-sd2");
    insert_book(&conn, &book).unwrap();

    let bm = Bookmark {
        id: "bm-sd2".to_string(),
        book_id: "book-sd2".to_string(),
        chapter_index: 0,
        scroll_position: 0.0,
        name: None,
        note: None,
        created_at: 1000,
        updated_at: 1000,
        deleted_at: None,
    };
    insert_bookmark(&conn, &bm).unwrap();

    soft_delete_bookmark(&conn, "bm-sd2").unwrap();
    let first_deleted_at: i64 = conn.query_row(
        "SELECT deleted_at FROM bookmarks WHERE id = 'bm-sd2'",
        [],
        |row| row.get(0),
    ).unwrap();

    // Second delete should not change deleted_at (idempotent)
    std::thread::sleep(std::time::Duration::from_millis(10));
    soft_delete_bookmark(&conn, "bm-sd2").unwrap();
    let second_deleted_at: i64 = conn.query_row(
        "SELECT deleted_at FROM bookmarks WHERE id = 'bm-sd2'",
        [],
        |row| row.get(0),
    ).unwrap();

    assert_eq!(first_deleted_at, second_deleted_at);
}

#[test]
fn test_soft_delete_highlight() {
    let (_dir, conn) = setup();
    let book = sample_book("book-sdh");
    insert_book(&conn, &book).unwrap();

    let hl = crate::models::Highlight {
        id: "hl-sd".to_string(),
        book_id: "book-sdh".to_string(),
        chapter_index: 0,
        text: "test".to_string(),
        color: "#f6c445".to_string(),
        note: None,
        start_offset: 0,
        end_offset: 4,
        created_at: 1000,
        updated_at: 1000,
        deleted_at: None,
    };
    insert_highlight(&conn, &hl).unwrap();

    soft_delete_highlight(&conn, "hl-sd").unwrap();

    let visible = list_highlights(&conn, "book-sdh").unwrap();
    assert!(visible.is_empty());

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM highlights WHERE id = 'hl-sd'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 1);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_soft_delete -- --nocapture 2>&1 | head -20`
Expected: FAIL — `soft_delete_bookmark` not found

- [ ] **Step 3: Implement soft_delete_bookmark and soft_delete_highlight**

In `src-tauri/src/db.rs`, replace `delete_bookmark` (line 544) and add `soft_delete_bookmark`:

```rust
pub fn soft_delete_bookmark(conn: &Connection, id: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}
```

Keep the old `delete_bookmark` for now (used by cascade tests), but rename it to `hard_delete_bookmark` if needed, or just leave it — the FK cascade handles book deletion.

Replace `delete_highlight` (line 965) with:

```rust
pub fn soft_delete_highlight(conn: &Connection, id: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE highlights SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Update commands.rs to use soft deletes**

In `commands.rs`, change `remove_bookmark` (~line 1171):
```rust
#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::soft_delete_bookmark(&conn, &bookmark_id).map_err(|e| e.to_string())
}
```

Change `remove_highlight` (~line 1454):
```rust
#[tauri::command]
pub async fn remove_highlight(
    highlight_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::soft_delete_highlight(&conn, &highlight_id).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: ALL PASS (some existing tests may need updating if they relied on hard delete behavior — fix those by checking row existence differently)

- [ ] **Step 6: Run clippy and fmt**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: No warnings

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/db.rs src-tauri/src/commands.rs
git commit -m "feat(sync): implement soft delete for bookmarks and highlights

Delete commands now set deleted_at + updated_at instead of DELETE FROM.
Idempotent: already-deleted rows are untouched.
UI queries filter deleted_at IS NULL; rows persist as tombstones for sync."
```

---

## Task 4: Device identity and sync_enabled setting

**Files:**
- Modify: `src-tauri/src/db.rs` (helpers live here — these are database/settings functions, not command handlers)
- Test: `src-tauri/src/db.rs` (tests module)

- [ ] **Step 1: Write failing test — get_or_create_device_id**

In `src-tauri/src/db.rs` tests:

```rust
#[test]
fn test_get_or_create_device_id() {
    let (_dir, conn) = setup();

    // First call creates a new device_id
    let id1 = get_or_create_device_id(&conn).unwrap();
    assert!(!id1.is_empty());
    // Should be a valid UUID format (36 chars with hyphens)
    assert_eq!(id1.len(), 36);

    // Second call returns the same device_id
    let id2 = get_or_create_device_id(&conn).unwrap();
    assert_eq!(id1, id2);
}

#[test]
fn test_is_sync_enabled() {
    let (_dir, conn) = setup();

    // Missing key = false
    assert!(!is_sync_enabled(&conn));

    // Explicitly set to true
    set_setting(&conn, "sync_enabled", "true").unwrap();
    assert!(is_sync_enabled(&conn));

    // Explicitly set to false
    set_setting(&conn, "sync_enabled", "false").unwrap();
    assert!(!is_sync_enabled(&conn));

    // Malformed value = false
    set_setting(&conn, "sync_enabled", "yes").unwrap();
    assert!(!is_sync_enabled(&conn));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_get_or_create_device_id -- --nocapture 2>&1 | head -10`
Expected: FAIL — function not found

- [ ] **Step 3: Implement get_or_create_device_id and is_sync_enabled**

In `src-tauri/src/db.rs`, add:

```rust
pub fn get_or_create_device_id(conn: &Connection) -> Result<String> {
    if let Some(id) = get_setting(conn, "device_id")? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set_setting(conn, "device_id", &id)?;
    Ok(id)
}

pub fn is_sync_enabled(conn: &Connection) -> bool {
    get_setting(conn, "sync_enabled")
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test test_get_or_create_device_id test_is_sync_enabled -- --nocapture 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Run full test suite + clippy**

Run: `cd src-tauri && cargo fmt && cargo test && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/db.rs
git commit -m "feat(sync): add device_id and sync_enabled helpers

get_or_create_device_id() is local-first: reads from settings,
generates UUID v4 if missing, never depends on remote.
is_sync_enabled() treats missing/malformed key as false."
```

---

## Task 5: Create sync.rs — structs and error types

**Files:**
- Create: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/lib.rs:1` (add `pub mod sync;`)

- [ ] **Step 1: Write failing test — sync structs serialize/deserialize correctly**

Create `src-tauri/src/sync.rs` with tests first:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBookmark {
    pub id: String,
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub name: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncHighlight {
    pub id: String,
    pub chapter_index: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    pub text: String,
    pub color: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSyncFile {
    pub schema_version: u32,
    pub book_hash: String,
    pub device_id: String,
    pub progress: Option<SyncProgress>,
    pub bookmarks: Vec<SyncBookmark>,
    pub highlights: Vec<SyncHighlight>,
}

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub enum SyncError {
    Transport(String),
    Timeout,
    Malformed(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Transport(msg) => write!(f, "transport error: {msg}"),
            SyncError::Timeout => write!(f, "timeout after 5s"),
            SyncError::Malformed(msg) => write!(f, "malformed remote data: {msg}"),
        }
    }
}

/// Result of merging remote sync data into local state.
#[derive(Debug, Default)]
pub struct MergeResult {
    pub progress_updated: bool,
    pub bookmarks_added: u32,
    pub bookmarks_updated: u32,
    pub highlights_added: u32,
    pub highlights_updated: u32,
}

impl MergeResult {
    pub fn has_changes(&self) -> bool {
        self.progress_updated
            || self.bookmarks_added > 0
            || self.bookmarks_updated > 0
            || self.highlights_added > 0
            || self.highlights_updated > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_sync_file_roundtrip() {
        let file = BookSyncFile {
            schema_version: CURRENT_SCHEMA_VERSION,
            book_hash: "abc123".to_string(),
            device_id: "dev-1".to_string(),
            progress: Some(SyncProgress {
                chapter_index: 5,
                scroll_position: 0.42,
                updated_at: 1000,
            }),
            bookmarks: vec![SyncBookmark {
                id: "bm-1".to_string(),
                chapter_index: 3,
                scroll_position: 0.65,
                name: Some("Test".to_string()),
                note: None,
                created_at: 500,
                updated_at: 1000,
                deleted_at: None,
            }],
            highlights: vec![SyncHighlight {
                id: "hl-1".to_string(),
                chapter_index: 2,
                start_offset: 10,
                end_offset: 20,
                text: "hello".to_string(),
                color: "#f6c445".to_string(),
                note: Some("note".to_string()),
                created_at: 500,
                updated_at: 1000,
                deleted_at: Some(2000),
            }],
        };

        let json = serde_json::to_string(&file).unwrap();
        let back: BookSyncFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.schema_version, 1);
        assert_eq!(back.book_hash, "abc123");
        assert!(back.progress.is_some());
        assert_eq!(back.bookmarks.len(), 1);
        assert_eq!(back.highlights.len(), 1);
        assert_eq!(back.highlights[0].deleted_at, Some(2000));
    }

    #[test]
    fn book_sync_file_ignores_unknown_fields() {
        let json = r#"{
            "schema_version": 1,
            "book_hash": "abc",
            "device_id": "dev",
            "progress": null,
            "bookmarks": [],
            "highlights": [],
            "future_field": "should be ignored"
        }"#;
        let file: BookSyncFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.book_hash, "abc");
    }

    #[test]
    fn merge_result_has_changes() {
        let empty = MergeResult::default();
        assert!(!empty.has_changes());

        let with_progress = MergeResult { progress_updated: true, ..Default::default() };
        assert!(with_progress.has_changes());

        let with_bookmarks = MergeResult { bookmarks_added: 1, ..Default::default() };
        assert!(with_bookmarks.has_changes());
    }

    #[test]
    fn sync_error_display() {
        assert_eq!(
            SyncError::Timeout.to_string(),
            "timeout after 5s"
        );
        assert_eq!(
            SyncError::Transport("connection refused".to_string()).to_string(),
            "transport error: connection refused"
        );
        assert_eq!(
            SyncError::Malformed("invalid JSON".to_string()).to_string(),
            "malformed remote data: invalid JSON"
        );
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let json = r#"{
            "schema_version": 99,
            "book_hash": "abc",
            "device_id": "dev",
            "progress": null,
            "bookmarks": [],
            "highlights": []
        }"#;
        let file: BookSyncFile = serde_json::from_str(json).unwrap();
        assert!(file.schema_version > CURRENT_SCHEMA_VERSION);
        // Callers should check this and treat as Malformed
    }
}
```

- [ ] **Step 2: Add `pub mod sync;` to lib.rs**

In `src-tauri/src/lib.rs`, add after line 1:

```rust
pub mod sync;
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test sync::tests -- --nocapture 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 4: Run clippy and fmt**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -10`
Expected: No warnings

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/sync.rs src-tauri/src/lib.rs
git commit -m "feat(sync): create sync module with structs, error types, and merge result

BookSyncFile with SyncProgress/SyncBookmark/SyncHighlight structs.
SyncError enum with Transport/Timeout/Malformed variants.
MergeResult tracks what changed for activity logging.
Unknown JSON fields ignored for forward compatibility."
```

---

## Task 6: Sync engine — build payload and merge logic

**Files:**
- Modify: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/db.rs` (add sync-inclusive query functions)

- [ ] **Step 1: Add sync-inclusive query functions to db.rs**

These queries return ALL rows including soft-deleted ones, for building sync payloads:

```rust
pub fn list_all_bookmarks_for_sync(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at
         FROM bookmarks WHERE book_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            scroll_position: row.get(3)?,
            name: row.get(4)?,
            note: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            deleted_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn list_all_highlights_for_sync(conn: &Connection, book_id: &str) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 ORDER BY chapter_index ASC, start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

/// Upsert a bookmark from sync (may create or overwrite, including setting deleted_at).
pub fn upsert_bookmark_from_sync(conn: &Connection, bm: &Bookmark) -> Result<()> {
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           chapter_index=excluded.chapter_index,
           scroll_position=excluded.scroll_position,
           name=excluded.name,
           note=excluded.note,
           updated_at=excluded.updated_at,
           deleted_at=excluded.deleted_at",
        params![bm.id, bm.book_id, bm.chapter_index, bm.scroll_position, bm.name, bm.note, bm.created_at, bm.updated_at, bm.deleted_at],
    )?;
    Ok(())
}

/// Upsert a highlight from sync.
pub fn upsert_highlight_from_sync(conn: &Connection, hl: &crate::models::Highlight) -> Result<()> {
    conn.execute(
        "INSERT INTO highlights (id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           chapter_index=excluded.chapter_index,
           text=excluded.text,
           color=excluded.color,
           note=excluded.note,
           start_offset=excluded.start_offset,
           end_offset=excluded.end_offset,
           updated_at=excluded.updated_at,
           deleted_at=excluded.deleted_at",
        params![hl.id, hl.book_id, hl.chapter_index, hl.text, hl.color, hl.note, hl.start_offset, hl.end_offset, hl.created_at, hl.updated_at, hl.deleted_at],
    )?;
    Ok(())
}
```

- [ ] **Step 2: Write tests for build_sync_payload in sync.rs**

```rust
#[cfg(test)]
mod tests {
    // ... existing tests ...

    use crate::db;
    use crate::models::{Bookmark, Highlight, ReadingProgress};
    use tempfile::tempdir;

    fn setup_db() -> (tempfile::TempDir, rusqlite::Connection) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = db::init_db(&db_path).unwrap();
        (dir, conn)
    }

    fn sample_book(id: &str, hash: &str) -> crate::models::Book {
        crate::models::Book {
            id: id.to_string(),
            title: "Test".to_string(),
            author: "Author".to_string(),
            file_path: format!("/tmp/{id}.epub"),
            cover_path: None,
            total_chapters: 10,
            added_at: 1000,
            format: crate::models::BookFormat::Epub,
            file_hash: Some(hash.to_string()),
            description: None,
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: true,
        }
    }

    #[test]
    fn test_build_sync_payload() {
        let (_dir, conn) = setup_db();
        let book = sample_book("book-1", "hash123");
        db::insert_book(&conn, &book).unwrap();

        let progress = ReadingProgress {
            book_id: "book-1".to_string(),
            chapter_index: 3,
            scroll_position: 0.5,
            last_read_at: 2000,
        };
        db::upsert_reading_progress(&conn, &progress).unwrap();

        let bm = Bookmark {
            id: "bm-1".to_string(),
            book_id: "book-1".to_string(),
            chapter_index: 1,
            scroll_position: 0.3,
            name: None,
            note: None,
            created_at: 1000,
            updated_at: 1000,
            deleted_at: None,
        };
        db::insert_bookmark(&conn, &bm).unwrap();

        let payload = build_sync_payload(&conn, "book-1", "hash123", "dev-1");
        assert_eq!(payload.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(payload.book_hash, "hash123");
        assert_eq!(payload.device_id, "dev-1");
        assert!(payload.progress.is_some());
        assert_eq!(payload.progress.as_ref().unwrap().chapter_index, 3);
        assert_eq!(payload.bookmarks.len(), 1);
    }

    #[test]
    fn test_build_sync_payload_includes_soft_deleted() {
        let (_dir, conn) = setup_db();
        let book = sample_book("book-sd", "hashsd");
        db::insert_book(&conn, &book).unwrap();

        let bm = Bookmark {
            id: "bm-sd".to_string(),
            book_id: "book-sd".to_string(),
            chapter_index: 0,
            scroll_position: 0.0,
            name: None,
            note: None,
            created_at: 1000,
            updated_at: 1000,
            deleted_at: None,
        };
        db::insert_bookmark(&conn, &bm).unwrap();
        db::soft_delete_bookmark(&conn, "bm-sd").unwrap();

        let payload = build_sync_payload(&conn, "book-sd", "hashsd", "dev-1");
        assert_eq!(payload.bookmarks.len(), 1);
        assert!(payload.bookmarks[0].deleted_at.is_some());
    }
}
```

- [ ] **Step 3: Implement build_sync_payload**

In `src-tauri/src/sync.rs`:

```rust
use crate::db;
use rusqlite::Connection;

pub fn build_sync_payload(
    conn: &Connection,
    book_id: &str,
    file_hash: &str,
    device_id: &str,
) -> BookSyncFile {
    let progress = db::get_reading_progress(conn, book_id)
        .ok()
        .flatten()
        .map(|p| SyncProgress {
            chapter_index: p.chapter_index,
            scroll_position: p.scroll_position,
            updated_at: p.last_read_at,
        });

    let bookmarks = db::list_all_bookmarks_for_sync(conn, book_id)
        .unwrap_or_default()
        .into_iter()
        .map(|b| SyncBookmark {
            id: b.id,
            chapter_index: b.chapter_index,
            scroll_position: b.scroll_position,
            name: b.name,
            note: b.note,
            created_at: b.created_at,
            updated_at: b.updated_at,
            deleted_at: b.deleted_at,
        })
        .collect();

    let highlights = db::list_all_highlights_for_sync(conn, book_id)
        .unwrap_or_default()
        .into_iter()
        .map(|h| SyncHighlight {
            id: h.id,
            chapter_index: h.chapter_index,
            start_offset: h.start_offset,
            end_offset: h.end_offset,
            text: h.text,
            color: h.color,
            note: h.note,
            created_at: h.created_at,
            updated_at: h.updated_at,
            deleted_at: h.deleted_at,
        })
        .collect();

    BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: file_hash.to_string(),
        device_id: device_id.to_string(),
        progress,
        bookmarks,
        highlights,
    }
}
```

- [ ] **Step 4: Write tests for merge_remote_into_local**

```rust
#[test]
fn test_merge_progress_remote_newer() {
    let (_dir, conn) = setup_db();
    let book = sample_book("book-m1", "hashm1");
    db::insert_book(&conn, &book).unwrap();

    let local_progress = ReadingProgress {
        book_id: "book-m1".to_string(),
        chapter_index: 2,
        scroll_position: 0.3,
        last_read_at: 1000,
    };
    db::upsert_reading_progress(&conn, &local_progress).unwrap();

    let remote = BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: "hashm1".to_string(),
        device_id: "other-dev".to_string(),
        progress: Some(SyncProgress {
            chapter_index: 5,
            scroll_position: 0.8,
            updated_at: 2000, // newer
        }),
        bookmarks: vec![],
        highlights: vec![],
    };

    let local = build_sync_payload(&conn, "book-m1", "hashm1", "dev-1");
    let result = merge_remote_into_local(&conn, "book-m1", &local, &remote);

    assert!(result.progress_updated);
    let updated = db::get_reading_progress(&conn, "book-m1").unwrap().unwrap();
    assert_eq!(updated.chapter_index, 5);
}

#[test]
fn test_merge_progress_local_newer() {
    let (_dir, conn) = setup_db();
    let book = sample_book("book-m2", "hashm2");
    db::insert_book(&conn, &book).unwrap();

    let local_progress = ReadingProgress {
        book_id: "book-m2".to_string(),
        chapter_index: 5,
        scroll_position: 0.8,
        last_read_at: 3000,
    };
    db::upsert_reading_progress(&conn, &local_progress).unwrap();

    let remote = BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: "hashm2".to_string(),
        device_id: "other-dev".to_string(),
        progress: Some(SyncProgress {
            chapter_index: 2,
            scroll_position: 0.3,
            updated_at: 1000, // older
        }),
        bookmarks: vec![],
        highlights: vec![],
    };

    let local = build_sync_payload(&conn, "book-m2", "hashm2", "dev-1");
    let result = merge_remote_into_local(&conn, "book-m2", &local, &remote);

    assert!(!result.progress_updated);
    let kept = db::get_reading_progress(&conn, "book-m2").unwrap().unwrap();
    assert_eq!(kept.chapter_index, 5);
}

#[test]
fn test_merge_new_remote_bookmark() {
    let (_dir, conn) = setup_db();
    let book = sample_book("book-m3", "hashm3");
    db::insert_book(&conn, &book).unwrap();

    let remote = BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: "hashm3".to_string(),
        device_id: "other-dev".to_string(),
        progress: None,
        bookmarks: vec![SyncBookmark {
            id: "bm-remote".to_string(),
            chapter_index: 1,
            scroll_position: 0.5,
            name: Some("Remote BM".to_string()),
            note: None,
            created_at: 1000,
            updated_at: 1000,
            deleted_at: None,
        }],
        highlights: vec![],
    };

    let local = build_sync_payload(&conn, "book-m3", "hashm3", "dev-1");
    let result = merge_remote_into_local(&conn, "book-m3", &local, &remote);

    assert_eq!(result.bookmarks_added, 1);
    let bookmarks = db::list_bookmarks(&conn, "book-m3").unwrap();
    assert_eq!(bookmarks.len(), 1);
    assert_eq!(bookmarks[0].name, Some("Remote BM".to_string()));
}

#[test]
fn test_merge_remote_soft_delete_propagates() {
    let (_dir, conn) = setup_db();
    let book = sample_book("book-m4", "hashm4");
    db::insert_book(&conn, &book).unwrap();

    let bm = Bookmark {
        id: "bm-del-sync".to_string(),
        book_id: "book-m4".to_string(),
        chapter_index: 0,
        scroll_position: 0.0,
        name: None,
        note: None,
        created_at: 1000,
        updated_at: 1000,
        deleted_at: None,
    };
    db::insert_bookmark(&conn, &bm).unwrap();

    let remote = BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: "hashm4".to_string(),
        device_id: "other-dev".to_string(),
        progress: None,
        bookmarks: vec![SyncBookmark {
            id: "bm-del-sync".to_string(),
            chapter_index: 0,
            scroll_position: 0.0,
            name: None,
            note: None,
            created_at: 1000,
            updated_at: 2000, // newer
            deleted_at: Some(2000), // deleted on remote
        }],
        highlights: vec![],
    };

    let local = build_sync_payload(&conn, "book-m4", "hashm4", "dev-1");
    let result = merge_remote_into_local(&conn, "book-m4", &local, &remote);

    assert_eq!(result.bookmarks_updated, 1);
    // Should not appear in normal list
    let visible = db::list_bookmarks(&conn, "book-m4").unwrap();
    assert!(visible.is_empty());
}
```

- [ ] **Step 5: Implement merge_remote_into_local**

```rust
pub fn merge_remote_into_local(
    conn: &Connection,
    book_id: &str,
    local: &BookSyncFile,
    remote: &BookSyncFile,
) -> MergeResult {
    let mut result = MergeResult::default();

    // --- Progress merge ---
    // Compare updated_at. Remote newer -> apply. Equal -> prefer remote for convergence.
    if let Some(ref remote_progress) = remote.progress {
        let local_ts = local.progress.as_ref().map(|p| p.updated_at).unwrap_or(0);
        if remote_progress.updated_at >= local_ts
            && (remote_progress.updated_at > local_ts || local.progress.is_none())
        {
            let progress = crate::models::ReadingProgress {
                book_id: book_id.to_string(),
                chapter_index: remote_progress.chapter_index,
                scroll_position: remote_progress.scroll_position,
                last_read_at: remote_progress.updated_at,
            };
            if db::upsert_reading_progress(conn, &progress).is_ok() {
                result.progress_updated = true;
            }
        }
    }

    // --- Bookmark merge ---
    // Build local lookup by id
    let local_bm_map: std::collections::HashMap<&str, &SyncBookmark> = local
        .bookmarks
        .iter()
        .map(|b| (b.id.as_str(), b))
        .collect();

    for remote_bm in &remote.bookmarks {
        match local_bm_map.get(remote_bm.id.as_str()) {
            None => {
                // Only on remote side — import it
                let bm = crate::models::Bookmark {
                    id: remote_bm.id.clone(),
                    book_id: book_id.to_string(),
                    chapter_index: remote_bm.chapter_index,
                    scroll_position: remote_bm.scroll_position,
                    name: remote_bm.name.clone(),
                    note: remote_bm.note.clone(),
                    created_at: remote_bm.created_at,
                    updated_at: remote_bm.updated_at,
                    deleted_at: remote_bm.deleted_at,
                };
                if db::upsert_bookmark_from_sync(conn, &bm).is_ok() {
                    result.bookmarks_added += 1;
                }
            }
            Some(local_bm) => {
                // Both sides exist — newer updated_at wins.
                // Equal timestamps + different payloads -> prefer remote for convergence.
                // Equal timestamps + identical payloads -> skip (no-op).
                if remote_bm.updated_at > local_bm.updated_at
                    || (remote_bm.updated_at == local_bm.updated_at && /* content differs */) {
                    let bm = crate::models::Bookmark {
                        id: remote_bm.id.clone(),
                        book_id: book_id.to_string(),
                        chapter_index: remote_bm.chapter_index,
                        scroll_position: remote_bm.scroll_position,
                        name: remote_bm.name.clone(),
                        note: remote_bm.note.clone(),
                        created_at: remote_bm.created_at,
                        updated_at: remote_bm.updated_at,
                        deleted_at: remote_bm.deleted_at,
                    };
                    if db::upsert_bookmark_from_sync(conn, &bm).is_ok() {
                        result.bookmarks_updated += 1;
                    }
                }
            }
        }
    }

    // --- Highlight merge ---
    // Same rules as bookmarks
    let local_hl_map: std::collections::HashMap<&str, &SyncHighlight> = local
        .highlights
        .iter()
        .map(|h| (h.id.as_str(), h))
        .collect();

    for remote_hl in &remote.highlights {
        match local_hl_map.get(remote_hl.id.as_str()) {
            None => {
                let hl = crate::models::Highlight {
                    id: remote_hl.id.clone(),
                    book_id: book_id.to_string(),
                    chapter_index: remote_hl.chapter_index,
                    text: remote_hl.text.clone(),
                    color: remote_hl.color.clone(),
                    note: remote_hl.note.clone(),
                    start_offset: remote_hl.start_offset,
                    end_offset: remote_hl.end_offset,
                    created_at: remote_hl.created_at,
                    updated_at: remote_hl.updated_at,
                    deleted_at: remote_hl.deleted_at,
                };
                if db::upsert_highlight_from_sync(conn, &hl).is_ok() {
                    result.highlights_added += 1;
                }
            }
            Some(local_hl) => {
                if remote_hl.updated_at >= local_hl.updated_at {
                    let hl = crate::models::Highlight {
                        id: remote_hl.id.clone(),
                        book_id: book_id.to_string(),
                        chapter_index: remote_hl.chapter_index,
                        text: remote_hl.text.clone(),
                        color: remote_hl.color.clone(),
                        note: remote_hl.note.clone(),
                        start_offset: remote_hl.start_offset,
                        end_offset: remote_hl.end_offset,
                        created_at: remote_hl.created_at,
                        updated_at: remote_hl.updated_at,
                        deleted_at: remote_hl.deleted_at,
                    };
                    if db::upsert_highlight_from_sync(conn, &hl).is_ok() {
                        result.highlights_updated += 1;
                    }
                }
            }
        }
    }

    result
}
```

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test sync::tests -- --nocapture 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 7: Run full suite + clippy**

Run: `cd src-tauri && cargo fmt && cargo test && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/sync.rs src-tauri/src/db.rs
git commit -m "feat(sync): implement build_sync_payload and merge_remote_into_local

build_sync_payload assembles local state including soft-deleted rows.
merge_remote_into_local applies true LWW merge per item.
Equal timestamps + different payloads prefer remote for convergence.
Equal timestamps + identical payloads skip write (no-op optimization)."
```

---

## Task 7: Sync engine — remote I/O (fetch and push)

**Files:**
- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Implement fetch_remote_sync and push_remote_sync**

In `src-tauri/src/sync.rs`, add:

```rust
use opendal::blocking::Operator;

fn sync_path(file_hash: &str) -> String {
    format!(".folio-sync/books/{file_hash}.json")
}

pub fn fetch_remote_sync(
    op: &Operator,
    file_hash: &str,
) -> Result<Option<BookSyncFile>, SyncError> {
    let path = sync_path(file_hash);
    match op.read(&path) {
        Ok(data) => {
            let file: BookSyncFile = serde_json::from_slice(&data.to_vec())
                .map_err(|e| SyncError::Malformed(e.to_string()))?;
            if file.schema_version > CURRENT_SCHEMA_VERSION {
                return Err(SyncError::Malformed(format!(
                    "unknown schema version {}",
                    file.schema_version
                )));
            }
            Ok(Some(file))
        }
        Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SyncError::Transport(e.to_string())),
    }
}

pub fn push_remote_sync(
    op: &Operator,
    file_hash: &str,
    payload: &BookSyncFile,
) -> Result<(), SyncError> {
    let path = sync_path(file_hash);
    let json = serde_json::to_string(payload)
        .map_err(|e| SyncError::Malformed(e.to_string()))?;
    op.write(&path, json.into_bytes())
        .map(|_| ())
        .map_err(|e| SyncError::Transport(e.to_string()))
}
```

- [ ] **Step 2: Write test with Fs operator (local filesystem as remote)**

```rust
#[test]
fn test_fetch_push_roundtrip_fs() {
    let dir = tempdir().unwrap();
    let mut builder = opendal::services::Fs::default();
    builder = builder.root(dir.path().to_str().unwrap());
    let async_op = opendal::Operator::new(builder).unwrap().finish();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = rt.enter();
    let op = Operator::new(async_op).unwrap();

    let hash = "testhash123";

    // Initially no file
    let result = fetch_remote_sync(&op, hash).unwrap();
    assert!(result.is_none());

    // Push a payload
    let payload = BookSyncFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        book_hash: hash.to_string(),
        device_id: "dev-1".to_string(),
        progress: Some(SyncProgress {
            chapter_index: 3,
            scroll_position: 0.5,
            updated_at: 1000,
        }),
        bookmarks: vec![],
        highlights: vec![],
    };
    push_remote_sync(&op, hash, &payload).unwrap();

    // Fetch it back
    let fetched = fetch_remote_sync(&op, hash).unwrap().unwrap();
    assert_eq!(fetched.book_hash, hash);
    assert_eq!(fetched.progress.unwrap().chapter_index, 3);
}

#[test]
fn test_fetch_malformed_json() {
    let dir = tempdir().unwrap();
    let mut builder = opendal::services::Fs::default();
    builder = builder.root(dir.path().to_str().unwrap());
    let async_op = opendal::Operator::new(builder).unwrap().finish();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = rt.enter();
    let op = Operator::new(async_op).unwrap();

    // Write garbage
    op.write(".folio-sync/books/badhash.json", b"not json".to_vec())
        .unwrap();

    let result = fetch_remote_sync(&op, "badhash");
    assert!(matches!(result, Err(SyncError::Malformed(_))));
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test sync::tests -- --nocapture 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 4: Run clippy**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/sync.rs
git commit -m "feat(sync): implement fetch/push remote sync via OpenDAL

fetch_remote_sync returns Ok(None) for missing files, Err(Malformed)
for bad JSON, Err(Transport) for I/O failures.
Rejects unknown schema versions.
push_remote_sync writes JSON to .folio-sync/books/{hash}.json."
```

---

## Task 8: Sync orchestration — commands and lifecycle hooks

**Files:**
- Modify: `src-tauri/src/sync.rs` (add orchestration helpers)
- Modify: `src-tauri/src/commands.rs` (add sync commands)
- Modify: `src-tauri/src/lib.rs` (register new commands)

**Note:** The threading/async code below is **behavioral guidance**, not mandatory implementation. The important invariants are:
- Pull must not block reader startup
- Pull must have a 5-second timeout
- Push must be background / fire-and-forget
- Push must pull-merge before pushing to avoid overwriting remote-only changes
- Sync business logic stays in `sync.rs`
- `commands.rs` only wires the Tauri command surface, guard checks, logging, diagnostics, and events
- Both commands must check `is_sync_enabled` + backup provider configured before doing anything

If the repo offers a cleaner way to structure the async/runtime/threading boundary (e.g. `tokio::time::timeout`, Tauri's async runtime directly, etc.), use that instead of the `mpsc::channel` + `recv_timeout` pattern shown here.

- [ ] **Step 1: Add orchestration helpers to sync.rs**

```rust
/// Orchestrate sync pull for a book on open.
/// Returns MergeResult if sync happened, None if skipped.
pub fn sync_book_on_open(
    conn: &Connection,
    op: &Operator,
    book_id: &str,
    file_hash: &str,
    device_id: &str,
) -> Result<MergeResult, SyncError> {
    let remote = match fetch_remote_sync(op, file_hash)? {
        Some(r) => r,
        None => return Ok(MergeResult::default()),
    };
    let local = build_sync_payload(conn, book_id, file_hash, device_id);
    Ok(merge_remote_into_local(conn, book_id, &local, &remote))
}

/// Pull remote, merge into local DB, rebuild payload from merged state, then push.
/// This ensures remote-only changes from other devices are preserved.
pub fn sync_book_on_close(
    conn: &Connection,
    op: &Operator,
    book_id: &str,
    file_hash: &str,
    device_id: &str,
) -> Result<(), SyncError> {
    // Step 1: Pull and merge remote changes into local DB
    if let Some(remote) = fetch_remote_sync(op, file_hash)? {
        let local = build_sync_payload(conn, book_id, file_hash, device_id);
        merge_remote_into_local(conn, book_id, &local, &remote);
    }

    // Step 2: Build fresh payload from merged local state and push
    let payload = build_sync_payload(conn, book_id, file_hash, device_id);
    push_remote_sync(op, file_hash, &payload)
}
```

- [ ] **Step 2: Add Tauri commands for sync**

In `src-tauri/src/commands.rs`, add:

```rust
// --- Sync Commands ---

#[tauri::command]
pub async fn sync_pull_book(
    book_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    if !db::is_sync_enabled(&conn) {
        return Ok(());
    }

    let config_json = match db::get_setting(&conn, "backup_config").map_err(|e| e.to_string())? {
        Some(j) => j,
        None => return Ok(()), // No provider configured
    };
    let mut config: crate::backup::BackupConfig =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    crate::backup::load_secrets(&mut config)?;
    let op = crate::backup::build_operator(&config)?;

    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book not found: {book_id}"))?;
    let file_hash = book.file_hash.as_deref().ok_or("Book has no file hash")?;
    let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;

    // Run sync in a thread with timeout
    let op_clone = op;
    let book_id_clone = book_id.clone();
    let file_hash_owned = file_hash.to_string();
    let device_id_clone = device_id.clone();

    let (tx, rx) = std::sync::mpsc::channel();
    let conn2 = state.active_db()?.get().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let result = crate::sync::sync_book_on_open(
            &conn2,
            &op_clone,
            &book_id_clone,
            &file_hash_owned,
            &device_id_clone,
        );
        let _ = tx.send(result);
    });

    let timeout = std::time::Duration::from_secs(5);
    match rx.recv_timeout(timeout) {
        Ok(Ok(merge_result)) => {
            // Update diagnostic timestamps
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let _ = db::set_setting(&conn, "last_sync_success_at", &now.to_string());

            if merge_result.has_changes() {
                log_activity(
                    &conn,
                    "sync_pull_success",
                    "book",
                    Some(&book_id),
                    Some(&book.title),
                    Some(&format!(
                        "{} bookmarks, {} highlights updated, progress {}",
                        merge_result.bookmarks_added + merge_result.bookmarks_updated,
                        merge_result.highlights_added + merge_result.highlights_updated,
                        if merge_result.progress_updated { "synced" } else { "unchanged" }
                    )),
                );
                if merge_result.progress_updated {
                    let _ = app.emit("sync-progress-updated", &book_id);
                }
                let _ = app.emit("sync-applied", &book_id);
            }
        }
        Ok(Err(sync_err)) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let msg = sync_err.to_string();
            let _ = db::set_setting(&conn, "last_sync_error_at", &now.to_string());
            let _ = db::set_setting(&conn, "last_sync_error_message", &msg);
            log_activity(
                &conn,
                "sync_pull_failed",
                "book",
                Some(&book_id),
                Some(&book.title),
                Some(&msg),
            );
        }
        Err(_) => {
            // Timeout
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let msg = "timeout after 5s";
            let _ = db::set_setting(&conn, "last_sync_error_at", &now.to_string());
            let _ = db::set_setting(&conn, "last_sync_error_message", msg);
            log_activity(
                &conn,
                "sync_pull_failed",
                "book",
                Some(&book_id),
                Some(&book.title),
                Some(msg),
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sync_push_book(
    book_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    if !db::is_sync_enabled(&conn) {
        return Ok(());
    }

    let config_json = match db::get_setting(&conn, "backup_config").map_err(|e| e.to_string())? {
        Some(j) => j,
        None => return Ok(()),
    };
    let mut config: crate::backup::BackupConfig =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    crate::backup::load_secrets(&mut config)?;
    let op = crate::backup::build_operator(&config)?;

    let book = db::get_book(&conn, &book_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Book not found: {book_id}"))?;
    let file_hash = book.file_hash.as_deref().ok_or("Book has no file hash")?;
    let device_id = db::get_or_create_device_id(&conn).map_err(|e| e.to_string())?;

    // Fire-and-forget: spawn a thread for push
    let file_hash_owned = file_hash.to_string();
    let book_title = book.title.clone();
    let book_id_clone = book_id.clone();
    let conn2 = state.active_db()?.get().map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn(async move {
        let result = std::thread::spawn(move || {
            crate::sync::sync_book_on_close(&conn2, &op, &book_id_clone, &file_hash_owned, &device_id)
        })
        .join();

        // We need a new connection for logging since we're in a different thread
        // This is fire-and-forget, so failures here are acceptable
        match result {
            Ok(Ok(())) => {
                // Push succeeded — diagnostic update happens outside this spawn
                // since we can't easily get a connection here. The important thing
                // is the push happened.
            }
            Ok(Err(sync_err)) => {
                eprintln!("sync push failed for {}: {}", book_title, sync_err);
            }
            Err(_) => {
                eprintln!("sync push thread panicked for {}", book_title);
            }
        }
    });

    Ok(())
}
```

Note: The push command uses fire-and-forget. For push activity logging and diagnostic updates, the spawned thread should obtain its own connection from the pool via `state.active_db()` before spawning, pass it into the closure, and call `log_activity` + `set_setting` from within the spawned thread. The implementing agent should wire this up following the same pattern as `sync_pull_book`.

- [ ] **Step 3: Register new commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the invoke_handler list (before the closing `]`):

```rust
commands::sync_pull_book,
commands::sync_push_book,
```

- [ ] **Step 4: Run tests + clippy**

Run: `cd src-tauri && cargo fmt && cargo test && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt
git add src-tauri/src/sync.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(sync): add sync_pull_book and sync_push_book commands

sync_pull_book: non-blocking pull with 5s timeout, emits sync-applied
and sync-progress-updated events, logs to activity log.
sync_push_book: fire-and-forget push via tauri::async_runtime::spawn.
Both guard on sync_enabled + backup provider configured."
```

---

## Task 9: Frontend — sync toggle in Settings

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add sync state and load function**

In `SettingsPanel.tsx`, add state variables near the other backup state (~line 322):

```typescript
const [syncEnabled, setSyncEnabled] = useState(false);
const [lastSyncSuccess, setLastSyncSuccess] = useState<number | null>(null);
const [lastSyncError, setLastSyncError] = useState<{ at: number; message: string } | null>(null);
```

In the `loadBackupSettings` callback (~line 418), add after loading backup status:

```typescript
const syncSetting = await invoke<string | null>("get_setting_value", { key: "sync_enabled" });
setSyncEnabled(syncSetting === "true");

const successAt = await invoke<string | null>("get_setting_value", { key: "last_sync_success_at" });
setLastSyncSuccess(successAt ? parseInt(successAt, 10) : null);

const errorAt = await invoke<string | null>("get_setting_value", { key: "last_sync_error_at" });
const errorMsg = await invoke<string | null>("get_setting_value", { key: "last_sync_error_message" });
if (errorAt) {
  setLastSyncError({ at: parseInt(errorAt, 10), message: errorMsg || "Unknown error" });
} else {
  setLastSyncError(null);
}
```

- [ ] **Step 2: Add sync toggle handler**

```typescript
const handleToggleSync = async (enabled: boolean) => {
  setSyncEnabled(enabled);
  await invoke("set_setting_value", { key: "sync_enabled", value: enabled ? "true" : "false" });
};
```

- [ ] **Step 3: Add sync toggle UI in the Remote Backup accordion**

Inside the Remote Backup `<Accordion>` (~line 1412), after the existing backup UI content (before the closing `</div>` of the accordion), add:

```tsx
{/* Sync toggle */}
<div className="bg-warm-subtle rounded-xl px-3 py-2.5 mt-2">
  <label className="flex items-center justify-between cursor-pointer">
    <div>
      <span className="text-sm font-medium text-ink">{t("settings.syncProgressLabel", "Sync reading progress across devices")}</span>
      <p className="text-xs text-ink-muted mt-0.5">
        {savedBackupConfig
          ? t("settings.syncProgressDesc", "Syncs reading progress, bookmarks, and highlights across devices using your configured remote backup destination. Does not sync book files.")
          : t("settings.syncProgressDisabled", "Configure a remote backup destination to enable sync.")}
      </p>
    </div>
    <input
      type="checkbox"
      checked={syncEnabled}
      disabled={!savedBackupConfig}
      onChange={(e) => handleToggleSync(e.target.checked)}
      className="ml-3 h-4 w-4 rounded accent-accent"
    />
  </label>

  {syncEnabled && savedBackupConfig && (
    <div className="mt-2 text-xs text-ink-muted space-y-0.5">
      {lastSyncSuccess ? (
        <p>{t("settings.lastSyncSuccess", "Last successful sync")}: {new Date(lastSyncSuccess * 1000).toLocaleString()}</p>
      ) : (
        <p>{t("settings.noSyncYet", "No successful sync yet")}</p>
      )}
      {lastSyncError && (!lastSyncSuccess || lastSyncError.at > lastSyncSuccess) && (
        <p className="text-red-500">{t("settings.lastSyncError", "Last sync error")}: {lastSyncError.message}</p>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 4: Type-check**

Run: `npm run type-check 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(sync): add sync toggle and status display in settings

Toggle visible in Remote Backup section, disabled when no provider configured.
Shows last successful sync timestamp and most recent error.
Default off (opt-in)."
```

---

## Task 10: Frontend — Reader sync event listeners

**Files:**
- Modify: `src/screens/Reader.tsx`

**Note:** The code snippets below are behavioral guidance, not mandatory literal implementation. The existing Reader component may have different state variable names, ref patterns, or effect structures. Choose the cleanest React-safe implementation that satisfies the invariants. Watch for stale closure risks — the event callbacks reference values like `chapterIndex` that may change during the reader session.

**Required invariants:**
1. `invoke("sync_pull_book", { bookId })` fires on reader mount (non-blocking, catch errors silently)
2. `invoke("sync_push_book", { bookId })` fires on reader unmount (fire-and-forget)
3. Listen for `sync-applied` event — refresh visible bookmarks/highlights from DB when received
4. Listen for `sync-progress-updated` event — apply remote progress only if user has not navigated or scrolled since mount
5. Clean up event listeners on unmount

- [ ] **Step 1: Add event listener imports**

In `Reader.tsx`, add import for Tauri event listening:

```typescript
import { listen } from "@tauri-apps/api/event";
```

- [ ] **Step 2: Add sync pull on mount and event listeners**

Add a ref to track whether the user has interacted (navigated or scrolled) since mount. Set it to `true` in the existing chapter navigation and scroll handlers.

Add a `useEffect` that depends only on `[bookId]` (not `loadHighlights` or `chapterIndex`):
1. Registers event listeners for `sync-applied` and `sync-progress-updated` FIRST
2. Then fires `sync_pull_book` (so events are never missed due to a race)
3. `sync-applied` callback uses a `loadHighlightsRef` to refresh bookmarks/highlights without causing the effect to re-run on chapter changes
4. `sync-progress-updated` callback reads `chapterIndexRef.current` (not a closure-captured value) to avoid stale comparison
5. Cleans up listeners on unmount

Be careful with stale closures — use refs for values that change during the reader session (like `chapterIndex`, `loadHighlights`) if they are referenced inside event callbacks.

- [ ] **Step 3: Add sync push on unmount**

Add a **separate** `useEffect` with `[]` deps for the sync push. Do NOT place it in the existing cleanup effect (which depends on `saveProgress`, `bookId`, `chapterIndex`) — that cleanup runs on every chapter change, not just unmount. Use a `bookIdRef` to read the current book ID without adding a dependency:

```typescript
useEffect(() => {
  return () => {
    const id = bookIdRef.current;
    if (id) {
      invoke("sync_push_book", { bookId: id }).catch(() => {});
    }
  };
}, []);
```

- [ ] **Step 4: Type-check**

Run: `npm run type-check 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 5: Run frontend tests**

Run: `npm run test 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/screens/Reader.tsx
git commit -m "feat(sync): hook sync into reader lifecycle

Pull on mount (non-blocking), push on unmount (fire-and-forget).
Listens for sync-applied to refresh bookmarks/highlights.
Listens for sync-progress-updated, applies only if user hasn't scrolled."
```

---

## Task 11: Full integration verification

- [ ] **Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 2: Run clippy**

Run: `cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -20`
Expected: No warnings

- [ ] **Step 3: Run fmt check**

Run: `cd src-tauri && cargo fmt --check 2>&1 | tail -10`
Expected: No formatting issues

- [ ] **Step 4: Run frontend type-check**

Run: `npm run type-check 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 5: Run frontend tests**

Run: `npm run test 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 6: Commit if any remaining changes**

If any formatting or minor fixes were needed, commit them.

```bash
git add -A
git commit -m "chore(sync): final cleanup and verification pass"
```
