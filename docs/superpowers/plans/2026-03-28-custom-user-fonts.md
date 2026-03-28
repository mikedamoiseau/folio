# Custom User Fonts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to import custom TTF/OTF/WOFF2 font files and use them as the reading font in EPUBs alongside the 3 built-in fonts.

**Architecture:** Add a `custom_fonts` DB table and 3 Tauri commands (import/list/remove). Frontend picks font files via Tauri dialog, backend copies them to `{app_data_dir}/fonts/`. Custom fonts are loaded as `@font-face` rules via the asset protocol. ThemeContext's `FontFamily` type expands to include `"custom:{id}"` strings. Settings UI shows a flat list of all fonts with add/delete.

**Tech Stack:** Rust (SQLite, Tauri commands, fs), React 19, TypeScript, Tailwind CSS v4, @tauri-apps/plugin-dialog

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src-tauri/src/models.rs` | Add `CustomFont` struct |
| Modify | `src-tauri/src/db.rs` | Add `custom_fonts` table, CRUD functions |
| Modify | `src-tauri/src/commands.rs` | Add `import_custom_font`, `get_custom_fonts`, `remove_custom_font` commands |
| Modify | `src-tauri/src/lib.rs` | Register new commands in invoke_handler |
| Modify | `src-tauri/tauri.conf.json` | Add `asset:` to `font-src` CSP directive |
| Modify | `src/context/ThemeContext.tsx` | Expand `FontFamily` type to `string`, handle custom font IDs |
| Modify | `src/components/SettingsPanel.tsx` | Replace 3-button font picker with scrollable list + add/delete |
| Modify | `src/screens/Reader.tsx` | Handle custom font CSS mapping |

---

### Task 1: Add `CustomFont` model and DB table (TDD)

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write failing test for custom font CRUD**

Add test at the end of the `#[cfg(test)]` module in `src-tauri/src/db.rs`:

```rust
    #[test]
    fn test_custom_font_crud() {
        let (_dir, conn) = setup();

        let font = CustomFont {
            id: "font-1".to_string(),
            name: "Merriweather".to_string(),
            file_name: "Merriweather-Regular.ttf".to_string(),
            file_path: "/tmp/fonts/font-1.ttf".to_string(),
            created_at: 1700000500,
        };
        insert_custom_font(&conn, &font).unwrap();

        let fonts = list_custom_fonts(&conn).unwrap();
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].name, "Merriweather");
        assert_eq!(fonts[0].file_path, "/tmp/fonts/font-1.ttf");

        delete_custom_font(&conn, "font-1").unwrap();
        let fonts = list_custom_fonts(&conn).unwrap();
        assert_eq!(fonts.len(), 0);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_custom_font_crud -- --nocapture 2>&1 | tail -10`

Expected: compile error — `CustomFont`, `insert_custom_font`, `list_custom_fonts`, `delete_custom_font` not found.

- [ ] **Step 3: Add `CustomFont` struct to models.rs**

Add after the `ActivityEntry` struct (after line 142) in `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFont {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub created_at: i64,
}
```

- [ ] **Step 4: Add `custom_fonts` table to `run_schema()`**

In `src-tauri/src/db.rs`, add inside the `run_schema()` function, after the existing `CREATE TABLE` statements (after the `activity_log` table creation), add:

```rust
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS custom_fonts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )?;
```

- [ ] **Step 5: Add CRUD functions**

Add after the last DB function (near the end of db.rs, before `#[cfg(test)]`):

```rust
pub fn insert_custom_font(conn: &Connection, font: &CustomFont) -> Result<()> {
    conn.execute(
        "INSERT INTO custom_fonts (id, name, file_name, file_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![font.id, font.name, font.file_name, font.file_path, font.created_at],
    )?;
    Ok(())
}

pub fn list_custom_fonts(conn: &Connection) -> Result<Vec<CustomFont>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_name, file_path, created_at
         FROM custom_fonts ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(CustomFont {
            id: row.get(0)?,
            name: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn delete_custom_font(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM custom_fonts WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_custom_font(conn: &Connection, id: &str) -> Result<Option<CustomFont>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_name, file_path, created_at
         FROM custom_fonts WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(CustomFont {
            id: row.get(0)?,
            name: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}
```

- [ ] **Step 6: Add necessary imports**

Add `CustomFont` to the `use crate::models::` import in `db.rs` (it should already import from models — just add `CustomFont` to the list).

- [ ] **Step 7: Run tests**

Run: `cd src-tauri && cargo test test_custom_font_crud -- --nocapture 2>&1`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs
git commit -m "feat(fonts): add CustomFont model and DB table with CRUD"
```

---

### Task 2: Add Tauri commands for font import/list/remove

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `derive_font_name` helper function**

Add at the top of `commands.rs` (or near the font commands section):

```rust
fn derive_font_name(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);

    // Strip trailing style suffixes like "-Regular", "-Bold", etc.
    let known_suffixes = [
        "-Regular", "-Bold", "-Italic", "-Light", "-Medium",
        "-SemiBold", "-ExtraBold", "-Thin", "-Black", "-BoldItalic",
    ];
    let mut name = stem.to_string();
    for suffix in &known_suffixes {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
            break;
        }
    }
    name
}
```

- [ ] **Step 2: Add `import_custom_font` command**

Add after `preview_collection_rules` (the last command):

```rust
#[tauri::command]
pub async fn import_custom_font(
    file_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<CustomFont, String> {
    let source = std::path::Path::new(&file_path);
    if !source.exists() {
        return Err(format!("File not found: {file_path}"));
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["ttf", "otf", "woff2"].contains(&extension.as_str()) {
        return Err(format!("Unsupported font format: .{extension}"));
    }

    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let id = Uuid::new_v4().to_string();
    let fonts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    std::fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;

    let dest = fonts_dir.join(format!("{id}.{extension}"));
    std::fs::copy(source, &dest).map_err(|e| e.to_string())?;

    let font = CustomFont {
        id,
        name: derive_font_name(&file_name),
        file_name,
        file_path: dest.to_string_lossy().to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::insert_custom_font(&conn, &font).map_err(|e| e.to_string())?;

    Ok(font)
}
```

- [ ] **Step 3: Add `get_custom_fonts` command**

```rust
#[tauri::command]
pub async fn get_custom_fonts(
    state: State<'_, AppState>,
) -> Result<Vec<CustomFont>, String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    db::list_custom_fonts(&conn).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Add `remove_custom_font` command**

```rust
#[tauri::command]
pub async fn remove_custom_font(
    font_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;

    // Get the font to find its file path
    if let Some(font) = db::get_custom_font(&conn, &font_id).map_err(|e| e.to_string())? {
        // Delete the file (ignore error if already gone)
        let _ = std::fs::remove_file(&font.file_path);
    }

    db::delete_custom_font(&conn, &font_id).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Add `CustomFont` to imports in commands.rs**

Add `CustomFont` to the `use crate::models::` import line in `commands.rs`.

- [ ] **Step 6: Register commands in invoke_handler**

In `src-tauri/src/lib.rs`, add after `commands::preview_collection_rules,`:

```rust
            commands::import_custom_font,
            commands::get_custom_fonts,
            commands::remove_custom_font,
```

- [ ] **Step 7: Add `derive_font_name` test**

Add to the `#[cfg(test)]` module in `commands.rs`:

```rust
    #[test]
    fn test_derive_font_name() {
        assert_eq!(derive_font_name("Merriweather-Regular.ttf"), "Merriweather");
        assert_eq!(derive_font_name("FiraCode-Bold.woff2"), "FiraCode");
        assert_eq!(derive_font_name("My Font.otf"), "My Font");
        assert_eq!(derive_font_name("Roboto-BoldItalic.ttf"), "Roboto");
        assert_eq!(derive_font_name("SimpleFont.ttf"), "SimpleFont");
    }
```

- [ ] **Step 8: Verify compilation and tests**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

Expected: no errors.

Run: `cd src-tauri && cargo test test_derive_font_name -- --nocapture 2>&1`

Expected: PASS.

Run: `cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -5`

Expected: no warnings.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(fonts): add import/list/remove custom font Tauri commands"
```

---

### Task 3: Update CSP for asset protocol fonts

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add `asset:` to `font-src` in CSP**

In `src-tauri/tauri.conf.json`, the CSP on line 21 currently has `font-src 'self'`. Change it to allow asset protocol:

Replace:
```
font-src 'self'
```
with:
```
font-src 'self' asset: https://asset.localhost
```

The full CSP line becomes:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http: https: data:; font-src 'self' asset: https://asset.localhost"
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(fonts): allow asset protocol in font-src CSP"
```

---

### Task 4: Update ThemeContext to support custom font IDs

**Files:**
- Modify: `src/context/ThemeContext.tsx`

- [ ] **Step 1: Change `FontFamily` type from union to string**

In `src/context/ThemeContext.tsx`, replace line 25:

```typescript
type FontFamily = "serif" | "sans-serif" | "dyslexic";
```

with:

```typescript
type FontFamily = string;
```

- [ ] **Step 2: Update `loadStoredFontFamily` to accept custom font IDs**

Replace the function (lines 121-125):

```typescript
function loadStoredFontFamily(): FontFamily {
  const stored = localStorage.getItem(STORAGE_KEYS.fontFamily);
  if (stored) return stored;
  return "serif";
}
```

- [ ] **Step 3: Run type-check**

Run: `npm run type-check 2>&1 | tail -10`

Expected: no errors (changing to `string` is a widening — all existing `"serif" | "sans-serif" | "dyslexic"` values still work).

- [ ] **Step 4: Commit**

```bash
git add src/context/ThemeContext.tsx
git commit -m "feat(fonts): expand FontFamily type to support custom font IDs"
```

---

### Task 5: Update Reader.tsx to handle custom fonts

**Files:**
- Modify: `src/screens/Reader.tsx`

- [ ] **Step 1: Update `fontFamilyCss` mapping**

Replace lines 818-823:

```typescript
  const fontFamilyCss =
    fontFamily === "serif"
      ? '"Lora Variable", Georgia, serif'
      : fontFamily === "dyslexic"
        ? '"OpenDyslexic", sans-serif'
        : fontFamily.startsWith("custom:")
          ? `"CustomFont-${fontFamily.slice(7)}", serif`
          : '"DM Sans Variable", system-ui, sans-serif';
```

- [ ] **Step 2: Run type-check**

Run: `npm run type-check 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/screens/Reader.tsx
git commit -m "feat(fonts): handle custom font CSS in reader"
```

---

### Task 6: Update SettingsPanel with font list, add/delete, and @font-face injection

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add imports and state for custom fonts**

At the top of `SettingsPanel.tsx`, add to the existing `invoke` import:

```typescript
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
```

Note: `openFolderPicker` is already imported from `@tauri-apps/plugin-dialog` on line 3. Change the import to:

```typescript
import { open as openFilePicker, open as openFolderPicker } from "@tauri-apps/plugin-dialog";
```

Actually, since both use `open`, just use a single import:

```typescript
import { open } from "@tauri-apps/plugin-dialog";
```

And update the existing `openFolderPicker` usage to call `open` directly (it's used in the library folder picker section).

Add inside the SettingsPanel component, near other state:

```typescript
  interface CustomFont {
    id: string;
    name: string;
    fileName: string;
    filePath: string;
    createdAt: number;
  }

  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [deletingFontId, setDeletingFontId] = useState<string | null>(null);

  const loadCustomFonts = useCallback(async () => {
    try {
      const fonts = await invoke<CustomFont[]>("get_custom_fonts");
      setCustomFonts(fonts);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadCustomFonts();
  }, [loadCustomFonts]);
```

- [ ] **Step 2: Add @font-face injection effect**

Add after the `loadCustomFonts` effect:

```typescript
  // Inject @font-face rules for custom fonts
  useEffect(() => {
    const styleId = "custom-fonts-style";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = customFonts
      .map(
        (f) =>
          `@font-face { font-family: "CustomFont-${f.id}"; src: url("https://asset.localhost/${f.filePath}"); font-display: swap; }`,
      )
      .join("\n");
  }, [customFonts]);
```

- [ ] **Step 3: Add font import and delete handlers**

```typescript
  const handleImportFont = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Font Files", extensions: ["ttf", "otf", "woff2"] },
        ],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : selected[0];
      await invoke("import_custom_font", { filePath });
      await loadCustomFonts();
    } catch {
      // non-fatal
    }
  };

  const handleDeleteFont = async (fontId: string) => {
    try {
      // If the deleted font is currently selected, fall back to serif
      if (fontFamily === `custom:${fontId}`) {
        setFontFamily("serif");
      }
      await invoke("remove_custom_font", { fontId });
      await loadCustomFonts();
    } catch {
      // non-fatal
    }
    setDeletingFontId(null);
  };
```

- [ ] **Step 4: Replace font picker UI**

Replace the entire font picker section (the `<Accordion title="Reading Font" defaultOpen>` block, lines 656-700) with:

```tsx
          {/* Font family */}
          <Accordion title="Reading Font" defaultOpen>
            <div className="flex flex-col gap-1">
              {/* Built-in fonts */}
              {([
                { key: "serif", label: "Lora", css: '"Lora Variable", Georgia, serif' },
                { key: "sans-serif", label: "DM Sans", css: '"DM Sans Variable", system-ui, sans-serif' },
                { key: "dyslexic", label: "OpenDyslexic", css: '"OpenDyslexic", sans-serif' },
              ] as const).map((option) => (
                <button
                  type="button"
                  key={option.key}
                  onClick={() => setFontFamily(option.key)}
                  className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
                    fontFamily === option.key
                      ? "bg-accent-light text-accent font-medium"
                      : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                  }`}
                  style={{ fontFamily: option.css }}
                >
                  {option.label}
                </button>
              ))}

              {/* Custom fonts */}
              {customFonts.map((font) => (
                <div
                  key={font.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150 cursor-pointer ${
                    fontFamily === `custom:${font.id}`
                      ? "bg-accent-light text-accent font-medium"
                      : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                  }`}
                  onClick={() => setFontFamily(`custom:${font.id}`)}
                >
                  <span
                    className="flex-1 text-sm truncate"
                    style={{ fontFamily: `"CustomFont-${font.id}", serif` }}
                  >
                    {font.name}
                  </span>
                  {deletingFontId === font.id ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteFont(font.id); }}
                        className="text-[10px] px-1.5 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
                      >
                        Delete
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeletingFontId(null); }}
                        className="text-[10px] px-1.5 py-0.5 text-ink-muted hover:text-ink transition-colors"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingFontId(font.id); }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all shrink-0"
                      aria-label={`Remove ${font.name}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                        <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}

              {/* Add font button */}
              <button
                type="button"
                onClick={handleImportFont}
                className="w-full text-left px-3 py-2 text-sm text-accent hover:bg-warm-subtle rounded-lg transition-colors flex items-center gap-2"
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Add font...
              </button>
              <p className="px-3 text-[10px] text-ink-muted/60">
                Adding many fonts may slow down the app
              </p>
            </div>

            {/* Font preview */}
            <p
              className="mt-3 text-sm text-ink-muted leading-relaxed"
              style={{
                fontFamily:
                  fontFamily === "serif"
                    ? '"Lora Variable", Georgia, serif'
                    : fontFamily === "dyslexic"
                      ? '"OpenDyslexic", sans-serif'
                      : fontFamily.startsWith("custom:")
                        ? `"CustomFont-${fontFamily.slice(7)}", serif`
                        : '"DM Sans Variable", system-ui, sans-serif',
              }}
            >
              The quick brown fox jumps over the lazy dog.
            </p>
          </Accordion>
```

- [ ] **Step 5: Run type-check**

Run: `npm run type-check 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(fonts): add custom font picker with import, delete, and @font-face injection"
```

---

### Task 7: Final verification and roadmap update

**Files:** None (verification only) + `docs/ROADMAP.md`

- [ ] **Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`

Expected: all tests pass.

- [ ] **Step 2: Run clippy**

Run: `cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -10`

Expected: no warnings.

- [ ] **Step 3: Run cargo fmt check**

Run: `cd src-tauri && cargo fmt --check 2>&1`

Expected: no formatting issues.

- [ ] **Step 4: Run frontend type-check**

Run: `npm run type-check 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 5: Run frontend tests**

Run: `npm run test 2>&1 | tail -10`

Expected: all tests pass.

- [ ] **Step 6: Update ROADMAP.md**

In `docs/ROADMAP.md`, update feature 29 from:

```markdown
#### 29. Custom User Fonts
- Load user-provided TTF/OTF font files
- Font picker shows both built-in and user-added fonts
- Fonts stored per-profile in the app data directory
```

to:

```markdown
#### 29. Custom User Fonts — **Done**
- ~~Load user-provided TTF/OTF/WOFF2 font files via file picker~~
- ~~Font picker shows both built-in and user-added fonts in a single list~~
- ~~Fonts copied into app data directory; custom @font-face rules injected dynamically~~
- ~~Add and delete custom fonts from settings~~
```

Also update the Phase 8 summary table row count from `10 done` to `11 done`.

- [ ] **Step 7: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: mark custom user fonts as done"
```
