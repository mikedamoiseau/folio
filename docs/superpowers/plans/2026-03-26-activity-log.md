# Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent activity log that records all data-changing operations (imports, deletions, metadata changes, backups, etc.) with a UI to browse and filter entries.

**Architecture:** New `activity_log` DB table with CRUD in `db.rs`. A thin `log_activity()` helper in `commands.rs` is called after each data-changing command succeeds or fails. A new `ActivityLog.tsx` component displays entries in a modal accessible from Settings. Log is capped at 1000 entries per profile via automatic pruning on insert.

**Tech Stack:** Rust (rusqlite, serde_json), React 19, TypeScript, Tailwind CSS v4

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src-tauri/src/models.rs` | `ActivityEntry` struct |
| `src-tauri/src/db.rs` | `activity_log` table schema, `insert_activity`, `get_activity_log`, `prune_activity_log` |
| `src-tauri/src/commands.rs` | `log_activity()` helper, `get_activity_log` command, calls to logger in 14 command handlers |
| `src-tauri/src/lib.rs` | Register `get_activity_log` command |
| `src/components/ActivityLog.tsx` | Modal component showing log entries with filtering |
| `src/components/SettingsPanel.tsx` | "View Activity Log" button |

---

### Task 1: Add ActivityEntry model and DB schema

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write tests for activity log DB operations**

Add to `src-tauri/src/db.rs` tests:

```rust
#[test]
fn test_activity_log_crud() {
    let conn = setup_test_db();
    let entry = crate::models::ActivityEntry {
        id: "act-1".to_string(),
        timestamp: 1000,
        action: "book_imported".to_string(),
        entity_type: "book".to_string(),
        entity_id: Some("book-1".to_string()),
        entity_name: Some("Dune".to_string()),
        detail: Some("Imported from /path/to/dune.epub".to_string()),
    };
    insert_activity(&conn, &entry).unwrap();

    let log = get_activity_log(&conn, 50, 0, None).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].action, "book_imported");
    assert_eq!(log[0].entity_name, Some("Dune".to_string()));
}

#[test]
fn test_activity_log_ordering() {
    let conn = setup_test_db();
    for i in 0..3 {
        let entry = crate::models::ActivityEntry {
            id: format!("act-{i}"),
            timestamp: 1000 + i as i64,
            action: "book_imported".to_string(),
            entity_type: "book".to_string(),
            entity_id: Some(format!("book-{i}")),
            entity_name: Some(format!("Book {i}")),
            detail: None,
        };
        insert_activity(&conn, &entry).unwrap();
    }
    let log = get_activity_log(&conn, 50, 0, None).unwrap();
    assert_eq!(log.len(), 3);
    // Most recent first
    assert_eq!(log[0].entity_name, Some("Book 2".to_string()));
    assert_eq!(log[2].entity_name, Some("Book 0".to_string()));
}

#[test]
fn test_activity_log_filter_by_action() {
    let conn = setup_test_db();
    insert_activity(&conn, &crate::models::ActivityEntry {
        id: "a1".into(), timestamp: 1000, action: "book_imported".into(),
        entity_type: "book".into(), entity_id: None, entity_name: None, detail: None,
    }).unwrap();
    insert_activity(&conn, &crate::models::ActivityEntry {
        id: "a2".into(), timestamp: 1001, action: "book_deleted".into(),
        entity_type: "book".into(), entity_id: None, entity_name: None, detail: None,
    }).unwrap();
    let log = get_activity_log(&conn, 50, 0, Some("book_imported")).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].action, "book_imported");
}

#[test]
fn test_activity_log_pruning() {
    let conn = setup_test_db();
    for i in 0..5 {
        insert_activity(&conn, &crate::models::ActivityEntry {
            id: format!("a{i}"), timestamp: 1000 + i as i64, action: "book_imported".into(),
            entity_type: "book".into(), entity_id: None, entity_name: None, detail: None,
        }).unwrap();
    }
    prune_activity_log(&conn, 3).unwrap();
    let log = get_activity_log(&conn, 50, 0, None).unwrap();
    assert_eq!(log.len(), 3);
    // Kept the 3 most recent
    assert_eq!(log[0].id, "a4");
    assert_eq!(log[2].id, "a2");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_activity_log -- --nocapture`
Expected: FAIL — `ActivityEntry` and functions don't exist.

- [ ] **Step 3: Add ActivityEntry to models.rs**

In `src-tauri/src/models.rs`, add after the `Collection` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub timestamp: i64,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub entity_name: Option<String>,
    pub detail: Option<String>,
}
```

- [ ] **Step 4: Add activity_log table schema to db.rs**

In `src-tauri/src/db.rs`, add to the `run_schema` batch SQL (inside the existing `conn.execute_batch(...)` call, before the closing `"`):

```sql
CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    entity_name TEXT,
    detail TEXT
);
```

Also add to the `use crate::models::` import at the top: `ActivityEntry`.

- [ ] **Step 5: Implement DB functions**

Add to `src-tauri/src/db.rs`:

```rust
pub fn insert_activity(conn: &Connection, entry: &ActivityEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO activity_log (id, timestamp, action, entity_type, entity_id, entity_name, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![entry.id, entry.timestamp, entry.action, entry.entity_type, entry.entity_id, entry.entity_name, entry.detail],
    )?;
    Ok(())
}

pub fn get_activity_log(
    conn: &Connection,
    limit: u32,
    offset: u32,
    action_filter: Option<&str>,
) -> Result<Vec<ActivityEntry>> {
    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(action) = action_filter {
        (
            "SELECT id, timestamp, action, entity_type, entity_id, entity_name, detail FROM activity_log WHERE action = ?1 ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3".to_string(),
            vec![Box::new(action.to_string()), Box::new(limit), Box::new(offset)],
        )
    } else {
        (
            "SELECT id, timestamp, action, entity_type, entity_id, entity_name, detail FROM activity_log ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2".to_string(),
            vec![Box::new(limit), Box::new(offset)],
        )
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
        Ok(ActivityEntry {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            action: row.get(2)?,
            entity_type: row.get(3)?,
            entity_id: row.get(4)?,
            entity_name: row.get(5)?,
            detail: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn prune_activity_log(conn: &Connection, keep: u32) -> Result<()> {
    conn.execute(
        "DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY timestamp DESC LIMIT ?1)",
        params![keep],
    )?;
    Ok(())
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test test_activity_log -- --nocapture`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs
git commit -m "feat(log): add ActivityEntry model and activity_log DB table with CRUD"
```

---

### Task 2: Add log_activity helper and Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the log_activity helper function**

In `src-tauri/src/commands.rs`, add a helper near the top (after the `AppState` impl block):

```rust
/// Log a data-changing operation to the activity log.
fn log_activity(
    conn: &rusqlite::Connection,
    action: &str,
    entity_type: &str,
    entity_id: Option<&str>,
    entity_name: Option<&str>,
    detail: Option<&str>,
) {
    let entry = crate::models::ActivityEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        action: action.to_string(),
        entity_type: entity_type.to_string(),
        entity_id: entity_id.map(|s| s.to_string()),
        entity_name: entity_name.map(|s| s.to_string()),
        detail: detail.map(|s| s.to_string()),
    };
    let _ = db::insert_activity(conn, &entry);
    // Prune to 1000 entries (runs every insert but the DELETE is fast with an index)
    let _ = db::prune_activity_log(conn, 1000);
}
```

- [ ] **Step 2: Add the get_activity_log Tauri command**

```rust
#[tauri::command]
pub async fn get_activity_log(
    limit: Option<u32>,
    offset: Option<u32>,
    action_filter: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::ActivityEntry>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::get_activity_log(
        &conn,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
        action_filter.as_deref(),
    )
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register in lib.rs**

Add `commands::get_activity_log` to the `invoke_handler` list in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(log): add log_activity helper and get_activity_log command"
```

---

### Task 3: Instrument all data-changing commands with logging

**Files:**
- Modify: `src-tauri/src/commands.rs`

Add `log_activity(...)` calls to each of these 14 commands. Each call goes **after** the operation succeeds. Use a consistent pattern:

- [ ] **Step 1: Instrument import_book**

After the book is successfully inserted into the DB and before returning, add:
```rust
log_activity(&conn, "book_imported", "book", Some(&book.id), Some(&book.title),
    Some(&format!("{} ({})", book.format, book.author)));
```

Note: `import_book` uses a fresh connection inside. Get the connection reference where the book has just been inserted.

- [ ] **Step 2: Instrument remove_book**

Before deleting (while we still have the book info), log:
```rust
log_activity(&conn, "book_deleted", "book", Some(&book_id), Some(&book.title), None);
```

- [ ] **Step 3: Instrument update_book_metadata**

After the update succeeds:
```rust
let mut changes = Vec::new();
if title.is_some() { changes.push("title"); }
if author.is_some() { changes.push("author"); }
if series.is_some() { changes.push("series"); }
if volume.is_some() { changes.push("volume"); }
if language.is_some() { changes.push("language"); }
if publisher.is_some() { changes.push("publisher"); }
if publish_year.is_some() { changes.push("year"); }
if cover_image_path.is_some() { changes.push("cover"); }
if !changes.is_empty() {
    log_activity(&conn, "book_updated", "book", Some(&book_id), Some(&updated.title),
        Some(&format!("Changed: {}", changes.join(", "))));
}
```

- [ ] **Step 4: Instrument enrich_book_from_openlibrary**

After enrichment succeeds:
```rust
log_activity(&conn, "book_enriched", "book", Some(&book_id), None,
    Some("Enriched from OpenLibrary"));
```

- [ ] **Step 5: Instrument scan_single_book**

After successful enrichment:
```rust
log_activity(&conn, "book_scanned", "book", Some(&book_id), Some(&book.title),
    Some(&format!("Matched via {}", result.data.source)));
```

On "No match found", also log:
```rust
log_activity(&conn, "book_scanned", "book", Some(&book_id), Some(&book.title),
    Some("No match found"));
```

- [ ] **Step 6: Instrument collection commands**

In `create_collection`:
```rust
log_activity(&conn, "collection_created", "collection", Some(&collection.id), Some(&name), None);
```

In `delete_collection`:
```rust
log_activity(&conn, "collection_deleted", "collection", Some(&collection_id), None, None);
```

In `add_book_to_collection`:
```rust
log_activity(&conn, "collection_modified", "collection", Some(&collection_id), None,
    Some(&format!("Added book {}", book_id)));
```

In `remove_book_from_collection`:
```rust
log_activity(&conn, "collection_modified", "collection", Some(&collection_id), None,
    Some(&format!("Removed book {}", book_id)));
```

- [ ] **Step 7: Instrument backup/restore/export commands**

In `export_library` (after success):
```rust
log_activity(&conn, "library_exported", "library", None, None,
    Some(if include_files { "Full backup with files" } else { "Metadata only" }));
```

In `import_library_backup` (after success):
```rust
log_activity(&conn, "library_imported", "library", None, None, Some("Restored from backup"));
```

In `run_backup` (after success):
```rust
log_activity(&conn, "backup_completed", "library", None, None,
    Some(&format!("Remote backup to {}", provider)));
```

- [ ] **Step 8: Instrument switch_profile**

After profile switch:
```rust
log_activity(&conn, "profile_switched", "profile", None, Some(&profile_name), None);
```

Note: use the NEW profile's connection for this log entry so the log lives in the profile that was switched TO.

- [ ] **Step 9: Run full test suite**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(log): instrument 14 data-changing commands with activity logging"
```

---

### Task 4: Create ActivityLog frontend component

**Files:**
- Create: `src/components/ActivityLog.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/ActivityLog.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ActivityEntry {
  id: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  detail: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  book_imported: "Book Imported",
  book_deleted: "Book Deleted",
  book_updated: "Book Updated",
  book_enriched: "Book Enriched",
  book_scanned: "Metadata Scan",
  collection_created: "Collection Created",
  collection_deleted: "Collection Deleted",
  collection_modified: "Collection Modified",
  library_exported: "Library Exported",
  library_imported: "Library Imported",
  backup_completed: "Backup Completed",
  profile_switched: "Profile Switched",
};

const ACTION_ICONS: Record<string, string> = {
  book_imported: "+",
  book_deleted: "−",
  book_updated: "✎",
  book_enriched: "✦",
  book_scanned: "✦",
  collection_created: "◈",
  collection_deleted: "◈",
  collection_modified: "◈",
  library_exported: "↑",
  library_imported: "↓",
  backup_completed: "☁",
  profile_switched: "⇄",
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

interface ActivityLogProps {
  onClose: () => void;
}

export default function ActivityLog({ onClose }: ActivityLogProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<ActivityEntry[]>("get_activity_log", {
        limit: 200,
        actionFilter: filter === "all" ? null : filter,
      });
      setEntries(result);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const actionTypes = Array.from(new Set(entries.map((e) => e.action))).sort();

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-lg pointer-events-auto flex flex-col"
          style={{ maxHeight: "80vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between shrink-0">
            <h2 className="font-serif text-base font-semibold text-ink">Activity Log</h2>
            <button onClick={onClose} className="text-ink-muted hover:text-ink p-1" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Filter */}
          <div className="px-5 py-3 border-b border-warm-border shrink-0">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="text-xs bg-warm-subtle border border-warm-border rounded-lg px-2 py-1.5 text-ink focus:outline-none focus:border-accent"
            >
              <option value="all">All actions</option>
              {Object.entries(ACTION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          {/* Entries */}
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {loading ? (
              <p className="text-xs text-ink-muted text-center py-8">Loading...</p>
            ) : entries.length === 0 ? (
              <p className="text-xs text-ink-muted text-center py-8">No activity recorded yet.</p>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2.5 py-2 border-b border-warm-border/50 last:border-0">
                    <span className="w-5 h-5 rounded-full bg-warm-subtle flex items-center justify-center text-[10px] text-ink-muted shrink-0 mt-0.5">
                      {ACTION_ICONS[entry.action] ?? "•"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-ink">
                          {ACTION_LABELS[entry.action] ?? entry.action}
                        </span>
                        <span className="text-[10px] text-ink-muted shrink-0">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                      {entry.entityName && (
                        <p className="text-xs text-ink-muted truncate">{entry.entityName}</p>
                      )}
                      {entry.detail && (
                        <p className="text-[10px] text-ink-muted/70 truncate">{entry.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/ActivityLog.tsx
git commit -m "feat(ui): create ActivityLog modal component"
```

---

### Task 5: Add "View Activity Log" button to SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Import the ActivityLog component**

At the top of `SettingsPanel.tsx`:
```typescript
import ActivityLog from "./ActivityLog";
```

- [ ] **Step 2: Add state for showing the log**

```typescript
const [showActivityLog, setShowActivityLog] = useState(false);
```

- [ ] **Step 3: Add the button in the settings panel**

After the last section (Remote Backup) and before the closing `</div>` of the scrollable content area, add a new section:

```tsx
<section>
  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
    Activity
  </h3>
  <button
    type="button"
    onClick={() => setShowActivityLog(true)}
    className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
  >
    View activity log
  </button>
</section>
```

- [ ] **Step 4: Render the modal conditionally**

At the end of the component's return (before the final `</>`), add:
```tsx
{showActivityLog && (
  <ActivityLog onClose={() => setShowActivityLog(false)} />
)}
```

- [ ] **Step 5: Run type-check and tests**

Run: `npm run type-check && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(ui): add 'View Activity Log' button to settings panel"
```

---

### Task 6: Run full CI checks

- [ ] **Step 1: Rust checks**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

- [ ] **Step 2: Frontend checks**

```bash
npm run type-check && npm run test
```

- [ ] **Step 3: Fix any failures**
