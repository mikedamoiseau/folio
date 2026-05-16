# PDF Disk Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist rendered PDF pages on disk so a second open hits disk instead of pdfium. Shares the existing comic page-cache namespace, manifest format, and three-tier eviction (LRU / size cap / age).

**Architecture:** First open of a PDF triggers `prepare_pdf` which renders the first ten pages at a canonical width (2400 px) and writes them under `page-cache/{hash}/{NNN}.jpg`. Subsequent reads check disk first; misses render at canonical width, write best-effort, then resize to the viewport width before responding. Comic manifests stay dense; PDF manifests carry `pages: []` and derive filenames from the page index — `get_cached_page` branches on `manifest.format`. Eviction runs after the explicit warm pass and is coalesced into batches of 25 lazy writes thereafter.

**Tech Stack:** Rust 1.x (`folio-core`, `src-tauri`), Tauri v2 IPC, React 19 frontend, vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-05-16-pdf-disk-cache-design.md` (commit `800396b`).

---

## File Structure

**Modify:**
- `folio-core/src/page_cache.rs` — extend `CacheManifest`, add `default_cache_format`, branch `get_cached_page` on format, add `ensure_pdf_prewarmed`, `get_or_render_pdf_page`, `get_or_render_pdf_page_with_eviction`, plus an internal `_with_renderer` variant that injects a renderer closure for testability. Tests live in the existing `#[cfg(test)] mod tests` block at the bottom of the file.
- `folio-core/src/pdf.rs` — add one public constant: `CACHE_CANONICAL_WIDTH: u32 = 2400`.
- `src-tauri/src/commands.rs` — add `prepare_pdf` command. Rewrite `get_pdf_page_bytes` body for cache-first + lazy-eviction trigger.
- `src-tauri/src/lib.rs` — register `prepare_pdf` in `invoke_handler`.
- `src/screens/Reader.tsx` — extend the existing `prepare_comic` branch to also call `prepare_pdf` for PDF books.
- `CHANGELOG.md` — entry under `[Unreleased]`.
- `docs/ROADMAP.md` — mark item #3 of the "perf + comics" bundle as shipped.

**No new files.**

---

## Milestone m1 — folio-core

### Task 1.1 — Manifest fields (`format`, `canonical_width`) + serde defaults

**Files:**
- Modify: `folio-core/src/page_cache.rs:1-50` and the manifest struct
- Test: `folio-core/src/page_cache.rs` (existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add inside the existing `mod tests`:

```rust
#[test]
fn manifest_legacy_comic_loads_without_format_or_canonical_width() {
    let (_d, storage) = temp_storage();
    let hash = "legacy-hash";
    // Hand-craft a manifest JSON missing the new fields, exactly as
    // pre-spec comic manifests on disk.
    let legacy = serde_json::json!({
        "book_id": "legacy",
        "book_hash": hash,
        "page_count": 2,
        "total_size_bytes": 42,
        "extracted_at": "2026-01-01T00:00:00Z",
        "last_accessed": "2026-01-01T00:00:00Z",
        "pages": ["000.jpg", "001.jpg"],
    });
    storage
        .put(&manifest_key(hash), legacy.to_string().as_bytes())
        .unwrap();

    let loaded = read_manifest(&storage, hash).expect("legacy manifest must load");
    assert_eq!(loaded.format, BookFormat::Cbz);
    assert_eq!(loaded.canonical_width, None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run from the workspace root: `cargo test -p folio-core manifest_legacy_comic_loads_without -- --nocapture`
Expected: FAIL (`format` field does not exist on `CacheManifest`).

- [ ] **Step 3: Add the helper + extend the struct**

Above the `CacheManifest` definition in `folio-core/src/page_cache.rs`:

```rust
fn default_cache_format() -> BookFormat {
    // Legacy comic manifests (pre-PDF-cache) lacked this field.
    // CBZ is a safe default: CBR manifests already carry
    // CBR-specific filenames inside `pages`, so the same comic
    // read path serves both at runtime.
    BookFormat::Cbz
}
```

Update the struct (only the two new fields are added):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheManifest {
    pub book_id: String,
    pub book_hash: String,
    pub page_count: u32,
    pub total_size_bytes: u64,
    pub extracted_at: String,
    pub last_accessed: String,
    pub pages: Vec<String>,
    #[serde(default = "default_cache_format")]
    pub format: BookFormat,
    #[serde(default)]
    pub canonical_width: Option<u32>,
}
```

Every existing site that constructs a `CacheManifest` literal needs the two new fields. As of the spec date, those sites are:

- `extract_cbz` (`folio-core/src/page_cache.rs:178`) — set `format: BookFormat::Cbz`, `canonical_width: None`.
- `extract_cbr` (`folio-core/src/page_cache.rs:266`) — set `format: BookFormat::Cbr`, `canonical_width: None`.
- `create_fake_cache` test helper (`folio-core/src/page_cache.rs:512`) — set `format: BookFormat::Cbz`, `canonical_width: None`.
- `manifest_roundtrip` test (`folio-core/src/page_cache.rs:530`) — set `format: BookFormat::Cbz`, `canonical_width: None`.

Re-grep before editing in case more have been added since the spec landed:

```bash
grep -nE "let .*= CacheManifest \{|^\s*CacheManifest \{|\) -> CacheManifest" folio-core/src/page_cache.rs
```

Update every match. The compile step in Step 5 will fail clearly if any literal is missed, but it is faster to catch them all up front than to iterate.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p folio-core manifest_legacy_comic_loads_without -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Run the full existing folio-core test suite to verify backward compat**

Run from workspace root: `cargo test -p folio-core`
Expected: all existing tests pass (no regression).

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/page_cache.rs
git commit -m "feat(folio-core): extend CacheManifest with format + canonical_width

PDF cache work needs the manifest to distinguish format and record
the rendered width. Both fields land with backward-compatible serde
defaults (BookFormat::Cbz via a named helper to avoid a global
Default impl; None for canonical_width). Existing comic manifests
on disk continue to deserialize cleanly.

Spec: docs/superpowers/specs/2026-05-16-pdf-disk-cache-design.md"
```

---

### Task 1.2 — Canonical-width constant in `pdf.rs`

**Files:**
- Modify: `folio-core/src/pdf.rs:1-15` (near the top, before existing fns)

- [ ] **Step 1: Add the constant**

At the top of `folio-core/src/pdf.rs`, after the existing `use` statements:

```rust
/// Canonical render width used when populating the on-disk page cache.
/// Wider than typical reading viewports so zoomed-in views can downscale
/// rather than re-render, but small enough that 200-page books stay
/// comfortably inside the shared `page-cache/` budget (≈ 200–500 KB JPEG
/// per page at this width).
pub const CACHE_CANONICAL_WIDTH: u32 = 2400;
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p folio-core`
Expected: clean (no warnings, no errors).

- [ ] **Step 3: Commit**

```bash
git add folio-core/src/pdf.rs
git commit -m "feat(folio-core): add pdf::CACHE_CANONICAL_WIDTH constant

The PDF page cache renders each cached page once at this fixed width;
viewport-target widths are produced by resizing the canonical bytes
on read. Picked 2400 px so zoomed-in views downscale rather than
re-render through pdfium."
```

---

### Task 1.3 — Branch `get_cached_page` on `manifest.format` for PDF

**Files:**
- Modify: `folio-core/src/page_cache.rs:284-314` (existing `get_cached_page`)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn get_cached_page_pdf_derives_filename_from_index() {
    let (_d, storage) = temp_storage();
    let hash = "pdf-hash";

    // Seed a PDF manifest with empty `pages` and write the disk file
    // under the index-derived name.
    let manifest = CacheManifest {
        book_id: "b".into(),
        book_hash: hash.into(),
        page_count: 50,
        total_size_bytes: 0,
        extracted_at: now_iso(),
        last_accessed: now_iso(),
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(2400),
    };
    write_manifest(&storage, hash, &manifest).unwrap();
    storage.put(&page_key(hash, "042.jpg"), b"pdf-page-bytes").unwrap();

    let (bytes, mime) = get_cached_page(&storage, hash, 42).unwrap();
    assert_eq!(bytes, b"pdf-page-bytes");
    assert_eq!(mime, "image/jpeg");
}

#[test]
fn get_cached_page_pdf_out_of_range() {
    let (_d, storage) = temp_storage();
    let hash = "pdf-hash";
    let manifest = CacheManifest {
        book_id: "b".into(),
        book_hash: hash.into(),
        page_count: 10,
        total_size_bytes: 0,
        extracted_at: now_iso(),
        last_accessed: now_iso(),
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(2400),
    };
    write_manifest(&storage, hash, &manifest).unwrap();

    let err = get_cached_page(&storage, hash, 999).unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("out of range"), "got: {msg}");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p folio-core get_cached_page_pdf -- --nocapture`
Expected: FAIL (`get_cached_page` indexes `manifest.pages[42]` which is out of bounds on an empty vec).

- [ ] **Step 3: Update `get_cached_page` to branch on `manifest.format`**

Replace the body of `get_cached_page`:

```rust
pub fn get_cached_page(
    storage: &dyn Storage,
    book_hash: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)> {
    let manifest = read_manifest(storage, book_hash)
        .ok_or_else(|| FolioError::not_found("Cache manifest not found"))?;

    let page_name = match manifest.format {
        BookFormat::Pdf => {
            if page_index >= manifest.page_count {
                return Err(FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                )));
            }
            format!("{page_index:03}.jpg")
        }
        _ => manifest
            .pages
            .get(page_index as usize)
            .cloned()
            .ok_or_else(|| {
                FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                ))
            })?,
    };

    let data = storage
        .get(&page_key(book_hash, &page_name))
        .map_err(|e| FolioError::io(format!("Failed to read cached page {page_index}: {e}")))?;

    let mime = mime_for_page_name(&page_name);
    Ok((data, mime.to_string()))
}
```

The existing inline mime branch is extracted into a tiny helper for reuse from `get_or_render_pdf_page` below. Add it next to `is_image_ext`:

```rust
fn mime_for_page_name(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}
```

- [ ] **Step 4: Run new + existing cache tests**

Run: `cargo test -p folio-core get_cached_page`
Expected: all PASS, including the existing comic coverage.

- [ ] **Step 5: Commit**

```bash
git add folio-core/src/page_cache.rs
git commit -m "feat(folio-core): branch get_cached_page on manifest.format

PDF manifests carry empty \`pages\` because page filenames are
deterministic ({i:03}.jpg) and the vector would either bloat (one
entry per page in 1000-page books) or force a sparse Option<String>
representation that breaks the comic invariant. Branching on the
new \`format\` field at lookup time keeps the two paths cleanly
separated.

Also extracts the inline mime detection into a helper for reuse
by the lazy-render path landing in the next commit."
```

---

### Task 1.4 — `ensure_pdf_prewarmed` (with a renderer hook for tests)

**Files:**
- Modify: `folio-core/src/page_cache.rs` (add a new section after `extract_cbr`)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn ensure_pdf_prewarmed_writes_first_n_pages() {
    let (_d, storage) = temp_storage();
    let hash = "warm-hash";

    // Fake renderer: returns deterministic bytes per page index.
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
    };

    let manifest = ensure_pdf_prewarmed_with_renderer(
        &storage, "book", hash, /*page_count=*/ 25, /*prewarm=*/ 10, &render,
    )
    .unwrap();

    assert_eq!(manifest.format, BookFormat::Pdf);
    assert_eq!(manifest.canonical_width, Some(2400));
    assert!(manifest.pages.is_empty(), "PDF manifests keep pages empty");
    assert_eq!(manifest.page_count, 25);

    for i in 0..10 {
        let key = page_key(hash, &format!("{i:03}.jpg"));
        assert!(storage.exists(&key).unwrap(), "page {i} should be on disk");
    }
    // Pages beyond the prewarm window are not pre-rendered.
    assert!(!storage.exists(&page_key(hash, "010.jpg")).unwrap());
}

#[test]
fn ensure_pdf_prewarmed_is_idempotent() {
    let (_d, storage) = temp_storage();
    let hash = "warm-hash";

    // Interior-mutable counter so the renderer closure can stay `Fn`
    // (the helper accepts `Fn`, not `FnMut`).
    let calls = std::cell::Cell::new(0u32);
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        calls.set(calls.get() + 1);
        Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
    };

    ensure_pdf_prewarmed_with_renderer(&storage, "book", hash, 25, 5, &render).unwrap();
    let first_calls = calls.get();

    ensure_pdf_prewarmed_with_renderer(&storage, "book", hash, 25, 5, &render).unwrap();
    assert_eq!(
        calls.get(),
        first_calls,
        "second prewarm with cache intact must not re-render"
    );
}

#[test]
fn ensure_pdf_prewarmed_disk_write_failure_aborts() {
    use crate::storage::Storage;

    // Custom storage stub that fails the third put(). The Storage
    // trait requires `size` and `local_path` in addition to the
    // headline methods, so forward both to the inner LocalStorage.
    struct FailingStorage {
        inner: LocalStorage,
        fail_after: std::cell::Cell<u32>,
    }
    impl Storage for FailingStorage {
        fn get(&self, k: &str) -> FolioResult<Vec<u8>> { self.inner.get(k) }
        fn put(&self, k: &str, v: &[u8]) -> FolioResult<()> {
            let n = self.fail_after.get();
            if n == 0 {
                return Err(FolioError::io("simulated disk failure"));
            }
            self.fail_after.set(n - 1);
            self.inner.put(k, v)
        }
        fn delete(&self, k: &str) -> FolioResult<()> { self.inner.delete(k) }
        fn list(&self, prefix: &str) -> FolioResult<Vec<String>> { self.inner.list(prefix) }
        fn exists(&self, k: &str) -> FolioResult<bool> { self.inner.exists(k) }
        fn size(&self, k: &str) -> FolioResult<u64> { self.inner.size(k) }
        fn local_path(&self, k: &str) -> FolioResult<std::path::PathBuf> {
            self.inner.local_path(k)
        }
    }

    let dir = TempDir::new().unwrap();
    let storage = FailingStorage {
        inner: LocalStorage::new(dir.path()).unwrap(),
        fail_after: std::cell::Cell::new(3),
    };
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        Ok((format!("page-{idx}").into_bytes(), "image/jpeg".into()))
    };

    let result = ensure_pdf_prewarmed_with_renderer(&storage, "book", "h", 25, 10, &render);
    assert!(result.is_err(), "must surface disk failure");
    assert!(
        read_manifest(&storage, "h").is_none(),
        "manifest must not be persisted on partial failure"
    );
    // Rollback must wipe the partial page files as well — otherwise
    // collect_cached_books cannot count them and eviction can never
    // reclaim the space.
    let remaining_pages: Vec<String> = storage
        .list(&book_prefix("h"))
        .unwrap_or_default()
        .into_iter()
        .filter(|k| !k.ends_with("manifest.json"))
        .collect();
    assert!(
        remaining_pages.is_empty(),
        "partial cache must be rolled back; orphans: {remaining_pages:?}"
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p folio-core ensure_pdf_prewarmed -- --nocapture`
Expected: FAIL (`ensure_pdf_prewarmed_with_renderer` does not exist).

- [ ] **Step 3: Implement `ensure_pdf_prewarmed_with_renderer` (+ thin public wrapper)**

Look for the `Storage` trait at `folio-core/src/storage.rs` to confirm method signatures match. The trait shape used in the test stub matches the real trait; if it has additional methods, mirror them in `FailingStorage`.

Add to `folio-core/src/page_cache.rs`, in a new `// PDF cache` section between `extract_cbr` and the existing `get_cached_page` block:

```rust
// ---------------------------------------------------------------------------
// PDF cache (lazy on-disk render cache)
// ---------------------------------------------------------------------------

/// Pre-render the first `prewarm.min(page_count)` pages of a PDF and
/// persist a manifest describing the document. The renderer closure is
/// injected so unit tests can stub pdfium out; production callers go
/// through `ensure_pdf_prewarmed` (below) which wires
/// `pdf::get_page_image_bytes` for them.
///
/// Returns `Err` on the first disk write failure and persists no
/// manifest in that case.
pub fn ensure_pdf_prewarmed_with_renderer<F>(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    page_count: u32,
    prewarm: u32,
    render: F,
) -> FolioResult<CacheManifest>
where
    F: Fn(u32) -> FolioResult<(Vec<u8>, String)>,
{
    let prewarm = prewarm.min(page_count);

    if let Some(mut manifest) = read_manifest(storage, book_hash) {
        if manifest.format == BookFormat::Pdf
            && manifest.page_count == page_count
            && (0..prewarm).all(|i| {
                storage
                    .exists(&page_key(book_hash, &format!("{i:03}.jpg")))
                    .unwrap_or(false)
            })
        {
            page_dbg!(
                "ensure_pdf_prewarmed: cache hit for {} ({}/{} pre-warmed)",
                book_hash,
                prewarm,
                page_count
            );
            manifest.last_accessed = now_iso();
            let _ = write_manifest(storage, book_hash, &manifest);
            return Ok(manifest);
        }
    }

    page_dbg!(
        "ensure_pdf_prewarmed: rendering first {} of {} for {}",
        prewarm,
        page_count,
        book_hash
    );
    let start = std::time::Instant::now();

    // Helper: any failure in the loop or the final manifest write
    // leaves the partial output (page files, possibly an old manifest
    // pointing at stale paths) unreferenced from the manifest layer.
    // `collect_cached_books` skips books without a manifest, so those
    // orphans would never be evicted. Roll back explicitly.
    let try_warm = || -> FolioResult<u64> {
        let mut total_size: u64 = 0;
        for i in 0..prewarm {
            let (bytes, _mime) = render(i)?;
            let name = format!("{i:03}.jpg");
            storage.put(&page_key(book_hash, &name), &bytes)?;
            total_size += bytes.len() as u64;
        }
        Ok(total_size)
    };

    let total_size = match try_warm() {
        Ok(s) => s,
        Err(e) => {
            page_dbg!(
                "ensure_pdf_prewarmed: warm failed for {} — rolling back partial cache",
                book_hash
            );
            let _ = evict_book(storage, book_hash);
            return Err(e);
        }
    };

    page_dbg!(
        "ensure_pdf_prewarmed: warmed {} pages ({} KB) in {:?}",
        prewarm,
        total_size / 1024,
        start.elapsed()
    );

    let now = now_iso();
    let manifest = CacheManifest {
        book_id: book_id.to_string(),
        book_hash: book_hash.to_string(),
        page_count,
        total_size_bytes: total_size,
        extracted_at: now.clone(),
        last_accessed: now,
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(crate::pdf::CACHE_CANONICAL_WIDTH),
    };
    if let Err(e) = write_manifest(storage, book_hash, &manifest) {
        // Same orphan risk as above — clean up before bubbling up.
        let _ = evict_book(storage, book_hash);
        return Err(e);
    }
    Ok(manifest)
}

/// Production entry point: wires `pdf::get_page_count` + `pdf::get_page_image_bytes`
/// into the generic prewarm above. Internal name keeps the symbol that the
/// command layer imports stable across the test/non-test split.
pub fn ensure_pdf_prewarmed(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    prewarm: u32,
) -> FolioResult<CacheManifest> {
    let page_count = crate::pdf::get_page_count(file_path)?;
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        crate::pdf::get_page_image_bytes(
            file_path,
            idx,
            Some(crate::pdf::CACHE_CANONICAL_WIDTH),
        )
    };
    ensure_pdf_prewarmed_with_renderer(storage, book_id, book_hash, page_count, prewarm, render)
}
```

- [ ] **Step 4: Run the three new tests**

Run: `cargo test -p folio-core ensure_pdf_prewarmed`
Expected: all three PASS.

- [ ] **Step 5: Run the whole folio-core suite**

Run: `cargo test -p folio-core`
Expected: PASS (no regression).

- [ ] **Step 6: Run clippy with deny-warnings**

Run from `src-tauri/`: `cargo clippy --workspace -- -D warnings` (clippy on the workspace covers folio-core).
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add folio-core/src/page_cache.rs
git commit -m "feat(folio-core): add ensure_pdf_prewarmed

Pre-renders the first N pages of a PDF at the canonical width and
persists a manifest with format=Pdf, pages=[], canonical_width=Some(2400).
Disk write failure aborts the call without persisting a manifest.

The renderer closure is injected via ensure_pdf_prewarmed_with_renderer
so unit tests can stub pdfium out; the production wrapper wires
pdf::get_page_image_bytes for the command layer."
```

---

### Task 1.5 — `get_or_render_pdf_page_with_eviction` (with `_with_renderer` for tests)

**Files:**
- Modify: `folio-core/src/page_cache.rs` (same PDF section)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn get_or_render_pdf_page_disk_hit_skips_renderer() {
    let (_d, storage) = temp_storage();
    let hash = "h";
    // Seed manifest + page on disk.
    let manifest = CacheManifest {
        book_id: "b".into(),
        book_hash: hash.into(),
        page_count: 10,
        total_size_bytes: 0,
        extracted_at: now_iso(),
        last_accessed: now_iso(),
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(2400),
    };
    write_manifest(&storage, hash, &manifest).unwrap();
    storage.put(&page_key(hash, "003.jpg"), b"cached-bytes").unwrap();

    let render = |_idx: u32| -> FolioResult<(Vec<u8>, String)> {
        panic!("renderer must not be called on cache hit");
    };

    let (bytes, mime) =
        get_or_render_pdf_page_with_renderer(&storage, hash, 3, &render, || {}).unwrap();
    assert_eq!(bytes, b"cached-bytes");
    assert_eq!(mime, "image/jpeg");
}

#[test]
fn get_or_render_pdf_page_miss_writes_disk_and_updates_manifest() {
    let (_d, storage) = temp_storage();
    let hash = "h";
    let manifest = CacheManifest {
        book_id: "b".into(),
        book_hash: hash.into(),
        page_count: 50,
        total_size_bytes: 100,
        extracted_at: now_iso(),
        last_accessed: now_iso(),
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(2400),
    };
    write_manifest(&storage, hash, &manifest).unwrap();

    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()))
    };

    let (bytes, _) =
        get_or_render_pdf_page_with_renderer(&storage, hash, 42, &render, || {}).unwrap();
    assert_eq!(bytes, b"p42");

    assert!(storage.exists(&page_key(hash, "042.jpg")).unwrap());
    let updated = read_manifest(&storage, hash).unwrap();
    assert_eq!(updated.total_size_bytes, 100 + b"p42".len() as u64);
    assert!(updated.pages.is_empty(), "PDF manifests keep pages empty");
}

#[test]
fn get_or_render_pdf_page_out_of_range_errors_without_rendering() {
    let (_d, storage) = temp_storage();
    let hash = "h";
    write_manifest(&storage, hash, &CacheManifest {
        book_id: "b".into(),
        book_hash: hash.into(),
        page_count: 10,
        total_size_bytes: 0,
        extracted_at: now_iso(),
        last_accessed: now_iso(),
        pages: Vec::new(),
        format: BookFormat::Pdf,
        canonical_width: Some(2400),
    }).unwrap();

    let render = |_idx: u32| -> FolioResult<(Vec<u8>, String)> {
        panic!("renderer must not run for out-of-range index");
    };

    let err = get_or_render_pdf_page_with_renderer(&storage, hash, 999, &render, || {}).unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("out of range"), "got: {msg}");
}

#[test]
fn get_or_render_pdf_page_missing_manifest_falls_back_to_render_only() {
    let (_d, storage) = temp_storage();
    let render = |idx: u32| Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()));

    let (bytes, _) =
        get_or_render_pdf_page_with_renderer(&storage, "nope", 0, &render, || {}).unwrap();
    assert_eq!(bytes, b"p0");
    // No manifest → no cache writes.
    assert!(!storage.exists(&page_key("nope", "000.jpg")).unwrap());
}

#[test]
fn get_or_render_pdf_page_swallows_write_failure() {
    use crate::storage::Storage;

    // Storage that fails all puts EXCEPT manifest writes. The
    // Storage trait requires `size` and `local_path`; forward them
    // to the inner LocalStorage.
    struct PageWriteFails {
        inner: LocalStorage,
    }
    impl Storage for PageWriteFails {
        fn get(&self, k: &str) -> FolioResult<Vec<u8>> { self.inner.get(k) }
        fn put(&self, k: &str, v: &[u8]) -> FolioResult<()> {
            if k.ends_with("manifest.json") {
                self.inner.put(k, v)
            } else {
                Err(FolioError::io("simulated"))
            }
        }
        fn delete(&self, k: &str) -> FolioResult<()> { self.inner.delete(k) }
        fn list(&self, p: &str) -> FolioResult<Vec<String>> { self.inner.list(p) }
        fn exists(&self, k: &str) -> FolioResult<bool> { self.inner.exists(k) }
        fn size(&self, k: &str) -> FolioResult<u64> { self.inner.size(k) }
        fn local_path(&self, k: &str) -> FolioResult<std::path::PathBuf> {
            self.inner.local_path(k)
        }
    }
    let dir = TempDir::new().unwrap();
    let storage = PageWriteFails { inner: LocalStorage::new(dir.path()).unwrap() };
    let hash = "h";
    write_manifest(&storage, hash, &CacheManifest {
        book_id: "b".into(), book_hash: hash.into(),
        page_count: 10, total_size_bytes: 0,
        extracted_at: now_iso(), last_accessed: now_iso(),
        pages: Vec::new(), format: BookFormat::Pdf,
        canonical_width: Some(2400),
    }).unwrap();

    let render = |idx: u32| Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()));
    let (bytes, _) =
        get_or_render_pdf_page_with_renderer(&storage, hash, 5, &render, || {}).unwrap();
    assert_eq!(bytes, b"p5");
    // Cache write failed silently; manifest size unchanged.
    let m = read_manifest(&storage, hash).unwrap();
    assert_eq!(m.total_size_bytes, 0);
}

#[test]
fn lazy_eviction_callback_fires_every_batch() {
    let (_d, storage) = temp_storage();
    let hash = "h";
    write_manifest(&storage, hash, &CacheManifest {
        book_id: "b".into(), book_hash: hash.into(),
        page_count: 200, total_size_bytes: 0,
        extracted_at: now_iso(), last_accessed: now_iso(),
        pages: Vec::new(), format: BookFormat::Pdf,
        canonical_width: Some(2400),
    }).unwrap();

    let render = |idx: u32| Ok((format!("p{idx}").into_bytes(), "image/jpeg".into()));
    let calls = std::cell::Cell::new(0u32);
    let on_batch = || calls.set(calls.get() + 1);

    // Reset the global counter so the test is deterministic.
    reset_lazy_eviction_counter_for_tests();

    for i in 0..LAZY_EVICTION_BATCH * 2 {
        get_or_render_pdf_page_with_renderer(&storage, hash, i, &render, &on_batch).unwrap();
    }

    assert_eq!(calls.get(), 2, "callback fires exactly once per batch");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p folio-core get_or_render_pdf_page`
Expected: FAIL (functions and constants do not exist yet).

- [ ] **Step 3: Implement the lazy-render path**

Append below `ensure_pdf_prewarmed` in `folio-core/src/page_cache.rs`:

```rust
/// Lazy cache writes are coalesced into background eviction passes:
/// every `LAZY_EVICTION_BATCH` successful writes fire the caller's
/// `on_batch` hook. The command layer uses this to spawn a background
/// `run_eviction`.
pub const LAZY_EVICTION_BATCH: u32 = 25;

// Global counter rather than per-book — eviction is whole-cache
// anyway, so the trigger cadence does not need to be per-book.
use std::sync::atomic::{AtomicU32, Ordering};
static LAZY_WRITE_COUNTER: AtomicU32 = AtomicU32::new(0);

#[cfg(test)]
pub fn reset_lazy_eviction_counter_for_tests() {
    LAZY_WRITE_COUNTER.store(0, Ordering::SeqCst);
}

/// Disk-first PDF page lookup. On cache miss, renders via the injected
/// closure, attempts to persist (best-effort), and returns the bytes
/// either way. Manifest must already exist (created by
/// `ensure_pdf_prewarmed`); without one, falls back to render-only.
///
/// `on_batch` fires when the lazy-write counter crosses a multiple of
/// `LAZY_EVICTION_BATCH` — the command layer wires this to spawn a
/// background eviction.
pub fn get_or_render_pdf_page_with_renderer<F, B>(
    storage: &dyn Storage,
    book_hash: &str,
    page_index: u32,
    render: F,
    on_batch: B,
) -> FolioResult<(Vec<u8>, String)>
where
    F: Fn(u32) -> FolioResult<(Vec<u8>, String)>,
    B: Fn(),
{
    let manifest_opt = read_manifest(storage, book_hash);

    if let Some(ref manifest) = manifest_opt {
        if manifest.format == BookFormat::Pdf {
            // Guard against out-of-range indices before either the
            // disk lookup or the renderer runs. `get_cached_page`
            // returns `NotFound` both for "file missing" and "index
            // >= page_count"; we want the latter to surface to the
            // caller rather than silently fall through to the
            // expensive render + cache path.
            if page_index >= manifest.page_count {
                return Err(FolioError::not_found(format!(
                    "Page index {page_index} out of range (total: {})",
                    manifest.page_count
                )));
            }
            if let Ok((data, mime)) = get_cached_page(storage, book_hash, page_index) {
                return Ok((data, mime));
            }
        }
    }

    let (bytes, mime) = render(page_index)?;

    // Only attempt to cache when a manifest exists; otherwise just
    // return the rendered bytes. Cache writes are best-effort.
    if let Some(mut manifest) = manifest_opt {
        if manifest.format == BookFormat::Pdf {
            let name = format!("{page_index:03}.jpg");
            match storage.put(&page_key(book_hash, &name), &bytes) {
                Ok(()) => {
                    manifest.total_size_bytes =
                        manifest.total_size_bytes.saturating_add(bytes.len() as u64);
                    manifest.last_accessed = now_iso();
                    let _ = write_manifest(storage, book_hash, &manifest);

                    let prev = LAZY_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
                    if (prev + 1) % LAZY_EVICTION_BATCH == 0 {
                        on_batch();
                    }
                }
                Err(e) => {
                    page_dbg!(
                        "lazy cache write failed for {}/{}: {} — serving from memory",
                        book_hash,
                        name,
                        e
                    );
                }
            }
        }
    }

    Ok((bytes, mime))
}

/// Production wrapper: wires `pdf::get_page_image_bytes` and forwards
/// the `on_batch` callback unchanged.
pub fn get_or_render_pdf_page_with_eviction<B>(
    storage: &dyn Storage,
    book_hash: &str,
    file_path: &str,
    page_index: u32,
    on_batch: B,
) -> FolioResult<(Vec<u8>, String)>
where
    B: Fn(),
{
    let render = |idx: u32| -> FolioResult<(Vec<u8>, String)> {
        crate::pdf::get_page_image_bytes(file_path, idx, Some(crate::pdf::CACHE_CANONICAL_WIDTH))
    };
    get_or_render_pdf_page_with_renderer(storage, book_hash, page_index, render, on_batch)
}

/// No-op-eviction variant for callers that do not have a runtime
/// to dispatch the background pass (tests, ad-hoc tooling).
pub fn get_or_render_pdf_page(
    storage: &dyn Storage,
    book_hash: &str,
    file_path: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)> {
    get_or_render_pdf_page_with_eviction(storage, book_hash, file_path, page_index, || {})
}
```

- [ ] **Step 4: Run new + existing tests**

Run: `cargo test -p folio-core`
Expected: all PASS.

- [ ] **Step 5: clippy**

Run from workspace root: `cargo clippy --workspace -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/page_cache.rs
git commit -m "feat(folio-core): lazy on-disk PDF page cache + coalesced eviction hook

get_or_render_pdf_page checks the manifest, returns cached bytes on
hit, otherwise renders via an injected closure and writes the result
under {NNN}.jpg. Cache writes are best-effort — failures are logged
and swallowed; the rendered bytes still reach the caller. A global
atomic counter coalesces lazy writes into eviction batches: the
caller's on_batch hook fires every LAZY_EVICTION_BATCH (=25) writes
so the command layer can spawn run_eviction without blocking the
hot path."
```

---

## Milestone m2 — Tauri command layer

### Task 2.1 — Register `prepare_pdf`

**Files:**
- Modify: `src-tauri/src/commands.rs` (new function near `prepare_comic`)
- Modify: `src-tauri/src/lib.rs:289-292` (invoke_handler list)

- [ ] **Step 1: Add `prepare_pdf`**

In `src-tauri/src/commands.rs`, immediately after the `prepare_comic` function block (search for `pub async fn prepare_comic`), add:

```rust
/// First-open warm pass for PDF books. Mirrors `prepare_comic`:
/// asserts the format, requires `book.file_hash`, renders the first
/// ten pages into the shared `page-cache/` namespace, and kicks off
/// a background eviction afterwards. Returns the freshly-written
/// manifest so the frontend knows the total page count and any
/// pre-warm errors are surfaced.
#[tauri::command]
pub async fn prepare_pdf(
    book_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<page_cache::CacheManifest> {
    const PDF_PREWARM_PAGES: u32 = 10;

    let (book, max_size_mb) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        let max_size_mb = db::get_setting(&conn, "page_cache_max_size_mb")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(page_cache::DEFAULT_MAX_CACHE_SIZE_MB);
        (book, max_size_mb)
    };
    let file_path = state.resolve_book_path(&book)?;
    validate_file_exists(&file_path)?;

    if book.format != BookFormat::Pdf {
        return Err(FolioError::invalid("prepare_pdf only supports PDF format"));
    }
    let book_hash = book
        .file_hash
        .as_deref()
        .ok_or_else(|| FolioError::invalid("Book has no file hash; cannot populate PDF cache"))?;

    let storage = page_cache_storage(&app)?;
    let prep_start = std::time::Instant::now();
    page_cache::page_dbg!(
        "prepare_pdf: book={} hash={} prewarm={}",
        book_id,
        book_hash,
        PDF_PREWARM_PAGES
    );
    let manifest =
        page_cache::ensure_pdf_prewarmed(&storage, &book_id, book_hash, &file_path, PDF_PREWARM_PAGES)?;
    page_cache::page_dbg!(
        "prepare_pdf done: page_count={} size={}KB elapsed={:?}",
        manifest.page_count,
        manifest.total_size_bytes / 1024,
        prep_start.elapsed()
    );

    let evict_storage = page_cache_storage(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = page_cache::run_eviction(&evict_storage, max_size_mb);
    });

    Ok(manifest)
}
```

- [ ] **Step 2: Register the command in `src-tauri/src/lib.rs`**

Find the existing line `commands::get_pdf_page_bytes,` inside the `invoke_handler` macro and add the new line beside it:

```rust
commands::check_pdf_support,
commands::get_pdf_page_count,
commands::get_pdf_page_bytes,
commands::prepare_pdf,   // <-- new
```

- [ ] **Step 3: Build to verify compilation**

Run from `src-tauri/`: `cargo build`
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add prepare_pdf

Mirrors prepare_comic exactly: asserts the format, requires
book.file_hash, calls page_cache::ensure_pdf_prewarmed for the first
ten pages, and spawns a background eviction tied to the configured
page_cache_max_size_mb setting. Registered in lib.rs invoke_handler."
```

---

### Task 2.2 — Rewrite `get_pdf_page_bytes` for cache-first + lazy eviction trigger

**Files:**
- Modify: `src-tauri/src/commands.rs:3687-3705` (existing `get_pdf_page_bytes`)

- [ ] **Step 1: Replace the body**

Locate the existing `get_pdf_page_bytes` (search for `pub async fn get_pdf_page_bytes`). Replace the entire function with:

```rust
/// PDF page reader for the desktop frontend. Cache-first against the
/// `page-cache/` namespace populated by `prepare_pdf`; on miss, renders
/// at the canonical width, writes to disk (best-effort), then resizes
/// to the viewport width before responding. Linked / no-hash PDFs
/// bypass the cache and render directly at the viewport width to
/// preserve pre-spec performance.
///
/// `width` controls the viewport-target width (clamped to 9600). When
/// omitted, `folio_core::pdf::get_page_image_bytes` falls back to
/// `DEFAULT_RENDER_WIDTH` (1200 px).
#[tauri::command]
pub async fn get_pdf_page_bytes(
    book_id: String,
    page_index: u32,
    width: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<tauri::ipc::Response> {
    let render_width = width.filter(|&w| w > 0).map(|w| w.min(9600));

    let book = {
        let conn = state.active_db()?.get()?;
        db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?
    };
    let file_path = state.resolve_book_path(&book)?;
    validate_file_exists(&file_path)?;

    // Cache-first path.
    if let Ok(storage) = page_cache_storage(&app) {
        if let Some(ref book_hash) = book.file_hash {
            if let Ok((data, mime)) = page_cache::get_cached_page(&storage, book_hash, page_index) {
                let (bytes, out_mime) =
                    crate::image_util::maybe_resize_to_jpeg(data, mime, render_width)?;
                return Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(
                    bytes, &out_mime,
                )));
            }
        }
    }

    // Miss path. Use the cached-render code path (canonical 2400 px
    // render + best-effort disk write) only when a PDF manifest is
    // already in place — otherwise we pay the higher canonical-width
    // render cost without getting cache reuse. Without a manifest
    // (prepare_pdf never ran, failed, or wrote a non-PDF manifest),
    // fall back to a direct render at the viewport width — the same
    // behaviour shipped before this spec landed.
    let (bytes, mime) = if let Some(book_hash) = book.file_hash.clone() {
        if let Ok(storage) = page_cache_storage(&app) {
            let has_pdf_manifest = page_cache::read_manifest(&storage, &book_hash)
                .map(|m| m.format == BookFormat::Pdf)
                .unwrap_or(false);
            if has_pdf_manifest {
                // Eviction callback. Cloning the AppHandle so it can
                // outlive this call into the background spawn.
                let app_for_evict = app.clone();
                let max_size_mb = {
                    let conn = state.active_db()?.get()?;
                    db::get_setting(&conn, "page_cache_max_size_mb")
                        .ok()
                        .flatten()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(page_cache::DEFAULT_MAX_CACHE_SIZE_MB)
                };
                let on_batch = move || {
                    if let Ok(evict_storage) = page_cache_storage(&app_for_evict) {
                        tauri::async_runtime::spawn_blocking(move || {
                            let _ = page_cache::run_eviction(&evict_storage, max_size_mb);
                        });
                    }
                };
                page_cache::get_or_render_pdf_page_with_eviction(
                    &storage,
                    &book_hash,
                    &file_path,
                    page_index,
                    on_batch,
                )?
            } else {
                // No PDF manifest — viewport render, no cache.
                pdf::get_page_image_bytes(&file_path, page_index, render_width)?
            }
        } else {
            // Storage unavailable — viewport render, no cache.
            pdf::get_page_image_bytes(&file_path, page_index, render_width)?
        }
    } else {
        // No file hash — viewport render, no cache.
        pdf::get_page_image_bytes(&file_path, page_index, render_width)?
    };

    // Cache-miss canonical-render branch produced 2400 px JPEG bytes;
    // the no-cache fallbacks already match `render_width`.
    // `maybe_resize_to_jpeg` is a no-op when input == target.
    let (bytes, out_mime) = crate::image_util::maybe_resize_to_jpeg(bytes, mime, render_width)?;
    Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(
        bytes, &out_mime,
    )))
}
```

- [ ] **Step 2: Build to verify compilation**

Run from `src-tauri/`: `cargo build`
Expected: clean.

- [ ] **Step 3: Run the full Rust test suite from workspace root**

Run from project root: `cargo test`
Expected: all PASS (no command-layer regression; cache path is exercised by the folio-core tests already, and the command-layer integration is structurally identical to `get_comic_page_bytes`).

- [ ] **Step 4: clippy + fmt**

Run from `src-tauri/`:
```bash
cargo fmt --check
cargo clippy -- -D warnings
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): cache-first get_pdf_page_bytes

Disk hit → resize → respond, mirroring get_comic_page_bytes.
Miss path goes through page_cache::get_or_render_pdf_page_with_eviction
which renders at the canonical 2400 px width, persists best-effort,
and fires a background eviction every 25 lazy writes via the closure
hook. Linked / no-hash / no-storage PDFs render at the viewport
width directly so uncacheable books stay at pre-spec performance."
```

---

## Milestone m3 — Frontend wiring + docs

### Task 3.1 — Reader.tsx invokes `prepare_pdf` for PDF books

**Files:**
- Modify: `src/screens/Reader.tsx:226-248` (existing `prepare_comic` block + the immediate `get_*_page_count` block that follows)

- [ ] **Step 1: Extend the prepare block + reuse the returned manifest**

`prepare_pdf` returns a `CacheManifest` whose `page_count` is the document total — exactly what `get_pdf_page_count` would return, except `prepare_pdf` already paid the open-and-count cost. Reusing the manifest avoids a second pdfium open + `FPDF_GetPageCount` round-trip per PDF.

Replace lines 226–248 of `src/screens/Reader.tsx` (the existing `prepare_*` block plus the immediate `get_*_page_count` block) with:

```typescript
// Capture the prewarmed manifest's page_count if available so we can
// skip the dedicated count round-trip below. PDF only — comic flow
// is unchanged.
let prewarmedPageCount: number | null = null;

if (bookInfo.format === "cbz" || bookInfo.format === "cbr") {
  try {
    await invoke("prepare_comic", { bookId });
  } catch (e) {
    console.warn("Cache preparation failed, falling back to direct read:", e);
  }
} else if (bookInfo.format === "pdf") {
  try {
    // The Rust CacheManifest struct exposes `page_count` (u32); we
    // only need that field on the frontend, so type it narrowly.
    const manifest = await invoke<{ page_count: number }>("prepare_pdf", { bookId });
    if (typeof manifest?.page_count === "number") {
      prewarmedPageCount = manifest.page_count;
    }
  } catch (e) {
    // No file hash, linked book, or transient disk error.
    // Reader still works through the live render path.
    console.warn("PDF cache preparation failed, falling back to direct read:", e);
  }
}

// Page count is only meaningful for fixed-layout (PDF) and image
// (CBZ/CBR) formats. HTML-reflowable books (EPUB + MOBI) use scroll
// progress instead, so skip the fetch and leave pageCount at 0.
if (bookInfo.format === "pdf" || bookInfo.format === "cbz" || bookInfo.format === "cbr") {
  if (bookInfo.format === "pdf" && prewarmedPageCount !== null) {
    if (!cancelled) setPageCount(prewarmedPageCount);
  } else {
    try {
      const command =
        bookInfo.format === "pdf"
          ? "get_pdf_page_count"
          : "get_comic_page_count";
      const count = await invoke<number>(command, { bookId });
      if (!cancelled) setPageCount(count);
    } catch {
      // page count unavailable
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run from project root: `npm run type-check`
Expected: clean.

- [ ] **Step 3: Run the frontend tests**

Run from project root: `npm run test -- --run`
Expected: all PASS (no Reader test exercises this branch directly).

- [ ] **Step 4: Commit**

```bash
git add src/screens/Reader.tsx
git commit -m "feat(reader): invoke prepare_pdf and reuse its manifest page_count

Mirrors the existing prepare_comic branch. A failure is non-fatal:
the reader still serves pages through the live render path so
linked / unhashed PDFs keep working.

prepare_pdf returns a CacheManifest whose page_count is the
document total. Reusing it avoids the extra pdfium open + page
count round-trip that get_pdf_page_count would otherwise pay.
Comic flow is unchanged (prepare_comic's manifest is still
discarded; that's outside this milestone's scope)."
```

---

### Task 3.2 — CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (under `[Unreleased]`)

- [ ] **Step 1: Add the entry**

In `CHANGELOG.md`, inside the existing `## [Unreleased]` block, add a new section above (or merge into) the existing `### Performance` block:

```markdown
- **PDF page disk cache** (ROADMAP "perf + comics" #3). Rendered PDF pages now survive app restarts. On first open of a PDF, `prepare_pdf` renders the first ten pages at a fixed canonical width (2400 px) into the shared `page-cache/{hash}/` namespace. Subsequent reads hit disk and resize down to the viewport width, bypassing pdfium entirely. Cache misses render at the canonical width, write best-effort, and trigger a coalesced background eviction every 25 lazy writes. Shares the same Settings size cap and LRU / 7-day eviction as the comic cache. Linked / unhashed PDFs gracefully fall back to live render at the viewport width.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for PDF disk cache"
```

---

### Task 3.3 — Mark roadmap item shipped

**Files:**
- Modify: `docs/ROADMAP.md` (item #3 of the "perf + comics" bundle at the line that currently begins `3. **PDF disk cache — P3.**`)

- [ ] **Step 1: Strike through with a shipped marker**

Replace that line with:

```markdown
3. ~~**PDF disk cache — P3.**~~ — **shipped 2026-05-16.** First-open warm of 10 pages + lazy fill, all under the existing `page-cache/{hash}/` namespace. Cached at canonical 2400 px and downscaled per viewport request. Shares the comic cache budget, LRU, and 7-day eviction; lazy writes coalesce into a background eviction every 25 pages. Linked PDFs (no file hash) gracefully bypass the cache and render at the viewport width. ([CHANGELOG](../CHANGELOG.md#unreleased))
```

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): mark PDF disk cache (#3 perf bundle) as shipped"
```

---

## Final Sanity Checks

After Task 3.3, run the full local CI suite once more to make sure nothing slipped between milestones:

- [ ] **Step 1: Workspace tests**

Run from project root:
```bash
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test
cargo test -p folio-core --features mobi
npm run type-check
npm run test -- --run
```

Expected: every command exits 0.

- [ ] **Step 2: Manual smoke test (read-only — no commits expected)**

Run `npm run tauri dev`. Open a PDF that was never previously opened in this session. Observe:
1. The reader shows the "Preparing pages…" overlay briefly (≤ ~5 s for a 10-page warm at typical complexity).
2. The first page renders immediately after.
3. Open the system file browser and confirm `page-cache/{hash}/000.jpg` through `009.jpg` exist under the app data directory.
4. Close the app entirely. Reopen the same PDF. Verify the first-page render is near-instant (disk hit).
5. Scroll to page 50 (a lazy-fill case). Reopen the app and jump to page 50. Verify that page is now also near-instant.

This step does not produce commits — just confirms the wiring.

---

## Notes for the Implementer

- **DO NOT** add unrelated cleanups inside the touched files (`page_cache.rs` is large; resist reformatting). Every diff line should trace to the spec.
- **DO NOT** introduce new tracing dependencies; reuse `page_dbg!` for all PDF cache logging.
- **DO NOT** wrap the eviction spawn in a runtime check; `tauri::async_runtime::spawn_blocking` is safe to call from any command path.
- Cache writes are best-effort by design — do not bubble disk errors out of `get_or_render_pdf_page` once the bytes are in memory.
- The spec is authoritative if anything in this plan looks inconsistent with it. Surface the divergence before changing the spec.
