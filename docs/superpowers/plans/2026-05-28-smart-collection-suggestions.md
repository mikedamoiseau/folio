# Smart Collection Auto-Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Suggest Collections" button to CollectionsSidebar that analyzes library patterns and offers rule-based collection templates as rich cards.

**Architecture:** Single Tauri command `get_collection_suggestions` runs four heuristic queries (author, series, reading status, format) in Rust, deduplicates against existing automated collections, and returns ranked suggestions. Frontend renders suggestion cards inline in the sidebar with Add/Edit/Dismiss actions.

**Tech Stack:** Rust (rusqlite), React 19, Tauri v2 IPC, Tailwind CSS v4

---

### Task 1: Add `CollectionSuggestion` Model

**Files:**
- Modify: `folio-core/src/models.rs:161` (after `Collection` struct)

- [ ] **Step 1: Add the struct**

Add after the `Collection` struct (line 161) in `folio-core/src/models.rs`:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSuggestion {
    pub name: String,
    pub icon: String,
    pub color: String,
    pub rules: Vec<NewRuleInput>,
    pub matched_book_count: usize,
    pub heuristic_type: String,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p folio-core`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add folio-core/src/models.rs
git commit -m "feat(models): add CollectionSuggestion struct"
```

---

### Task 2: Implement Author Heuristic with Tests

**Files:**
- Modify: `folio-core/src/db.rs:1959` (before `#[cfg(test)]`)
- Modify: `folio-core/src/db.rs` test module (after line 1961)

- [ ] **Step 1: Write the failing test**

Add to the test module in `folio-core/src/db.rs`:

```rust
#[test]
fn test_suggest_author_collections() {
    let (_dir, conn) = setup();

    for i in 0..4 {
        let mut book = sample_book(&format!("author-test-{i}"));
        book.author = "J.R.R. Tolkien".to_string();
        book.title = format!("Book {i}");
        insert_book(&conn, &book).unwrap();
    }
    // Add 2 books by another author (below threshold)
    for i in 0..2 {
        let mut book = sample_book(&format!("other-{i}"));
        book.author = "Other Author".to_string();
        book.title = format!("Other {i}");
        insert_book(&conn, &book).unwrap();
    }

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    let author_suggestions: Vec<_> = suggestions
        .iter()
        .filter(|s| s.heuristic_type == "author")
        .collect();

    assert_eq!(author_suggestions.len(), 1);
    assert_eq!(author_suggestions[0].name, "Books by J.R.R. Tolkien");
    assert_eq!(author_suggestions[0].matched_book_count, 4);
    assert_eq!(author_suggestions[0].rules.len(), 1);
    assert_eq!(author_suggestions[0].rules[0].field, "author");
    assert_eq!(author_suggestions[0].rules[0].operator, "equals");
    assert_eq!(author_suggestions[0].rules[0].value, "J.R.R. Tolkien");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core test_suggest_author_collections`
Expected: FAIL — `get_collection_suggestions` not found

- [ ] **Step 3: Implement `get_collection_suggestions` with author heuristic**

Add before `#[cfg(test)]` (line 1959) in `folio-core/src/db.rs`:

```rust
pub fn get_collection_suggestions(
    conn: &Connection,
    existing_collections: &[Collection],
) -> Result<Vec<CollectionSuggestion>> {
    let mut suggestions = Vec::new();
    let colors = [
        "#c2714e", "#6b8f71", "#7a6b9a", "#4e7a8f", "#8f7a4e", "#8f4e4e", "#4e8f8a",
        "#666666",
    ];
    let mut color_idx = 0;

    let existing_rules: Vec<(&str, &str, &str)> = existing_collections
        .iter()
        .filter(|c| matches!(c.r#type, CollectionType::Automated))
        .flat_map(|c| {
            c.rules
                .iter()
                .map(|r| (r.field.as_str(), r.operator.as_str(), r.value.as_str()))
        })
        .collect();

    // Author heuristic: authors with 3+ books
    {
        let mut stmt = conn.prepare(
            "SELECT author, COUNT(*) as cnt FROM books \
             WHERE author IS NOT NULL AND author != '' \
             GROUP BY author HAVING cnt >= 3 \
             ORDER BY cnt DESC LIMIT 5",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })?;
        for row in rows {
            let (author, count) = row?;
            if existing_rules
                .iter()
                .any(|(f, o, v)| *f == "author" && *o == "equals" && *v == author)
            {
                continue;
            }
            suggestions.push(CollectionSuggestion {
                name: format!("Books by {author}"),
                icon: "📖".to_string(),
                color: colors[color_idx % colors.len()].to_string(),
                rules: vec![NewRuleInput {
                    field: "author".to_string(),
                    operator: "equals".to_string(),
                    value: author,
                }],
                matched_book_count: count,
                heuristic_type: "author".to_string(),
            });
            color_idx += 1;
        }
    }

    suggestions.sort_by(|a, b| b.matched_book_count.cmp(&a.matched_book_count));
    suggestions.truncate(8);
    Ok(suggestions)
}
```

- [ ] **Step 4: Add import for `CollectionSuggestion`**

At the top of `folio-core/src/db.rs`, in the `use crate::models::` block, add `CollectionSuggestion` and `NewRuleInput` to the import list.

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p folio-core test_suggest_author_collections`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add collection suggestion engine with author heuristic"
```

---

### Task 3: Add Series Heuristic

**Files:**
- Modify: `folio-core/src/db.rs` — `get_collection_suggestions` function and test module

- [ ] **Step 1: Write the failing test**

Add to test module:

```rust
#[test]
fn test_suggest_series_collections() {
    let (_dir, conn) = setup();

    for i in 0..3 {
        let mut book = sample_book(&format!("series-{i}"));
        book.series = Some("Discworld".to_string());
        book.volume = Some(i as f64 + 1.0);
        book.title = format!("Discworld {}", i + 1);
        insert_book(&conn, &book).unwrap();
    }

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    let series_suggestions: Vec<_> = suggestions
        .iter()
        .filter(|s| s.heuristic_type == "series")
        .collect();

    assert_eq!(series_suggestions.len(), 1);
    assert_eq!(series_suggestions[0].name, "Discworld series");
    assert_eq!(series_suggestions[0].matched_book_count, 3);
    assert_eq!(series_suggestions[0].rules[0].field, "series");
    assert_eq!(series_suggestions[0].rules[0].operator, "equals");
    assert_eq!(series_suggestions[0].rules[0].value, "Discworld");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core test_suggest_series_collections`
Expected: FAIL — no series suggestions returned (heuristic not implemented yet)

- [ ] **Step 3: Add series heuristic to `get_collection_suggestions`**

Add inside `get_collection_suggestions`, after the author heuristic block and before the final sort/truncate:

```rust
    // Series heuristic: series with 2+ books
    {
        let mut stmt = conn.prepare(
            "SELECT series, COUNT(*) as cnt FROM books \
             WHERE series IS NOT NULL AND series != '' \
             GROUP BY series HAVING cnt >= 2 \
             ORDER BY cnt DESC LIMIT 5",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })?;
        for row in rows {
            let (series, count) = row?;
            if existing_rules
                .iter()
                .any(|(f, o, v)| *f == "series" && *o == "equals" && *v == series)
            {
                continue;
            }
            suggestions.push(CollectionSuggestion {
                name: format!("{series} series"),
                icon: "📚".to_string(),
                color: colors[color_idx % colors.len()].to_string(),
                rules: vec![NewRuleInput {
                    field: "series".to_string(),
                    operator: "equals".to_string(),
                    value: series,
                }],
                matched_book_count: count,
                heuristic_type: "series".to_string(),
            });
            color_idx += 1;
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core test_suggest_series_collections`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add series heuristic to collection suggestions"
```

---

### Task 4: Add Reading Status Heuristic

**Files:**
- Modify: `folio-core/src/db.rs` — `get_collection_suggestions` function and test module

- [ ] **Step 1: Write the failing test**

Add to test module:

```rust
#[test]
fn test_suggest_reading_status() {
    let (_dir, conn) = setup();

    // 4 books with no reading progress → "unread"
    for i in 0..4 {
        let mut book = sample_book(&format!("unread-{i}"));
        book.title = format!("Unread Book {i}");
        insert_book(&conn, &book).unwrap();
    }

    // 3 finished books
    for i in 0..3 {
        let mut book = sample_book(&format!("finished-{i}"));
        book.title = format!("Finished Book {i}");
        book.total_chapters = 5;
        insert_book(&conn, &book).unwrap();
        let progress = ReadingProgress {
            book_id: format!("finished-{i}"),
            chapter_index: 4, // >= total_chapters - 1
            scroll_position: 1.0,
            last_read_at: 1700000000,
        };
        upsert_reading_progress(&conn, &progress).unwrap();
    }

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    let status_suggestions: Vec<_> = suggestions
        .iter()
        .filter(|s| s.heuristic_type == "reading_status")
        .collect();

    assert_eq!(status_suggestions.len(), 2);

    let unread = status_suggestions.iter().find(|s| s.name == "Unread books").unwrap();
    assert_eq!(unread.matched_book_count, 4);
    assert_eq!(unread.rules[0].value, "unread");

    let finished = status_suggestions.iter().find(|s| s.name == "Finished books").unwrap();
    assert_eq!(finished.matched_book_count, 3);
    assert_eq!(finished.rules[0].value, "finished");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core test_suggest_reading_status`
Expected: FAIL — no reading_status suggestions returned

- [ ] **Step 3: Add reading status heuristic**

Add inside `get_collection_suggestions`, after series heuristic, before final sort/truncate:

```rust
    // Reading status heuristic: unread and finished
    {
        // Unread: books with no reading_progress entry
        let unread_count: usize = conn.query_row(
            "SELECT COUNT(*) FROM books b \
             LEFT JOIN reading_progress rp ON rp.book_id = b.id \
             WHERE rp.book_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        if unread_count >= 3
            && !existing_rules
                .iter()
                .any(|(f, o, v)| *f == "reading_progress" && *o == "equals" && *v == "unread")
        {
            suggestions.push(CollectionSuggestion {
                name: "Unread books".to_string(),
                icon: "🎯".to_string(),
                color: colors[color_idx % colors.len()].to_string(),
                rules: vec![NewRuleInput {
                    field: "reading_progress".to_string(),
                    operator: "equals".to_string(),
                    value: "unread".to_string(),
                }],
                matched_book_count: unread_count,
                heuristic_type: "reading_status".to_string(),
            });
            color_idx += 1;
        }

        // Finished: books where chapter_index >= total_chapters - 1
        let finished_count: usize = conn.query_row(
            "SELECT COUNT(*) FROM books b \
             JOIN reading_progress rp ON rp.book_id = b.id \
             WHERE rp.chapter_index >= b.total_chapters - 1 AND b.total_chapters > 0",
            [],
            |row| row.get(0),
        )?;
        if finished_count >= 2
            && !existing_rules
                .iter()
                .any(|(f, o, v)| *f == "reading_progress" && *o == "equals" && *v == "finished")
        {
            suggestions.push(CollectionSuggestion {
                name: "Finished books".to_string(),
                icon: "🏆".to_string(),
                color: colors[color_idx % colors.len()].to_string(),
                rules: vec![NewRuleInput {
                    field: "reading_progress".to_string(),
                    operator: "equals".to_string(),
                    value: "finished".to_string(),
                }],
                matched_book_count: finished_count,
                heuristic_type: "reading_status".to_string(),
            });
            color_idx += 1;
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core test_suggest_reading_status`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add reading status heuristic to collection suggestions"
```

---

### Task 5: Add Format Heuristic

**Files:**
- Modify: `folio-core/src/db.rs` — `get_collection_suggestions` function and test module

- [ ] **Step 1: Write the failing test**

Add to test module:

```rust
#[test]
fn test_suggest_format() {
    let (_dir, conn) = setup();

    // 10 EPUBs (dominant — should be skipped)
    for i in 0..10 {
        let mut book = sample_book(&format!("epub-{i}"));
        book.title = format!("Epub Book {i}");
        book.format = BookFormat::Epub;
        insert_book(&conn, &book).unwrap();
    }
    // 3 PDFs (non-dominant — should be suggested)
    for i in 0..3 {
        let mut book = sample_book(&format!("pdf-{i}"));
        book.title = format!("PDF Book {i}");
        book.format = BookFormat::Pdf;
        book.file_path = format!("/tmp/test-{i}.pdf");
        insert_book(&conn, &book).unwrap();
    }

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    let format_suggestions: Vec<_> = suggestions
        .iter()
        .filter(|s| s.heuristic_type == "format")
        .collect();

    // EPUB >80% so skipped; PDF = 3 books so suggested
    assert_eq!(format_suggestions.len(), 1);
    assert_eq!(format_suggestions[0].name, "PDF Books");
    assert_eq!(format_suggestions[0].matched_book_count, 3);
    assert_eq!(format_suggestions[0].rules[0].field, "format");
    assert_eq!(format_suggestions[0].rules[0].value, "pdf");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p folio-core test_suggest_format`
Expected: FAIL — no format suggestions returned

- [ ] **Step 3: Add format heuristic**

Add inside `get_collection_suggestions`, after reading status heuristic, before final sort/truncate:

```rust
    // Format heuristic: non-dominant formats with 3+ books
    {
        let total_books: usize =
            conn.query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))?;
        if total_books > 0 {
            let mut stmt = conn.prepare(
                "SELECT format, COUNT(*) as cnt FROM books \
                 GROUP BY format HAVING cnt >= 3 \
                 ORDER BY cnt DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
            })?;
            let threshold = (total_books as f64 * 0.8) as usize;
            for row in rows {
                let (format, count) = row?;
                if count > threshold {
                    continue;
                }
                if existing_rules
                    .iter()
                    .any(|(f, o, v)| *f == "format" && *o == "equals" && *v == format)
                {
                    continue;
                }
                let display_name = format.to_uppercase();
                suggestions.push(CollectionSuggestion {
                    name: format!("{display_name} Books"),
                    icon: "📄".to_string(),
                    color: colors[color_idx % colors.len()].to_string(),
                    rules: vec![NewRuleInput {
                        field: "format".to_string(),
                        operator: "equals".to_string(),
                        value: format,
                    }],
                    matched_book_count: count,
                    heuristic_type: "format".to_string(),
                });
                color_idx += 1;
            }
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core test_suggest_format`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(db): add format heuristic to collection suggestions"
```

---

### Task 6: Add Dedup and Limit Tests

**Files:**
- Modify: `folio-core/src/db.rs` test module

- [ ] **Step 1: Write dedup test**

```rust
#[test]
fn test_dedup_existing_collections() {
    let (_dir, conn) = setup();

    for i in 0..4 {
        let mut book = sample_book(&format!("dedup-{i}"));
        book.author = "Agatha Christie".to_string();
        book.title = format!("Mystery {i}");
        insert_book(&conn, &book).unwrap();
    }

    // Simulate existing automated collection with same author rule
    let existing = vec![Collection {
        id: "existing-1".to_string(),
        name: "Christie Books".to_string(),
        r#type: CollectionType::Automated,
        icon: None,
        color: None,
        created_at: 0,
        updated_at: 0,
        rules: vec![CollectionRule {
            id: "rule-1".to_string(),
            collection_id: "existing-1".to_string(),
            field: "author".to_string(),
            operator: "equals".to_string(),
            value: "Agatha Christie".to_string(),
        }],
    }];

    let suggestions = get_collection_suggestions(&conn, &existing).unwrap();
    let author_suggestions: Vec<_> = suggestions
        .iter()
        .filter(|s| s.heuristic_type == "author")
        .collect();

    assert_eq!(author_suggestions.len(), 0);
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p folio-core test_dedup_existing_collections`
Expected: PASS (dedup already implemented in Task 2)

- [ ] **Step 3: Write small library test**

```rust
#[test]
fn test_no_suggestions_small_library() {
    let (_dir, conn) = setup();

    let book = sample_book("lonely-book");
    insert_book(&conn, &book).unwrap();

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    assert!(suggestions.is_empty());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p folio-core test_no_suggestions_small_library`
Expected: PASS

- [ ] **Step 5: Write suggestion limit test**

```rust
#[test]
fn test_suggestion_limit() {
    let (_dir, conn) = setup();

    // Create 10 distinct authors with 3+ books each → 10 potential suggestions
    for a in 0..10 {
        for i in 0..3 {
            let mut book = sample_book(&format!("limit-{a}-{i}"));
            book.author = format!("Author {a}");
            book.title = format!("Book {a}-{i}");
            insert_book(&conn, &book).unwrap();
        }
    }

    let suggestions = get_collection_suggestions(&conn, &[]).unwrap();
    assert!(suggestions.len() <= 8);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test -p folio-core test_suggestion_limit`
Expected: PASS

- [ ] **Step 7: Run all suggestion tests together**

Run: `cargo test -p folio-core test_suggest -- --test-threads=1`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "test(db): add dedup, small library, and limit tests for suggestions"
```

---

### Task 7: Add Tauri Command

**Files:**
- Modify: `src-tauri/src/commands.rs:9-13` (imports) and after `preview_collection_rules` command
- Modify: `src-tauri/src/lib.rs:345` (invoke_handler registration)

- [ ] **Step 1: Add import**

In `src-tauri/src/commands.rs`, add `CollectionSuggestion` to the model imports (line ~11):

```rust
use crate::models::{
    AutoBackup, Book, BookFormat, BookGridItem, Bookmark, ChapterMeta, CleanupEntry,
    CleanupProgress, CleanupResult, Collection, CollectionRule, CollectionSuggestion,
    CollectionType, CustomFont, FeatureFlag, Highlight, HighlightSearchResult, NewRuleInput,
    ReadingProgress, SeriesInfo,
};
```

- [ ] **Step 2: Add the command**

Add after the `preview_collection_rules` command in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn get_collection_suggestions(
    state: State<'_, AppState>,
) -> FolioResult<Vec<CollectionSuggestion>> {
    let conn = state.active_db()?.get()?;
    let collections = db::list_collections(&conn)?;
    Ok(db::get_collection_suggestions(&conn, &collections)?)
}
```

- [ ] **Step 3: Register in invoke_handler**

In `src-tauri/src/lib.rs`, add after line 345 (`commands::preview_collection_rules,`):

```rust
            commands::get_collection_suggestions,
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check` (from `src-tauri/`)
Expected: compiles with no errors

- [ ] **Step 5: Run clippy**

Run: `cargo clippy -- -D warnings` (from `src-tauri/`)
Expected: no warnings

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add get_collection_suggestions Tauri command"
```

---

### Task 8: Add Frontend Suggestion UI

**Files:**
- Modify: `src/components/CollectionsSidebar.tsx`

- [ ] **Step 1: Add TypeScript interface**

Add after the `CreateCollectionData` interface (line ~31) in `CollectionsSidebar.tsx`:

```typescript
interface CollectionSuggestion {
  name: string;
  icon: string;
  color: string;
  rules: Omit<CollectionRule, "id">[];
  matchedBookCount: number;
  heuristicType: string;
}
```

- [ ] **Step 2: Extend formMode to support pre-filled create**

Change the `formMode` state type (line 642) from:

```typescript
const [formMode, setFormMode] = useState<{ mode: "create" } | { mode: "edit"; collection: Collection } | null>(null);
```

to:

```typescript
const [formMode, setFormMode] = useState<
  | { mode: "create"; prefill?: CreateCollectionData }
  | { mode: "edit"; collection: Collection }
  | null
>(null);
```

Update the create `<CollectionForm>` rendering (line ~660) to pass `prefill` as initial:

```tsx
{formMode?.mode === "create" ? (
  <CollectionForm
    initial={formMode.prefill ? {
      id: "",
      name: formMode.prefill.name,
      type: formMode.prefill.type,
      icon: formMode.prefill.icon,
      color: formMode.prefill.color,
      rules: formMode.prefill.rules.map((r, i) => ({ ...r, id: `prefill-${i}` })),
    } : undefined}
    onSave={handleCreate}
    onCancel={() => setFormMode(null)}
  />
```

- [ ] **Step 3: Add suggestion state and fetch handler**

Add after `formMode` state declaration:

```typescript
const [suggestions, setSuggestions] = useState<CollectionSuggestion[]>([]);
const [showSuggestions, setShowSuggestions] = useState(false);
const [loadingSuggestions, setLoadingSuggestions] = useState(false);

const handleSuggest = async () => {
  setLoadingSuggestions(true);
  try {
    const result = await invoke<CollectionSuggestion[]>("get_collection_suggestions");
    setSuggestions(result);
    setShowSuggestions(true);
  } finally {
    setLoadingSuggestions(false);
  }
};

const handleAcceptSuggestion = async (suggestion: CollectionSuggestion) => {
  await onCreate({
    name: suggestion.name,
    type: "automated",
    icon: suggestion.icon,
    color: suggestion.color,
    rules: suggestion.rules,
  });
  setSuggestions((prev) => prev.filter((s) => s !== suggestion));
};

const handleEditSuggestion = (suggestion: CollectionSuggestion) => {
  setFormMode({
    mode: "create",
    prefill: {
      name: suggestion.name,
      type: "automated",
      icon: suggestion.icon,
      color: suggestion.color,
      rules: suggestion.rules,
    },
  });
  setSuggestions((prev) => prev.filter((s) => s !== suggestion));
};

const handleDismissSuggestion = (suggestion: CollectionSuggestion) => {
  setSuggestions((prev) => prev.filter((s) => s !== suggestion));
  if (suggestions.length <= 1) setShowSuggestions(false);
};
```

- [ ] **Step 4: Add suggestion cards JSX**

Add after the collections `</nav>` (line ~758) and before the `{/* Footer */}` comment (line ~760):

```tsx
            {/* Suggestion cards */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="px-3 py-2 border-t border-warm-border">
                <div className="text-[10px] uppercase tracking-wider text-ink-muted/50 mb-2 font-medium">
                  {t("collections.suggested", "Suggested")}
                </div>
                <div className="space-y-2">
                  {suggestions.map((s, i) => (
                    <div
                      key={`${s.heuristicType}-${s.name}-${i}`}
                      className="border border-warm-border rounded-lg p-2.5 bg-warm-subtle/30"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">{s.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate">{s.name}</div>
                          <div className="text-[10px] text-ink-muted/50">
                            {s.matchedBookCount} {t("collections.booksMatch", "books match")} &bull; {s.heuristicType}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleAcceptSuggestion(s)}
                          className="flex-1 text-[11px] py-1 px-2 rounded font-medium text-white transition-colors"
                          style={{ backgroundColor: s.color }}
                        >
                          {t("collections.add", "Add")}
                        </button>
                        <button
                          onClick={() => handleEditSuggestion(s)}
                          className="text-[11px] py-1 px-2 rounded text-ink-muted hover:bg-warm-border transition-colors"
                        >
                          {t("collections.edit", "Edit")}
                        </button>
                        <button
                          onClick={() => handleDismissSuggestion(s)}
                          className="text-[11px] py-1 px-2 rounded text-ink-muted/40 hover:text-ink-muted transition-colors"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {showSuggestions && suggestions.length === 0 && !loadingSuggestions && (
              <div className="px-3 py-3 border-t border-warm-border text-center text-xs text-ink-muted/50">
                {t("collections.noSuggestions", "No suggestions — your library is well-organized!")}
              </div>
            )}
```

- [ ] **Step 5: Add Suggest Collections button**

In the footer `<div>` (line ~760), add a second button after the existing "New Collection" button:

```tsx
              <button
                onClick={handleSuggest}
                disabled={loadingSuggestions}
                className="w-full flex items-center justify-center gap-1.5 py-2 mt-1.5 text-xs font-medium text-ink-muted hover:bg-warm-border rounded-lg transition-colors disabled:opacity-50"
              >
                {loadingSuggestions ? (
                  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                    <path d="M10 2l2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                )}
                {t("collections.suggest", "Suggest Collections")}
              </button>
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npm run type-check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/components/CollectionsSidebar.tsx
git commit -m "feat(ui): add suggestion cards and Suggest Collections button to sidebar"
```

---

### Task 9: Full CI Verification

**Files:** None (verification only)

- [ ] **Step 1: Run Rust formatting check**

Run: `cargo fmt --check` (from `src-tauri/`)
Expected: no formatting issues. If issues found, run `cargo fmt` and re-commit.

- [ ] **Step 2: Run Rust linter**

Run: `cargo clippy -- -D warnings` (from `src-tauri/`)
Expected: no warnings

- [ ] **Step 3: Run all Rust tests**

Run: `cargo test` (from `src-tauri/`)
Expected: all pass

- [ ] **Step 4: Run TypeScript type check**

Run: `npm run type-check`
Expected: no errors

- [ ] **Step 5: Run frontend tests**

Run: `npm run test`
Expected: all pass

- [ ] **Step 6: Manual smoke test**

Run: `npm run tauri dev`
1. Open Collections sidebar
2. Click "Suggest Collections" button
3. Verify suggestion cards appear (or empty message if library is small)
4. Click "Add" on a suggestion — verify collection appears in list
5. Click "Edit" on a suggestion — verify form opens pre-filled
6. Click "✕" on a suggestion — verify card dismissed
7. Click "Suggest Collections" again — verify accepted collections don't reappear
