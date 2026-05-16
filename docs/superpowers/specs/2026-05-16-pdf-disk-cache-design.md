# PDF Disk Cache

## Overview

PDF pages today are rendered by pdfium on every request. A reading-size render costs roughly 100 ms – 2 s per page depending on document complexity, and the result lives only in an in-memory LRU; closing the app discards it. This spec adds an on-disk cache for rendered PDF pages that survives restarts.

The cache reuses the existing `page-cache/{hash}/` namespace, manifest format, and three-tier eviction (LRU / size cap / age) that already serves the CBZ and CBR readers. Both formats share one Settings slider, one storage budget, and one eviction pass.

A PDF is pre-warmed at the first ten pages on reader open (mirroring `prepare_comic`); subsequent pages fill lazily on demand. Cached pages are rendered at a fixed canonical width (2400 px) and downscaled on read to the viewport-derived target width — the same pattern the comic cache uses to serve archive scans at viewport resolution.

## Goals

- A second open of any PDF page hits disk instead of pdfium.
- First open of a PDF feels indistinguishable from the comic flow (a brief "Preparing pages…" then immediate first-page render).
- No new Settings UI; no new user-facing concept.
- Existing comic manifests deserialize without migration.

## Non-Goals

- Pre-rendering every page of large PDFs at import time.
- Per-width disk variants (we cache one canonical size and resize on read).
- In-memory pdfium document caching changes.
- Background prefetch beyond the explicit pre-warm window.

## Architecture

### `folio-core/src/page_cache.rs`

`CacheManifest` gains two fields, both backward-compatible via serde defaults so existing comic manifests continue to load:

```rust
pub struct CacheManifest {
    pub book_id: String,
    pub book_hash: String,
    pub page_count: u32,
    pub total_size_bytes: u64,
    pub extracted_at: String,
    pub last_accessed: String,
    pub pages: Vec<String>,

    // NEW — defaults to BookFormat::Cbz so legacy manifests parse.
    #[serde(default)]
    pub format: BookFormat,

    // NEW — Some(2400) for PDF, None for comic (which caches archive bytes
    // as-is and lets the resize helper clamp on read).
    #[serde(default)]
    pub canonical_width: Option<u32>,
}
```

Two new functions, side by side with the existing `extract_cbz` / `extract_cbr` pair:

```rust
pub fn ensure_pdf_prewarmed(
    storage: &dyn Storage,
    book_id: &str,
    book_hash: &str,
    file_path: &str,
    prewarm: u32,
) -> FolioResult<CacheManifest>;

pub fn get_or_render_pdf_page(
    storage: &dyn Storage,
    book_hash: &str,
    file_path: &str,
    page_index: u32,
) -> FolioResult<(Vec<u8>, String)>;
```

`ensure_pdf_prewarmed`:
1. Read manifest if present. If `format == Pdf` and the first `prewarm.min(page_count)` page keys exist on disk, refresh `last_accessed` and return.
2. Otherwise query `pdf::get_page_count(file_path)` for `page_count`, render pages `0..prewarm.min(page_count)` at `pdf::CACHE_CANONICAL_WIDTH`, write each as `{NNN}.jpg`, and persist the manifest with `format = Pdf`, `canonical_width = Some(2400)`, and `pages` populated with the rendered filenames.

`get_or_render_pdf_page`:
1. Try `get_cached_page(storage, book_hash, page_index)`. On success, return its bytes + mime unchanged.
2. On miss, call `pdf::get_page_image_bytes(file_path, page_index, Some(CACHE_CANONICAL_WIDTH))`. Write the bytes to disk under `{NNN}.jpg`, update the manifest (`pages` slot, `total_size_bytes`, `last_accessed`), then return the bytes.

`ensure_cached` gains a `BookFormat::Pdf` arm that delegates to `ensure_pdf_prewarmed(..., prewarm=10)`. Comic arms unchanged.

`run_eviction`, `collect_cached_books`, `get_cache_stats`, and `clear_cache` need no logic changes — they are already format-agnostic.

### `folio-core/src/pdf.rs`

Adds one constant:

```rust
pub const CACHE_CANONICAL_WIDTH: u32 = 2400;
```

`get_page_image_bytes` is unchanged.

### `src-tauri/src/commands.rs`

New command, registered in `lib.rs`'s `invoke_handler`:

```rust
#[tauri::command]
pub async fn prepare_pdf(
    book_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<page_cache::CacheManifest>;
```

Resolves the book + file path, asserts the format is `Pdf`, requires `book.file_hash` (PDFs without a hash skip caching — same precondition the comic path already enforces), and calls `page_cache::ensure_pdf_prewarmed(..., prewarm=10)`. Returns the manifest so the frontend knows how many pages exist.

`get_pdf_page_bytes` is rewritten to follow the same shape as `get_comic_page_bytes`:

```rust
let render_width = width.filter(|&w| w > 0).map(|w| w.min(9600));

// Cache-first path. Cached pages are at the canonical render width;
// resize on read to the viewport-derived target.
if let Ok(storage) = page_cache_storage(&app) {
    if let Some(ref book_hash) = book.file_hash {
        if let Ok((data, mime)) = page_cache::get_cached_page(&storage, book_hash, page_index) {
            let (bytes, out_mime) =
                crate::image_util::maybe_resize_to_jpeg(data, mime, render_width)?;
            return Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(bytes, &out_mime)));
        }
    }
}

// Miss: render at canonical width, write to cache, then resize.
let (bytes, mime) = if let Ok(storage) = page_cache_storage(&app) {
    if let Some(ref book_hash) = book.file_hash {
        page_cache::get_or_render_pdf_page(&storage, book_hash, &file_path, page_index)?
    } else {
        pdf::get_page_image_bytes(&file_path, page_index, render_width)?
    }
} else {
    pdf::get_page_image_bytes(&file_path, page_index, render_width)?
};

let (bytes, out_mime) = crate::image_util::maybe_resize_to_jpeg(bytes, mime, render_width)?;
Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(bytes, &out_mime)))
```

The structure mirrors the comic command intentionally, so the two paths stay easy to read against each other.

### Frontend `src/screens/Reader.tsx`

The reader already invokes `prepare_comic` when opening a CBZ / CBR book and shows a "Preparing pages…" overlay during the call. Extend the same code path:

```ts
if (bookFormat === "pdf") {
  await invoke<CacheManifest>("prepare_pdf", { bookId });
} else if (bookFormat === "cbz" || bookFormat === "cbr") {
  await invoke<CacheManifest>("prepare_comic", { bookId });
}
```

The existing overlay UI, error path, and `CacheManifest` TypeScript type are reused as-is.

## Data Flow

```
Open PDF
  Reader.tsx
    invoke prepare_pdf(book_id)
      commands::prepare_pdf
        page_cache::ensure_pdf_prewarmed(prewarm=10)
          for i in 0..10:
            pdf::get_page_image_bytes(.., Some(2400))
            storage.put("page-cache/{hash}/{NNN}.jpg")
          write_manifest({ format: Pdf, canonical_width: Some(2400), .. })
      <- CacheManifest

Read page (viewport-derived width = 1600)
  invoke get_pdf_page_bytes(book_id, page_index=42, width=1600)
    commands::get_pdf_page_bytes
      page_cache::get_cached_page("{hash}", 42)
        HIT  -> image_util::maybe_resize_to_jpeg(2400 -> 1600)
              -> page_wire::append_tag -> Response
        MISS -> page_cache::get_or_render_pdf_page
                  pdf::get_page_image_bytes(.., Some(2400))
                  storage.put("page-cache/{hash}/042.jpg")
                  update manifest
                -> image_util::maybe_resize_to_jpeg(2400 -> 1600)
                -> page_wire::append_tag -> Response
```

## Cache Key & Invalidation

- Cached page key: `page-cache/{book_hash}/{NNN}.jpg`. Identical layout to the comic cache.
- Invalidation is implicit: the storage key is keyed by `book_hash`. A modified PDF file gets a new hash on import, lands at a different storage prefix, and the old entry is evicted by the LRU pass when the budget pressure hits.
- Width is not part of the key. Only one cached form per page; viewport-resize-on-read handles the variable target width. Identical to comic behaviour.

## Eviction & Memory

- Disk eviction: existing `run_eviction` runs unchanged. LRU keeps at most five cached books, the size cap from Settings applies across PDF and comic combined, age expiry kicks in at 7 days idle. PDF entries are treated identically to comic entries because the manifest exposes `total_size_bytes` and `last_accessed` in the same shape.
- In-memory pdfium document cache: out of scope. The existing in-process LRU still serves intra-session reads; this spec is about cross-session persistence.

## Backward Compatibility

- Comic manifests written before this change omit `format` and `canonical_width`. Serde defaults supply `format = BookFormat::Cbz` and `canonical_width = None` on load. On the next manifest write (any cache touch) the missing fields are persisted with the correct values.
- No DB migration is required.
- No frontend behaviour changes for comic books.

## Error Handling

- pdfium render failure inside `get_or_render_pdf_page` returns a `FolioError::Internal` (whatever `pdf::get_page_image_bytes` already returns). Nothing is written to disk on failure.
- Disk write failure during `get_or_render_pdf_page` is logged through `page_dbg!` and the in-memory bytes are still returned so the user sees the page. Cache stays best-effort.
- `read_manifest` returning corrupt JSON is already handled by the existing recovery path (`Option::None` -> re-extract). For PDF this triggers a re-warm of the first 10 pages on the next open.
- `prepare_pdf` invoked for a book whose `file_hash` is `None` returns the file-path-resolved manifest with `page_count` filled but no on-disk writes — caching simply skips. The reader still works against the live render path.

## Testing

`folio-core` unit tests (added next to the existing `page_cache` suite):

- `ensure_pdf_prewarmed_writes_first_n_pages` — fixture PDF, verify N files on disk + manifest reflects them.
- `ensure_pdf_prewarmed_is_idempotent` — second call without changes is a no-op (no extra renders).
- `get_or_render_pdf_page_disk_hit_skips_pdfium` — mock pdf renderer would fail; the disk hit must not call it.
- `get_or_render_pdf_page_miss_writes_disk` — page not previously cached gets persisted after the call.
- `manifest_legacy_comic_loads_without_format_field` — serde-default check, ensures backward compat.
- `run_eviction_evicts_pdf_book_under_size_pressure` — PDF cache participates in eviction.

Tauri layer (`src-tauri/src/commands.rs`):

- `get_pdf_page_bytes` cache-hit path returns the resized bytes from the cache and bypasses pdfium.
- `get_pdf_page_bytes` cache-miss path renders, caches, then returns the resized bytes.
- `prepare_pdf` rejects non-PDF formats with `FolioError::Invalid`.

Frontend tests: no Vitest coverage added — the prepare call extension is a one-line shape change reusing existing UI.

CI gates: existing `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check`, `npm run type-check`, and Vitest must all stay green.

## Milestones (autonomous-milestones)

1. **m1 — folio-core**: extend `CacheManifest`, add `ensure_pdf_prewarmed`, `get_or_render_pdf_page`, add `CACHE_CANONICAL_WIDTH`, write unit tests. Existing PDF command path unchanged.
2. **m2 — Tauri layer**: register `prepare_pdf`, rewrite `get_pdf_page_bytes` for cache-first + resize-on-read, add tests for the cache-hit and cache-miss branches.
3. **m3 — Frontend**: extend the existing `prepare_*` call site to fire `prepare_pdf` on PDF books. Update CHANGELOG. Mark ROADMAP item #3 of the "perf + comics" bundle as shipped.
