# Provider Priority Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users reorder enrichment providers via up/down arrow buttons in Settings, persisted to DB, controlling scan order.

**Architecture:** Add a `reorder` method to `ProviderRegistry`, a new Tauri command to persist order, load saved order at startup, and add ▲/▼ buttons to the existing provider list in `SettingsPanel.tsx`.

**Tech Stack:** Rust (Tauri commands, ProviderRegistry), React/TypeScript (SettingsPanel), SQLite (settings table), i18n (EN + FR)

---

### Task 1: Add `ProviderRegistry::reorder` with tests

**Files:**
- Modify: `src-tauri/src/providers/mod.rs:82-119` (add `reorder` method)
- Test: `src-tauri/src/providers/mod.rs:180-240` (add tests in existing test module)

- [ ] **Step 1: Write the failing tests**

Add these tests at the end of the `mod tests` block in `src-tauri/src/providers/mod.rs` (before the closing `}`):

```rust
    #[test]
    fn reorder_changes_provider_order() {
        let mut reg = ProviderRegistry::new();
        reg.reorder(&[
            "bnf".to_string(),
            "comic_vine".to_string(),
            "openlibrary".to_string(),
            "google_books".to_string(),
        ]);
        let providers = reg.list_providers();
        assert_eq!(providers[0].id, "bnf");
        assert_eq!(providers[1].id, "comic_vine");
        assert_eq!(providers[2].id, "openlibrary");
        assert_eq!(providers[3].id, "google_books");
    }

    #[test]
    fn reorder_appends_unlisted_providers_at_end() {
        let mut reg = ProviderRegistry::new();
        // Only specify two — the other two should be appended in their original relative order
        reg.reorder(&["bnf".to_string(), "openlibrary".to_string()]);
        let providers = reg.list_providers();
        assert_eq!(providers[0].id, "bnf");
        assert_eq!(providers[1].id, "openlibrary");
        // google_books and comic_vine appended in original order
        assert_eq!(providers[2].id, "google_books");
        assert_eq!(providers[3].id, "comic_vine");
    }

    #[test]
    fn reorder_ignores_unknown_ids() {
        let mut reg = ProviderRegistry::new();
        reg.reorder(&[
            "nonexistent".to_string(),
            "bnf".to_string(),
            "google_books".to_string(),
        ]);
        let providers = reg.list_providers();
        // bnf and google_books reordered, unknown skipped, rest appended
        assert_eq!(providers[0].id, "bnf");
        assert_eq!(providers[1].id, "google_books");
        assert_eq!(providers[2].id, "openlibrary");
        assert_eq!(providers[3].id, "comic_vine");
    }

    #[test]
    fn reorder_with_empty_order_is_noop() {
        let mut reg = ProviderRegistry::new();
        reg.reorder(&[]);
        let providers = reg.list_providers();
        assert_eq!(providers[0].id, "google_books");
        assert_eq!(providers[1].id, "openlibrary");
        assert_eq!(providers[2].id, "comic_vine");
        assert_eq!(providers[3].id, "bnf");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test providers::tests::reorder -v`
Expected: FAIL — `reorder` method not found.

- [ ] **Step 3: Implement `reorder` method**

Add this method to the `impl ProviderRegistry` block in `src-tauri/src/providers/mod.rs`, after the `configure_provider` method (after line 119):

```rust
    /// Reorder providers to match the given ID order.
    /// IDs not found in the registry are skipped.
    /// Providers not listed in `order` are appended at the end in their current relative order.
    pub fn reorder(&mut self, order: &[String]) {
        let mut ordered: Vec<Box<dyn EnrichmentProvider>> = Vec::new();
        let mut remaining = std::mem::take(&mut self.providers);

        for id in order {
            if let Some(pos) = remaining.iter().position(|p| p.id() == id) {
                ordered.push(remaining.remove(pos));
            }
        }
        // Append any providers not mentioned in `order`
        ordered.append(&mut remaining);
        self.providers = ordered;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test providers::tests -v`
Expected: All provider tests pass, including the 4 new `reorder` tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/providers/mod.rs
git commit -m "feat(providers): add ProviderRegistry::reorder method with tests"
```

---

### Task 2: Add `set_enrichment_provider_order` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs:3047` (add new command after `set_enrichment_provider_config`)
- Modify: `src-tauri/src/lib.rs:192` (register command in invoke_handler)

- [ ] **Step 1: Add the command**

Add this after the `set_enrichment_provider_config` function (after line 3047) in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn set_enrichment_provider_order(
    order: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut reg = state
        .enrichment_registry
        .lock()
        .map_err(|e| e.to_string())?;
    reg.reorder(&order);
    // Persist the order
    let json = serde_json::to_string(&order).map_err(|e| e.to_string())?;
    let conn = state.active_db()?.get().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, "enrichment_provider_order", &json).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Register in invoke_handler**

In `src-tauri/src/lib.rs`, add `commands::set_enrichment_provider_order,` on the line after `commands::set_enrichment_provider_config,` (after line 192):

```rust
            commands::set_enrichment_provider_config,
            commands::set_enrichment_provider_order,
```

- [ ] **Step 3: Run build check**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: No errors or warnings.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(providers): add set_enrichment_provider_order Tauri command"
```

---

### Task 3: Load saved order at startup

**Files:**
- Modify: `src-tauri/src/lib.rs:88-103` (add order loading after config loading)

- [ ] **Step 1: Add order loading**

In `src-tauri/src/lib.rs`, inside the `enrichment_registry` block, add the order loading right after the existing `configure_provider` loop closes (after the inner `}` on line 100, before the outer `}` on line 101):

```rust
                    if let Ok(Some(order_json)) =
                        crate::db::get_setting(&conn, "enrichment_provider_order")
                    {
                        if let Ok(order) = serde_json::from_str::<Vec<String>>(&order_json) {
                            reg.reorder(&order);
                        }
                    }
```

The full block should now look like:

```rust
            let enrichment_registry = {
                let mut reg = crate::providers::ProviderRegistry::new();
                if let Ok(conn) = pool.get() {
                    if let Ok(Some(json)) = crate::db::get_setting(&conn, "enrichment_providers") {
                        if let Ok(configs) = serde_json::from_str::<
                            std::collections::HashMap<String, crate::providers::ProviderConfig>,
                        >(&json)
                        {
                            for (id, config) in configs {
                                reg.configure_provider(&id, config);
                            }
                        }
                    }
                    if let Ok(Some(order_json)) =
                        crate::db::get_setting(&conn, "enrichment_provider_order")
                    {
                        if let Ok(order) = serde_json::from_str::<Vec<String>>(&order_json) {
                            reg.reorder(&order);
                        }
                    }
                }
                std::sync::Mutex::new(reg)
            };
```

- [ ] **Step 2: Run build check**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: No errors or warnings.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(providers): load saved provider order at startup"
```

---

### Task 4: Add i18n keys

**Files:**
- Modify: `src/locales/en.json:254` (add key after `enrichmentSources`)
- Modify: `src/locales/fr.json:254` (add French translation)

- [ ] **Step 1: Add English key**

In `src/locales/en.json`, add after the `"enrichmentSources"` line (line 254):

```json
    "enrichmentSourcesOrder": "Tried in order from top to bottom",
```

- [ ] **Step 2: Add French key**

In `src/locales/fr.json`, add after the `"enrichmentSources"` line (line 254):

```json
    "enrichmentSourcesOrder": "Essayés dans l'ordre de haut en bas",
```

- [ ] **Step 3: Run type check**

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(i18n): add provider order label in EN and FR"
```

---

### Task 5: Add ▲/▼ reorder buttons to SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx:1223-1273` (update enrichment providers section)

- [ ] **Step 1: Update the enrichment providers section**

Replace the enrichment providers block in `src/components/SettingsPanel.tsx` (lines 1223-1273). Find this code:

```tsx
              {enrichmentProviders.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium text-ink-muted mb-2">{t("settings.enrichmentSources")}</h4>
                  {enrichmentProviders.map((provider) => (
                    <div key={provider.id} className="flex items-start gap-2 py-2 border-b border-warm-border last:border-0">
                      <input
                        type="checkbox"
                        checked={provider.config.enabled}
                        onChange={async (e) => {
                          await invoke("set_enrichment_provider_config", {
                            providerId: provider.id,
                            enabled: e.target.checked,
                            apiKey: provider.config.apiKey,
                          }).catch(() => {});
                          loadProviders();
                        }}
                        className="mt-0.5 accent-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-ink">{provider.name}</span>
                        {provider.apiKeyHelp && (
                          <div className="mt-1">
                            <input
                              type="text"
                              value={provider.config.apiKey ?? ""}
                              onChange={(e) => {
                                setEnrichmentProviders((prev) =>
                                  prev.map((p) =>
                                    p.id === provider.id
                                      ? { ...p, config: { ...p.config, apiKey: e.target.value } }
                                      : p
                                  )
                                );
                              }}
                              onBlur={async (e) => {
                                await invoke("set_enrichment_provider_config", {
                                  providerId: provider.id,
                                  enabled: provider.config.enabled,
                                  apiKey: e.target.value || null,
                                }).catch(() => {});
                              }}
                              placeholder={t("settings.apiKeyPlaceholder")}
                              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                            />
                            <p className="text-[10px] text-ink-muted mt-0.5">{provider.apiKeyHelp}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
```

Replace with:

```tsx
              {enrichmentProviders.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium text-ink-muted mb-1">{t("settings.enrichmentSources")}</h4>
                  <p className="text-[10px] text-ink-muted mb-2">{t("settings.enrichmentSourcesOrder")}</p>
                  {enrichmentProviders.map((provider, index) => (
                    <div key={provider.id} className="flex items-start gap-2 py-2 border-b border-warm-border last:border-0">
                      <div className="flex flex-col items-center gap-0.5 mt-0.5">
                        <button
                          onClick={async () => {
                            if (index === 0) return;
                            const reordered = [...enrichmentProviders];
                            [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                            setEnrichmentProviders(reordered);
                            await invoke("set_enrichment_provider_order", {
                              order: reordered.map((p) => p.id),
                            }).catch(() => {});
                          }}
                          disabled={index === 0}
                          className="text-[10px] leading-none text-ink-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={`Move ${provider.name} up`}
                        >
                          ▲
                        </button>
                        <button
                          onClick={async () => {
                            if (index === enrichmentProviders.length - 1) return;
                            const reordered = [...enrichmentProviders];
                            [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
                            setEnrichmentProviders(reordered);
                            await invoke("set_enrichment_provider_order", {
                              order: reordered.map((p) => p.id),
                            }).catch(() => {});
                          }}
                          disabled={index === enrichmentProviders.length - 1}
                          className="text-[10px] leading-none text-ink-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={`Move ${provider.name} down`}
                        >
                          ▼
                        </button>
                      </div>
                      <input
                        type="checkbox"
                        checked={provider.config.enabled}
                        onChange={async (e) => {
                          await invoke("set_enrichment_provider_config", {
                            providerId: provider.id,
                            enabled: e.target.checked,
                            apiKey: provider.config.apiKey,
                          }).catch(() => {});
                          loadProviders();
                        }}
                        className="mt-0.5 accent-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-ink">{provider.name}</span>
                        {provider.apiKeyHelp && (
                          <div className="mt-1">
                            <input
                              type="text"
                              value={provider.config.apiKey ?? ""}
                              onChange={(e) => {
                                setEnrichmentProviders((prev) =>
                                  prev.map((p) =>
                                    p.id === provider.id
                                      ? { ...p, config: { ...p.config, apiKey: e.target.value } }
                                      : p
                                  )
                                );
                              }}
                              onBlur={async (e) => {
                                await invoke("set_enrichment_provider_config", {
                                  providerId: provider.id,
                                  enabled: provider.config.enabled,
                                  apiKey: e.target.value || null,
                                }).catch(() => {});
                              }}
                              placeholder={t("settings.apiKeyPlaceholder")}
                              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                            />
                            <p className="text-[10px] text-ink-muted mt-0.5">{provider.apiKeyHelp}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
```

- [ ] **Step 2: Run type check and tests**

Run: `npm run type-check && npm run test`
Expected: No errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): add up/down arrow buttons for provider priority reordering"
```

---

### Task 6: Update roadmap and user guide

**Files:**
- Modify: `docs/ROADMAP.md` (mark provider priority as done)
- Modify: `docs/USER_GUIDE.md` (update enrichment providers section)

- [ ] **Step 1: Update roadmap**

In `docs/ROADMAP.md`, find the "Future Enrichment Improvements" section (under item 17) and change:

```markdown
- User-configurable provider priority order (drag-to-reorder in Settings)
```

to:

```markdown
- ~~User-configurable provider priority order (up/down arrow buttons in Settings)~~
```

- [ ] **Step 2: Update user guide**

In `docs/USER_GUIDE.md`, in the enrichment providers table (around line 253), add a sentence after the table:

```markdown
Providers are tried in the order shown. Use the ▲/▼ buttons next to each provider to change the priority — the first provider to return a match wins.
```

- [ ] **Step 3: Run full CI checks**

Run from `src-tauri/`: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
Run from project root: `npm run type-check && npm run test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add docs/ROADMAP.md docs/USER_GUIDE.md
git commit -m "docs: update roadmap and user guide for provider priority reordering"
```
