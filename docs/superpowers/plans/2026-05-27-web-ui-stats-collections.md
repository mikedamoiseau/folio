# Web UI Reading Stats & Collections Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reading stats and collections browser views to the Folio web UI, plus the `/api/stats` backend endpoint.

**Architecture:** Extend the existing vanilla JS SPA (`app.js`) with two new hash routes (`#/stats`, `#/collections`) and add header nav icons to all views. Backend adds one new endpoint (`GET /api/stats`) and extends the existing collections list endpoint with book counts. All frontend work is CSS + vanilla JS — no build step, no dependencies.

**Tech Stack:** Rust/Axum (backend), vanilla JS/CSS (frontend), Playwright (e2e tests)

**Spec:** `docs/superpowers/specs/2026-05-27-web-ui-stats-collections-design.md`

**Note:** The `ReadingStats` struct uses `#[serde(rename_all = "camelCase")]`, so the `/api/stats` response uses camelCase field names (e.g., `totalReadingTimeSecs`), not snake_case as the spec originally stated. The frontend code in this plan uses the correct camelCase names.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/src/web_server/api.rs` | Add `GET /api/stats` endpoint, extend `list_collections` with book counts |
| Modify | `src-tauri/src/web_server/static/app.js` | Add router entries, `showStats()`, `showCollections()`, `formatDuration()`, nav icons helper |
| Modify | `src-tauri/src/web_server/static/app.css` | Stats cards, chart bars, collection rows, toolbar, nav icon styles |
| Create | `e2e/web-ui-stats-collections.spec.ts` | Playwright e2e tests for stats and collections pages |
| Create | `playwright.config.ts` | Playwright config (if not exists) |

---

### Task 1: Backend — `GET /api/stats` endpoint

**Files:**
- Modify: `src-tauri/src/web_server/api.rs:14-42` (routes fn) and append new handler

- [ ] **Step 1: Write the test**

Add to the `mod tests` block at the bottom of `api.rs`:

```rust
#[test]
fn test_stats_endpoint_exists() {
    // Verify the ReadingStats struct serializes to the expected JSON shape.
    // The actual endpoint is integration-tested via Playwright; this confirms
    // the serde contract.
    let stats = db::ReadingStats {
        total_reading_time_secs: 3600,
        total_sessions: 10,
        total_pages_read: 200,
        books_finished: 2,
        current_streak_days: 3,
        longest_streak_days: 7,
        daily_reading: vec![("2026-05-01".to_string(), 1800)],
    };
    let json = serde_json::to_value(&stats).unwrap();
    assert_eq!(json["totalReadingTimeSecs"], 3600);
    assert_eq!(json["totalSessions"], 10);
    assert_eq!(json["totalPagesRead"], 200);
    assert_eq!(json["booksFinished"], 2);
    assert_eq!(json["currentStreakDays"], 3);
    assert_eq!(json["longestStreakDays"], 7);
    assert!(json["dailyReading"].is_array());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src-tauri/`:
```bash
cargo test --lib test_stats_endpoint_exists -- --nocapture
```
Expected: FAIL — `db::ReadingStats` fields are private or struct not imported. The test uses `db::ReadingStats` which is re-exported from folio-core. Should compile since `use crate::db;` is already in scope via `use super::*`.

Actually, `ReadingStats` fields are `pub` in folio-core, so this should pass immediately once added. If it fails because `db::ReadingStats` isn't directly constructible from tests in this module, adjust: the test confirms the serde shape is correct.

- [ ] **Step 3: Make the test pass — add the endpoint**

In `api.rs`, add the route to the `routes()` function. Insert before `.route("/series", ...)`:

```rust
.route("/stats", get(get_stats))
```

Add the handler function after the `get_collection_books` handler (before `#[cfg(test)]`):

```rust
// ── Stats ───────────────────────────────────────────────────────────────────

async fn get_stats(
    State(state): State<WebState>,
) -> Result<Json<db::ReadingStats>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let stats = db::get_reading_stats(&conn).map_err(folio_status)?;
    Ok(Json(stats))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cargo test --lib test_stats_endpoint_exists -- --nocapture
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/web_server/api.rs
git commit -m "feat(web): add GET /api/stats endpoint"
```

---

### Task 2: Backend — Extend collections list with book counts

**Files:**
- Modify: `src-tauri/src/web_server/api.rs:583-589` (list_collections handler)

- [ ] **Step 1: Write the test**

Add to `mod tests` in `api.rs`:

```rust
#[test]
fn test_collection_with_count_serializes() {
    // CollectionWithCount wraps Collection and adds book_count
    let coll = CollectionWithCount {
        id: "c1".into(),
        name: "Test".into(),
        r#type: crate::models::CollectionType::Manual,
        icon: Some("📚".into()),
        color: None,
        created_at: 0,
        updated_at: 0,
        rules: vec![],
        book_count: 5,
    };
    let json = serde_json::to_value(&coll).unwrap();
    assert_eq!(json["bookCount"], 5);
    assert_eq!(json["name"], "Test");
    assert_eq!(json["icon"], "📚");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test --lib test_collection_with_count_serializes -- --nocapture
```
Expected: FAIL — `CollectionWithCount` not defined yet.

- [ ] **Step 3: Implement CollectionWithCount and update handler**

Add the struct above the `list_collections` handler in `api.rs`:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionWithCount {
    id: String,
    name: String,
    r#type: crate::models::CollectionType,
    icon: Option<String>,
    color: Option<String>,
    created_at: i64,
    updated_at: i64,
    rules: Vec<crate::models::CollectionRule>,
    book_count: usize,
}
```

Update the `list_collections` handler:

```rust
async fn list_collections(
    State(state): State<WebState>,
) -> Result<Json<Vec<CollectionWithCount>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let collections = db::list_collections(&conn).map_err(folio_status)?;

    let result: Vec<CollectionWithCount> = collections
        .into_iter()
        .map(|c| {
            let book_count = db::get_books_in_collection_grid(&conn, &c.id)
                .map(|books| books.len())
                .unwrap_or(0);
            CollectionWithCount {
                id: c.id,
                name: c.name,
                r#type: c.r#type,
                icon: c.icon,
                color: c.color,
                created_at: c.created_at,
                updated_at: c.updated_at,
                rules: c.rules,
                book_count,
            }
        })
        .collect();

    Ok(Json(result))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cargo test --lib test_collection_with_count_serializes -- --nocapture
```
Expected: PASS

- [ ] **Step 5: Run full Rust test suite**

```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```
Expected: All pass, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/web_server/api.rs
git commit -m "feat(web): add book_count to collections list response"
```

---

### Task 3: Frontend CSS — Stats and collections styles

**Files:**
- Modify: `src-tauri/src/web_server/static/app.css`

- [ ] **Step 1: Add stats CSS**

Append to `app.css` before the `@media` rule:

```css
/* ── Stats ────────────────────────────────────── */
.stats { max-width: 500px; margin: 0 auto; padding: var(--gap); }
.stat-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 32px; }
.stat-card { background: var(--card-bg); border-radius: 12px; padding: 16px; text-align: center; }
.stat-value { font-size: 1.4rem; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.stat-value.accent { color: var(--accent); }
.stat-label { font-size: 0.65rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
.stat-chart-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.stat-chart-title { font-size: 0.7rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
.stat-chart-peak { font-size: 0.6rem; color: #666; }
.stat-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; }
.stat-bar { flex: 1; background: var(--accent); opacity: 0.7; border-radius: 2px 2px 0 0; transition: opacity 0.15s; min-height: 0; }
.stat-bar:hover { opacity: 1; }
```

- [ ] **Step 2: Add collections CSS**

Append after the stats CSS:

```css
/* ── Collections ──────────────────────────────── */
.collections { max-width: 600px; margin: 0 auto; padding: var(--gap); }
.collections-toolbar { display: flex; gap: 10px; align-items: center; padding-bottom: var(--gap); }
.collections-toolbar input { flex: 1; padding: 8px 12px; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-size: 0.85rem; }
.collections-toolbar .sort-btn { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; color: #aaa; cursor: pointer; font-size: 0.8rem; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.collections-toolbar .sort-btn:hover { color: var(--fg); border-color: #555; }
.section-header { font-size: 0.7rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
.section-header .count { color: #555; }
.collection-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
.collection-row { background: var(--card-bg); border-radius: var(--radius); padding: 14px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; border: 1px solid var(--border); transition: border-color 0.15s; }
.collection-row:hover { border-color: #555; }
.collection-icon { font-size: 1.2rem; flex-shrink: 0; }
.collection-info { flex: 1; min-width: 0; }
.collection-name { font-size: 0.9rem; font-weight: 600; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.collection-type { font-size: 0.7rem; color: #888; margin-top: 2px; }
.collection-color { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.auto-dot { display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.collection-count { background: #2a2a4e; color: #aaa; font-size: 0.7rem; padding: 3px 8px; border-radius: 10px; font-weight: 500; white-space: nowrap; }
.collection-chevron { color: #555; font-size: 0.9rem; }
```

- [ ] **Step 3: Add nav icon CSS**

Append after collections CSS:

```css
/* ── Nav Icons ────────────────────────────────── */
.nav-icons { display: flex; gap: 8px; align-items: center; }
.nav-icon { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px; color: #aaa; display: flex; align-items: center; }
.nav-icon:hover { color: var(--fg); }
.nav-icon.active { color: var(--accent); }
```

- [ ] **Step 4: Update the mobile breakpoint**

Replace the existing `@media (max-width: 600px)` rule with:

```css
@media (max-width: 600px) {
  .detail .meta { flex-direction: column; align-items: center; text-align: center; }
  .detail .cover { width: 150px; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
  .stats { padding: 12px; }
  .stat-cards { gap: 8px; }
  .stat-value { font-size: 1.1rem; }
  .collections { padding: 12px; }
}
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/web_server/static/app.css
git commit -m "feat(web): add CSS for stats, collections, and nav icons"
```

---

### Task 4: Frontend JS — `formatDuration` helper and nav icons helper

**Files:**
- Modify: `src-tauri/src/web_server/static/app.js`

- [ ] **Step 1: Add `formatDuration` helper**

Add after the existing `esc()` function (around line 358):

```javascript
function formatDuration(secs) {
  if (!secs || secs < 60) return "< 1m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return m + "m";
  return h + "h " + m + "m";
}
```

- [ ] **Step 2: Add `navIconsHtml` helper**

Add after `formatDuration`:

```javascript
function navIconsHtml(activePage) {
  const folderColor = activePage === "collections" ? "active" : "";
  const chartColor = activePage === "stats" ? "active" : "";
  return `<div class="nav-icons">
    <button class="nav-icon ${folderColor}" title="Collections" data-nav="collections">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    </button>
    <button class="nav-icon ${chartColor}" title="Reading Stats" data-nav="stats">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
    </button>
  </div>`;
}

function bindNavIcons() {
  $$("[data-nav]").forEach(btn => {
    btn.onclick = () => navigate("#/" + btn.dataset.nav);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/web_server/static/app.js
git commit -m "feat(web): add formatDuration and nav icons helpers"
```

---

### Task 5: Frontend JS — Update router and existing headers

**Files:**
- Modify: `src-tauri/src/web_server/static/app.js:26-35` (route function) and header renders

- [ ] **Step 1: Update the `route()` function**

Replace the current `route()` function:

```javascript
function route() {
  const hash = window.location.hash || "#";
  if (hash === "#" || hash === "#/") return showLibrary();
  if (hash === "#/stats") return showStats();
  if (hash === "#/collections") return showCollections();
  if (hash.startsWith("#/book/") && hash.includes("/read")) {
    const parts = hash.replace("#/book/", "").replace("/read", "").split("/");
    return showReader(parts[0], parseInt(parts[1] || "0"));
  }
  if (hash.startsWith("#/book/")) return showDetail(hash.replace("#/book/", ""));
  showLibrary();
}
```

- [ ] **Step 2: Add nav icons to the library header**

In `showLibrary()`, update the header HTML (inside the `if (!existing)` block). Replace the header template — add nav icons after the sort select:

```javascript
app().innerHTML = `
  <div class="header">
    <h1>Folio</h1>
    <input type="search" id="search" placeholder="Search books..." value="${esc(query || "")}">
    <select id="sort-select" aria-label="Sort by">
      <option value="date_added">Recent</option>
      <option value="title">Title</option>
      <option value="author">Author</option>
      <option value="last_read">Last Read</option>
      <option value="rating">Rating</option>
    </select>
    ${navIconsHtml("")}
  </div>
  <div id="filter-bar"></div>
  <div id="library-content"><div class="loading">Loading...</div></div>`;
```

Right after setting up `sortSelect.onchange` and the search `oninput`, add:

```javascript
bindNavIcons();
```

- [ ] **Step 3: Add nav icons to the detail header**

In `showDetail()`, update the header template:

```javascript
<div class="header">
  <button class="back-btn" id="back-btn">&larr;</button>
  <h1>${esc(book.title)}</h1>
  <span style="flex:1"></span>
  ${navIconsHtml("")}
</div>
```

After binding the back button, add:

```javascript
bindNavIcons();
```

- [ ] **Step 4: Add nav icons to the reader header**

In `showReader()`, update both the HTML-book header and the page-based header to include nav icons. Add `<span style="flex:1"></span>${navIconsHtml("")}` after the `<h1>` in both branches.

After binding prev/next buttons in both branches, add:

```javascript
bindNavIcons();
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/web_server/static/app.js
git commit -m "feat(web): add router entries and nav icons to all headers"
```

---

### Task 6: Frontend JS — Stats page (`showStats`)

**Files:**
- Modify: `src-tauri/src/web_server/static/app.js`

- [ ] **Step 1: Add `showStats()` function**

Add after the `showReader()` function:

```javascript
// ── Stats ──────────────────────────────────────
async function showStats() {
  app().innerHTML = `
    <div class="header">
      <button class="back-btn" id="back-btn">&larr;</button>
      <h1>Reading Stats</h1>
      <span style="flex:1"></span>
      ${navIconsHtml("stats")}
    </div>
    <div class="stats"><div class="loading">Loading...</div></div>`;
  $("#back-btn").addEventListener("click", () => navigate("#"));
  bindNavIcons();

  const resp = await api("/api/stats");
  if (!resp) return;
  const s = await resp.json();

  const container = $(".stats");
  if (!s || (s.totalSessions === 0 && s.totalReadingTimeSecs === 0)) {
    container.innerHTML = '<div class="empty">No reading stats yet. Start reading on the desktop app to see your progress here.</div>';
    return;
  }

  const maxDaily = s.dailyReading.reduce((max, entry) => Math.max(max, entry[1]), 0);

  let chartHtml = "";
  if (s.dailyReading.length > 0 && maxDaily > 0) {
    const bars = s.dailyReading.map(([date, secs]) => {
      const pct = Math.max(4, (secs / maxDaily) * 100);
      return `<div class="stat-bar" style="height:${pct}%" title="${date}: ${formatDuration(secs)}"></div>`;
    }).join("");
    chartHtml = `
      <div class="stat-chart-header">
        <div class="stat-chart-title">Last 30 Days</div>
        <div class="stat-chart-peak">${formatDuration(maxDaily)} peak</div>
      </div>
      <div class="stat-chart">${bars}</div>`;
  }

  const streak = (d) => d === 1 ? "1 day" : d + " days";

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${formatDuration(s.totalReadingTimeSecs)}</div><div class="stat-label">Time Reading</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalSessions}</div><div class="stat-label">Sessions</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalPagesRead.toLocaleString()}</div><div class="stat-label">Pages Read</div></div>
      <div class="stat-card"><div class="stat-value">${s.booksFinished}</div><div class="stat-label">Books Finished</div></div>
      <div class="stat-card"><div class="stat-value accent">${streak(s.currentStreakDays)}</div><div class="stat-label">Current Streak</div></div>
      <div class="stat-card"><div class="stat-value">${streak(s.longestStreakDays)}</div><div class="stat-label">Longest Streak</div></div>
    </div>
    ${chartHtml}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/web_server/static/app.js
git commit -m "feat(web): add reading stats page"
```

---

### Task 7: Frontend JS — Collections page (`showCollections`)

**Files:**
- Modify: `src-tauri/src/web_server/static/app.js`

- [ ] **Step 1: Add `showCollections()` function**

Add after `showStats()`:

```javascript
// ── Collections ────────────────────────────────
async function showCollections() {
  app().innerHTML = `
    <div class="header">
      <button class="back-btn" id="back-btn">&larr;</button>
      <h1>Collections</h1>
      <span style="flex:1"></span>
      ${navIconsHtml("collections")}
    </div>
    <div class="collections"><div class="loading">Loading...</div></div>`;
  $("#back-btn").addEventListener("click", () => navigate("#"));
  bindNavIcons();

  const [collectionsResp, seriesResp] = await Promise.all([
    api("/api/collections"),
    api("/api/series"),
  ]);

  const collections = collectionsResp ? await collectionsResp.json() : [];
  const series = seriesResp ? await seriesResp.json() : [];

  const container = $(".collections");
  if (collections.length === 0 && series.length === 0) {
    container.innerHTML = '<div class="empty">No collections yet. Create collections in the desktop app.</div>';
    return;
  }

  let sortAsc = true;
  let filterText = "";

  function render() {
    const q = filterText.toLowerCase();
    const filteredColls = collections
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    const filteredSeries = series
      .filter(s => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));

    let html = `<div class="collections-toolbar">
      <input type="text" id="coll-filter" placeholder="Filter collections..." value="${esc(filterText)}">
      <button class="sort-btn" id="coll-sort">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5h10M11 9h7M11 13h4"/><path d="M3 17l3 3 3-3M6 18V4"/></svg>
        ${sortAsc ? "A→Z" : "Z→A"}
      </button>
    </div>`;

    if (filteredColls.length > 0) {
      html += `<div class="section-header">Collections <span class="count">(${filteredColls.length})</span></div>`;
      html += '<div class="collection-list">';
      for (const c of filteredColls) {
        const icon = c.icon || "📁";
        const colorSwatch = c.color ? `<span class="collection-color" style="background:${esc(c.color)}"></span>` : "";
        const typeBadge = c.type === "automated"
          ? '<span class="auto-dot"></span>Auto-collection'
          : "Manual collection";
        const count = c.bookCount !== undefined ? c.bookCount : "?";
        html += `<div class="collection-row" data-collection-id="${c.id}">
          <span class="collection-icon">${icon}</span>
          <div class="collection-info">
            <div class="collection-name">${colorSwatch}${esc(c.name)}</div>
            <div class="collection-type">${typeBadge}</div>
          </div>
          <span class="collection-count">${count} book${count !== 1 ? "s" : ""}</span>
          <span class="collection-chevron">&rsaquo;</span>
        </div>`;
      }
      html += '</div>';
    }

    if (filteredSeries.length > 0) {
      html += `<div class="section-header">Series <span class="count">(${filteredSeries.length})</span></div>`;
      html += '<div class="collection-list">';
      for (const s of filteredSeries) {
        html += `<div class="collection-row" data-series-name="${esc(s.name)}">
          <span class="collection-icon" style="display:flex;align-items:center;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </span>
          <div class="collection-info">
            <div class="collection-name">${esc(s.name)}</div>
          </div>
          <span class="collection-count">${s.count} book${s.count !== 1 ? "s" : ""}</span>
          <span class="collection-chevron">&rsaquo;</span>
        </div>`;
      }
      html += '</div>';
    }

    if (filteredColls.length === 0 && filteredSeries.length === 0) {
      html += '<div class="empty">No matches</div>';
    }

    container.innerHTML = html;

    // Bind filter input
    const filterInput = $("#coll-filter");
    let filterTimer;
    filterInput.oninput = (e) => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { filterText = e.target.value; render(); }, 200);
    };
    filterInput.focus();

    // Bind sort toggle
    $("#coll-sort").onclick = () => { sortAsc = !sortAsc; render(); };

    // Bind collection rows
    container.querySelectorAll("[data-collection-id]").forEach(row => {
      row.onclick = () => {
        activeCollectionId = row.dataset.collectionId;
        activeSeries = null;
        navigate("#/");
      };
    });
    container.querySelectorAll("[data-series-name]").forEach(row => {
      row.onclick = () => {
        activeSeries = row.dataset.seriesName;
        activeCollectionId = null;
        navigate("#/");
      };
    });
  }

  render();
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/web_server/static/app.js
git commit -m "feat(web): add collections browser page"
```

---

### Task 8: Playwright e2e tests

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/web-ui-stats-collections.spec.ts`

- [ ] **Step 1: Install Playwright**

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Create Playwright config**

Create `playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:7788",
    headless: true,
  },
});
```

- [ ] **Step 3: Write the e2e tests**

Create `e2e/web-ui-stats-collections.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

// These tests require the Folio web server running on localhost:7788
// with no PIN configured (open access).

test.describe("Reading Stats page", () => {
  test("navigates to stats via header icon", async ({ page }) => {
    await page.goto("/");
    await page.click('[data-nav="stats"]');
    await expect(page).toHaveURL(/#\/stats/);
    await expect(page.locator("h1")).toHaveText("Reading Stats");
  });

  test("shows stat cards or empty state", async ({ page }) => {
    await page.goto("/#/stats");
    await page.waitForSelector(".stats");
    // Either stat cards render or empty state shows
    const hasCards = await page.locator(".stat-card").count();
    const hasEmpty = await page.locator(".empty").count();
    expect(hasCards > 0 || hasEmpty > 0).toBeTruthy();
  });

  test("stat cards show expected labels", async ({ page }) => {
    await page.goto("/#/stats");
    await page.waitForSelector(".stats");
    const hasCards = await page.locator(".stat-card").count();
    if (hasCards > 0) {
      const labels = await page.locator(".stat-label").allTextContents();
      expect(labels).toContain("Time Reading");
      expect(labels).toContain("Sessions");
      expect(labels).toContain("Pages Read");
      expect(labels).toContain("Books Finished");
      expect(labels).toContain("Current Streak");
      expect(labels).toContain("Longest Streak");
    }
  });

  test("back button returns to library", async ({ page }) => {
    await page.goto("/#/stats");
    await page.waitForSelector(".stats");
    await page.click("#back-btn");
    await expect(page).toHaveURL(/#$/);
  });
});

test.describe("Collections page", () => {
  test("navigates to collections via header icon", async ({ page }) => {
    await page.goto("/");
    await page.click('[data-nav="collections"]');
    await expect(page).toHaveURL(/#\/collections/);
    await expect(page.locator("h1")).toHaveText("Collections");
  });

  test("shows collections or empty state", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".collections");
    const hasRows = await page.locator(".collection-row").count();
    const hasEmpty = await page.locator(".empty").count();
    expect(hasRows > 0 || hasEmpty > 0).toBeTruthy();
  });

  test("filter input filters collection rows", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".collections");
    const totalBefore = await page.locator(".collection-row").count();
    if (totalBefore > 0) {
      // Type a filter that probably won't match everything
      await page.fill("#coll-filter", "zzzznonexistent");
      await page.waitForTimeout(300); // debounce
      const totalAfter = await page.locator(".collection-row").count();
      expect(totalAfter).toBeLessThanOrEqual(totalBefore);
    }
  });

  test("sort toggle changes button label", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".collections");
    const hasSort = await page.locator("#coll-sort").count();
    if (hasSort > 0) {
      const before = await page.locator("#coll-sort").textContent();
      await page.click("#coll-sort");
      const after = await page.locator("#coll-sort").textContent();
      expect(before).not.toEqual(after);
    }
  });

  test("clicking collection row navigates to library", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".collections");
    const rows = page.locator("[data-collection-id]");
    const count = await rows.count();
    if (count > 0) {
      await rows.first().click();
      await expect(page).toHaveURL(/#$/);
    }
  });

  test("back button returns to library", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".collections");
    await page.click("#back-btn");
    await expect(page).toHaveURL(/#$/);
  });
});

test.describe("Nav icons", () => {
  test("library page shows nav icons", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".nav-icons")).toBeVisible();
    await expect(page.locator('[data-nav="stats"]')).toBeVisible();
    await expect(page.locator('[data-nav="collections"]')).toBeVisible();
  });

  test("stats page highlights stats icon", async ({ page }) => {
    await page.goto("/#/stats");
    await page.waitForSelector(".nav-icons");
    await expect(page.locator('[data-nav="stats"]')).toHaveClass(/active/);
    await expect(page.locator('[data-nav="collections"]')).not.toHaveClass(/active/);
  });

  test("collections page highlights collections icon", async ({ page }) => {
    await page.goto("/#/collections");
    await page.waitForSelector(".nav-icons");
    await expect(page.locator('[data-nav="collections"]')).toHaveClass(/active/);
    await expect(page.locator('[data-nav="stats"]')).not.toHaveClass(/active/);
  });
});
```

- [ ] **Step 4: Run the Playwright tests**

The web server must be running. Start Folio with `npm run tauri dev`, then:

```bash
npx playwright test e2e/web-ui-stats-collections.spec.ts
```

Expected: All tests pass (some collection/stats tests may show empty state if no data).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e/
git commit -m "test(web): add Playwright e2e tests for stats and collections"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full Rust CI checks**

From `src-tauri/`:
```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```
Expected: All pass.

- [ ] **Step 2: Run frontend checks**

From project root:
```bash
npm run type-check && npm run test
```
Expected: All pass.

- [ ] **Step 3: Manual smoke test**

Start `npm run tauri dev`, open the web UI in a browser at the logged URL (e.g., `http://192.168.x.x:7788`):

1. Verify nav icons appear in library header
2. Click chart icon → stats page loads, shows data or empty state
3. Click back arrow → returns to library
4. Click folder icon → collections page loads, shows collections/series or empty state
5. Type in filter → rows filter
6. Click sort toggle → order changes, label flips
7. Click a collection row → library shows filtered by that collection
8. Verify icons appear on detail page and reader page too

- [ ] **Step 4: Run Playwright tests**

```bash
npx playwright test e2e/web-ui-stats-collections.spec.ts
```
Expected: All pass.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git status
# If there are unstaged changes, commit them
git commit -m "feat(web): F-1-3 web UI reading stats and collections browser"
```
