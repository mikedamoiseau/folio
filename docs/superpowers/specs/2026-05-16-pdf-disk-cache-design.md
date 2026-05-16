# PDF Disk Cache

## Overview

PDF pages today are rendered by pdfium on every request and the rendered bytes are discarded once they leave the IPC response (`src-tauri/src/commands.rs:3701`). A reading-size render costs roughly 100 ms – 2 s per page depending on document complexity, so re-opening a book, jumping back to a previously visited page, or even reloading after a window resize re-pays that cost from scratch. This spec adds an on-disk cache for rendered PDF pages that survives restarts.

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

`CacheManifest` gains two new fields. Both are backward-compatible: existing comic manifests written before this change deserialize cleanly because `format` falls back via a named default function (avoiding a global `Default` impl on `BookFormat`, which would carry semantic weight everywhere else) and `canonical_width` uses serde's `Option` default.

```rust
fn default_cache_format() -> BookFormat {
    // Legacy comic manifests pre-dated the field. CBZ is the safest
    // default because CBR ones contained CBR-specific filenames that
    // round-trip identically through the comic read path.
    BookFormat::Cbz
}

pub struct CacheManifest {
    pub book_id: String,
    pub book_hash: String,
    pub page_count: u32,
    pub total_size_bytes: u64,
    pub extracted_at: String,
    pub last_accessed: String,
    pub pages: Vec<String>,

    // NEW — distinguishes comic manifests (dense `pages`, archive entry
    // names) from PDF manifests (empty `pages`, filenames derived from
    // index). Defaulted via a function so we do not need to declare a
    // global `Default for BookFormat` impl.
    #[serde(default = "default_cache_format")]
    pub format: BookFormat,

    // NEW — `Some(2400)` for PDF, `None` for comic (which caches archive
    // bytes as-is and lets the resize helper clamp on read).
    #[serde(default)]
    pub canonical_width: Option<u32>,
}
```

The `pages` field stays a `Vec<String>` and stays the source of truth for comic books. **For PDF the vector is intentionally left empty**; PDF page filenames are deterministic (`{NNN}.jpg` zero-padded to three digits) and derived from the page index at read time. Trying to pre-populate `pages` with placeholders for a 1000-page PDF would either bloat the manifest or force us into a sparse representation (`Vec<Option<String>>`) that breaks the comic invariant where every slot is `Some`. Branching on `manifest.format` keeps the two paths cleanly separated.

`get_cached_page` is updated to handle both shapes:

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

    let mime = mime_for(&page_name);
    Ok((data, mime.to_string()))
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

`ensure_pdf_prewarmed` (failure surfaces — the user is waiting):
1. Read manifest. If `format == Pdf` and pages `0..prewarm.min(page_count)` all exist on disk, refresh `last_accessed`, write the manifest, return.
2. Otherwise:
   - `page_count = pdf::get_page_count(file_path)`.
   - For `i in 0..prewarm.min(page_count)`: render at `pdf::CACHE_CANONICAL_WIDTH` via `pdf::get_page_image_bytes(_, i, Some(2400))`, write to `page-cache/{hash}/{i:03}.jpg`. **Any disk write failure aborts the call and returns `FolioError::Io`** (matches the explicit user-visible "Preparing pages…" contract).
   - Persist manifest with `format = BookFormat::Pdf`, `canonical_width = Some(2400)`, `pages = Vec::new()`, `total_size_bytes` summed from writes, `extracted_at` / `last_accessed = now`.

`get_or_render_pdf_page` (best-effort — the user is reading a page that must appear):
1. `read_manifest`. If missing or `format != Pdf`, fall back to live render and skip the cache entirely (the `prepare_pdf` path is responsible for establishing the manifest; without it we do not synthesize one mid-session).
2. Try `get_cached_page(storage, book_hash, page_index)`. On success, return its bytes + mime.
3. On miss: `pdf::get_page_image_bytes(file_path, page_index, Some(CACHE_CANONICAL_WIDTH))`. Attempt to `storage.put` under `{NNN}.jpg`. **A failed disk write is logged via `page_dbg!` and swallowed** — the in-memory bytes are still returned so the user sees the page. On successful write, update the manifest's `total_size_bytes` (additive) and `last_accessed`. Manifest update failures are also swallowed (best-effort).

`ensure_cached` gains a `BookFormat::Pdf` arm that delegates to `ensure_pdf_prewarmed(..., prewarm=10)`. Comic arms unchanged.

`run_eviction`, `collect_cached_books`, `get_cache_stats`, and `clear_cache` need no logic changes — they iterate manifests independent of format. PDF manifests participate in the same LRU / size / age budget.

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

Resolves the book + file path, asserts the format is `Pdf`, **requires `book.file_hash`** and returns `FolioError::Invalid` if it is missing (mirrors `prepare_comic` exactly, see `src-tauri/src/commands.rs:1980`). Calls `page_cache::ensure_pdf_prewarmed(..., prewarm=10)`, then spawns a background `run_eviction` against the configured `page_cache_max_size_mb` setting (same pattern as `prepare_comic`'s post-warm eviction at `src-tauri/src/commands.rs:1999`).

Linked / not-yet-hashed PDFs are not a supported caching target — they keep working because `get_pdf_page_bytes` falls back to the direct render path when no hash is present (see below). The reader is responsible for treating a `prepare_pdf` error as non-fatal: it can still serve the book uncached.

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

// Miss: render at canonical width, write to cache (best-effort),
// then resize. `get_or_render_pdf_page` internally also nudges the
// coalesced lazy-eviction counter on successful writes.
let (bytes, mime) = if let Ok(storage) = page_cache_storage(&app) {
    if let Some(ref book_hash) = book.file_hash {
        let app_handle = app.clone();
        let max_size_mb = page_cache_max_size_mb(&app);
        page_cache::get_or_render_pdf_page_with_eviction(
            &storage,
            book_hash,
            &file_path,
            page_index,
            // Hook fired on writes that cross LAZY_EVICTION_BATCH.
            // Spawns a background eviction; never blocks the response.
            move || {
                let storage = page_cache_storage(&app_handle).ok();
                if let Some(storage) = storage {
                    tauri::async_runtime::spawn_blocking(move || {
                        let _ = page_cache::run_eviction(&storage, max_size_mb);
                    });
                }
            },
        )?
    } else {
        // Linked / no-hash PDF — direct render at the viewport width.
        // Skipping the cache means skipping the canonical-width step
        // too; the cache only exists to amortise the cost of a 2400 px
        // render across reuses, which we cannot get here.
        pdf::get_page_image_bytes(&file_path, page_index, render_width)?
    }
} else {
    // Storage unavailable — same reasoning as the no-hash branch.
    pdf::get_page_image_bytes(&file_path, page_index, render_width)?
};

// The cache-miss branch returned canonical-width bytes; the no-hash /
// no-storage branches already rendered at `render_width`. Either way,
// `maybe_resize_to_jpeg` is a no-op when the input is already at the
// target width, so the call below stays valid.
let (bytes, out_mime) = crate::image_util::maybe_resize_to_jpeg(bytes, mime, render_width)?;
Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(bytes, &out_mime)))
```

`get_or_render_pdf_page_with_eviction` takes the eviction-trigger closure so `folio-core` does not need to depend on the Tauri runtime. The plain `get_or_render_pdf_page` is implemented as a thin wrapper that passes a no-op closure — used by the unit tests.

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
            storage.put("page-cache/{hash}/{i:03}.jpg")
          write_manifest({
            format: Pdf,
            canonical_width: Some(2400),
            pages: [],           // intentionally empty
            page_count: <total>,
            total_size_bytes: <sum of writes>,
            ...
          })
        spawn_blocking(run_eviction(max_size_mb))
      <- CacheManifest

Read page (viewport-derived width = 1600)
  invoke get_pdf_page_bytes(book_id, page_index=42, width=1600)
    commands::get_pdf_page_bytes
      page_cache::get_cached_page("{hash}", 42)
        derived name = "042.jpg" (manifest.format == Pdf)
        HIT  -> image_util::maybe_resize_to_jpeg(2400 -> 1600)
              -> page_wire::append_tag -> Response
        MISS -> page_cache::get_or_render_pdf_page
                  pdf::get_page_image_bytes(.., Some(2400))
                  storage.put("page-cache/{hash}/042.jpg")  // best-effort
                  manifest.total_size_bytes += jpeg.len()    // best-effort
                  if lazy_writes++ % LAZY_EVICTION_BATCH == 0:
                    spawn_blocking(run_eviction(max_size_mb))
                -> image_util::maybe_resize_to_jpeg(2400 -> 1600)
                -> page_wire::append_tag -> Response
```

## Cache Key & Invalidation

- Cached page key: `page-cache/{book_hash}/{NNN}.jpg`. Identical layout to the comic cache.
- Invalidation is implicit: the storage key is keyed by `book_hash`. A modified PDF file gets a new hash on import, lands at a different storage prefix, and the old entry is evicted by the LRU pass when the budget pressure hits.
- Width is not part of the key. Only one cached form per page; viewport-resize-on-read handles the variable target width. Identical to comic behaviour.

## Eviction & Memory

- **Disk eviction triggers** (both go through the existing `run_eviction`):
  - **prepare_pdf** — spawns a background eviction immediately after the warm pass completes. Identical to `prepare_comic` (`src-tauri/src/commands.rs:1999`).
  - **Lazy writes** — `get_or_render_pdf_page` increments a module-level atomic counter on every successful cache write. When the counter crosses `LAZY_EVICTION_BATCH` (constant, initial value `25`), it is reset and a `tauri::async_runtime::spawn_blocking(run_eviction)` is fired. Per-write eviction would re-list every cached book and re-read every manifest; coalescing keeps the cost amortised while bounding worst-case overage to roughly `LAZY_EVICTION_BATCH × page_size ≈ ~10 MB` past the configured cap.
- Manifest writes on the lazy path rewrite the small JSON file on each cache write. The cost is negligible compared to a pdfium render and well below the JPEG write itself, so we do not coalesce manifest persistence further.
- No in-memory pdfium page-render cache exists today (`src-tauri/src/commands.rs:3701` re-renders on every request; the only PDF-side cache in `folio-core/src/pdf.rs` is a text/metadata cache, not rendered images). Intra-session reads after this spec will be served from the disk cache via the OS page cache, which is the relevant fast path. An in-process render LRU stays out of scope.

## Backward Compatibility

- Comic manifests written before this change omit `format` and `canonical_width`. Serde defaults supply `format = BookFormat::Cbz` and `canonical_width = None` on load. On the next manifest write (any cache touch) the missing fields are persisted with the correct values.
- No DB migration is required.
- No frontend behaviour changes for comic books.

## Error Handling

`prepare_pdf` (user-visible warm pass — failures surface):
- pdfium render failure → propagated as `FolioError::Internal`. No partial cache state is committed: the manifest is only written after the loop completes.
- Disk write failure → `FolioError::Io`. Aborts the call before the manifest is persisted.
- Missing `book.file_hash` → `FolioError::Invalid`. The frontend logs and continues; reading still works against the live render path.

`get_or_render_pdf_page` (background reader fast path — failures are swallowed):
- Manifest missing or `format != Pdf` → fall back to live render. The function does not synthesize a manifest mid-session; `prepare_pdf` is the only path that creates one.
- pdfium render failure → propagated to the command, which propagates to the reader. The blob never lands on disk.
- Disk write failure on the cache write → logged via `page_dbg!`, swallowed; the rendered bytes are still returned to the caller. Manifest update is skipped for that page.
- Manifest write failure on the lazy path → logged, swallowed. The page bytes returned this call are valid; the next request for the same page may not hit the cache.

Corrupt manifest on disk: `read_manifest` already returns `None` on parse failure. For PDF this means cache reads fall back to live render until the next `prepare_pdf` rewrites the manifest.

## Testing

`folio-core` unit tests (added next to the existing `page_cache` suite):

- `ensure_pdf_prewarmed_writes_first_n_pages` — fixture PDF, verify N files on disk + manifest reflects them with `format = Pdf`, `pages = []`, `canonical_width = Some(2400)`.
- `ensure_pdf_prewarmed_is_idempotent` — second call without changes is a no-op (no extra renders, manifest `last_accessed` advances).
- `ensure_pdf_prewarmed_disk_write_failure_aborts` — simulated `storage.put` failure returns `FolioError::Io` and leaves no manifest behind.
- `get_cached_page_pdf_derives_filename_from_index` — manifest with `format = Pdf` and `pages = []` still resolves index 42 → `042.jpg` and returns the stored bytes.
- `get_cached_page_pdf_out_of_range` — index beyond `page_count` returns `NotFound`.
- `get_or_render_pdf_page_disk_hit_skips_pdfium` — pre-seeded cache; the renderer must not be invoked.
- `get_or_render_pdf_page_miss_writes_disk_and_updates_manifest` — total_size_bytes grows by the JPEG byte count; `pages` stays empty.
- `get_or_render_pdf_page_swallows_write_failure` — simulated `storage.put` error: the function still returns the rendered bytes; manifest unchanged.
- `lazy_eviction_counter_triggers_callback_at_batch_size` — `get_or_render_pdf_page_with_eviction` fires its callback exactly once per `LAZY_EVICTION_BATCH` lazy writes.
- `manifest_legacy_comic_loads_without_format_or_canonical_width` — serde-default check; existing comic manifests deserialize with `format = Cbz`, `canonical_width = None`.
- `run_eviction_evicts_pdf_book_under_size_pressure` — PDF cache participates in the shared LRU + size budget.

Tauri layer (`src-tauri/src/commands.rs`):

- `get_pdf_page_bytes` cache-hit path returns the resized bytes from the cache and bypasses pdfium.
- `get_pdf_page_bytes` cache-miss path renders, caches, then returns the resized bytes.
- `prepare_pdf` rejects non-PDF formats with `FolioError::Invalid`.

Frontend tests: no Vitest coverage added — the prepare call extension is a one-line shape change reusing existing UI.

CI gates: existing `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check`, `npm run type-check`, and Vitest must all stay green.

## Milestones (autonomous-milestones)

1. **m1 — folio-core**: extend `CacheManifest` (`format` + `canonical_width` with `default_cache_format` helper), branch `get_cached_page` on `format`, add `pdf::CACHE_CANONICAL_WIDTH`, add `ensure_pdf_prewarmed`, `get_or_render_pdf_page`, and the `_with_eviction` variant. Write unit tests including legacy-manifest serde-default coverage. Existing Tauri command path unchanged.
2. **m2 — Tauri layer**: register `prepare_pdf` (mirroring `prepare_comic` precisely — same hash precondition, same post-warm eviction spawn), rewrite `get_pdf_page_bytes` for cache-first + resize-on-read with the lazy-eviction callback wired in. Add tests for the cache-hit and cache-miss branches and the no-hash fallback.
3. **m3 — Frontend**: extend the existing `prepare_*` call site in `Reader.tsx` to fire `prepare_pdf` on PDF books. Treat a `prepare_pdf` error as non-fatal (log + continue without cache). Update CHANGELOG. Mark ROADMAP item #3 of the "perf + comics" bundle as shipped.
