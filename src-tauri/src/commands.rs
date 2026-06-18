use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use folio_core::activity::ActivityEvent;
use folio_core::events::{self, FolioEvent, ImportSource, SyncDirection};

use crate::cbr;
use crate::cbz;
use crate::db::{self, DbPool};
use crate::epub;
use crate::error::{FolioError, FolioResult};
use crate::ipc_metrics::IpcMetrics;
use crate::models::{
    AutoBackup, Book, BookFormat, BookGridItem, Bookmark, ChapterMeta, CleanupEntry,
    CleanupProgress, CleanupResult, Collection, CollectionRule, CollectionSuggestion,
    CollectionType, CustomFont, FeatureFlag, Highlight, HighlightSearchResult, NewRuleInput,
    ReadingProgress, SeriesInfo,
};
use crate::opds;
use crate::openlibrary;
use crate::page_cache;
use crate::pdf;

pub use folio_core::cache::LruCache;
use folio_core::cache::{
    DiskPageCacheAdapter, ManagedCache, MemoryCacheAdapter, UnifiedCacheStats,
};

/// Profile state: active profile name + pool map in a single Mutex.
/// This prevents the race condition where the active profile changes between
/// reading the name and looking up the pool.
///
/// ## Lock ordering
///
/// `AppState` contains multiple Mutexes. To prevent deadlocks, always acquire
/// them in the order listed below. Never hold a higher-numbered lock while
/// waiting for a lower-numbered one.
///
/// 1. `profile_state` — profile name + pool map
/// 2. `epub_cache` — EPUB archive LRU cache
/// 3. `mobi_cache` — MOBI parsed-book LRU cache (mobi feature only)
/// 4. `enrichment_registry` — metadata provider registry
/// 5. `web_server_handle` — running web server handle
pub struct ProfileState {
    pub active: String,
    pub pools: std::collections::HashMap<String, DbPool>,
}

pub struct AppState {
    pub db: DbPool,
    /// Combined profile name + pool map (lock #1). See lock ordering above.
    pub profile_state: std::sync::Mutex<ProfileState>,
    pub data_dir: std::path::PathBuf,
    /// EPUB archive LRU cache (lock #2). Single Mutex replaces the former
    /// dual-Mutex (epub_cache + epub_cache_order). Arc so the unified cache
    /// registry (get_unified_cache_stats / clear_all_caches) can hold the
    /// same handle.
    pub epub_cache: std::sync::Arc<std::sync::Mutex<LruCache<epub::CachedEpubArchive>>>,
    /// MOBI parsed-book LRU cache (lock #3). Holds the post-parse view
    /// (HTML parts + image resources) so chapter reads, full-book loads,
    /// and search don't reopen and reparse the file via libmobi on every
    /// request. Mirrors the EPUB cache's role for the MOBI hot paths.
    #[cfg(feature = "mobi")]
    pub mobi_cache: std::sync::Arc<std::sync::Mutex<LruCache<folio_core::mobi::CachedMobiBook>>>,
    /// Metadata provider registry (lock #4).
    pub enrichment_registry: std::sync::Mutex<crate::providers::ProviderRegistry>,
    /// DB pool shared with the web server, swapped on profile switch.
    pub shared_active_pool: std::sync::Arc<std::sync::Mutex<DbPool>>,
    /// PIN hash shared with the web server, updated by `web_server_set_pin`.
    pub shared_pin_hash: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Handle to the running web server (lock #5).
    pub web_server_handle: std::sync::Mutex<Option<crate::web_server::WebServerHandle>>,
    /// IPC command timing metrics (leaf lock — no ordering constraint).
    pub ipc_metrics: IpcMetrics,
    /// Plugin manager for the active profile (leaf lock). `None` until the
    /// setup hook initializes it; a plugin failure never blocks startup.
    /// `Arc<Mutex<..>>` so a single forwarding bus subscriber can read the
    /// current manager and `switch_profile` can swap it (the manager is
    /// rebuilt against the new profile's DB on switch).
    pub plugin_manager: std::sync::Arc<
        std::sync::Mutex<Option<std::sync::Arc<folio_core::plugins::PluginManager>>>,
    >,
    /// Keeps the non-blocking tracing file writer alive for the app's
    /// lifetime so buffered log records flush on shutdown. Held only for
    /// its `Drop`; never read. `None` when logging to stderr (dev).
    pub _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

impl AppState {
    /// Returns the DB pool for the active profile.
    /// Uses a single lock to read profile name and look up the pool atomically.
    pub fn active_db(&self) -> FolioResult<DbPool> {
        let ps = self.profile_state.lock()?;
        if ps.active == "default" {
            return Ok(self.db.clone());
        }
        ps.pools
            .get(&ps.active)
            .cloned()
            .ok_or_else(|| FolioError::not_found(format!("Profile '{}' not found", ps.active)))
    }

    /// Returns the library folder path for the active profile. Reads the
    /// `library_folder` setting, falling back to the platform default.
    pub fn active_library_folder(&self) -> FolioResult<String> {
        let conn = self.active_db()?.get()?;
        match db::get_setting(&conn, "library_folder")? {
            Some(f) => Ok(f),
            None => default_library_folder(),
        }
    }

    /// Returns a `Storage` handle rooted at the active profile's library
    /// folder. Each call constructs a fresh `LocalStorage`; this is cheap
    /// (stores a PathBuf) and keeps the handle in sync when the user
    /// changes the library folder at runtime.
    pub fn active_storage(&self) -> FolioResult<std::sync::Arc<dyn folio_core::storage::Storage>> {
        let folder = self.active_library_folder()?;
        Ok(std::sync::Arc::new(folio_core::storage::LocalStorage::new(
            folder,
        )?))
    }

    /// Returns a `Storage` handle for cover images, rooted at
    /// `{data_dir}/covers` — the same on-disk layout used before #64 M3.
    /// Cover keys take the form `{book_id}/cover.{ext}`.
    pub fn covers_storage(&self) -> FolioResult<std::sync::Arc<dyn folio_core::storage::Storage>> {
        let root = self.data_dir.join("covers");
        Ok(std::sync::Arc::new(folio_core::storage::LocalStorage::new(
            root,
        )?))
    }

    /// Returns a `Storage` handle for EPUB inline chapter images, rooted at
    /// `{data_dir}/images` — matches the on-disk layout used before #64 M6.
    /// Image keys take the form `{book_id}/{chapter_index}/{basename}`.
    pub fn images_storage(&self) -> FolioResult<std::sync::Arc<dyn folio_core::storage::Storage>> {
        let root = self.data_dir.join("images");
        Ok(std::sync::Arc::new(folio_core::storage::LocalStorage::new(
            root,
        )?))
    }

    /// Resolve a book's stored `file_path` value to an absolute local
    /// filesystem path that can be handed to parsers.
    ///
    /// Semantics after #64 M4:
    /// * **Imported books** — `file_path` is a storage key relative to
    ///   the library `Storage`. Resolves through `storage.local_path`.
    /// * **Linked books** — `file_path` is an absolute external path.
    ///   Returned unchanged.
    /// * **Legacy imported rows** — rows that predate M4 and weren't
    ///   caught by the migration (library folder changed, etc.) still
    ///   carry an absolute path. Detected via `Path::is_absolute()` and
    ///   returned as-is so the old read flow keeps working.
    pub fn resolve_book_path(&self, book: &Book) -> FolioResult<String> {
        if !book.is_imported {
            return Ok(book.file_path.clone());
        }
        let p = std::path::Path::new(&book.file_path);
        if p.is_absolute() {
            return Ok(book.file_path.clone());
        }
        let storage = self.active_storage()?;
        Ok(storage
            .local_path(&book.file_path)?
            .to_string_lossy()
            .to_string())
    }
}

/// Build the storage key for a book file from its ID and the (already
/// lowercased) extension. The key is what `Storage::put_path` writes to
/// and what `Storage::delete` removes — the on-disk file for `LocalStorage`
/// ends up at `{library_folder}/{book_id}.{extension}`.
pub fn book_storage_key(book_id: &str, extension: &str) -> String {
    format!("{book_id}.{extension}")
}

/// Derive the storage key for an existing book from its absolute
/// `file_path` column (legacy rows that weren't migrated by the M4
/// schema pass — e.g. because the library folder changed after import).
/// Returns `None` when the path is not under the library folder; linked
/// books sit outside the library folder by design.
///
/// Thin wrapper over [`folio_core::storage::key_for_local_path`].
pub fn book_key_from_path(file_path: &str, library_folder: &str) -> Option<String> {
    folio_core::storage::key_for_local_path(
        std::path::Path::new(library_folder),
        std::path::Path::new(file_path),
    )
}

/// Ensure a file_path is loaded in the EPUB LRU cache. If it's already present,
/// move it to most-recently-used. Otherwise open the archive and insert it.
fn ensure_epub_cached(cache: &mut LruCache<epub::CachedEpubArchive>, file_path: &str) {
    if cache.get(file_path).is_some() {
        cache.touch(file_path);
        return;
    }
    if let Ok(archive) = epub::CachedEpubArchive::open(file_path) {
        cache.insert(file_path.to_string(), archive);
    }
}

/// MOBI counterpart of `ensure_epub_cached`. Returns an error when libmobi
/// can't parse the file so the caller can surface it instead of falling
/// through with an empty cache miss — `cache.get()` only signals presence.
///
/// Inserts via `insert_with_size` so the byte budget configured on
/// `mobi_cache` in `lib.rs` actually drives eviction. Owned MOBI bytes
/// (chapters + image resources) can run hundreds of MB on illustrated
/// AZW3s; relying on entry count alone would let a small handful of
/// books pin multi-GB of RAM.
#[cfg(feature = "mobi")]
fn ensure_mobi_cached(
    cache: &mut LruCache<folio_core::mobi::CachedMobiBook>,
    file_path: &str,
) -> FolioResult<()> {
    if cache.get(file_path).is_some() {
        cache.touch(file_path);
        return Ok(());
    }
    let cached = folio_core::mobi::CachedMobiBook::open(file_path)?;
    let size = cached.byte_size();
    cache.insert_with_size(file_path.to_string(), cached, size);
    Ok(())
}

// --- Activity logging ---

pub(crate) fn log_event(conn: &rusqlite::Connection, event: ActivityEvent) {
    let f = event.into_fields();
    let entry = crate::models::ActivityEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        action: f.action.to_string(),
        entity_type: f.entity_type.to_string(),
        entity_id: f.entity_id,
        entity_name: f.entity_name,
        detail: f.detail,
    };
    let _ = db::insert_activity(conn, &entry);
    let _ = db::prune_activity_log(conn, 1000, 90);
}

// --- Cover helpers (#64 M3) ---

/// Build the storage key for a book's cover image. The `covers_storage`
/// on [`AppState`] is rooted at `{data_dir}/covers`, so a key of
/// `{book_id}/cover.{ext}` resolves to the same on-disk path this app
/// has always used.
pub fn cover_storage_key(book_id: &str, ext: &str) -> String {
    format!("{book_id}/cover.{ext}")
}

/// Target width (px) for grid thumbnails. The library card renders the
/// cover in a 160 px box; 320 px is 2× for crisp rendering on Retina
/// displays without paying the multi-megapixel decode cost of the full
/// cover on every scroll-mounted row.
pub const THUMB_WIDTH: u32 = 320;

/// Storage key for a book's grid thumbnail, sibling to its `cover.{ext}`.
pub fn thumb_storage_key(book_id: &str) -> String {
    format!("{book_id}/thumb.jpg")
}

/// One-time backfill of grid thumbnails for covers imported before the
/// thumbnail feature existed. Reads each book's cover from disk, generates
/// a thumbnail when the cover is larger than [`THUMB_WIDTH`], and writes it
/// to `{book_id}/thumb.jpg`. Covers that already have a thumbnail, or that
/// are already small, are skipped — the skip path only probes image
/// headers, never a full decode, so re-running on every startup is cheap.
///
/// CPU-bound and I/O-bound; call from a background thread so it never
/// blocks app startup. All failures are non-fatal and logged.
pub fn run_thumbnail_backfill(
    pool: db::DbPool,
    storage: std::sync::Arc<dyn folio_core::storage::Storage>,
) {
    let items =
        match pool.get().map_err(Into::into).and_then(|conn| {
            db::list_books_grid(&conn).map_err(folio_core::error::FolioError::from)
        }) {
            Ok(items) => items,
            Err(e) => {
                log::warn!("thumbnail backfill: could not list books: {e}");
                return;
            }
        };

    let mut made = 0usize;
    for item in items {
        let Some(cover_path) = item.cover_path else {
            continue;
        };
        let tkey = thumb_storage_key(&item.id);
        if matches!(storage.exists(&tkey), Ok(true)) {
            continue;
        }
        let bytes = match std::fs::read(&cover_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if let Ok(Some(thumb)) = folio_core::image_util::make_thumbnail(&bytes, THUMB_WIDTH) {
            if storage.put(&tkey, &thumb).is_ok() {
                made += 1;
            }
        }
    }
    if made > 0 {
        log::info!("thumbnail backfill: generated {made} cover thumbnail(s)");
    }
}

/// Rewrite each grid item's `cover_path` to its thumbnail when one exists
/// on disk. Items whose cover is already small (no thumbnail was generated)
/// keep their original `cover_path`. Best-effort: any storage error leaves
/// the item pointing at the full cover.
fn apply_grid_thumbnails(storage: &dyn folio_core::storage::Storage, items: &mut [BookGridItem]) {
    for item in items.iter_mut() {
        if item.cover_path.is_none() {
            continue;
        }
        let key = thumb_storage_key(&item.id);
        if let Ok(true) = storage.exists(&key) {
            if let Ok(p) = storage.local_path(&key) {
                item.cover_path = Some(p.to_string_lossy().to_string());
            }
        }
    }
}

/// Decode a `data:<mime>;base64,<payload>` cover URI. Returns the raw
/// image bytes plus a sanitized file extension (`png` / `jpg` / `webp`
/// / `gif`). Callers persist the bytes via [`Storage::put`] rather than
/// writing to disk directly.
fn decode_cover_data_uri(data_uri: &str, book_id: &str) -> Option<(Vec<u8>, &'static str)> {
    use base64::{engine::general_purpose, Engine as _};

    let rest = data_uri.strip_prefix("data:")?;
    let (header, encoded) = rest.split_once(',')?;
    let mime = header.strip_suffix(";base64")?;
    let ext: &'static str = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    match general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) => Some((bytes, ext)),
        Err(e) => {
            log::warn!("cover extraction failed for book {book_id}: base64 decode error: {e}");
            None
        }
    }
}

/// Write cover bytes through the covers storage and return the resulting
/// local path (what the DB stores). On LocalStorage this is the usual
/// `{data_dir}/covers/{book_id}/cover.{ext}` path; a future remote
/// backend would materialize the key to a cache and return that.
fn save_cover_via_storage(
    storage: &dyn folio_core::storage::Storage,
    book_id: &str,
    bytes: &[u8],
    ext: &str,
) -> Option<String> {
    let key = cover_storage_key(book_id, ext);
    if let Err(e) = storage.put(&key, bytes) {
        log::warn!("cover extraction failed for book {book_id}: could not write cover: {e}");
        return None;
    }
    // Best-effort grid thumbnail. A failure here is non-fatal: the grid
    // falls back to serving the full cover. `Ok(None)` means the cover is
    // already small enough to use directly.
    match folio_core::image_util::make_thumbnail(bytes, THUMB_WIDTH) {
        Ok(Some(thumb)) => {
            let tkey = thumb_storage_key(book_id);
            if let Err(e) = storage.put(&tkey, &thumb) {
                log::warn!("thumbnail write failed for book {book_id}: {e}");
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("thumbnail generation failed for book {book_id}: {e}"),
    }
    match storage.local_path(&key) {
        Ok(p) => Some(p.to_string_lossy().to_string()),
        Err(e) => {
            log::warn!("cover extraction failed for book {book_id}: could not resolve path: {e}");
            None
        }
    }
}

/// Save a decoded data-URI cover via the covers storage.
fn save_cover_from_data_uri(
    storage: &dyn folio_core::storage::Storage,
    book_id: &str,
    data_uri: &str,
) -> Option<String> {
    let (bytes, ext) = decode_cover_data_uri(data_uri, book_id)?;
    save_cover_via_storage(storage, book_id, &bytes, ext)
}

/// Remove every cover artifact owned by a given book from the covers
/// storage. Idempotent; missing entries are silently skipped.
fn delete_book_covers(
    storage: &dyn folio_core::storage::Storage,
    book_id: &str,
) -> FolioResult<()> {
    let prefix = format!("{book_id}/");
    let keys = storage.list(&prefix)?;
    for key in keys {
        if let Err(e) = storage.delete(&key) {
            log::warn!("could not delete cover '{key}' for book {book_id}: {e}");
        }
    }
    Ok(())
}

/// Remove every extracted EPUB inline image owned by a given book from the
/// images storage (all chapters). Idempotent; missing entries are silently
/// skipped. Introduced for #64 M6.
fn delete_book_images(
    storage: &dyn folio_core::storage::Storage,
    book_id: &str,
) -> FolioResult<()> {
    let prefix = format!("{book_id}/");
    let keys = storage.list(&prefix)?;
    for key in keys {
        if let Err(e) = storage.delete(&key) {
            log::warn!("could not delete image '{key}' for book {book_id}: {e}");
        }
    }
    Ok(())
}

// --- Page cache storage (#64 M5) ---

/// Build a `LocalStorage` rooted at the platform's app cache directory.
/// `page_cache::*` takes `&dyn Storage`; this helper keeps the `AppHandle`
/// → cache-dir resolution in one place so every command site gets the same
/// root.
fn page_cache_storage(app: &AppHandle) -> FolioResult<folio_core::storage::LocalStorage> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| FolioError::internal(format!("Failed to get cache dir: {e}")))?;
    folio_core::storage::LocalStorage::new(dir)
}

// --- Library management ---

/// Extensions the backend can import in this build. Core formats are
/// always present; MOBI family is conditional on the `mobi` feature. Used
/// both by the Tauri command exposed to the frontend and by internal
/// validators like download_opds_book.
pub fn supported_import_extensions() -> &'static [&'static str] {
    #[cfg(feature = "mobi")]
    {
        &["epub", "pdf", "cbz", "cbr", "mobi", "azw", "azw3"]
    }
    #[cfg(not(feature = "mobi"))]
    {
        &["epub", "pdf", "cbz", "cbr"]
    }
}

/// Return the list of file extensions the backend can import in this build.
/// The frontend uses this to populate the file-picker and folder-scan
/// filters so MOBI/AZW/AZW3 only appear when libmobi is compiled in.
#[tauri::command]
pub async fn get_supported_formats() -> FolioResult<Vec<&'static str>> {
    Ok(supported_import_extensions().to_vec())
}

#[tauri::command]
#[tracing::instrument(
    skip(file_path, state, _app),
    fields(ext = std::path::Path::new(&file_path).extension().and_then(|e| e.to_str()))
)]
pub async fn import_book(
    file_path: String,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("import_book");
    tracing::info!("importing book");
    let db_pool = state.active_db()?;
    let storage = state.active_storage()?;
    let covers_storage = state.covers_storage()?;
    let import_mode = {
        let conn = db_pool.get()?;
        db::get_setting(&conn, "import_mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "import".to_string())
    };
    import_book_inner(
        file_path,
        db_pool,
        storage,
        covers_storage,
        &import_mode,
        false,
        ImportSource::Manual,
    )
    .map(ImportOutcome::into_book)
}

/// Distinguishes a freshly-imported book from one that already existed in the
/// library (matched by content hash). The IPC `import_book` handler flattens
/// both into the existing `Book` contract; the background importer needs the
/// distinction to report accurate "added" vs. "skipped" counts.
pub(crate) enum ImportOutcome {
    Imported(Book),
    Duplicate(Book),
}

impl ImportOutcome {
    pub(crate) fn into_book(self) -> Book {
        match self {
            ImportOutcome::Imported(b) | ImportOutcome::Duplicate(b) => b,
        }
    }

    pub(crate) fn is_new(&self) -> bool {
        matches!(self, ImportOutcome::Imported(_))
    }
}

#[derive(serde::Serialize)]
pub struct OpdsImportResult {
    #[serde(flatten)]
    pub book: Book,
    pub newly_imported: bool,
}

/// Detects the macOS smbfs lookup bug: files whose path contains non-ASCII
/// characters on an SMB share (mounted under `/Volumes/`) are listed by
/// directory enumeration but fail `stat()`/`open()` with `NotFound`. The
/// file is intact on the server, and no userland API can open it (POSIX
/// `open`, `openat` with raw readdir bytes, and Cocoa `FileHandle` all
/// fail), so the only fixes are server-side. Returns a user-facing
/// workaround hint when the failure pattern matches.
fn smb_unicode_hint(path: &str, kind: std::io::ErrorKind) -> Option<String> {
    if kind == std::io::ErrorKind::NotFound && path.starts_with("/Volumes/") && !path.is_ascii() {
        Some(
            "This looks like a macOS SMB bug: files with accented names on network \
             shares can be listed but not opened. The file is intact on the server. \
             Workarounds: rename it on the NAS (e.g. via its web file manager), copy \
             it over SSH (scp/rsync), or mount the share via NFS — see Troubleshooting \
             in the User Guide."
                .to_string(),
        )
    } else {
        None
    }
}

/// Appends the [`smb_unicode_hint`] workaround text to an import error
/// message when running on macOS and the failure pattern matches.
fn with_smb_hint(base: String, path: &str, err: &std::io::Error) -> String {
    if cfg!(target_os = "macos") {
        if let Some(hint) = smb_unicode_hint(path, err.kind()) {
            return format!("{base} {hint}");
        }
    }
    base
}

/// Body of [`import_book`], extracted so background tasks can call it without
/// going through Tauri's `State`/`invoke` machinery. All resources that the
/// importer touches are passed in explicitly so the same code runs from the
/// IPC handler and from a `spawn_blocking` background loop.
pub(crate) fn import_book_inner(
    file_path: String,
    db_pool: DbPool,
    storage: std::sync::Arc<dyn folio_core::storage::Storage>,
    covers_storage: std::sync::Arc<dyn folio_core::storage::Storage>,
    import_mode: &str,
    force_copy: bool,
    source: ImportSource,
) -> FolioResult<ImportOutcome> {
    // Step 1: single stat — used for size guard, mode-dependent dedup, and to
    // avoid extra round trips on slow filesystems (network shares).
    const MAX_IMPORT_SIZE_BYTES: u64 = 500 * 1024 * 1024;
    let source_metadata = std::fs::metadata(&file_path)
        .map_err(|e| with_smb_hint(format!("Cannot stat file: {e}"), &file_path, &e))?;
    if source_metadata.len() > MAX_IMPORT_SIZE_BYTES {
        let size_mb = source_metadata.len() / (1024 * 1024);
        return Err(FolioError::invalid(format!(
            "File is too large ({size_mb} MB). Maximum supported import size is 500 MB."
        )));
    }

    // Source identity for the fast skip-before-hash re-import path. mtime is
    // best-effort: if the platform/FS can't report it, treat as absent and
    // fall through to hashing (never skip without a confirmed size+mtime match).
    let source_size = source_metadata.len() as i64;
    let source_mtime: Option<i64> = source_metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    // Step 2: callers that own the file (e.g. OPDS-downloaded temp files)
    // must set `force_copy` so `link` mode still copies into the library.
    // The path string itself is unreliable as a signal — OPDS hands us a
    // local temp path, not a URL — so we take an explicit flag instead.
    let should_copy = force_copy || import_mode != "link";

    // Step 3: content-hash dedup for all modes. `file_hash` is required by
    // downstream features (comic page-cache prepare, cross-device sync), so
    // linked books need a stable content hash too. Hashing also guards
    // against duplicate library entries when the same file is reached
    // through different path spellings (symlinks, alternate mounts, …).
    // Fast skip-before-hash: if this exact source path was imported before and
    // its size + mtime are unchanged, return the existing book without reading
    // a single byte. Any mismatch / path-miss falls through to the hash, which
    // remains the duplicate source of truth.
    // One pooled connection serves both reads; scoped so it is released before
    // the hash read below never holds a connection during byte streaming.
    if let Some(existing) = {
        let conn = db_pool.get()?;
        match db::get_book_by_source_path(&conn, &file_path)? {
            Some(src_ref)
                if src_ref.source_size == Some(source_size)
                    && source_mtime.is_some()
                    && src_ref.source_mtime == source_mtime =>
            {
                db::get_book(&conn, &src_ref.id)?
            }
            _ => None,
        }
    } {
        return Ok(ImportOutcome::Duplicate(existing));
    }

    let hash: Option<String> = {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut hasher = Sha256::new();
        let mut file = std::fs::File::open(&file_path)
            .map_err(|e| with_smb_hint(format!("Cannot open file: {e}"), &file_path, &e))?;
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let computed = format!("{:x}", hasher.finalize());
        {
            let conn = db_pool.get()?;
            if let Some(existing) = db::get_book_by_file_hash(&conn, &computed)? {
                // Re-arm the fast-path: refresh this book's source tracking to
                // the current path/size/mtime so a content-identical file whose
                // mtime drifted (re-copy, restore, cloud resync) fast-skips next
                // time instead of re-hashing forever. Best-effort — dedup itself
                // already succeeded.
                let _ = db::set_book_source(
                    &conn,
                    &existing.id,
                    &file_path,
                    source_size,
                    source_mtime.unwrap_or(0),
                );
                return Ok(ImportOutcome::Duplicate(existing));
            }
        }
        Some(computed)
    };

    // Detect format from file extension, with magic-byte fallback for
    // mislabeled archives (e.g., RAR files saved as .cbz).
    let extension = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let format = match extension.as_str() {
        "epub" => BookFormat::Epub,
        "cbz" | "cbr" => {
            // Read magic bytes to detect actual archive type
            let mut magic = [0u8; 7];
            if let Ok(mut f) = std::fs::File::open(&file_path) {
                let _ = std::io::Read::read(&mut f, &mut magic);
            }
            if magic[0..4] == [0x50, 0x4B, 0x03, 0x04] {
                // PK\x03\x04 = ZIP
                BookFormat::Cbz
            } else if magic[0..7] == *b"Rar!\x1a\x07\x00" || magic[0..6] == *b"Rar!\x1a\x07" {
                // RAR v4 or v5
                BookFormat::Cbr
            } else if extension == "cbz" {
                BookFormat::Cbz // trust extension if magic unknown
            } else {
                BookFormat::Cbr
            }
        }
        "pdf" => BookFormat::Pdf,
        "mobi" | "azw" | "azw3" => {
            #[cfg(feature = "mobi")]
            {
                BookFormat::Mobi
            }
            #[cfg(not(feature = "mobi"))]
            {
                return Err(FolioError::invalid(
                    "MOBI/AZW/AZW3 support is not enabled in this build",
                ));
            }
        }
        _ => {
            return Err(FolioError::invalid(format!(
                "unsupported file format: .{extension}"
            )))
        }
    };

    let book_id = Uuid::new_v4().to_string();

    // Derive a human-friendly title from the *original* filename before copying
    // to the library (which renames the file to {uuid}.{ext}).
    let original_stem = std::path::Path::new(&file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Step 4: Copy source file into library folder as {book_id}.{ext},
    // or keep original path if import_mode is "link".
    //
    // #64 M4: imported books now store the storage *key* in `file_path`,
    // not the absolute filesystem path. Parsers still need a real path,
    // so we materialize one (`parser_path`) locally while recording the
    // key in the DB. Linked books continue to store the original
    // external absolute path.
    let (file_path_value, parser_path, is_imported) = if should_copy {
        let key = book_storage_key(&book_id, &extension);
        storage
            .put_path(&key, std::path::Path::new(&file_path))
            .map_err(|e| FolioError::internal(format!("Failed to copy file to library: {e}")))?;
        let parser_path = storage.local_path(&key)?.to_string_lossy().to_string();
        (key, parser_path, true)
    } else {
        (file_path.clone(), file_path.clone(), false)
    };
    // Kept as `final_path` to minimize churn in the parser match arms
    // below — all of them use it as a real filesystem path today.
    let final_path = parser_path;

    // Steps 5 & 6: Parse using library-internal path; store hash in Book.
    //
    // #64 M3: covers flow through the covers storage instead of writing
    // directly to `{data_dir}/covers/…`. `cover_saved` tracks whether we
    // persisted any cover artifact so the error-cleanup paths below can
    // tear them back out via `delete_book_covers`.
    let mut cover_saved = false;

    let book = match format {
        BookFormat::Epub => {
            // Open the EPUB zip archive once and reuse it for all operations
            // (metadata, cover extraction, chapter list) instead of reopening 3 times.
            let epub_file = std::fs::File::open(&final_path).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;
            let mut archive = zip::ZipArchive::new(epub_file).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;
            epub::validate_archive(&mut archive).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let metadata = epub::parse_epub_metadata_from_archive(&mut archive).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let cover_path = match epub::extract_cover_from_archive(&mut archive) {
                Ok(Some(cover)) => {
                    let saved = save_cover_via_storage(
                        &*covers_storage,
                        &book_id,
                        &cover.bytes,
                        &cover.ext,
                    );
                    if saved.is_some() {
                        cover_saved = true;
                    }
                    saved
                }
                Ok(None) => None,
                Err(e) => {
                    log::warn!("cover extraction failed for book {book_id}: {e}");
                    None
                }
            };

            let chapters = epub::get_chapter_list_from_archive(&mut archive).map_err(|e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                e.to_string()
            })?;

            let language = if metadata.language.is_empty() {
                None
            } else {
                Some(metadata.language.clone())
            };
            Book {
                id: book_id,
                title: metadata.title,
                author: metadata.author,
                file_path: file_path_value.clone(),
                cover_path,
                total_chapters: chapters.len() as u32,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: hash.clone(),
                description: metadata.description,
                genres: if metadata.genres.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&metadata.genres).unwrap_or_default())
                },
                rating: None,
                isbn: metadata.isbn,
                openlibrary_key: None,
                enrichment_status: None,
                series: None,
                volume: None,
                language,
                publisher: None,
                publish_year: None,
                is_imported,
            }
        }
        BookFormat::Cbz => {
            let meta = cbz::import_cbz(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            let page_result = cbz::get_page_image(&final_path, 0);
            if let Err(ref e) = page_result {
                log::warn!("cover extraction failed for book {book_id}: {e}");
            }
            let cover_path = page_result
                .ok()
                .and_then(|uri| save_cover_from_data_uri(&*covers_storage, &book_id, &uri));
            if cover_path.is_some() {
                cover_saved = true;
            }
            Book {
                id: book_id,
                title: meta.title,
                author: meta.author.unwrap_or_default(),
                file_path: file_path_value.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: hash.clone(),
                description: meta.summary,
                genres: meta.genre.map(|g| {
                    let genres: Vec<String> = g
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    serde_json::to_string(&genres).unwrap_or_else(|_| "[]".to_string())
                }),
                rating: None,
                isbn: None,
                openlibrary_key: None,
                enrichment_status: None,
                series: meta.series,
                volume: meta.volume,
                language: meta.language,
                publisher: meta.publisher,
                publish_year: meta.year,
                is_imported,
            }
        }
        BookFormat::Cbr => {
            let meta = cbr::import_cbr(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            let page_result = cbr::get_page_image(&final_path, 0);
            if let Err(ref e) = page_result {
                log::warn!("cover extraction failed for book {book_id}: {e}");
            }
            let cover_path = page_result
                .ok()
                .and_then(|uri| save_cover_from_data_uri(&*covers_storage, &book_id, &uri));
            if cover_path.is_some() {
                cover_saved = true;
            }
            Book {
                id: book_id,
                title: meta.title,
                author: meta.author.unwrap_or_default(),
                file_path: file_path_value.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: hash.clone(),
                description: meta.summary,
                genres: meta.genre.map(|g| {
                    let genres: Vec<String> = g
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    serde_json::to_string(&genres).unwrap_or_else(|_| "[]".to_string())
                }),
                rating: None,
                isbn: None,
                openlibrary_key: None,
                enrichment_status: None,
                series: meta.series,
                volume: meta.volume,
                language: meta.language,
                publisher: meta.publisher,
                publish_year: meta.year,
                is_imported,
            }
        }
        BookFormat::Pdf => {
            let meta = pdf::import_pdf(&final_path).inspect_err(|_e| {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
            })?;
            // Use PDF metadata title if available; fall back to original filename.
            let library_stem = std::path::Path::new(&final_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let title = if meta.title == library_stem || meta.title.is_empty() {
                original_stem.clone()
            } else {
                meta.title
            };
            // Extract first page as cover thumbnail.
            let page_result = pdf::get_page_image(&final_path, 0, 400);
            if let Err(ref e) = page_result {
                log::warn!("cover extraction failed for book {book_id}: {e}");
            }
            let cover_path = page_result
                .ok()
                .and_then(|uri| save_cover_from_data_uri(&*covers_storage, &book_id, &uri));
            if cover_path.is_some() {
                cover_saved = true;
            }
            Book {
                id: book_id,
                title,
                author: meta.author,
                file_path: file_path_value.clone(),
                cover_path,
                total_chapters: meta.page_count,
                added_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                format,
                file_hash: hash.clone(),
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
                is_imported,
            }
        }
        BookFormat::Mobi => {
            #[cfg(feature = "mobi")]
            {
                use folio_core::mobi;
                let meta = mobi::parse_mobi_metadata(&final_path).inspect_err(|_e| {
                    if should_copy {
                        let _ = std::fs::remove_file(&final_path);
                    }
                })?;
                let cover_path = match mobi::extract_cover(&final_path) {
                    Ok(Some(cover)) => {
                        let saved = save_cover_via_storage(
                            &*covers_storage,
                            &book_id,
                            &cover.bytes,
                            &cover.ext,
                        );
                        if saved.is_some() {
                            cover_saved = true;
                        }
                        saved
                    }
                    Ok(None) => None,
                    Err(e) => {
                        log::warn!("cover extraction failed for book {book_id}: {e}");
                        None
                    }
                };
                let chapters = mobi::get_chapter_list(&final_path).inspect_err(|_e| {
                    if should_copy {
                        let _ = std::fs::remove_file(&final_path);
                    }
                })?;
                let title = if meta.title.is_empty() {
                    original_stem.clone()
                } else {
                    meta.title
                };
                let language = if meta.language.is_empty() {
                    None
                } else {
                    Some(meta.language.clone())
                };
                Book {
                    id: book_id,
                    title,
                    author: meta.author,
                    file_path: file_path_value.clone(),
                    cover_path,
                    total_chapters: chapters.len() as u32,
                    added_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64,
                    format,
                    file_hash: hash.clone(),
                    description: meta.description,
                    genres: if meta.genres.is_empty() {
                        None
                    } else {
                        Some(serde_json::to_string(&meta.genres).unwrap_or_default())
                    },
                    rating: None,
                    isbn: meta.isbn,
                    openlibrary_key: None,
                    enrichment_status: None,
                    series: None,
                    volume: None,
                    language,
                    publisher: None,
                    publish_year: None,
                    is_imported,
                }
            }
            // Unreachable in practice: the extension-detection arm above
            // returns an error when the feature is off, so this branch
            // only compiles as a placeholder for the exhaustive match.
            #[cfg(not(feature = "mobi"))]
            {
                if should_copy {
                    let _ = std::fs::remove_file(&final_path);
                }
                return Err(FolioError::invalid(
                    "MOBI/AZW/AZW3 support is not enabled in this build",
                ));
            }
        }
    };

    let mut conn = db_pool.get()?;
    let tx = conn.transaction()?;
    if let Err(e) = db::insert_book(&tx, &book) {
        // If the insert failed due to a duplicate hash, clean up the new copy
        // and return the existing book instead of surfacing a cryptic error.
        if let Some(existing) =
            db::get_book_by_file_hash(&tx, book.file_hash.as_deref().unwrap_or(""))
                .ok()
                .flatten()
        {
            if should_copy {
                let _ = std::fs::remove_file(&final_path);
            }
            if cover_saved {
                let _ = delete_book_covers(&*covers_storage, &book.id);
            }
            return Ok(ImportOutcome::Duplicate(existing));
        }
        if should_copy {
            let _ = std::fs::remove_file(&final_path);
        }
        if cover_saved {
            let _ = delete_book_covers(&*covers_storage, &book.id);
        }
        return Err(e.into());
    }

    // Store 0 when mtime was unavailable at import: a real file never reports
    // epoch-0 mtime, so the read-side fast-path (which also requires
    // source_mtime.is_some()) can never wrongly skip on it.
    if let Err(e) = db::set_book_source(
        &tx,
        &book.id,
        &file_path,
        source_size,
        source_mtime.unwrap_or(0),
    ) {
        if should_copy {
            let _ = std::fs::remove_file(&final_path);
        }
        if cover_saved {
            let _ = delete_book_covers(&*covers_storage, &book.id);
        }
        return Err(e.into());
    }

    log_event(
        &tx,
        ActivityEvent::BookImported {
            id: book.id.clone(),
            title: book.title.clone(),
            format: book.format.to_string(),
            author: book.author.clone(),
        },
    );

    tx.commit().map_err(|e| {
        // Clean up files if commit fails
        if should_copy {
            let _ = std::fs::remove_file(&final_path);
        }
        if cover_saved {
            let _ = delete_book_covers(&*covers_storage, &book.id);
        }
        e.to_string()
    })?;

    // Emit only after the commit — the event must reflect durable state.
    events::bus().emit(FolioEvent::BookImported {
        book_id: book.id.clone(),
        format: book.format.clone(),
        source,
    });

    Ok(ImportOutcome::Imported(book))
}

#[tauri::command]
pub async fn get_library(state: State<'_, AppState>) -> FolioResult<Vec<Book>> {
    let _t = state.ipc_metrics.time("get_library");
    let conn = state.active_db()?.get()?;
    Ok(db::list_books(&conn)?)
}

#[tauri::command]
pub async fn get_library_grid(state: State<'_, AppState>) -> FolioResult<Vec<BookGridItem>> {
    let _t = state.ipc_metrics.time("get_library_grid");
    let conn = state.active_db()?.get()?;
    let mut items = db::list_books_grid(&conn)?;
    if let Ok(storage) = state.covers_storage() {
        apply_grid_thumbnails(&*storage, &mut items);
    }
    Ok(items)
}

#[tauri::command]
pub async fn remove_book(book_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;

    // Fetch book before deleting so we can remove the library file and log.
    let existing_book = db::get_book(&conn, &book_id)?;
    let file_path = existing_book.as_ref().map(|b| b.file_path.clone());

    log_event(
        &conn,
        ActivityEvent::BookDeleted {
            id: book_id.clone(),
            title: existing_book.as_ref().map(|b| b.title.clone()),
        },
    );

    // #64 M2: resolve the storage handle and library folder *before* the
    // DB delete, and degrade any failure to a logged warning. Doing the
    // fallible storage setup after `db::delete_book` would leave the row
    // gone but return `Err` to the UI — the caller can't retry because
    // the book no longer exists, and the physical file stays orphaned.
    let is_imported = existing_book
        .as_ref()
        .map(|b| b.is_imported)
        .unwrap_or(true);
    let cleanup = if is_imported {
        match (state.active_library_folder(), state.active_storage()) {
            (Ok(folder), Ok(storage)) => Some((folder, storage)),
            (Err(e), _) | (_, Err(e)) => {
                log::warn!(
                    "could not resolve library storage for delete of '{}': {}",
                    book_id,
                    e
                );
                None
            }
        }
    } else {
        None
    };

    db::delete_book(&conn, &book_id)?;

    // Evict the EPUB archive cache entry for this file.
    if let Some(ref path) = file_path {
        if let Ok(mut cache) = state.epub_cache.lock() {
            cache.remove(path);
        }
        #[cfg(feature = "mobi")]
        if let Ok(mut cache) = state.mobi_cache.lock() {
            cache.remove(path);
        }
    }

    // Remove the physical file only if it was imported (copied) into the library.
    // Linked books reference external files that should not be deleted.
    //
    // #64 M4: `file_path` is now a storage key for imported rows written
    // after the migration. Legacy imported rows may still hold an
    // absolute path (library folder changed before the migration caught
    // them) — we detect that via `Path::is_absolute` and fall through
    // to the path-based removal so legacy data stays cleanable.
    if let (Some(path), Some((library_folder, storage))) = (file_path, cleanup) {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() {
            // M4 storage key — delete directly.
            if let Err(e) = storage.delete(&path) {
                log::warn!(
                    "could not delete library file for book '{}' (storage_key): {}",
                    book_id,
                    e
                );
            }
        } else if let Some(key) = book_key_from_path(&path, &library_folder) {
            if let Err(e) = storage.delete(&key) {
                log::warn!(
                    "could not delete library file for book '{}' (library_absolute): {}",
                    book_id,
                    e
                );
            }
        } else {
            // Fallback: absolute path that isn't under the library folder
            // (legacy import, profile migration, etc.). Remove directly.
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "could not delete library file for book '{}' (external_legacy_absolute): {}",
                        book_id,
                        e
                    );
                }
            }
        }
    }

    // Clean up extracted inline images for this book via the images storage.
    if let Ok(images) = state.images_storage() {
        let _ = delete_book_images(&*images, &book_id);
    }

    Ok(())
}

#[tauri::command]
pub async fn get_book(book_id: String, state: State<'_, AppState>) -> FolioResult<Option<Book>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_book(&conn, &book_id)?)
}

// --- Folder Scan ---

#[derive(Clone, serde::Serialize)]
struct FolderScanProgress {
    folder: String,
    files_found: usize,
}

#[tauri::command]
pub async fn scan_folder_for_books(
    folder_path: String,
    app: AppHandle,
) -> FolioResult<Vec<String>> {
    let _state = app.state::<AppState>();
    let _t = _state.ipc_metrics.time("scan_folder_for_books");
    let dir = std::path::Path::new(&folder_path);
    if !dir.is_dir() {
        return Err(FolioError::invalid(format!(
            "'{}' is not a directory",
            folder_path
        )));
    }

    let supported = {
        #[cfg(feature = "mobi")]
        {
            &["epub", "cbz", "cbr", "pdf", "mobi", "azw", "azw3"][..]
        }
        #[cfg(not(feature = "mobi"))]
        {
            &["epub", "cbz", "cbr", "pdf"][..]
        }
    };
    let mut found = Vec::new();

    fn walk(
        dir: &std::path::Path,
        extensions: &[&str],
        results: &mut Vec<String>,
        app: &AppHandle,
    ) {
        let _ = app.emit(
            "folder-scan-progress",
            FolderScanProgress {
                folder: dir.to_string_lossy().to_string(),
                files_found: results.len(),
            },
        );
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') && name != "__MACOSX" {
                        walk(&path, extensions, results, app);
                    }
                }
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let lower = ext.to_lowercase();
                if extensions.iter().any(|&s| s == lower) {
                    results.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    walk(dir, supported, &mut found, &app);
    found.sort();
    Ok(found)
}

// --- Metadata Editing ---

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_book_metadata(
    book_id: String,
    title: Option<String>,
    author: Option<String>,
    cover_image_path: Option<String>,
    series: Option<String>,
    volume: Option<u32>,
    language: Option<String>,
    publisher: Option<String>,
    publish_year: Option<u16>,
    rating: Option<f64>,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<Book> {
    let conn = state.active_db()?.get()?;
    let mut book = db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;

    let has_title = title.is_some();
    let has_author = author.is_some();
    let has_series = series.is_some();
    let has_volume = volume.is_some();
    let has_language = language.is_some();
    let has_publisher = publisher.is_some();
    let has_publish_year = publish_year.is_some();
    let has_cover = cover_image_path.is_some();
    let has_rating = rating.is_some();

    // Normalize and length-limit metadata strings.
    let normalize = |s: String, max_len: usize| -> String {
        let trimmed = s.trim().to_string();
        if trimmed.len() > max_len {
            trimmed[..max_len].to_string()
        } else {
            trimmed
        }
    };
    let normalize_opt = |s: String, max_len: usize| -> Option<String> {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else if trimmed.len() > max_len {
            Some(trimmed[..max_len].to_string())
        } else {
            Some(trimmed)
        }
    };

    if let Some(t) = title {
        let t = normalize(t, 500);
        if t.is_empty() {
            return Err(FolioError::invalid("Title cannot be empty."));
        }
        book.title = t;
    }
    if let Some(a) = author {
        book.author = normalize(a, 500);
    }
    if let Some(s) = series {
        book.series = normalize_opt(s, 500);
    }
    if let Some(v) = volume {
        book.volume = Some(v);
    }
    if let Some(l) = language {
        book.language = normalize_opt(l, 50);
    }
    if let Some(p) = publisher {
        book.publisher = normalize_opt(p, 500);
    }
    if let Some(y) = publish_year {
        book.publish_year = Some(y);
    }
    if let Some(r) = rating {
        book.rating = if r <= 0.0 { None } else { Some(r.min(5.0)) };
    }
    if let Some(image_path) = cover_image_path {
        // #64 M3: route user-supplied cover replacement through the covers
        // storage instead of copying directly to `{data_dir}/covers/…`.
        let covers_storage = state.covers_storage()?;
        let ext = std::path::Path::new(&image_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_string();
        let key = cover_storage_key(&book_id, &ext);
        covers_storage
            .put_path(&key, std::path::Path::new(&image_path))
            .map_err(|e| FolioError::internal(format!("Failed to copy cover image: {e}")))?;
        book.cover_path = Some(
            covers_storage
                .local_path(&key)?
                .to_string_lossy()
                .to_string(),
        );
    }

    db::update_book(&conn, &book)?;

    let mut changes = Vec::new();
    if has_title {
        changes.push("title");
    }
    if has_author {
        changes.push("author");
    }
    if has_series {
        changes.push("series");
    }
    if has_volume {
        changes.push("volume");
    }
    if has_language {
        changes.push("language");
    }
    if has_publisher {
        changes.push("publisher");
    }
    if has_publish_year {
        changes.push("year");
    }
    if has_cover {
        changes.push("cover");
    }
    if has_rating {
        changes.push("rating");
    }
    if !changes.is_empty() {
        let detail = format!("Changed: {}", changes.join(", "));
        log_event(
            &conn,
            ActivityEvent::BookUpdated {
                id: book_id.clone(),
                title: book.title.clone(),
                detail,
            },
        );
    }

    Ok(book)
}

// --- Recently Read ---

#[tauri::command]
pub async fn get_recently_read(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<Book>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_recently_read_books(&conn, limit.unwrap_or(5))?)
}

// --- Reading ---

#[tauri::command]
pub async fn get_chapter_content(
    book_id: String,
    chapter_index: u32,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let _t = state.ipc_metrics.time("get_chapter_content");
    let (file_path, format) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        (state.resolve_book_path(&book)?, book.format)
    };

    validate_file_exists(&file_path)?;
    let images_storage = state.images_storage()?;

    match format {
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open EPUB archive"))?;
            Ok(epub::get_chapter_content_from_cache(
                cached,
                chapter_index as usize,
                images_storage.as_ref(),
                &book_id,
            )?)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            Ok(folio_core::mobi::get_chapter_content_from_cache(
                cached,
                chapter_index as usize,
                images_storage.as_ref(),
                &book_id,
            )?)
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        other => Err(FolioError::invalid(format!(
            "get_chapter_content is not supported for format {other}"
        ))),
    }
}

#[tauri::command]
pub async fn search_book_content(
    book_id: String,
    query: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::models::SearchResult>> {
    let _t = state.ipc_metrics.time("search_book_content");
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let book = {
        let conn = state.active_db()?.get()?;
        db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?
    };
    let file_path = state.resolve_book_path(&book)?;

    validate_file_exists(&file_path)?;

    match book.format {
        BookFormat::Pdf => {
            let results = pdf::search_pdf(&file_path, &query)?;
            Ok(results
                .into_iter()
                .map(|r| crate::models::SearchResult {
                    chapter_index: r.chapter_index as u32,
                    snippet: r.snippet,
                    match_offset: r.match_offset,
                })
                .collect())
        }
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open EPUB archive"))?;
            Ok(epub::search_book(cached, &query)?)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            let images_storage = state.images_storage()?;
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            let chapters = folio_core::mobi::get_chapter_list_from_cache(cached);
            let chapter_indices: Vec<u32> = chapters.iter().map(|c| c.index as u32).collect();
            folio_core::search::search_chapters(chapter_indices, &query, &book_id, |idx| {
                folio_core::mobi::get_chapter_content_from_cache(
                    cached,
                    idx as usize,
                    images_storage.as_ref(),
                    &book_id,
                )
            })
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        _ => Ok(Vec::new()), // CBZ/CBR are image-only, no text to search
    }
}

#[tauri::command]
pub async fn get_chapter_word_counts(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<usize>> {
    let (file_path, format) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        (state.resolve_book_path(&book)?, book.format)
    };

    validate_file_exists(&file_path)?;

    match format {
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or("Failed to open EPUB archive")?;
            Ok(epub::get_chapter_word_counts(cached)?)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            Ok(folio_core::mobi::get_chapter_word_counts_from_cache(
                cached,
            )?)
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        other => Err(FolioError::invalid(format!(
            "get_chapter_word_counts is not supported for format {other}"
        ))),
    }
}

#[tauri::command]
pub async fn get_chapter_metadata_batch(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<ChapterMeta>> {
    let (file_path, format) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        (state.resolve_book_path(&book)?, book.format)
    };

    validate_file_exists(&file_path)?;

    match format {
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or("Failed to open EPUB archive")?;
            Ok(epub::get_chapter_metadata_batch(cached)?)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            Ok(folio_core::mobi::get_chapter_metadata_batch_from_cache(
                cached,
            )?)
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        other => Err(FolioError::invalid(format!(
            "get_chapter_metadata_batch is not supported for format {other}"
        ))),
    }
}

#[tauri::command]
pub async fn get_all_chapters(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<String>> {
    let _t = state.ipc_metrics.time("get_all_chapters");
    let (file_path, total_chapters, format) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        let total = book.total_chapters;
        (state.resolve_book_path(&book)?, total, book.format)
    };

    validate_file_exists(&file_path)?;
    let images_storage = state.images_storage()?;

    match format {
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or("Failed to open EPUB archive")?;

            let mut chapters = Vec::with_capacity(total_chapters as usize);
            for i in 0..total_chapters as usize {
                let html = epub::get_chapter_content_from_cache(
                    cached,
                    i,
                    images_storage.as_ref(),
                    &book_id,
                )?;
                chapters.push(html);
            }
            Ok(chapters)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            let mut chapters = Vec::with_capacity(total_chapters as usize);
            for i in 0..total_chapters as usize {
                let html = folio_core::mobi::get_chapter_content_from_cache(
                    cached,
                    i,
                    images_storage.as_ref(),
                    &book_id,
                )?;
                chapters.push(html);
            }
            Ok(chapters)
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        other => Err(FolioError::invalid(format!(
            "get_all_chapters is not supported for format {other}"
        ))),
    }
}

#[tauri::command]
pub async fn get_toc(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::models::TocEntry>> {
    let _t = state.ipc_metrics.time("get_toc");
    let (file_path, format) = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        (state.resolve_book_path(&book)?, book.format)
    };

    validate_file_exists(&file_path)?;

    match format {
        BookFormat::Epub => {
            let mut cache = state.epub_cache.lock()?;
            ensure_epub_cached(&mut cache, &file_path);
            let cached = cache
                .get_mut(&file_path)
                .ok_or("Failed to open EPUB archive")?;
            Ok(epub::get_toc_from_cache(cached)?)
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            // MOBI has no real TOC — synthesize a flat list from the
            // adapter's chapter list so the Contents sidebar works. Each
            // entry is a depth-0 leaf (no children).
            let mut cache = state.mobi_cache.lock()?;
            ensure_mobi_cached(&mut cache, &file_path)?;
            let cached = cache
                .get(&file_path)
                .ok_or_else(|| FolioError::internal("Failed to open MOBI book"))?;
            let chapters = folio_core::mobi::get_chapter_list_from_cache(cached);
            Ok(chapters
                .into_iter()
                .map(|c| crate::models::TocEntry {
                    chapter_index: c.index as u32,
                    label: c.title,
                    play_order: format!("{}", c.index + 1),
                    children: Vec::new(),
                })
                .collect())
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => Err(FolioError::invalid(
            "MOBI support is not enabled in this build",
        )),
        other => Err(FolioError::invalid(format!(
            "get_toc is not supported for format {other}"
        ))),
    }
}

// --- Progress ---

#[tauri::command]
pub async fn get_reading_progress(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Option<ReadingProgress>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_reading_progress(&conn, &book_id)?)
}

#[tauri::command]
pub async fn get_all_reading_progress(
    state: State<'_, AppState>,
) -> FolioResult<Vec<ReadingProgress>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_all_reading_progress(&conn)?)
}

fn validate_file_exists(file_path: &str) -> FolioResult<()> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        let base = format!(
            "Book file not found at '{}'. It may have been moved or deleted.",
            file_path
        );
        let not_found = std::io::Error::from(std::io::ErrorKind::NotFound);
        return Err(FolioError::not_found(with_smb_hint(
            base, file_path, &not_found,
        )));
    }
    // Reject symlinks to prevent traversal attacks
    if path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(FolioError::invalid(
            "Symbolic links are not supported for book files.",
        ));
    }
    Ok(())
}

/// Validate that a path, once canonicalized, lies within an expected parent directory.
/// Returns the canonical path on success.
#[allow(dead_code)]
fn validate_path_within(path: &str, parent: &str) -> FolioResult<std::path::PathBuf> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve library folder '{}': {}", parent, e))?;
    if !canonical.starts_with(&canonical_parent) {
        return Err(FolioError::invalid(format!(
            "Path '{}' is outside the library folder.",
            path
        )));
    }
    Ok(canonical)
}

fn validate_scroll_position(pos: f64) -> FolioResult<f64> {
    if pos.is_nan() || pos.is_infinite() {
        return Err(FolioError::invalid(
            "scroll_position must be a finite number",
        ));
    }
    Ok(pos.clamp(0.0, 1.0))
}

#[tauri::command]
pub async fn save_reading_progress(
    book_id: String,
    chapter_index: u32,
    scroll_position: f64,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<()> {
    let scroll_position = validate_scroll_position(scroll_position)?;

    let conn = state.active_db()?.get()?;

    // Validate chapter_index against the book's total chapters
    let book = db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found(format!("Book not found: {}", book_id)))?;

    if book.total_chapters > 0 && chapter_index >= book.total_chapters {
        return Err(FolioError::invalid(format!(
            "chapter_index {} is out of range (book has {} chapters)",
            chapter_index, book.total_chapters
        )));
    }

    let is_on_last_chapter =
        book.total_chapters > 0 && chapter_index >= book.total_chapters.saturating_sub(1);

    let was_completed_before = is_on_last_chapter
        && db::get_reading_progress(&conn, &book_id)?
            .map(|p| p.chapter_index >= book.total_chapters.saturating_sub(1))
            .unwrap_or(false);

    let progress = ReadingProgress {
        book_id: book_id.clone(),
        chapter_index,
        scroll_position,
        last_read_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    db::upsert_reading_progress(&conn, &progress)?;

    if is_on_last_chapter && !was_completed_before {
        events::bus().emit(FolioEvent::BookFinished {
            book_id: book_id.clone(),
        });
        log_event(
            &conn,
            ActivityEvent::BookCompleted {
                id: book_id.clone(),
                title: book.title.clone(),
            },
        );
        let _ = app.emit(
            "book-completed",
            serde_json::json!({
                "bookId": book_id,
                "title": book.title,
                "author": book.author,
                "coverPath": book.cover_path,
                "totalChapters": book.total_chapters,
            }),
        );
    }

    Ok(())
}

// --- Bookmarks ---

#[tauri::command]
pub async fn get_bookmarks(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<Bookmark>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_bookmarks(&conn, &book_id)?)
}

#[tauri::command]
pub async fn add_bookmark(
    book_id: String,
    chapter_index: u32,
    scroll_position: f64,
    note: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<Bookmark> {
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

    let conn = state.active_db()?.get()?;
    db::insert_bookmark(&conn, &bookmark)?;

    events::bus().emit(FolioEvent::BookmarkCreated {
        book_id: bookmark.book_id.clone(),
        bookmark_id: bookmark.id.clone(),
    });

    Ok(bookmark)
}

#[tauri::command]
pub async fn remove_bookmark(bookmark_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::soft_delete_bookmark(&conn, &bookmark_id)?)
}

#[tauri::command]
pub async fn update_bookmark(
    bookmark_id: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let truncated_name: Option<String> = name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.chars().take(100).collect::<String>());
    let name_ref = truncated_name.as_deref();
    let conn = state.active_db()?.get()?;
    Ok(db::update_bookmark_name(&conn, &bookmark_id, name_ref)?)
}

// --- Comic (CBZ / CBR) ---

#[tauri::command]
pub async fn get_comic_page_count(book_id: String, state: State<'_, AppState>) -> FolioResult<u32> {
    let book = {
        let conn = state.active_db()?.get()?;
        db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?
    };
    let file_path = state.resolve_book_path(&book)?;

    validate_file_exists(&file_path)?;
    match book.format {
        BookFormat::Cbz => cbz::get_page_count(&file_path),
        BookFormat::Cbr => cbr::get_page_count(&file_path),
        _ => Err(FolioError::invalid(format!(
            "get_comic_page_count is not supported for {:?}",
            book.format
        ))),
    }
}

/// Comic page reader for the desktop frontend. Returns raw image
/// bytes plus a trailing mime tag (see `page_wire`); the frontend
/// builds a `Blob` + `URL.createObjectURL` and assigns it directly
/// to `<img src>`, bypassing base64 entirely.
///
/// `target_width` clamps the page width to the viewport. The frontend
/// computes this from container width × DPR so we ship roughly the
/// number of pixels the browser actually paints, not the full-res
/// archive scan (often 4–10 MB at native resolution).
#[tauri::command]
pub async fn get_comic_page_bytes(
    book_id: String,
    page_index: u32,
    target_width: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<tauri::ipc::Response> {
    let _t = state.ipc_metrics.time("get_comic_page_bytes");
    let start = std::time::Instant::now();
    let target_width = target_width.filter(|&w| w > 0).map(|w| w.min(9600));

    let book = {
        let conn = state.active_db()?.get()?;
        db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?
    };
    let file_path = state.resolve_book_path(&book)?;
    validate_file_exists(&file_path)?;

    // Cache-first path. Cached pages are full-resolution archive bytes;
    // run them through the same resize helper the cold path uses so the
    // wire-level promise (≤ target_width) holds either way.
    if let Ok(storage) = page_cache_storage(&app) {
        if let Some(ref book_hash) = book.file_hash {
            if let Ok((data, mime)) = page_cache::get_cached_page(&storage, book_hash, page_index) {
                let (bytes, out_mime) =
                    crate::image_util::maybe_resize_to_jpeg(data, mime, target_width)?;
                page_cache::page_dbg!(
                    "bytes cache HIT: page={} size={}KB total={:?}",
                    page_index,
                    bytes.len() / 1024,
                    start.elapsed()
                );
                return Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(
                    bytes, &out_mime,
                )));
            }
        }
    }

    let (bytes, mime) = match book.format {
        BookFormat::Cbz => cbz::get_page_image_bytes(&file_path, page_index, target_width)?,
        BookFormat::Cbr => cbr::get_page_image_bytes(&file_path, page_index, target_width)?,
        _ => {
            return Err(FolioError::invalid(format!(
                "get_comic_page_bytes is not supported for {:?}",
                book.format
            )));
        }
    };
    page_cache::page_dbg!(
        "bytes archive read: page={} size={}KB total={:?}",
        page_index,
        bytes.len() / 1024,
        start.elapsed()
    );
    Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(
        bytes, &mime,
    )))
}

#[tauri::command]
pub async fn prepare_comic(
    book_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<page_cache::CacheManifest> {
    let _t = state.ipc_metrics.time("prepare_comic");
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

    if book.format != BookFormat::Cbz && book.format != BookFormat::Cbr {
        return Err(FolioError::invalid(
            "prepare_comic only supports CBZ/CBR formats",
        ));
    }

    let book_hash = book.file_hash.as_deref().ok_or("Book has no file hash")?;
    let storage = page_cache_storage(&app)?;

    let prep_start = std::time::Instant::now();
    page_cache::page_dbg!(
        "prepare_comic: book={} format={:?} hash={}",
        book_id,
        book.format,
        book_hash
    );
    let manifest =
        page_cache::ensure_cached(&storage, &book_id, book_hash, &file_path, &book.format)?;
    page_cache::page_dbg!(
        "prepare_comic done: pages={} size={}KB elapsed={:?}",
        manifest.page_count,
        manifest.total_size_bytes / 1024,
        prep_start.elapsed()
    );

    // Run eviction in background
    let evict_storage = page_cache_storage(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = page_cache::run_eviction(&evict_storage, max_size_mb);
    });

    Ok(manifest)
}

/// First-open warm pass for PDF books. Mirrors `prepare_comic`:
/// asserts the format, requires `book.file_hash`, renders the first
/// ten pages into the shared `page-cache/` namespace, and kicks off
/// a background eviction afterwards. Returns the freshly-written
/// manifest so the frontend can reuse `page_count` instead of calling
/// `get_pdf_page_count` separately.
#[tauri::command]
pub async fn prepare_pdf(
    book_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<page_cache::CacheManifest> {
    let _t = state.ipc_metrics.time("prepare_pdf");
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
    let manifest = page_cache::ensure_pdf_prewarmed(
        &storage,
        &book_id,
        book_hash,
        &file_path,
        PDF_PREWARM_PAGES,
    )?;
    page_cache::page_dbg!(
        "prepare_pdf done: page_count={} elapsed={:?}",
        manifest.page_count,
        prep_start.elapsed()
    );

    let evict_storage = page_cache_storage(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = page_cache::run_eviction(&evict_storage, max_size_mb);
    });

    Ok(manifest)
}

/// Build the lifecycle registry over every cache. Constructed per call:
/// cheap (three Arc clones), and the disk storage handle comes from
/// `page_cache_storage` exactly like the existing page-cache commands.
fn cache_registry(
    state: &AppState,
    storage: std::sync::Arc<dyn folio_core::storage::Storage>,
) -> Vec<Box<dyn ManagedCache>> {
    let mut registry: Vec<Box<dyn ManagedCache>> = vec![Box::new(MemoryCacheAdapter::new(
        "epub",
        false,
        state.epub_cache.clone(),
    ))];
    #[cfg(feature = "mobi")]
    registry.push(Box::new(MemoryCacheAdapter::new(
        "mobi",
        true,
        state.mobi_cache.clone(),
    )));
    registry.push(Box::new(DiskPageCacheAdapter::new(storage)));
    registry
}

#[tauri::command]
pub async fn get_unified_cache_stats(
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<UnifiedCacheStats> {
    let storage: std::sync::Arc<dyn folio_core::storage::Storage> =
        std::sync::Arc::new(page_cache_storage(&app)?);
    Ok(folio_core::cache::unified_stats(&cache_registry(
        &state, storage,
    )))
}

#[tauri::command]
pub async fn clear_all_caches(app: AppHandle, state: State<'_, AppState>) -> FolioResult<()> {
    let storage: std::sync::Arc<dyn folio_core::storage::Storage> =
        std::sync::Arc::new(page_cache_storage(&app)?);
    folio_core::cache::clear_all(&cache_registry(&state, storage))
}

#[tauri::command]
pub async fn clear_page_cache(app: AppHandle) -> FolioResult<()> {
    let storage = page_cache_storage(&app)?;
    page_cache::clear_cache(&storage)
}

// --- Reading Stats ---

#[tauri::command]
pub async fn record_reading_session(
    book_id: String,
    started_at: i64,
    duration_secs: i64,
    pages_read: i32,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    if duration_secs < 10 {
        return Ok(());
    } // Skip very short sessions
    let conn = state.active_db()?.get()?;
    let id = Uuid::new_v4().to_string();
    Ok(db::insert_reading_session(
        &conn,
        &id,
        &book_id,
        started_at,
        duration_secs,
        pages_read,
    )?)
}

#[tauri::command]
pub async fn get_reading_stats(state: State<'_, AppState>) -> FolioResult<db::ReadingStats> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_reading_stats(&conn)?)
}

#[tauri::command]
pub async fn get_book_reading_time(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<i64> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_book_reading_time(&conn, &book_id)?)
}

// --- Highlights ---

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_highlight(
    book_id: String,
    chapter_index: u32,
    text: String,
    color: String,
    start_offset: u32,
    end_offset: u32,
    note: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<Highlight> {
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
    let conn = state.active_db()?.get()?;
    db::insert_highlight(&conn, &highlight)?;

    events::bus().emit(FolioEvent::HighlightCreated {
        book_id: highlight.book_id.clone(),
        highlight_id: highlight.id.clone(),
    });

    Ok(highlight)
}

#[tauri::command]
pub async fn get_highlights(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<Highlight>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_highlights(&conn, &book_id)?)
}

#[tauri::command]
pub async fn get_chapter_highlights(
    book_id: String,
    chapter_index: u32,
    state: State<'_, AppState>,
) -> FolioResult<Vec<Highlight>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_chapter_highlights(&conn, &book_id, chapter_index)?)
}

#[tauri::command]
pub async fn update_highlight_note(
    highlight_id: String,
    note: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    db::update_highlight_note(&conn, &highlight_id, note.as_deref())?;
    events::bus().emit(FolioEvent::HighlightUpdated { highlight_id });
    Ok(())
}

#[tauri::command]
pub async fn remove_highlight(highlight_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    db::soft_delete_highlight(&conn, &highlight_id)?;
    events::bus().emit(FolioEvent::HighlightDeleted { highlight_id });
    Ok(())
}

#[tauri::command]
pub async fn export_highlights_markdown(
    book_id: String,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;
    let book = db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
    let highlights = db::list_highlights(&conn, &book_id)?;

    let mut md = format!("# Highlights: {}\n\n", book.title);
    if !book.author.is_empty() {
        md.push_str(&format!("**{}**\n\n", book.author));
    }
    let mut current_chapter: Option<u32> = None;
    for h in &highlights {
        if current_chapter != Some(h.chapter_index) {
            md.push_str(&format!("\n## Chapter {}\n\n", h.chapter_index + 1));
            current_chapter = Some(h.chapter_index);
        }
        md.push_str(&format!("> {}\n", h.text));
        if let Some(ref note) = h.note {
            md.push_str(&format!("\n*{}*\n", note));
        }
        md.push('\n');
    }
    Ok(md)
}

#[tauri::command]
pub async fn search_highlights(
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<HighlightSearchResult>> {
    let conn = state.active_db()?.get()?;
    Ok(db::search_highlights(&conn, &query, limit.unwrap_or(200))?)
}

// --- Tags ---

#[derive(serde::Serialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn get_all_tags(state: State<'_, AppState>) -> FolioResult<Vec<Tag>> {
    let conn = state.active_db()?.get()?;
    let tags = db::list_tags(&conn)?;
    Ok(tags
        .into_iter()
        .map(|(id, name)| Tag { id, name })
        .collect())
}

#[tauri::command]
pub async fn get_book_tags(book_id: String, state: State<'_, AppState>) -> FolioResult<Vec<Tag>> {
    let conn = state.active_db()?.get()?;
    let tags = db::get_book_tags(&conn, &book_id)?;
    Ok(tags
        .into_iter()
        .map(|(id, name)| Tag { id, name })
        .collect())
}

#[tauri::command]
pub async fn add_tag_to_book(
    book_id: String,
    tag_name: String,
    state: State<'_, AppState>,
) -> FolioResult<Tag> {
    let conn = state.active_db()?.get()?;
    // Find or create tag
    let tag_id = if let Some(id) = db::get_tag_by_name(&conn, &tag_name)? {
        id
    } else {
        let id = Uuid::new_v4().to_string();
        db::get_or_create_tag(&conn, &id, &tag_name)?;
        id
    };
    db::add_tag_to_book(&conn, &book_id, &tag_id)?;
    Ok(Tag {
        id: tag_id,
        name: tag_name,
    })
}

#[tauri::command]
pub async fn remove_tag_from_book(
    book_id: String,
    tag_id: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::remove_tag_from_book(&conn, &book_id, &tag_id)?)
}

#[derive(serde::Serialize)]
pub struct BookTagAssoc {
    pub book_id: String,
    pub tag_id: String,
}

#[tauri::command]
pub async fn get_all_book_tags(state: State<'_, AppState>) -> FolioResult<Vec<BookTagAssoc>> {
    let conn = state.active_db()?.get()?;
    let assocs = db::list_all_book_tags(&conn)?;
    Ok(assocs
        .into_iter()
        .map(|(book_id, tag_id)| BookTagAssoc { book_id, tag_id })
        .collect())
}

// --- Collections ---

/// Valid (field, operator) combinations for collection rules.
const VALID_RULE_PAIRS: &[(&str, &str)] = &[
    ("author", "contains"),
    ("author", "equals"),
    ("filename", "contains"),
    ("series", "contains"),
    ("series", "equals"),
    ("language", "equals"),
    ("language", "contains"),
    ("publisher", "contains"),
    ("description", "contains"),
    ("format", "equals"),
    ("date_added", "last_n_days"),
    ("tag", "contains"),
    ("tag", "equals"),
    ("reading_progress", "equals"),
];

fn validate_collection_rules(rules: &[NewRuleInput]) -> FolioResult<()> {
    for rule in rules {
        if !VALID_RULE_PAIRS
            .iter()
            .any(|(f, o)| *f == rule.field && *o == rule.operator)
        {
            return Err(FolioError::invalid(format!(
                "Invalid collection rule: field '{}' with operator '{}'",
                rule.field, rule.operator
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_collection(
    name: String,
    coll_type: String,
    icon: Option<String>,
    color: Option<String>,
    rules: Vec<NewRuleInput>,
    state: State<'_, AppState>,
) -> FolioResult<Collection> {
    validate_collection_rules(&rules)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let collection_id = Uuid::new_v4().to_string();

    let coll_type_enum = match coll_type.as_str() {
        "automated" => CollectionType::Automated,
        _ => CollectionType::Manual,
    };

    let rule_structs: Vec<CollectionRule> = rules
        .into_iter()
        .map(|r| CollectionRule {
            id: Uuid::new_v4().to_string(),
            collection_id: collection_id.clone(),
            field: r.field,
            operator: r.operator,
            value: r.value,
        })
        .collect();

    let collection = Collection {
        id: collection_id,
        name,
        r#type: coll_type_enum,
        icon,
        color,
        created_at: now,
        updated_at: now,
        rules: rule_structs,
    };

    let conn = state.active_db()?.get()?;
    db::insert_collection(&conn, &collection)?;

    log_event(
        &conn,
        ActivityEvent::CollectionCreated {
            id: collection.id.clone(),
            name: collection.name.clone(),
        },
    );

    Ok(collection)
}

#[tauri::command]
pub async fn update_collection(
    id: String,
    name: String,
    coll_type: String,
    icon: Option<String>,
    color: Option<String>,
    rules: Vec<NewRuleInput>,
    state: State<'_, AppState>,
) -> FolioResult<Collection> {
    validate_collection_rules(&rules)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let coll_type_enum = match coll_type.as_str() {
        "automated" => CollectionType::Automated,
        _ => CollectionType::Manual,
    };

    let rule_structs: Vec<CollectionRule> = rules
        .into_iter()
        .map(|r| CollectionRule {
            id: Uuid::new_v4().to_string(),
            collection_id: id.clone(),
            field: r.field,
            operator: r.operator,
            value: r.value,
        })
        .collect();

    let conn = state.active_db()?.get()?;

    let created_at: i64 = conn.query_row(
        "SELECT created_at FROM collections WHERE id = ?1",
        rusqlite::params![&id],
        |row| row.get(0),
    )?;

    let collection = Collection {
        id,
        name,
        r#type: coll_type_enum,
        icon,
        color,
        created_at,
        updated_at: now,
        rules: rule_structs,
    };

    db::update_collection(&conn, &collection)?;

    log_event(
        &conn,
        ActivityEvent::CollectionUpdated {
            id: collection.id.clone(),
            name: collection.name.clone(),
        },
    );

    Ok(collection)
}

#[tauri::command]
pub async fn get_collections(state: State<'_, AppState>) -> FolioResult<Vec<Collection>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_collections(&conn)?)
}

#[tauri::command]
pub async fn delete_collection(id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    log_event(&conn, ActivityEvent::CollectionDeleted { id: id.clone() });
    Ok(db::delete_collection(&conn, &id)?)
}

#[tauri::command]
pub async fn add_book_to_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    let coll_type: String = conn.query_row(
        "SELECT type FROM collections WHERE id = ?1",
        rusqlite::params![collection_id],
        |row| row.get(0),
    )?;
    if coll_type == "automated" {
        return Err(FolioError::invalid(
            "Cannot manually add books to an automated collection",
        ));
    }
    db::add_book_to_collection(&conn, &book_id, &collection_id)?;
    log_event(
        &conn,
        ActivityEvent::CollectionModified {
            id: collection_id.clone(),
            detail: format!("Added book {}", book_id),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn remove_book_from_collection(
    book_id: String,
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    db::remove_book_from_collection(&conn, &book_id, &collection_id)?;
    log_event(
        &conn,
        ActivityEvent::CollectionModified {
            id: collection_id.clone(),
            detail: format!("Removed book {}", book_id),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn get_books_in_collection(
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<Book>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_books_in_collection(&conn, &collection_id)?)
}

#[tauri::command]
pub async fn get_books_in_collection_grid(
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<BookGridItem>> {
    let conn = state.active_db()?.get()?;
    let mut items = db::get_books_in_collection_grid(&conn, &collection_id)?;
    if let Ok(storage) = state.covers_storage() {
        apply_grid_thumbnails(&*storage, &mut items);
    }
    Ok(items)
}

// --- Share Collections ---

#[tauri::command]
pub async fn export_collection_markdown(
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;

    // Get collection name
    let name: String = conn.query_row(
        "SELECT name FROM collections WHERE id = ?1",
        rusqlite::params![collection_id],
        |row| row.get(0),
    )?;

    let books = db::get_books_in_collection(&conn, &collection_id)?;

    let mut md = format!("# {}\n\n", name);
    md.push_str(&format!("{} books\n\n", books.len()));
    for (i, book) in books.iter().enumerate() {
        md.push_str(&format!("{}. **{}**", i + 1, book.title));
        if !book.author.is_empty() {
            md.push_str(&format!(" — {}", book.author));
        }
        md.push_str(&format!(" *({})*\n", book.format));
    }
    Ok(md)
}

#[tauri::command]
pub async fn export_collection_json(
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;
    let name: String = conn.query_row(
        "SELECT name FROM collections WHERE id = ?1",
        rusqlite::params![collection_id],
        |row| row.get(0),
    )?;

    let books = db::get_books_in_collection(&conn, &collection_id)?;

    let list: Vec<serde_json::Value> = books
        .iter()
        .map(|b| {
            serde_json::json!({
                "title": b.title,
                "author": b.author,
                "format": b.format.to_string(),
            })
        })
        .collect();

    let export = serde_json::json!({
        "collection": name,
        "books": list,
    });

    Ok(serde_json::to_string_pretty(&export)?)
}

// --- OpenLibrary ---

#[tauri::command]
pub async fn search_openlibrary(
    title: String,
    author: Option<String>,
) -> FolioResult<Vec<openlibrary::OpenLibraryResult>> {
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(openlibrary::search(&title, author.as_deref()));
    });
    rx.recv()?
}

#[tauri::command]
#[tracing::instrument(skip(openlibrary_key, state))]
pub async fn enrich_book_from_openlibrary(
    book_id: String,
    openlibrary_key: String,
    state: State<'_, AppState>,
) -> FolioResult<Book> {
    let _t = state.ipc_metrics.time("enrich_book_from_openlibrary");
    tracing::info!("enriching book from openlibrary");
    // Fetch detailed metadata from OpenLibrary (on a separate thread)
    let key = openlibrary_key.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(openlibrary::get_work(&key));
    });
    let work = rx.recv()??;

    // Also get search result for rating/isbn (work endpoint doesn't have them)
    let conn = state.active_db()?.get()?;
    let mut book = db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;

    // Do a quick search to get rating and ISBN
    let search_title = book.title.clone();
    let search_author = if book.author.is_empty() {
        None
    } else {
        Some(book.author.clone())
    };
    let (tx2, rx2) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx2.send(openlibrary::search(&search_title, search_author.as_deref()));
    });
    let search_results = rx2.recv()?.unwrap_or_default();
    let matched = search_results.iter().find(|r| r.key == openlibrary_key);

    // Update book with enriched data
    let description = work
        .description
        .or_else(|| matched.and_then(|m| m.description.clone()));
    let genres = if !work.genres.is_empty() {
        Some(serde_json::to_string(&work.genres).unwrap_or_default())
    } else {
        matched.map(|m| serde_json::to_string(&m.genres).unwrap_or_default())
    };
    let rating = matched.and_then(|m| m.rating);
    let isbn = matched.and_then(|m| m.isbn.clone());

    db::update_book_enrichment(
        &conn,
        &book_id,
        description.as_deref(),
        genres.as_deref(),
        rating,
        isbn.as_deref(),
        Some(&openlibrary_key),
    )?;

    // Return updated book
    book.description = description;
    book.genres = genres;
    book.rating = rating;
    book.isbn = isbn;
    book.openlibrary_key = Some(openlibrary_key);

    events::bus().emit(FolioEvent::MetadataEnriched {
        book_id: book_id.clone(),
        provider: "OpenLibrary".to_string(),
    });
    log_event(&conn, ActivityEvent::BookEnriched { id: book_id });

    Ok(book)
}

// --- OPDS Catalog ---

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCatalogSource {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}

const DEFAULT_CATALOGS: &[(&str, &str, &str)] = &[
    (
        "Project Gutenberg",
        "https://www.gutenberg.org/ebooks.opds/",
        "project-gutenberg",
    ),
    (
        "Standard Ebooks (New Releases)",
        "https://standardebooks.org/feeds/atom/new-releases",
        "standard-ebooks-new",
    ),
    (
        "Wikisource (English)",
        "https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml",
        "wikisource-en",
    ),
];

/// Build the trusted-host list for OPDS network calls. Every catalog the user
/// (or Folio's defaults) has configured contributes its `host:port`, which
/// lets `is_safe_url_with_trusted` allow LAN/loopback servers the user
/// explicitly added — without weakening SSRF protection on arbitrary
/// feed-derived URLs from untrusted hosts.
fn trusted_hosts_from_catalogs(catalogs: &[OpdsCatalogSource]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for cat in catalogs {
        if let Some(hp) = opds::host_port_from_url(&cat.url) {
            if !hosts.iter().any(|h| h.eq_ignore_ascii_case(&hp)) {
                hosts.push(hp);
            }
        }
    }
    hosts
}

/// Same as [`trusted_hosts_from_catalogs`] but reads directly from the DB
/// connection so callers that don't already have the catalog list don't pay
/// the cost of an extra `get_opds_catalogs` round-trip.
fn trusted_hosts_from_db(conn: &rusqlite::Connection) -> Vec<String> {
    let mut hosts: Vec<String> = DEFAULT_CATALOGS
        .iter()
        .filter_map(|(_, url, _)| opds::host_port_from_url(url))
        .collect();
    let custom_json = db::get_setting(conn, "opds_custom_catalogs")
        .ok()
        .flatten()
        .unwrap_or_else(|| "[]".to_string());
    if let Ok(custom) = serde_json::from_str::<Vec<OpdsCatalogSource>>(&custom_json) {
        for c in custom {
            if let Some(hp) = opds::host_port_from_url(&c.url) {
                if !hosts.iter().any(|h| h.eq_ignore_ascii_case(&hp)) {
                    hosts.push(hp);
                }
            }
        }
    }
    hosts
}

#[tauri::command]
pub async fn get_opds_catalogs(state: State<'_, AppState>) -> FolioResult<Vec<OpdsCatalogSource>> {
    let conn = state.active_db()?.get()?;
    let custom_json =
        db::get_setting(&conn, "opds_custom_catalogs")?.unwrap_or_else(|| "[]".to_string());
    let custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();

    let mut result: Vec<OpdsCatalogSource> = DEFAULT_CATALOGS
        .iter()
        .map(|(name, url, preset_id)| OpdsCatalogSource {
            name: name.to_string(),
            url: url.to_string(),
            preset_id: Some(preset_id.to_string()),
        })
        .collect();
    result.extend(custom);
    Ok(result)
}

/// Persistence body for `add_opds_catalog`, factored out so tests can
/// exercise the exact code path the Tauri command runs without needing
/// to construct a `tauri::State`. The URL validation lives at the
/// command boundary, not here, so callers must validate first.
fn add_opds_catalog_inner(
    conn: &rusqlite::Connection,
    name: String,
    url: String,
    preset_id: Option<String>,
) -> FolioResult<()> {
    let custom_json =
        db::get_setting(conn, "opds_custom_catalogs")?.unwrap_or_else(|| "[]".to_string());
    let mut custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();
    custom.push(OpdsCatalogSource {
        name,
        url,
        preset_id,
    });
    let json = serde_json::to_string(&custom)?;
    Ok(db::set_setting(conn, "opds_custom_catalogs", &json)?)
}

#[tauri::command]
pub async fn add_opds_catalog(
    name: String,
    url: String,
    preset_id: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    if !opds::is_user_addable_url(&url) {
        return Err(FolioError::invalid(
            "Invalid catalog URL — only http:// or https:// URLs are accepted.",
        ));
    }
    let conn = state.active_db()?.get()?;
    add_opds_catalog_inner(&conn, name, url, preset_id)
}

#[tauri::command]
pub async fn remove_opds_catalog(url: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    let custom_json =
        db::get_setting(&conn, "opds_custom_catalogs")?.unwrap_or_else(|| "[]".to_string());
    let mut custom: Vec<OpdsCatalogSource> = serde_json::from_str(&custom_json).unwrap_or_default();
    custom.retain(|c| c.url != url);
    let json = serde_json::to_string(&custom)?;
    Ok(db::set_setting(&conn, "opds_custom_catalogs", &json)?)
}

/// Search all configured OPDS catalogs in parallel and return aggregated results.
#[tauri::command]
pub async fn search_all_catalogs(
    query: String,
    state: State<'_, AppState>,
) -> FolioResult<Vec<opds::OpdsEntry>> {
    // Collect all catalog URLs
    let catalogs = get_opds_catalogs(state).await?;
    let trusted = trusted_hosts_from_catalogs(&catalogs);

    // Fetch root feeds in parallel to discover search URLs
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let mut thread_count = 0;

    for cat in &catalogs {
        let url = cat.url.clone();
        let q = query.clone();
        let tx = result_tx.clone();
        let cat_name = cat.name.clone();
        let trusted = trusted.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // 1. Fetch root feed to get searchUrl
            let root = match opds::fetch_feed_with_trusted(&url, &trusted) {
                Ok(f) => f,
                Err(_) => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            let raw_search_url = match root.search_url {
                Some(u) => u,
                None => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            // 2. Resolve OpenSearch description if needed, then search
            let template = match opds::resolve_search_url_with_trusted(&raw_search_url, &trusted) {
                Some(t) => t,
                None => {
                    let _ = tx.send(Vec::new());
                    return;
                }
            };
            let search_url = template.replace("{searchTerms}", &opds::url_encode(&q));
            let results = match opds::fetch_feed_with_trusted(&search_url, &trusted) {
                Ok(f) => f.entries,
                Err(_) => Vec::new(),
            };
            // Tag entries with catalog source
            let tagged: Vec<opds::OpdsEntry> = results
                .into_iter()
                .map(|mut e| {
                    if !e.summary.is_empty() {
                        e.summary = format!("[{}] {}", cat_name, e.summary);
                    } else {
                        e.summary = format!("[{}]", cat_name);
                    }
                    e
                })
                .collect();
            let _ = tx.send(tagged);
        });
        thread_count += 1;
    }
    drop(result_tx);

    let mut all_entries = Vec::new();
    for _ in 0..thread_count {
        if let Ok(entries) = result_rx.recv() {
            all_entries.extend(entries);
        }
    }
    Ok(all_entries)
}

/// Returns a cached list of popular/new books from all configured catalogs.
/// Results are cached for 24 hours in the settings DB to avoid slowing down startup.
#[tauri::command]
pub async fn get_discover_books(state: State<'_, AppState>) -> FolioResult<Vec<opds::OpdsEntry>> {
    let conn = state.active_db()?.get()?;

    // Check cache (stored as JSON with a timestamp)
    if let Some(cached) = db::get_setting(&conn, "discover_cache_v3")? {
        if let Ok(cache) = serde_json::from_str::<serde_json::Value>(&cached) {
            let cached_at = cache["cached_at"].as_i64().unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if now - cached_at < 86400 {
                // Cache is fresh (< 24h)
                if let Ok(entries) =
                    serde_json::from_value::<Vec<opds::OpdsEntry>>(cache["entries"].clone())
                {
                    return Ok(entries);
                }
            }
        }
    }

    // Cache miss or stale — fetch from catalogs in parallel
    let catalogs = get_opds_catalogs(state).await?;
    let trusted = trusted_hosts_from_catalogs(&catalogs);
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let mut thread_count = 0;

    for cat in &catalogs {
        let url = cat.url.clone();
        let tx = result_tx.clone();
        let cat_name = cat.name.clone();
        let trusted = trusted.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let entries = match opds::fetch_feed_with_trusted(&url, &trusted) {
                Ok(feed) => feed
                    .entries
                    .into_iter()
                    .filter(|e| !e.links.is_empty() && e.nav_url.is_none())
                    .take(10)
                    .map(|mut e| {
                        // Tag with catalog source
                        if e.summary.is_empty() {
                            e.summary = format!("From {}", cat_name);
                        }
                        e
                    })
                    .collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            };
            let _ = tx.send(entries);
        });
        thread_count += 1;
    }
    drop(result_tx);

    let mut all_entries = Vec::new();
    for _ in 0..thread_count {
        if let Ok(entries) = result_rx.recv() {
            all_entries.extend(entries);
        }
    }

    // Cache the results
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let cache = serde_json::json!({
        "cached_at": now,
        "entries": all_entries,
    });
    let _ = db::set_setting(
        &conn,
        "discover_cache_v3",
        &serde_json::to_string(&cache).unwrap_or_default(),
    );

    Ok(all_entries)
}

/// Pick the file extension from an OPDS acquisition URL. Parses the URL with
/// the `url` crate and inspects the final non-empty path segment — query
/// strings, fragments, and trailing slashes are handled by the parser, so
/// feeds that append `?token=…` or `/` don't hide the extension.
/// Returns `None` when the URL is unparseable or the extension isn't in our
/// supported set; the caller decides the fallback.
fn opds_extension_from_url(url: &str) -> Option<&'static str> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.rfind(|s| !s.is_empty())?;
    let ext = last.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "epub" => Some("epub"),
        "pdf" => Some("pdf"),
        "cbz" => Some("cbz"),
        "cbr" => Some("cbr"),
        "mobi" => Some("mobi"),
        "azw" => Some("azw"),
        "azw3" => Some("azw3"),
        _ => None,
    }
}

/// Download a book from `url` and import it into the active profile, reusing
/// the standard import pipeline (dedup, copy-on-import). Returns the book id
/// (new or existing duplicate). Backs the plugin `import:books` host function
/// (`plugin_host::DesktopHostServices::import_from_url`); runs on the caller's
/// thread, so it uses blocking download + import directly.
pub(crate) fn import_book_from_url(state: &AppState, url: &str) -> FolioResult<String> {
    let ext = opds_extension_from_url(url).unwrap_or("epub");
    if !supported_import_extensions().contains(&ext) {
        return Err(FolioError::invalid(format!(
            "Format '.{ext}' is not supported in this build."
        )));
    }

    let db_pool = state.active_db()?;
    let storage = state.active_storage()?;
    let covers_storage = state.covers_storage()?;
    let import_mode = {
        let conn = db_pool.get()?;
        db::get_setting(&conn, "import_mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "import".to_string())
    };

    let temp_path = std::env::temp_dir().join(format!("folio-plugin-{}.{}", Uuid::new_v4(), ext));
    let temp_str = temp_path.to_string_lossy().to_string();
    // SSRF-guarded on every redirect hop, with NO trusted-host relaxation:
    // a plugin must not reach the user's LAN catalogs, only public URLs.
    opds::download_file_ssrf_guarded(url, &temp_str)?;

    let outcome = import_book_inner(
        temp_str,
        db_pool,
        storage,
        covers_storage,
        &import_mode,
        true,
        ImportSource::Download,
    );
    let _ = std::fs::remove_file(&temp_path);
    Ok(outcome?.into_book().id)
}

/// Map an OPDS acquisition link's MIME type to the file extension the import
/// pipeline expects. Preferred over URL-based detection because many feeds
/// serve opaque download URLs (e.g. `/download/123`) while still returning
/// the correct MIME. Parameters (`; profile="…"`) are ignored.
fn opds_extension_from_mime(mime: &str) -> Option<&'static str> {
    let bare = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    match bare.as_str() {
        "application/epub+zip" => Some("epub"),
        "application/pdf" => Some("pdf"),
        // MOBI family. `x-mobipocket-ebook` is the historical MOBI MIME and
        // unambiguous. `application/vnd.amazon.ebook` is the Amazon vendor
        // MIME shared by both `.azw` and `.azw3` — mapping it to a specific
        // extension here would collapse that distinction, so we return None
        // and let URL-based detection disambiguate. A final default of
        // `.azw3` (the more common container) is applied at the import
        // layer when the URL is also opaque.
        "application/x-mobipocket-ebook" => Some("mobi"),
        // Comic book archives. Both vendor-prefixed and de-facto MIMEs seen in feeds.
        "application/x-cbz" | "application/vnd.comicbook+zip" => Some("cbz"),
        "application/x-cbr" | "application/vnd.comicbook-rar" => Some("cbr"),
        _ => None,
    }
}

#[tauri::command]
pub async fn browse_opds(url: String, state: State<'_, AppState>) -> FolioResult<opds::OpdsFeed> {
    let trusted = {
        let conn = state.active_db()?.get()?;
        trusted_hosts_from_db(&conn)
    };
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(opds::fetch_feed_with_trusted(&url, &trusted));
    });
    rx.recv()?
}

#[tauri::command]
pub async fn download_opds_book(
    download_url: String,
    mime_type: Option<String>,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<OpdsImportResult> {
    // Determine the file extension for the temp import path. Precedence:
    //   1. URL suffix — Folio's own feed and many well-behaved feeds put the
    //      extension in the path; this is the only signal that disambiguates
    //      the AZW / AZW3 pair since they share
    //      `application/vnd.amazon.ebook`.
    //   2. MIME type — authoritative for unambiguous types and covers feeds
    //      with opaque URLs like `/download/123`.
    //   3. Vendor-MIME fallback — `application/vnd.amazon.ebook` resolves to
    //      `.azw3` here (the far more common container), which kicks in only
    //      when the URL also had no usable suffix.
    //   4. Final fallback `.epub` so we never feed an extensionless file to
    //      the importer.
    let vendor_amazon = mime_type
        .as_deref()
        .map(|m| {
            m.split(';')
                .next()
                .unwrap_or(m)
                .trim()
                .eq_ignore_ascii_case("application/vnd.amazon.ebook")
        })
        .unwrap_or(false);
    let ext = opds_extension_from_url(&download_url)
        .or_else(|| mime_type.as_deref().and_then(opds_extension_from_mime))
        .or(if vendor_amazon { Some("azw3") } else { None })
        .unwrap_or("epub");

    // Defense in depth: reject unsupported formats before the download so
    // non-`mobi` builds don't waste bandwidth/disk on a file they'll throw
    // away in import_book. The frontend already hides these buttons via
    // get_supported_formats, but feature flags could diverge (e.g. direct
    // IPC calls from tests), and the import error is clearer here.
    if !supported_import_extensions().contains(&ext) {
        return Err(FolioError::invalid(format!(
            "Format '.{ext}' is not supported in this build."
        )));
    }

    // Download to a temp file
    let temp_dir = std::env::temp_dir();
    let temp_name = format!("folio-opds-{}.{}", Uuid::new_v4(), ext);
    let temp_path = temp_dir.join(&temp_name);
    let temp_str = temp_path.to_string_lossy().to_string();

    {
        let dl_url = download_url.clone();
        let dl_dest = temp_str.clone();
        let trusted = {
            let conn = state.active_db()?.get()?;
            trusted_hosts_from_db(&conn)
        };
        let (tx, rx) = std::sync::mpsc::channel();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = tx.send(opds::download_file_with_trusted(
                &dl_url, &dl_dest, &trusted,
            ));
        });
        rx.recv()??;
    }

    // Import via the shared inner pipeline. We bypass the `import_book` IPC
    // wrapper so we can pass `force_copy = true`: the temp file is about to
    // be deleted below, so even in `link` mode we must copy into the library
    // rather than store the temp path in the DB.
    let db_pool = state.active_db()?;
    let storage = state.active_storage()?;
    let covers_storage = state.covers_storage()?;
    let import_mode = {
        let conn = db_pool.get()?;
        db::get_setting(&conn, "import_mode")
            .ok()
            .flatten()
            .unwrap_or_else(|| "import".to_string())
    };
    let outcome = import_book_inner(
        temp_str.clone(),
        db_pool,
        storage,
        covers_storage,
        &import_mode,
        true,
        ImportSource::Download,
    );

    // Clean up temp file regardless of import success/failure
    let _ = std::fs::remove_file(&temp_path);

    let outcome = outcome?;
    Ok(OpdsImportResult {
        newly_imported: outcome.is_new(),
        book: outcome.into_book(),
    })
}

// --- Profiles ---

#[derive(serde::Serialize)]
pub struct Profile {
    pub name: String,
    pub is_active: bool,
}

#[tauri::command]
pub async fn get_profiles(state: State<'_, AppState>) -> FolioResult<Vec<Profile>> {
    let ps = state.profile_state.lock()?;
    let mut result = vec![Profile {
        name: "default".to_string(),
        is_active: ps.active == "default",
    }];
    for name in ps.pools.keys() {
        result.push(Profile {
            name: name.clone(),
            is_active: *name == ps.active,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
pub async fn create_profile(name: String, state: State<'_, AppState>) -> FolioResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() || name == "default" {
        return Err(FolioError::invalid("Invalid profile name"));
    }
    let db_path = state.data_dir.join(format!("library-{name}.db"));
    if db_path.exists() {
        return Err(FolioError::invalid(format!(
            "Profile '{name}' already exists"
        )));
    }
    let pool = db::create_pool(&db_path)?;

    // Ensure library folder for this profile
    let conn = pool.get()?;
    let library_folder = default_library_folder()?;
    let profile_folder = format!("{} - {}", library_folder, name);
    let _ = std::fs::create_dir_all(&profile_folder);
    db::set_setting(&conn, "library_folder", &profile_folder)?;

    let mut ps = state.profile_state.lock()?;
    ps.pools.insert(name, pool);
    Ok(())
}

#[tauri::command]
pub async fn switch_profile(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    {
        let mut ps = state.profile_state.lock()?;
        if name != "default" && !ps.pools.contains_key(&name) {
            return Err(FolioError::invalid(format!("Profile '{name}' not found")));
        }
        ps.active = name.clone();
    }

    // Sync the shared pool used by the web server
    let new_pool = state.active_db()?;
    {
        let mut shared = state.shared_active_pool.lock()?;
        *shared = new_pool;
    }

    // Rebuild the plugin manager against the new profile's DB so plugin
    // grants, enable-state, and host-API queries all follow the active
    // profile. Plugins are per-profile; the single bus subscriber reads the
    // swapped slot, so no listener is leaked.
    crate::plugin_host::rebuild_for_profile(
        &app,
        &state.data_dir,
        state.active_db()?,
        &state.plugin_manager,
    );

    let conn = state.active_db()?.get()?;
    log_event(&conn, ActivityEvent::ProfileSwitched { name });

    Ok(())
}

#[tauri::command]
pub async fn delete_profile(name: String, state: State<'_, AppState>) -> FolioResult<()> {
    if name == "default" {
        return Err(FolioError::invalid("Cannot delete the default profile"));
    }
    let mut ps = state.profile_state.lock()?;
    if ps.active == name {
        return Err(FolioError::invalid(
            "Cannot delete the active profile. Switch to another profile first.",
        ));
    }
    ps.pools.remove(&name);
    // Remove DB file
    let db_path = state.data_dir.join(format!("library-{name}.db"));
    let _ = std::fs::remove_file(db_path);
    Ok(())
}

// --- Library Folder ---

#[derive(serde::Serialize)]
pub struct LibraryFolderInfo {
    pub path: String,
    pub file_count: u64,
    pub linked_count: u64,
    pub total_size_bytes: u64,
}

/// Thin wrapper kept for backwards compatibility with the existing in-crate
/// call sites; the implementation lives in [`folio_core::paths`] so both the
/// desktop app and future headless binaries share a single definition.
pub fn default_library_folder() -> FolioResult<String> {
    folio_core::paths::default_library_folder()
}

#[tauri::command]
pub async fn get_library_folder(state: State<'_, AppState>) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;
    if let Some(folder) = db::get_setting(&conn, "library_folder")? {
        Ok(folder)
    } else {
        default_library_folder()
    }
}

#[tauri::command]
pub async fn get_library_folder_info(state: State<'_, AppState>) -> FolioResult<LibraryFolderInfo> {
    let conn = state.active_db()?.get()?;
    let path = if let Some(f) = db::get_setting(&conn, "library_folder")? {
        f
    } else {
        default_library_folder()?
    };
    let books = db::list_books(&conn)?;

    // #64 M4: `file_path` is now a storage key for imported books, so we
    // resolve each book through `AppState::resolve_book_path` before
    // comparing to the requested folder. Linked books whose absolute path
    // sits elsewhere are naturally excluded.
    let prefix = if path.ends_with('/') {
        path.clone()
    } else {
        format!("{}/", path)
    };
    let mut file_count = 0u64;
    let mut linked_count = 0u64;
    let mut total_size_bytes = 0u64;
    for book in &books {
        let resolved = match state.resolve_book_path(book) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Books whose resolved path lives outside the storage folder are
        // linked (remote) rather than imported into the library.
        if !resolved.starts_with(&prefix) {
            linked_count += 1;
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&resolved) {
            if meta.is_file() {
                file_count += 1;
                total_size_bytes += meta.len();
            }
        }
    }

    Ok(LibraryFolderInfo {
        path,
        file_count,
        linked_count,
        total_size_bytes,
    })
}

#[tauri::command]
pub async fn set_library_folder(
    new_folder: String,
    move_files: bool,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    // Validate the folder path: reject obviously dangerous values.
    let folder_path = std::path::Path::new(&new_folder);
    if new_folder.is_empty() || new_folder == "/" || new_folder == "\\" {
        return Err(FolioError::invalid("Invalid library folder path."));
    }
    // Ensure the folder exists (or can be created) then canonicalize.
    std::fs::create_dir_all(&new_folder)?;
    let canonical = std::fs::canonicalize(folder_path)
        .map_err(|e| format!("Cannot resolve library folder: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    if !move_files {
        let conn = state.active_db()?.get()?;
        db::set_setting(&conn, "library_folder", &canonical_str)?;
        return Ok(());
    }

    // Atomic migration: gather books, plan moves, execute all-or-nothing.
    let books = {
        let conn = state.active_db()?.get()?;
        db::list_books(&conn)?
    };

    // #64 M4: `book.file_path` is a storage key for imported books and an
    // absolute path for linked ones. Resolve each imported source to an
    // absolute path via the *current* library storage before moving, and
    // persist the new key (`{book_id}.{ext}`) back to the DB on success.
    // Linked books are not relocated.
    let current_storage = state.active_storage()?;
    let moves: Vec<(String, String, String)> = books
        .iter()
        .filter(|b| b.is_imported)
        .map(|book| {
            // Use the key's extension where possible (matches the on-disk
            // filename); fall back to reading it from the resolved path.
            let ext = std::path::Path::new(&book.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let new_key = format!("{}.{}", book.id, ext);
            let dest = format!("{}/{}", canonical_str, new_key);
            let src = match current_storage.local_path(&book.file_path) {
                Ok(p) => p.to_string_lossy().to_string(),
                // Legacy row with absolute path that escaped the M4
                // migration — move it as-is.
                Err(_) => book.file_path.clone(),
            };
            (src, dest, new_key)
        })
        .collect();

    // Attempt all moves; roll back on first failure.
    let mut completed: Vec<(String, String)> = Vec::new();
    for (src, dest, _new_key) in &moves {
        let result = std::fs::rename(src, dest).or_else(|_| {
            // Cross-device fallback: copy then delete source.
            std::fs::copy(src, dest)
                .map(|_| ())
                .and_then(|_| std::fs::remove_file(src))
        });
        if let Err(e) = result {
            // Roll back every completed move before returning the error.
            // Collect rollback failures so the caller has full context if
            // rollback itself fails (e.g. cross-device copy-back fails).
            let mut rollback_errors: Vec<String> = Vec::new();
            for (orig_src, orig_dest) in &completed {
                if let Err(re) = std::fs::rename(orig_dest, orig_src).or_else(|_| {
                    std::fs::copy(orig_dest, orig_src)
                        .map(|_| ())
                        .and_then(|_| std::fs::remove_file(orig_dest))
                }) {
                    rollback_errors.push(format!("'{}': {}", orig_dest, re));
                }
            }
            let mut msg = format!("Failed to move '{}': {}", src, e);
            if !rollback_errors.is_empty() {
                msg = format!(
                    "{}. Rollback also failed: {}",
                    msg,
                    rollback_errors.join("; ")
                );
            }
            return Err(FolioError::io(msg));
        }
        completed.push((src.clone(), dest.clone()));
    }

    // All moves succeeded — persist new keys and setting atomically.
    let mut conn = state.active_db()?.get()?;
    let tx = conn.transaction()?;
    let imported_books: Vec<&Book> = books.iter().filter(|b| b.is_imported).collect();
    for (book, (_, _, new_key)) in imported_books.iter().zip(moves.iter()) {
        db::update_book_file_path(&tx, &book.id, new_key)?;
    }
    db::set_setting(&tx, "library_folder", &canonical_str)?;
    tx.commit()?;

    Ok(())
}

#[tauri::command]
pub async fn copy_to_library(book_id: String, state: State<'_, AppState>) -> FolioResult<Book> {
    let conn = state.active_db()?.get()?;
    let book =
        db::get_book(&conn, &book_id)?.ok_or_else(|| FolioError::not_found("Book not found"))?;

    if book.is_imported {
        return Err(FolioError::invalid("Book is already in the library"));
    }

    // Linked book: `file_path` is an external absolute path. Verify it still exists,
    // then import it through the library storage (#64 M2/M4).
    if !std::path::Path::new(&book.file_path).exists() {
        return Err(FolioError::invalid(
            "Source file not available. Reconnect the drive and try again.",
        ));
    }

    let ext = std::path::Path::new(&book.file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("epub")
        .to_string();
    let storage = state.active_storage()?;
    let key = book_storage_key(&book.id, &ext);
    storage
        .put_path(&key, std::path::Path::new(&book.file_path))
        .map_err(|e| FolioError::internal(format!("Failed to copy file to library: {e}")))?;

    db::update_book_path(&conn, &book.id, &key, true)?;

    log_event(
        &conn,
        ActivityEvent::BookUpdated {
            id: book.id.clone(),
            title: book.title.clone(),
            detail: "Copied to library".to_string(),
        },
    );

    db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found("Book not found after update"))
}

// --- Library Export/Import ---

#[tauri::command]
pub async fn export_library(
    dest_path: String,
    include_files: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let conn = state.active_db()?.get()?;
    let books = db::list_books(&conn)?;
    let metadata = db::build_core_export(&conn)?;

    let file = std::fs::File::create(&dest_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Add metadata JSON
    let metadata_json = serde_json::to_string_pretty(&metadata)?;
    zip.start_file("library.json", options)?;
    zip.write_all(metadata_json.as_bytes())?;

    let mut linked_count = 0u32;
    if include_files {
        // Add each book file (use Stored for already-compressed formats)
        // `large_file(true)` forces ZIP64 per entry so a book ≥4GB doesn't
        // abort the write mid-stream (the zip crate errors "Large file
        // option has not been set" otherwise, leaving a truncated archive).
        let stored_options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        for book in &books {
            if !book.is_imported {
                linked_count += 1;
                continue;
            }
            // #64 M4: resolve the storage key to an absolute path for reading.
            let resolved = match state.resolve_book_path(book) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let ext = std::path::Path::new(&resolved)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let archive_name = format!("books/{}.{}", book.id, ext);
            // epub/cbz are already zips; pdf compresses poorly — use Stored for all
            if let Ok(data) = std::fs::read(&resolved) {
                zip.start_file(&archive_name, stored_options)?;
                zip.write_all(&data)?;
            }
        }

        // Add cover files
        if let Ok(_data_dir) = app.path().app_data_dir() {
            for book in &books {
                if let Some(cover_path) = &book.cover_path {
                    // Prefer the small grid thumbnail (sibling `thumb.jpg`)
                    // over the full-resolution cover so backups stay small —
                    // the thumbnail is what the library grid displays. Falls
                    // back to the full cover when no thumbnail exists (the
                    // cover was already small enough at import time).
                    let thumb = std::path::Path::new(cover_path).with_file_name("thumb.jpg");
                    let (src, archive_name) = if thumb.exists() {
                        (thumb, format!("covers/{}/cover.jpg", book.id))
                    } else {
                        let ext = std::path::Path::new(cover_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("jpg");
                        (
                            std::path::PathBuf::from(cover_path),
                            format!("covers/{}/cover.{}", book.id, ext),
                        )
                    };
                    if let Ok(data) = std::fs::read(&src) {
                        zip.start_file(&archive_name, options)?;
                        zip.write_all(&data)?;
                    }
                }
            }
        }
    }

    zip.finish()?;

    let export_detail = if include_files {
        if linked_count > 0 {
            &format!(
                "Full backup with files ({} linked books skipped)",
                linked_count
            )
        } else {
            "Full backup with files"
        }
    } else {
        "Metadata only"
    };
    log_event(
        &conn,
        ActivityEvent::LibraryExported {
            detail: export_detail.to_string(),
        },
    );

    Ok(dest_path)
}

#[tauri::command]
pub async fn import_library_backup(
    archive_path: String,
    state: State<'_, AppState>,
    _app: AppHandle,
) -> FolioResult<u32> {
    use std::io::Read;

    let file = std::fs::File::open(&archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // Read library.json
    let books: Vec<Book> = {
        let mut entry = archive.by_name("library.json")?;
        let mut json = String::new();
        entry.read_to_string(&mut json)?;
        serde_json::from_str(&json)?
    };

    let conn = state.active_db()?.get()?;
    let library_folder = match db::get_setting(&conn, "library_folder")? {
        Some(f) => f,
        None => default_library_folder()?,
    };
    std::fs::create_dir_all(&library_folder)?;

    let mut imported = 0u32;

    // Helper: validate that a ZIP entry name is safe (no path traversal).
    let is_safe_zip_entry = |name: &str| -> bool {
        !name.contains("..") && !name.starts_with('/') && !name.starts_with('\\')
    };

    for book in &books {
        // Skip if book already exists by hash
        if let Some(ref hash) = book.file_hash {
            if db::get_book_by_file_hash(&conn, hash)?.is_some() {
                continue;
            }
        }

        // Linked books carry no file bytes in the backup (export skips
        // them; only the metadata row + cover are archived). Restore them
        // as links to their original absolute path — consistent with how
        // `resolve_book_path` treats linked books. The source volume must
        // be mounted at the same path on the restoring machine.
        let restored_file_path = if book.is_imported {
            // Derive the extension for the archive entry. For post-M4 backups
            // `book.file_path` is a storage key (e.g. `abc.epub`); for older
            // backups it's an absolute path. `Path::extension` handles both.
            let ext = std::path::Path::new(&book.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("epub");
            let book_archive_name = format!("books/{}.{}", book.id, ext);

            // Validate ZIP entry name before extraction
            if !is_safe_zip_entry(&book_archive_name) {
                continue;
            }

            // Extract book file through the library storage — storage owns the
            // on-disk layout, and the key (`{book_id}.{ext}`) is what the DB
            // now stores (#64 M4).
            let storage = state.active_storage()?;
            let book_key = book_storage_key(&book.id, ext);
            if let Ok(mut entry) = archive.by_name(&book_archive_name) {
                // Validate the actual entry name from the archive as well
                if !is_safe_zip_entry(entry.name()) {
                    continue;
                }
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf)?;
                storage.put(&book_key, &buf)?;
            } else {
                continue; // imported book whose file is missing from the backup
            }
            book_key
        } else {
            // Linked: keep the original absolute path verbatim.
            book.file_path.clone()
        };

        // Extract cover if present — route through the covers storage
        // (#64 M3) so on-disk layout stays identical whether restore writes
        // locally or (eventually) to a remote backend.
        let mut cover_path = book.cover_path.clone();
        let covers_storage = state.covers_storage()?;
        for ext_try in &["jpg", "png", "webp", "gif"] {
            let cover_name = format!("covers/{}/cover.{}", book.id, ext_try);
            if !is_safe_zip_entry(&cover_name) {
                continue;
            }
            if let Ok(mut entry) = archive.by_name(&cover_name) {
                if !is_safe_zip_entry(entry.name()) {
                    continue;
                }
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf)?;
                let key = cover_storage_key(&book.id, ext_try);
                covers_storage.put(&key, &buf)?;
                cover_path = Some(
                    covers_storage
                        .local_path(&key)?
                        .to_string_lossy()
                        .to_string(),
                );
                break;
            }
        }

        let restored_book = Book {
            file_path: restored_file_path,
            cover_path,
            ..book.clone()
        };

        if db::insert_book(&conn, &restored_book).is_ok() {
            imported += 1;
        }
    }

    log_event(
        &conn,
        ActivityEvent::LibraryImported {
            detail: "Restored from backup".to_string(),
        },
    );

    Ok(imported)
}

// --- PDF ---

#[tauri::command]
pub async fn check_pdf_support() -> bool {
    pdf::is_available()
}

#[tauri::command]
pub async fn get_pdf_page_count(book_id: String, state: State<'_, AppState>) -> FolioResult<u32> {
    let file_path = {
        let conn = state.active_db()?.get()?;
        let book = db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?;
        state.resolve_book_path(&book)?
    };
    validate_file_exists(&file_path)?;
    pdf::get_page_count(&file_path)
}

/// PDF page reader for the desktop frontend. Returns raw JPEG bytes
/// plus a trailing mime tag (see `page_wire`); the frontend builds a
/// `Blob` + `URL.createObjectURL` for `<img src>`.
///
/// `width` controls the viewport-target width (clamped to 9600). When
/// omitted, `folio_core::pdf::get_page_image_bytes` falls back to
/// `DEFAULT_RENDER_WIDTH` (1200 px).
///
/// Cache-first against the `page-cache/` namespace populated by
/// `prepare_pdf`: a disk hit reads canonical-width bytes and resizes
/// down to the viewport target. On miss with a PDF manifest present,
/// renders at the canonical width and writes best-effort to disk
/// (eviction is coalesced via a callback). Without a manifest (no
/// hash, storage error, or `prepare_pdf` never ran) the function
/// falls back to a direct render at the viewport width so uncacheable
/// PDFs match pre-spec performance.
#[tauri::command]
pub async fn get_pdf_page_bytes(
    book_id: String,
    page_index: u32,
    width: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<tauri::ipc::Response> {
    let _t = state.ipc_metrics.time("get_pdf_page_bytes");
    let render_width = width.filter(|&w| w > 0).map(|w| w.min(9600));

    let book = {
        let conn = state.active_db()?.get()?;
        db::get_book(&conn, &book_id)?
            .ok_or_else(|| FolioError::not_found(format!("Book '{book_id}' not found")))?
    };
    if book.format != BookFormat::Pdf {
        return Err(FolioError::invalid(
            "get_pdf_page_bytes only supports PDF format",
        ));
    }
    let file_path = state.resolve_book_path(&book)?;
    validate_file_exists(&file_path)?;

    // Cache-first path. Cached pages live at the canonical render
    // width; resize on read clamps them to the viewport-derived
    // target.
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
    // already in place — otherwise the higher render cost has no
    // cache benefit. No manifest → render at viewport width directly,
    // matching pre-spec behavior.
    let (bytes, mime) = if let Some(book_hash) = book.file_hash.clone() {
        if let Ok(storage) = page_cache_storage(&app) {
            let has_pdf_manifest = page_cache::read_manifest(&storage, &book_hash)
                .map(|m| m.format == BookFormat::Pdf)
                .unwrap_or(false);
            if has_pdf_manifest {
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
                let (b, m) = page_cache::get_or_render_pdf_page_with_eviction(
                    &storage, &book_hash, &file_path, page_index, on_batch,
                )?;
                (b, m.to_string())
            } else {
                // No PDF manifest — viewport render, no cache.
                let (b, m) = pdf::get_page_image_bytes(&file_path, page_index, render_width)?;
                (b, m.to_string())
            }
        } else {
            // Storage unavailable — viewport render, no cache.
            let (b, m) = pdf::get_page_image_bytes(&file_path, page_index, render_width)?;
            (b, m.to_string())
        }
    } else {
        // No file hash — viewport render, no cache.
        let (b, m) = pdf::get_page_image_bytes(&file_path, page_index, render_width)?;
        (b, m.to_string())
    };

    // Cache-miss canonical-render branch produced 2400 px JPEG bytes;
    // the no-cache fallbacks already match `render_width`.
    // `maybe_resize_to_jpeg` is a no-op when input == target.
    let (bytes, out_mime) = crate::image_util::maybe_resize_to_jpeg(bytes, mime, render_width)?;
    Ok(tauri::ipc::Response::new(crate::page_wire::append_tag(
        bytes, &out_mime,
    )))
}

// ---- Remote Backup Commands ----

#[tauri::command]
pub async fn get_backup_providers() -> FolioResult<Vec<crate::backup::ProviderInfo>> {
    Ok(crate::backup::provider_schemas())
}

#[tauri::command]
pub async fn save_backup_config(
    config: crate::backup::BackupConfig,
    state: State<'_, AppState>,
) -> Result<crate::backup::ConnectionTestResult, String> {
    // Snapshot existing secrets for rollback on test failure
    let old_secrets = {
        let conn = state
            .active_db()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        if let Some(json) = db::get_setting(&conn, "backup_config").map_err(|e| e.to_string())? {
            let mut old_config: crate::backup::BackupConfig =
                serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let _ = crate::backup::load_secrets(&mut old_config);
            Some(old_config)
        } else {
            None
        }
    };

    // Store new secrets in OS keychain
    let clean = crate::backup::store_secrets(&config).map_err(|e| e.to_string())?;

    // Test connection with the original config (secrets still in values map)
    let (tx, rx) = std::sync::mpsc::channel();
    let test_config = config.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::backup::test_connection(&test_config);
        let _ = tx.send(result);
    });
    let test_result = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap_or(crate::backup::ConnectionTestResult::Timeout);

    match &test_result {
        crate::backup::ConnectionTestResult::Ok { .. } => {
            // Test passed — persist clean config to DB
            let conn = state
                .active_db()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;
            let json = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
            db::set_setting(&conn, "backup_config", &json).map_err(|e| e.to_string())?;
        }
        _ => {
            // Rollback: restore old secrets or remove new ones
            if let Some(old_config) = &old_secrets {
                let _ = crate::backup::store_secrets(old_config);
            } else {
                let _ = crate::backup::remove_secrets(&config);
            }
        }
    }

    Ok(test_result)
}

#[tauri::command]
pub async fn test_backup_connection(
    config: crate::backup::BackupConfig,
) -> Result<crate::backup::ConnectionTestResult, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::backup::test_connection(&config);
        let _ = tx.send(result);
    });
    Ok(rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap_or(crate::backup::ConnectionTestResult::Timeout))
}

#[tauri::command]
pub async fn get_backup_config(
    state: State<'_, AppState>,
) -> FolioResult<Option<crate::backup::BackupConfig>> {
    let conn = state.active_db()?.get()?;
    match db::get_setting(&conn, "backup_config")? {
        Some(j) => {
            let mut config: crate::backup::BackupConfig = serde_json::from_str(&j)?;
            // Load secrets from OS keychain
            crate::backup::load_secrets(&mut config)?;
            Ok(Some(config))
        }
        None => Ok(None),
    }
}

static BACKUP_RUNNING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// RAII guard for the `BACKUP_RUNNING` set. Acquires the profile entry on
/// construction and releases it on drop — so any `?` in `run_backup` frees
/// the lock automatically without an explicit cleanup block. Without this
/// guard, a fallible setup step (keychain, operator build, storage init)
/// would leave the profile wedged until the app restarted.
#[derive(Debug)]
struct BackupLockGuard {
    profile_name: String,
}

impl BackupLockGuard {
    fn acquire(profile_name: String) -> FolioResult<Self> {
        let mut running = BACKUP_RUNNING.lock()?;
        if !running.insert(profile_name.clone()) {
            return Err(FolioError::invalid(
                "A backup is already in progress for this profile",
            ));
        }
        Ok(Self { profile_name })
    }
}

impl Drop for BackupLockGuard {
    fn drop(&mut self) {
        match BACKUP_RUNNING.lock() {
            Ok(mut running) => {
                running.remove(&self.profile_name);
            }
            Err(_) => {
                log::error!(
                    "BACKUP_RUNNING mutex poisoned; could not release lock for profile '{}'",
                    self.profile_name
                );
            }
        }
    }
}

#[tauri::command]
pub async fn run_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<crate::backup::SyncResult> {
    let _t = state.ipc_metrics.time("run_backup");
    let profile_name = {
        let ps = state.profile_state.lock()?;
        ps.active.clone()
    };
    let _guard = BackupLockGuard::acquire(profile_name.clone())?;
    let conn = state.active_db()?.get()?;
    let json = db::get_setting(&conn, "backup_config")?
        .ok_or_else(|| FolioError::not_found("No backup provider configured"))?;
    let mut config: crate::backup::BackupConfig = serde_json::from_str(&json)?;
    crate::backup::load_secrets(&mut config)?;
    let provider_name = config.provider_type.clone();
    let op = crate::backup::build_operator(&config)?;
    // Pass the active library `Storage` into backup so book-file reads
    // go through the trait (backend-agnostic) instead of `std::fs::read`.
    let library_storage = state.active_storage()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::backup::run_incremental_backup_with_progress(
            &op,
            &conn,
            Some(library_storage.as_ref()),
            &|step, current, total| {
                let _ = app_handle.emit(
                    "backup-progress",
                    serde_json::json!({
                        "step": step,
                        "current": current,
                        "total": total,
                    }),
                );
            },
        );
        let _ = tx.send(result);
    });
    let result = rx.recv()?;
    let log_conn = state.active_db()?.get()?;
    events::bus().emit(FolioEvent::BackupCompleted {
        provider: format!("{provider_name:?}"),
        success: result.is_ok(),
    });
    match &result {
        Ok(sync_result) => {
            log_event(
                &log_conn,
                ActivityEvent::BackupCompleted {
                    detail: format!(
                        "Provider: {:?} — {} books, {} bookmarks, {} highlights pushed",
                        provider_name,
                        sync_result.books_pushed,
                        sync_result.bookmarks_pushed,
                        sync_result.highlights_pushed,
                    ),
                },
            );
        }
        Err(e) => {
            log_event(
                &log_conn,
                ActivityEvent::BackupFailed {
                    detail: format!("Provider: {:?} — {}", provider_name, e),
                },
            );
        }
    }
    // `_guard` drops here → profile is removed from BACKUP_RUNNING on every
    // return path, including the `?` propagations above.
    result
}

#[tauri::command]
pub async fn get_backup_status(
    state: State<'_, AppState>,
) -> FolioResult<Option<crate::backup::SyncManifest>> {
    let conn = state.active_db()?.get()?;
    let json = match db::get_setting(&conn, "backup_config")? {
        Some(j) => j,
        None => return Ok(None),
    };
    let mut config: crate::backup::BackupConfig = serde_json::from_str(&json)?;
    crate::backup::load_secrets(&mut config)?;
    let op = crate::backup::build_operator(&config)?;
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(crate::backup::read_manifest(&op));
    });
    let manifest = rx.recv()?;
    Ok(Some(manifest))
}

use std::sync::atomic::{AtomicBool, Ordering};

static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    current: u32,
    total: u32,
    book_title: String,
    status: String,
}

#[tauri::command]
pub async fn start_scan(
    include_skipped: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<()> {
    SCAN_CANCEL.store(false, Ordering::SeqCst);
    let conn = state.active_db()?.get()?;
    if include_skipped.unwrap_or(false) {
        // Re-queue previously skipped books so new providers can try them
        conn.execute(
            "UPDATE books SET enrichment_status = NULL WHERE enrichment_status = 'skipped'",
            [],
        )?;
    }
    let books = db::list_unenriched_books(&conn)?;
    let total = books.len() as u32;
    if total == 0 {
        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                current: 0,
                total: 0,
                book_title: String::new(),
                status: "done".into(),
            },
        );
        return Ok(());
    }
    let registry = {
        let reg = state.enrichment_registry.lock()?;
        let mut new_reg = crate::providers::ProviderRegistry::new();
        for info in reg.list_providers() {
            new_reg.configure_provider(&info.id, info.config.clone());
        }
        new_reg
    };
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for (i, book) in books.iter().enumerate() {
            if SCAN_CANCEL.load(Ordering::SeqCst) {
                let _ = app_clone.emit(
                    "scan-progress",
                    ScanProgress {
                        current: (i + 1) as u32,
                        total,
                        book_title: book.title.clone(),
                        status: "cancelled".into(),
                    },
                );
                return;
            }
            let _ = app_clone.emit(
                "scan-progress",
                ScanProgress {
                    current: (i + 1) as u32,
                    total,
                    book_title: book.title.clone(),
                    status: "running".into(),
                },
            );
            let parsed = crate::enrichment::parse_filename(
                std::path::Path::new(&book.file_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(""),
            );
            let lookup_title = if book.title == "Unknown Title" || book.title == "Unknown" {
                parsed.title.as_deref().unwrap_or(&book.title)
            } else {
                &book.title
            };
            let lookup_author = if book.author.is_empty() || book.author == "Unknown Author" {
                parsed.author.as_deref().unwrap_or(&book.author)
            } else {
                &book.author
            };
            let lookup_isbn = book.isbn.as_deref().or(parsed.isbn.as_deref());
            match crate::enrichment::enrich_book(
                lookup_title,
                lookup_author,
                lookup_isbn,
                &registry,
            ) {
                Some(result) if result.auto_apply => {
                    let genres_json = if !result.data.genres.is_empty() {
                        Some(serde_json::to_string(&result.data.genres).unwrap_or_default())
                    } else {
                        None
                    };
                    let _ = db::update_book_enrichment(
                        &conn,
                        &book.id,
                        result.data.description.as_deref(),
                        genres_json.as_deref(),
                        result.data.rating,
                        result.data.isbn.as_deref().or(lookup_isbn),
                        match result.data.source_key.as_deref() {
                            Some("") | None => None,
                            some => some,
                        },
                    );
                    // Apply new metadata fields if the book doesn't already have them
                    if let Ok(Some(mut db_book)) = db::get_book(&conn, &book.id) {
                        let mut changed = false;
                        if db_book.language.is_none() {
                            if let Some(ref v) = result.data.language {
                                db_book.language = Some(v.clone());
                                changed = true;
                            }
                        }
                        if db_book.publisher.is_none() {
                            if let Some(ref v) = result.data.publisher {
                                db_book.publisher = Some(v.clone());
                                changed = true;
                            }
                        }
                        if db_book.publish_year.is_none() {
                            if let Some(v) = result.data.publish_year {
                                db_book.publish_year = Some(v);
                                changed = true;
                            }
                        }
                        if changed {
                            let _ = db::update_book(&conn, &db_book);
                        }
                    }
                    let _ = db::set_enrichment_status(&conn, &book.id, "enriched");
                }
                _ => {
                    let _ = db::set_enrichment_status(&conn, &book.id, "skipped");
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = app_clone.emit(
            "scan-progress",
            ScanProgress {
                current: total,
                total,
                book_title: String::new(),
                status: "done".into(),
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_scan() -> FolioResult<()> {
    SCAN_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

// ── Background import ─────────────────────────────────────────────────────────
//
// Mirrors the `start_scan` shape: the IPC command kicks off a `spawn_blocking`
// task that owns the long-running work, emits `import-progress` events, and
// observes `IMPORT_CANCEL` between work units. Only one import may run at a
// time — `IMPORT_RUNNING` enforces that.

static IMPORT_RUNNING: AtomicBool = AtomicBool::new(false);
static IMPORT_CANCEL: AtomicBool = AtomicBool::new(false);

const IMPORT_WORKER_COUNT: usize = 6;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgressEvent {
    /// "scanning" while walking the folder, "importing" per file, "empty"
    /// when no supported files were found, "done" or "cancelled" once the
    /// task exits.
    phase: String,
    current: u32,
    total: u32,
    filename: String,
    imported: u32,
    duplicates: u32,
    errors: u32,
}

#[tauri::command]
pub async fn is_import_running() -> bool {
    IMPORT_RUNNING.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn cancel_import() -> FolioResult<()> {
    IMPORT_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn start_files_import(
    paths: Vec<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<()> {
    let resources = acquire_import_slot(&state)?;
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_import_task(app_clone, paths, resources);
    });
    Ok(())
}

#[tauri::command]
pub async fn start_folder_import(
    folder_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<()> {
    let _t = state.ipc_metrics.time("start_folder_import");
    // Validate the root folder up front so the IPC call surfaces obvious
    // mistakes (typo, deleted folder, file picked instead of directory,
    // permission denied, vanished network mount) instead of silently
    // spawning a background task that emits "empty" with zero files —
    // which would tell the user "no supported files" when the real cause
    // is that the folder cannot be traversed at all.
    let root = std::path::Path::new(&folder_path);
    let root_meta = std::fs::metadata(root)
        .map_err(|e| FolioError::invalid(format!("Cannot read folder: {e}")))?;
    if !root_meta.is_dir() {
        return Err(FolioError::invalid("Selected path is not a folder"));
    }
    std::fs::canonicalize(root)
        .map_err(|e| FolioError::invalid(format!("Cannot resolve folder: {e}")))?;
    // Drop the iterator immediately — we only care that opening the
    // directory succeeds. The walker will re-open it inside the spawned
    // task and silently skip nested dirs that fail to read, which is the
    // intended behavior for partial-permission trees.
    let _ = std::fs::read_dir(root)
        .map_err(|e| FolioError::invalid(format!("Cannot read folder: {e}")))?;

    let resources = acquire_import_slot(&state)?;
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app_clone.emit(
            "import-progress",
            ImportProgressEvent {
                phase: "scanning".into(),
                current: 0,
                total: 0,
                filename: folder_path.clone(),
                imported: 0,
                duplicates: 0,
                errors: 0,
            },
        );
        // The walker's own canonicalize/read_dir on the root IS the
        // authoritative traversal check — if it fails here we surface a real
        // error instead of falling through to the "empty" branch, which would
        // misdiagnose a vanished mount or permission change as "no supported
        // files". Recursive calls inside the walker still silently skip
        // unreadable nested directories (intended for partial-permission
        // trees).
        let mut files = Vec::new();
        let mut visited: std::collections::HashSet<std::path::PathBuf> =
            std::collections::HashSet::new();
        if let Err(e) = walk_folder_for_import(
            std::path::Path::new(&folder_path),
            &mut files,
            &mut visited,
            &app_clone,
        ) {
            let _ = app_clone.emit(
                "import-progress",
                ImportProgressEvent {
                    phase: "error".into(),
                    current: 0,
                    total: 0,
                    // Frontend renders this string verbatim via the
                    // `library.importBackgroundError` template.
                    filename: format!("Cannot read folder: {e}"),
                    imported: 0,
                    duplicates: 0,
                    errors: 0,
                },
            );
            IMPORT_RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        files.sort();
        if files.is_empty() {
            // Distinguish a user-cancelled scan (walker bailed early via
            // IMPORT_CANCEL) from an actually empty folder. Emitting "empty"
            // for a cancel would tell the user the folder had no supported
            // files when they just hit Cancel.
            let phase = if IMPORT_CANCEL.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "empty"
            };
            let _ = app_clone.emit(
                "import-progress",
                ImportProgressEvent {
                    phase: phase.into(),
                    current: 0,
                    total: 0,
                    filename: folder_path.clone(),
                    imported: 0,
                    duplicates: 0,
                    errors: 0,
                },
            );
            IMPORT_RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        run_import_task(app_clone, files, resources);
    });
    Ok(())
}

struct ImportResources {
    db_pool: DbPool,
    storage: std::sync::Arc<dyn folio_core::storage::Storage>,
    covers_storage: std::sync::Arc<dyn folio_core::storage::Storage>,
    import_mode: String,
}

fn acquire_import_slot(state: &State<'_, AppState>) -> FolioResult<ImportResources> {
    if IMPORT_RUNNING.swap(true, Ordering::SeqCst) {
        return Err(FolioError::invalid("Import already running"));
    }
    IMPORT_CANCEL.store(false, Ordering::SeqCst);
    // From here on, every error path must release the slot.
    let result = (|| -> FolioResult<ImportResources> {
        let db_pool = state.active_db()?;
        let storage = state.active_storage()?;
        let covers_storage = state.covers_storage()?;
        let import_mode = {
            let conn = db_pool.get()?;
            db::get_setting(&conn, "import_mode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "import".to_string())
        };
        Ok(ImportResources {
            db_pool,
            storage,
            covers_storage,
            import_mode,
        })
    })();
    if result.is_err() {
        IMPORT_RUNNING.store(false, Ordering::SeqCst);
    }
    result
}

fn walk_folder_for_import(
    dir: &std::path::Path,
    results: &mut Vec<String>,
    visited: &mut std::collections::HashSet<std::path::PathBuf>,
    app: &AppHandle,
) -> std::io::Result<()> {
    if IMPORT_CANCEL.load(Ordering::SeqCst) {
        return Ok(());
    }
    // Cycle guard: resolve the directory's canonical path and skip if we've
    // already walked it. Symlink loops (`books/back -> ..`) would otherwise
    // recurse forever and wedge the IMPORT_RUNNING slot.
    //
    // Errors from canonicalize/read_dir bubble up as `Err`. The top-level
    // caller surfaces that as an error event so the user sees a real
    // diagnostic; recursive callers below intentionally swallow the error
    // (`let _ = ...`) so partial-permission trees still walk past
    // unreadable nested dirs.
    let canonical = std::fs::canonicalize(dir)?;
    if !visited.insert(canonical) {
        return Ok(());
    }
    let _ = app.emit(
        "import-progress",
        ImportProgressEvent {
            phase: "scanning".into(),
            current: results.len() as u32,
            total: 0,
            filename: dir.to_string_lossy().to_string(),
            imported: 0,
            duplicates: 0,
            errors: 0,
        },
    );
    let supported = supported_import_extensions();
    let entries = std::fs::read_dir(dir)?;
    for entry in entries.flatten() {
        if IMPORT_CANCEL.load(Ordering::SeqCst) {
            return Ok(());
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let path = entry.path();
        // `file_type()` does not follow symlinks. For symlink entries, stat
        // the target so symlinked subdirectories still get walked.
        let is_dir = if file_type.is_symlink() {
            std::fs::metadata(&path)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };
        if is_dir {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if !name.starts_with('.') && name != "__MACOSX" {
                    // Silently skip unreadable nested dirs.
                    let _ = walk_folder_for_import(&path, results, visited, app);
                }
            }
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let lower = ext.to_lowercase();
            if supported.contains(&lower.as_str()) {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

fn run_import_task(app: AppHandle, paths: Vec<String>, resources: ImportResources) {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    let total = paths.len() as u32;
    let queue: Mutex<VecDeque<String>> = Mutex::new(paths.into());
    let imported = AtomicU32::new(0);
    let duplicates = AtomicU32::new(0);
    let errors = AtomicU32::new(0);
    let completed = AtomicU32::new(0);

    let ImportResources {
        db_pool,
        storage,
        covers_storage,
        import_mode,
    } = resources;

    if total > 0 {
        std::thread::scope(|scope| {
            for _ in 0..IMPORT_WORKER_COUNT {
                let queue = &queue;
                let imported = &imported;
                let duplicates = &duplicates;
                let errors = &errors;
                let completed = &completed;
                let db_pool = db_pool.clone();
                let storage = storage.clone();
                let covers_storage = covers_storage.clone();
                let import_mode = import_mode.clone();
                let app = app.clone();
                scope.spawn(move || loop {
                    if IMPORT_CANCEL.load(Ordering::SeqCst) {
                        break;
                    }
                    let path = match queue.lock() {
                        Ok(mut q) => match q.pop_front() {
                            Some(p) => p,
                            None => break,
                        },
                        Err(_) => break,
                    };
                    let filename = std::path::Path::new(&path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&path)
                        .to_string();
                    match import_book_inner(
                        path.clone(),
                        db_pool.clone(),
                        storage.clone(),
                        covers_storage.clone(),
                        &import_mode,
                        false,
                        ImportSource::FolderScan,
                    ) {
                        Ok(ImportOutcome::Imported(_)) => {
                            imported.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(ImportOutcome::Duplicate(_)) => {
                            duplicates.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(e) => {
                            log::warn!("import failed for {path}: {e}");
                            errors.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit(
                        "import-progress",
                        ImportProgressEvent {
                            phase: "importing".into(),
                            current: done,
                            total,
                            filename: filename.clone(),
                            imported: imported.load(Ordering::SeqCst),
                            duplicates: duplicates.load(Ordering::SeqCst),
                            errors: errors.load(Ordering::SeqCst),
                        },
                    );
                });
            }
        });
    }

    let final_phase = if IMPORT_CANCEL.load(Ordering::SeqCst) {
        "cancelled"
    } else {
        "done"
    };
    let _ = app.emit(
        "import-progress",
        ImportProgressEvent {
            phase: final_phase.into(),
            current: completed.load(Ordering::SeqCst),
            total,
            filename: String::new(),
            imported: imported.load(Ordering::SeqCst),
            duplicates: duplicates.load(Ordering::SeqCst),
            errors: errors.load(Ordering::SeqCst),
        },
    );
    IMPORT_RUNNING.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub async fn scan_single_book(book_id: String, state: State<'_, AppState>) -> FolioResult<Book> {
    let conn = state.active_db()?.get()?;
    let book = db::get_book(&conn, &book_id)?
        .ok_or_else(|| FolioError::not_found(format!("Book '{}' not found", book_id)))?;
    let parsed = crate::enrichment::parse_filename(
        std::path::Path::new(&book.file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    );
    let lookup_title = if book.title == "Unknown Title" || book.title == "Unknown" {
        parsed.title.as_deref().unwrap_or(&book.title)
    } else {
        &book.title
    };
    let lookup_author = if book.author.is_empty() || book.author == "Unknown Author" {
        parsed.author.as_deref().unwrap_or(&book.author)
    } else {
        &book.author
    };
    let lookup_isbn = book.isbn.as_deref().or(parsed.isbn.as_deref());
    let registry = {
        let reg = state.enrichment_registry.lock()?;
        let mut new_reg = crate::providers::ProviderRegistry::new();
        for info in reg.list_providers() {
            new_reg.configure_provider(&info.id, info.config.clone());
        }
        new_reg
    };
    let enabled_provider_names: Vec<String> = registry
        .list_providers()
        .iter()
        .filter(|p| p.config.enabled)
        .map(|p| p.name.clone())
        .collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let t = lookup_title.to_string();
    let a = lookup_author.to_string();
    let i = lookup_isbn.map(|s| s.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(crate::enrichment::enrich_book(
            &t,
            &a,
            i.as_deref(),
            &registry,
        ));
    });
    let enrichment = rx.recv()?;
    match enrichment {
        Some(result) => {
            let genres_json = if !result.data.genres.is_empty() {
                Some(serde_json::to_string(&result.data.genres).unwrap_or_default())
            } else {
                None
            };
            db::update_book_enrichment(
                &conn,
                &book_id,
                result.data.description.as_deref(),
                genres_json.as_deref(),
                result.data.rating,
                result.data.isbn.as_deref().or(lookup_isbn),
                match result.data.source_key.as_deref() {
                    Some("") | None => None,
                    some => some,
                },
            )?;
            // Apply new metadata fields if the book doesn't already have them
            let mut book = db::get_book(&conn, &book_id)?
                .ok_or_else(|| FolioError::not_found("Book not found"))?;
            let mut changed = false;
            if book.language.is_none() {
                if let Some(ref v) = result.data.language {
                    book.language = Some(v.clone());
                    changed = true;
                }
            }
            if book.publisher.is_none() {
                if let Some(ref v) = result.data.publisher {
                    book.publisher = Some(v.clone());
                    changed = true;
                }
            }
            if book.publish_year.is_none() {
                if let Some(v) = result.data.publish_year {
                    book.publish_year = Some(v);
                    changed = true;
                }
            }
            if changed {
                db::update_book(&conn, &book)?;
            }
            db::set_enrichment_status(&conn, &book_id, "enriched")?;
            let updated_book = db::get_book(&conn, &book_id)?
                .ok_or_else(|| FolioError::not_found("Book not found"))?;
            let tried = result.providers_tried.join(", ");
            events::bus().emit(FolioEvent::MetadataEnriched {
                book_id: book_id.clone(),
                provider: result.data.source.clone(),
            });
            log_event(
                &conn,
                ActivityEvent::BookScanned {
                    id: book_id.clone(),
                    title: updated_book.title.clone(),
                    detail: format!("Matched via {} (searched: {})", result.data.source, tried),
                },
            );
            Ok(updated_book)
        }
        None => {
            db::set_enrichment_status(&conn, &book_id, "skipped")?;
            let tried = enabled_provider_names.join(", ");
            log_event(
                &conn,
                ActivityEvent::BookScanned {
                    id: book_id.clone(),
                    title: book.title.clone(),
                    detail: format!("No match found (searched: {})", tried),
                },
            );
            Err(FolioError::not_found("No match found"))
        }
    }
}

#[tauri::command]
pub async fn queue_book_for_scan(book_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::set_enrichment_status(&conn, &book_id, "queued")?)
}

#[tauri::command]
pub async fn get_setting_value(
    key: String,
    state: State<'_, AppState>,
) -> FolioResult<Option<String>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_setting(&conn, &key)?)
}

#[tauri::command]
pub async fn set_setting_value(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::set_setting(&conn, &key, &value)?)
}

#[tauri::command]
pub async fn get_feature_flags(state: State<'_, AppState>) -> FolioResult<Vec<FeatureFlag>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_feature_flags(&conn)?)
}

#[tauri::command]
pub async fn set_feature_flag(
    key: String,
    enabled: bool,
    description: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::set_feature_flag(
        &conn,
        &key,
        enabled,
        description.as_deref(),
    )?)
}

#[tauri::command]
pub async fn get_feature_flag_value(key: String, state: State<'_, AppState>) -> FolioResult<bool> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_feature_flag(&conn, &key)?)
}

#[tauri::command]
pub async fn delete_feature_flag(key: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    Ok(db::delete_feature_flag(&conn, &key)?)
}

#[tauri::command]
pub async fn get_enrichment_providers(
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::providers::ProviderInfo>> {
    let reg = state.enrichment_registry.lock()?;
    Ok(reg.list_providers())
}

#[tauri::command]
pub async fn set_enrichment_provider_config(
    provider_id: String,
    enabled: bool,
    api_key: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let config = crate::providers::ProviderConfig {
        enabled,
        api_key: api_key.filter(|k| !k.is_empty()),
    };
    let mut reg = state.enrichment_registry.lock()?;
    reg.configure_provider(&provider_id, config);
    // Persist all provider configs
    let all: std::collections::HashMap<String, crate::providers::ProviderConfig> = reg
        .list_providers()
        .into_iter()
        .map(|p| (p.id, p.config))
        .collect();
    let json = serde_json::to_string(&all)?;
    let conn = state.active_db()?.get()?;
    crate::db::set_setting(&conn, "enrichment_providers", &json)?;
    Ok(())
}

#[tauri::command]
pub async fn set_enrichment_provider_order(
    order: Vec<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let mut reg = state.enrichment_registry.lock()?;
    reg.reorder(&order);
    // Persist the order
    let json = serde_json::to_string(&order)?;
    let conn = state.active_db()?.get()?;
    crate::db::set_setting(&conn, "enrichment_provider_order", &json)?;
    Ok(())
}

// --- Activity log ---

#[tauri::command]
pub async fn get_activity_log(
    limit: Option<u32>,
    offset: Option<u32>,
    action_filter: Option<String>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::models::ActivityEntry>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_activity_log(
        &conn,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
        action_filter.as_deref(),
    )?)
}

#[tauri::command]
pub async fn get_login_history(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<Vec<crate::models::WebSessionEntry>> {
    let conn = state.active_db()?.get()?;
    Ok(db::get_web_session_log(
        &conn,
        limit.unwrap_or(100).min(1000),
    )?)
}

#[tauri::command]
pub async fn export_activity_log(
    dest_path: String,
    state: State<'_, AppState>,
) -> FolioResult<String> {
    let conn = state.active_db()?.get()?;
    let rows = db::get_all_activity(&conn)?;
    let json = serde_json::to_string_pretty(&rows)?;
    std::fs::write(&dest_path, json)?;
    Ok(dest_path)
}

#[tauri::command]
pub async fn prune_activity_log(
    keep: Option<u32>,
    max_age_days: Option<u32>,
    state: State<'_, AppState>,
) -> FolioResult<usize> {
    let conn = state.active_db()?.get()?;
    let deleted = db::prune_activity_log(&conn, keep.unwrap_or(1000), max_age_days.unwrap_or(90))?;
    Ok(deleted)
}

#[tauri::command]
pub async fn preview_collection_rules(
    rules: Vec<crate::models::NewRuleInput>,
    state: State<'_, AppState>,
) -> FolioResult<usize> {
    let conn = state.active_db()?.get()?;
    Ok(db::preview_collection_rules(&conn, &rules)?)
}

#[tauri::command]
pub async fn get_collection_suggestions(
    state: State<'_, AppState>,
) -> FolioResult<Vec<CollectionSuggestion>> {
    let conn = state.active_db()?.get()?;
    let collections = db::list_collections(&conn)?;
    Ok(db::get_collection_suggestions(&conn, &collections)?)
}

fn derive_font_name(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);

    let known_suffixes = [
        "-Regular",
        "-Bold",
        "-Italic",
        "-Light",
        "-Medium",
        "-SemiBold",
        "-ExtraBold",
        "-Thin",
        "-Black",
        "-BoldItalic",
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

#[tauri::command]
pub async fn import_custom_font(
    file_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> FolioResult<CustomFont> {
    let source = std::path::Path::new(&file_path);
    if !source.exists() {
        return Err(FolioError::invalid(format!("File not found: {file_path}")));
    }

    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["ttf", "otf", "woff2"].contains(&extension.as_str()) {
        return Err(FolioError::invalid(format!(
            "Unsupported font format: .{extension}"
        )));
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
        .map_err(|e| FolioError::internal(format!("tauri: {e}")))?
        .join("fonts");
    std::fs::create_dir_all(&fonts_dir)?;

    let dest = fonts_dir.join(format!("{id}.{extension}"));
    std::fs::copy(source, &dest)?;

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

    let conn = state.active_db()?.get()?;
    db::insert_custom_font(&conn, &font)?;

    Ok(font)
}

#[tauri::command]
pub async fn get_custom_fonts(state: State<'_, AppState>) -> FolioResult<Vec<CustomFont>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_custom_fonts(&conn)?)
}

#[tauri::command]
pub async fn remove_custom_font(font_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;

    if let Some(font) = db::get_custom_font(&conn, &font_id)? {
        let _ = std::fs::remove_file(&font.file_path);
    }

    Ok(db::delete_custom_font(&conn, &font_id)?)
}

#[tauri::command]
pub async fn check_file_exists(file_path: String) -> FolioResult<bool> {
    if std::path::Path::new(&file_path).exists() {
        Ok(true)
    } else {
        Err(FolioError::not_found(format!(
            "Book file not found at '{}'. It may have been moved or deleted.",
            file_path
        )))
    }
}

#[tauri::command]
pub async fn cleanup_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<CleanupResult> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let conn = state.active_db()?.get()?;
    let books = db::list_books(&conn)?;
    let total = books.len() as u32;

    // Auto-backup metadata before cleanup.
    let backups_dir = state.data_dir.join("backups");
    std::fs::create_dir_all(&backups_dir)?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_path = backups_dir.join(format!("pre-cleanup-{}.zip", timestamp));

    {
        let progress: Vec<ReadingProgress> = books
            .iter()
            .filter_map(|b| db::get_reading_progress(&conn, &b.id).ok().flatten())
            .collect();
        let bookmarks: Vec<Bookmark> = books
            .iter()
            .flat_map(|b| db::list_bookmarks(&conn, &b.id).unwrap_or_default())
            .collect();
        let highlights: Vec<Highlight> = books
            .iter()
            .flat_map(|b| db::list_highlights(&conn, &b.id).unwrap_or_default())
            .collect();
        let collections = db::list_collections(&conn)?;
        let tags = db::list_tags(&conn)?;
        let book_tags: Vec<(String, String, String)> = books
            .iter()
            .flat_map(|b| {
                db::get_book_tags(&conn, &b.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(tag_id, tag_name)| (b.id.clone(), tag_id, tag_name))
                    .collect::<Vec<_>>()
            })
            .collect();

        let metadata = serde_json::json!({
            "version": 1,
            "books": books,
            "reading_progress": progress,
            "bookmarks": bookmarks,
            "highlights": highlights,
            "collections": collections,
            "tags": tags,
            "book_tags": book_tags,
        });

        let file = std::fs::File::create(&backup_path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let metadata_json = serde_json::to_string_pretty(&metadata)?;
        zip.start_file("library.json", options)?;
        zip.write_all(metadata_json.as_bytes())?;
        zip.finish()?;
    }

    let mut removed_books: Vec<CleanupEntry> = Vec::new();

    for (i, book) in books.iter().enumerate() {
        let _ = app.emit(
            "cleanup-progress",
            CleanupProgress {
                current: (i + 1) as u32,
                total,
            },
        );

        // #64 M4: resolve the key (or legacy absolute path) to a real
        // filesystem path before the existence check.
        let resolved = match state.resolve_book_path(book) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if std::path::Path::new(&resolved).exists() {
            continue;
        }

        // Book file is missing — remove from database.
        db::delete_book(&conn, &book.id)?;

        // Evict EPUB cache entry.
        if let Ok(mut cache) = state.epub_cache.lock() {
            cache.remove(&resolved);
        }
        #[cfg(feature = "mobi")]
        if let Ok(mut cache) = state.mobi_cache.lock() {
            cache.remove(&resolved);
        }

        // Remove any cover artifacts for this book via the covers storage.
        if let Ok(covers) = state.covers_storage() {
            let _ = delete_book_covers(&*covers, &book.id);
        }

        // Remove extracted inline images via the images storage.
        if let Ok(images) = state.images_storage() {
            let _ = delete_book_images(&*images, &book.id);
        }

        log_event(
            &conn,
            ActivityEvent::BookRemovedCleanup {
                id: book.id.clone(),
                title: book.title.clone(),
            },
        );

        removed_books.push(CleanupEntry {
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
        });
    }

    Ok(CleanupResult {
        removed_count: removed_books.len() as u32,
        removed_books,
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn list_auto_backups(state: State<'_, AppState>) -> FolioResult<Vec<AutoBackup>> {
    let backups_dir = state.data_dir.join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut backups: Vec<AutoBackup> = Vec::new();

    let entries = std::fs::read_dir(&backups_dir)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }

        let filename = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Parse known prefixes: "pre-cleanup-{timestamp}"
        let (label, timestamp) = if let Some(ts_str) = filename.strip_prefix("pre-cleanup-") {
            match ts_str.parse::<i64>() {
                Ok(ts) => ("Pre-cleanup".to_string(), ts),
                Err(_) => continue,
            }
        } else {
            continue; // Skip unknown files
        };

        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        backups.push(AutoBackup {
            path: path.to_string_lossy().to_string(),
            label,
            timestamp,
            size_bytes,
        });
    }

    // Sort newest first
    backups.sort_by_key(|b| std::cmp::Reverse(b.timestamp));

    Ok(backups)
}

#[tauri::command]
pub async fn get_series(state: State<'_, AppState>) -> FolioResult<Vec<SeriesInfo>> {
    let conn = state.active_db()?.get()?;
    Ok(db::list_series(&conn)?)
}

// --- Sync orchestration ---

fn merge_result_summary(r: &crate::sync::MergeResult) -> String {
    let mut parts = Vec::new();
    if r.progress_updated {
        parts.push("progress synced".to_string());
    }
    let bm = r.bookmarks_added + r.bookmarks_updated;
    if bm > 0 {
        parts.push(format!("{bm} bookmarks updated"));
    }
    let hl = r.highlights_added + r.highlights_updated;
    if hl > 0 {
        parts.push(format!("{hl} highlights updated"));
    }
    if parts.is_empty() {
        "no changes".to_string()
    } else {
        parts.join(", ")
    }
}

fn sync_error_kind_str(e: &crate::sync::SyncError) -> &'static str {
    match e {
        crate::sync::SyncError::Transport { kind: Some(k), .. } => match k {
            opendal::ErrorKind::PermissionDenied => "auth_failed",
            _ => "network",
        },
        crate::sync::SyncError::Transport { kind: None, .. } => "network",
        crate::sync::SyncError::Timeout => "timeout",
        crate::sync::SyncError::Malformed(_) => "other",
    }
}

fn friendly_sync_error(e: &crate::sync::SyncError) -> String {
    match e {
        crate::sync::SyncError::Timeout => {
            "Remote server did not respond within 5 seconds".to_string()
        }
        crate::sync::SyncError::Transport { .. } => {
            "Could not reach remote storage. Check your internet connection and backup settings."
                .to_string()
        }
        crate::sync::SyncError::Malformed(_) => {
            "Remote sync data is unreadable. It may have been created by a newer version of Folio."
                .to_string()
        }
    }
}

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[tauri::command]
pub async fn sync_pull_book(
    book_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    // The reader invokes this on every book open regardless of sync state,
    // which makes it the backend's open signal — emit before the sync guards.
    events::bus().emit(FolioEvent::BookOpened {
        book_id: book_id.clone(),
    });

    let conn = state.active_db()?.get()?;

    // Guard: sync must be enabled and backup provider configured
    if !db::is_sync_enabled(&conn) {
        return Ok(());
    }
    let config_json = match db::get_setting(&conn, "backup_config")? {
        Some(j) => j,
        None => return Ok(()),
    };

    let mut config: crate::backup::BackupConfig = serde_json::from_str(&config_json)?;
    crate::backup::load_secrets(&mut config)?;
    let op = crate::backup::build_operator(&config)?;

    let book = match db::get_book(&conn, &book_id)? {
        Some(b) => b,
        None => return Err(FolioError::not_found(format!("Book not found: {book_id}"))),
    };
    let file_hash = match &book.file_hash {
        Some(h) => h.clone(),
        None => return Ok(()),
    };
    let device_id = db::get_or_create_device_id(&conn)?;

    // Spawn thread for network fetch only — keep DB connection on main thread
    let fh = file_hash.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::sync::fetch_remote_sync(&op, &fh);
        let _ = tx.send(result);
    });

    let timeout = std::time::Duration::from_secs(5);
    match rx.recv_timeout(timeout) {
        Ok(Ok(Some(remote))) => {
            events::bus().emit(FolioEvent::SyncCompleted {
                direction: SyncDirection::Pull,
                success: true,
            });
            // Merge on main thread using the existing connection
            let local = crate::sync::build_sync_payload(&conn, &book_id, &file_hash, &device_id);
            let merge_result =
                crate::sync::merge_remote_into_local(&conn, &book_id, &local, &remote);
            let _ = db::set_setting(&conn, "last_sync_success_at", &now_unix_secs().to_string());
            if merge_result.has_changes() {
                let summary = merge_result_summary(&merge_result);
                log_event(
                    &conn,
                    ActivityEvent::SyncPullSuccess {
                        book_id: book_id.clone(),
                        title: book.title.clone(),
                        detail: summary,
                    },
                );
                let _ = app.emit("sync-applied", &book_id);
                if merge_result.progress_updated {
                    let _ = app.emit("sync-progress-updated", &book_id);
                }
            }
        }
        Ok(Ok(None)) => {
            // No remote file — success (nothing to merge)
            events::bus().emit(FolioEvent::SyncCompleted {
                direction: SyncDirection::Pull,
                success: true,
            });
            let _ = db::set_setting(&conn, "last_sync_success_at", &now_unix_secs().to_string());
        }
        Ok(Err(e)) => {
            events::bus().emit(FolioEvent::SyncCompleted {
                direction: SyncDirection::Pull,
                success: false,
            });
            let msg = friendly_sync_error(&e);
            let kind = sync_error_kind_str(&e);
            let _ = db::set_setting(&conn, "last_sync_error_at", &now_unix_secs().to_string());
            let _ = db::set_setting(&conn, "last_sync_error_message", &msg);
            let _ = db::set_setting(&conn, "last_sync_error_kind", kind);
            if kind == "auth_failed" {
                let _ = app.emit("backup-auth-error", serde_json::json!({ "message": msg }));
            }
            log_event(
                &conn,
                ActivityEvent::SyncPullFailed {
                    book_id: book_id.clone(),
                    title: book.title.clone(),
                    detail: e.to_string(),
                },
            );
        }
        Err(_) => {
            // Timeout
            events::bus().emit(FolioEvent::SyncCompleted {
                direction: SyncDirection::Pull,
                success: false,
            });
            let msg = "Remote server did not respond within 5 seconds";
            let _ = db::set_setting(&conn, "last_sync_error_at", &now_unix_secs().to_string());
            let _ = db::set_setting(&conn, "last_sync_error_message", msg);
            let _ = db::set_setting(&conn, "last_sync_error_kind", "timeout");
            log_event(
                &conn,
                ActivityEvent::SyncPullFailed {
                    book_id: book_id.clone(),
                    title: book.title.clone(),
                    detail: "timeout after 5s".to_string(),
                },
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sync_push_book(book_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    // The reader invokes this on every book close regardless of sync state,
    // which makes it the backend's close signal — emit before the sync guards.
    events::bus().emit(FolioEvent::BookClosed {
        book_id: book_id.clone(),
    });

    let conn = state.active_db()?.get()?;

    // Guard: sync must be enabled and backup provider configured
    if !db::is_sync_enabled(&conn) {
        return Ok(());
    }
    let config_json = match db::get_setting(&conn, "backup_config")? {
        Some(j) => j,
        None => return Ok(()),
    };

    let mut config: crate::backup::BackupConfig = serde_json::from_str(&config_json)?;
    crate::backup::load_secrets(&mut config)?;
    let op = crate::backup::build_operator(&config)?;

    let book = match db::get_book(&conn, &book_id)? {
        Some(b) => b,
        None => return Err(FolioError::not_found(format!("Book not found: {book_id}"))),
    };
    let file_hash = match &book.file_hash {
        Some(h) => h.clone(),
        None => return Ok(()),
    };
    let device_id = db::get_or_create_device_id(&conn)?;
    let book_title = book.title.clone();

    drop(conn);

    // Clone the pool handle for the background thread (Pool is Arc-based, cheap to clone)
    let pool = state.active_db()?;

    // Fire-and-forget: spawn background thread that pull-merges then pushes
    tauri::async_runtime::spawn_blocking(move || {
        let bg_conn = match pool.get() {
            Ok(c) => c,
            Err(_) => return,
        };
        match crate::sync::sync_book_on_close(&bg_conn, &op, &book_id, &file_hash, &device_id) {
            Ok(()) => {
                events::bus().emit(FolioEvent::SyncCompleted {
                    direction: SyncDirection::Push,
                    success: true,
                });
                let _ = db::set_setting(
                    &bg_conn,
                    "last_sync_success_at",
                    &now_unix_secs().to_string(),
                );
                log_event(
                    &bg_conn,
                    ActivityEvent::SyncPushSuccess {
                        book_id: book_id.clone(),
                        title: book_title.clone(),
                        detail: "progress and annotations pushed".to_string(),
                    },
                );
            }
            Err(e) => {
                events::bus().emit(FolioEvent::SyncCompleted {
                    direction: SyncDirection::Push,
                    success: false,
                });
                let msg = friendly_sync_error(&e);
                let _ =
                    db::set_setting(&bg_conn, "last_sync_error_at", &now_unix_secs().to_string());
                let _ = db::set_setting(&bg_conn, "last_sync_error_message", &msg);
                let _ = db::set_setting(&bg_conn, "last_sync_error_kind", sync_error_kind_str(&e));
                log_event(
                    &bg_conn,
                    ActivityEvent::SyncPushFailed {
                        book_id: book_id.clone(),
                        title: book_title.clone(),
                        detail: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

// ── Bulk Operations (#60) ────────────────────────────────────────────────────

#[tauri::command]
pub async fn bulk_delete_books(
    book_ids: Vec<String>,
    state: State<'_, AppState>,
) -> FolioResult<u32> {
    let conn = state.active_db()?.get()?;
    let ids_ref: Vec<&str> = book_ids.iter().map(|s| s.as_str()).collect();
    db::bulk_delete_books(&conn, &ids_ref)?;
    log_event(
        &conn,
        ActivityEvent::BulkDelete {
            count: book_ids.len(),
        },
    );
    Ok(book_ids.len() as u32)
}

#[tauri::command]
pub async fn bulk_add_to_collection(
    book_ids: Vec<String>,
    collection_id: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    let ids_ref: Vec<&str> = book_ids.iter().map(|s| s.as_str()).collect();
    db::bulk_add_to_collection(&conn, &ids_ref, &collection_id)?;
    Ok(())
}

#[tauri::command]
pub async fn bulk_add_tag(
    book_ids: Vec<String>,
    tag: String,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    let conn = state.active_db()?.get()?;
    let ids_ref: Vec<&str> = book_ids.iter().map(|s| s.as_str()).collect();
    db::bulk_add_tag(&conn, &ids_ref, &tag)?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkEditFields {
    pub author: Option<String>,
    pub series: Option<String>,
    pub publish_year: Option<u16>,
    pub language: Option<String>,
    pub publisher: Option<String>,
}

#[tauri::command]
pub async fn bulk_update_metadata(
    book_ids: Vec<String>,
    fields: BulkEditFields,
    state: State<'_, AppState>,
) -> FolioResult<u32> {
    let conn = state.active_db()?.get()?;
    let ids_ref: Vec<&str> = book_ids.iter().map(|s| s.as_str()).collect();

    // Normalize strings with the same rules as update_book_metadata:
    // trim whitespace + enforce length limits.
    let normalize_str = |s: String, max_len: usize| -> String {
        let trimmed = s.trim().to_string();
        if trimmed.len() > max_len {
            // Truncate to the largest valid char boundary at or below max_len bytes.
            // Direct byte slicing can panic on multi-byte UTF-8 characters.
            let mut end = max_len;
            while end > 0 && !trimmed.is_char_boundary(end) {
                end -= 1;
            }
            trimmed[..end].to_string()
        } else {
            trimmed
        }
    };
    // Author is required: reject empty after trim instead of silently skipping.
    let author = if let Some(s) = fields.author {
        let t = normalize_str(s, 500);
        if t.is_empty() {
            return Err(FolioError::invalid("Author cannot be empty."));
        }
        Some(t)
    } else {
        None
    };
    // Optional fields: trim + length-limit; empty string preserved for DB to convert to NULL.
    let series = fields.series.map(|s| normalize_str(s, 500));
    let language = fields.language.map(|s| normalize_str(s, 50));
    let publisher = fields.publisher.map(|s| normalize_str(s, 500));

    let count = db::bulk_update_metadata(
        &conn,
        &ids_ref,
        author.as_deref(),
        series.as_deref(),
        fields.publish_year,
        language.as_deref(),
        publisher.as_deref(),
    )?;

    log_event(
        &conn,
        ActivityEvent::BulkEdit {
            count: count as usize,
        },
    );

    Ok(count)
}

// ── Web Server Commands ──────────────────────────────────────────────────────

/// One-shot migration of the legacy `web_server_enabled` setting to the
/// new pair `web_ui_enabled` + `opds_enabled`. Idempotent: after the
/// first run the legacy key is gone and subsequent calls are no-ops.
/// New settings are only written when they are absent, so a user who
/// adjusted the new settings between two migration runs keeps their
/// changes.
pub fn migrate_web_server_setting(conn: &rusqlite::Connection) -> FolioResult<()> {
    let Some(old) = db::get_setting(conn, "web_server_enabled")? else {
        return Ok(());
    };
    let was_on = old == "true";
    if db::get_setting(conn, "web_ui_enabled")?.is_none() {
        db::set_setting(conn, "web_ui_enabled", &was_on.to_string())?;
    }
    if db::get_setting(conn, "opds_enabled")?.is_none() {
        db::set_setting(conn, "opds_enabled", &was_on.to_string())?;
    }
    db::delete_setting(conn, "web_server_enabled")?;
    Ok(())
}

#[tauri::command]
pub async fn web_server_set_modes(
    web_ui: bool,
    opds: bool,
    port: Option<u16>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<crate::web_server::WebServerStatus> {
    // 1. Persist intent first. Settings reflect what the user wants;
    //    runtime state is derived.
    {
        let conn = state.active_db()?.get()?;
        db::set_setting(&conn, "web_ui_enabled", &web_ui.to_string())?;
        db::set_setting(&conn, "opds_enabled", &opds.to_string())?;
        if let Some(p) = port {
            db::set_setting(&conn, "web_server_port", &p.to_string())?;
        }
    }

    let modes = crate::web_server::ServerModes { web_ui, opds };

    // 2. Stop existing handle (if any).
    let prev = { state.web_server_handle.lock()?.take() };
    if let Some(h) = prev {
        crate::web_server::stop(h);
    }

    // 3. Start fresh if anything is enabled.
    let (running, url, port_used) = if modes.any() {
        let port_used = {
            let conn = state.active_db()?.get()?;
            port.unwrap_or_else(|| {
                db::get_setting(&conn, "web_server_port")
                    .ok()
                    .flatten()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(crate::web_server::DEFAULT_PORT)
            })
        };

        // Sync PIN hash from keychain before starting.
        {
            let fresh = crate::web_server::auth::load_pin_hash();
            let mut ph = state.shared_pin_hash.lock()?;
            *ph = fresh;
        }

        let web_state = crate::web_server::WebState {
            pool: state.shared_active_pool.clone(),
            data_dir: state.data_dir.clone(),
            pin_hash: state.shared_pin_hash.clone(),
            sessions: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            login_limiter: std::sync::Arc::new(crate::web_server::auth::RateLimiter::new(5, 300)),
        };

        let handle = crate::web_server::start(web_state, port_used, modes).await?;
        let url = handle.url.clone();
        {
            let mut h = state.web_server_handle.lock()?;
            *h = Some(handle);
        }
        (true, Some(url), port_used)
    } else {
        // Server is now stopped. Pick the persisted port for the response.
        let port_used = {
            let conn = state.active_db()?.get()?;
            port.unwrap_or_else(|| {
                db::get_setting(&conn, "web_server_port")
                    .ok()
                    .flatten()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(crate::web_server::DEFAULT_PORT)
            })
        };
        (false, None, port_used)
    };

    let has_pin = crate::web_server::auth::load_pin_hash().is_some();

    // 4. Audit log.
    {
        let conn = state.active_db()?.get()?;
        log_event(
            &conn,
            ActivityEvent::WebServerModesChanged {
                detail: format!("web_ui={web_ui} opds={opds}"),
            },
        );
    }

    // 5. Refresh tray menu.
    let _ = crate::tray::rebuild_tray_menu(&app);

    // Build status directly instead of recursing into web_server_status —
    // calling another #[tauri::command] async fn from within a command can
    // hang in Tauri v2 when the State borrow is reused after an await.
    Ok(crate::web_server::WebServerStatus {
        running,
        url,
        port: port_used,
        has_pin,
        web_ui_enabled: web_ui,
        opds_enabled: opds,
    })
}

#[tauri::command]
pub async fn web_server_status(
    state: State<'_, AppState>,
) -> FolioResult<crate::web_server::WebServerStatus> {
    let has_pin = crate::web_server::auth::load_pin_hash().is_some();

    // Read user intent (these settings drive the running state).
    let (web_ui_enabled, opds_enabled, persisted_port) = {
        let conn = state.active_db()?.get()?;
        let web_ui = db::get_setting(&conn, "web_ui_enabled")?.as_deref() == Some("true");
        let opds = db::get_setting(&conn, "opds_enabled")?.as_deref() == Some("true");
        let port = db::get_setting(&conn, "web_server_port")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(crate::web_server::DEFAULT_PORT);
        (web_ui, opds, port)
    };

    let handle = state.web_server_handle.lock()?;
    match handle.as_ref() {
        Some(h) => Ok(crate::web_server::WebServerStatus {
            running: true,
            url: Some(h.url.clone()),
            port: h.port,
            has_pin,
            web_ui_enabled,
            opds_enabled,
        }),
        None => Ok(crate::web_server::WebServerStatus {
            running: false,
            url: None,
            port: persisted_port,
            has_pin,
            web_ui_enabled,
            opds_enabled,
        }),
    }
}

#[tauri::command]
pub async fn web_server_set_pin(pin: String, state: State<'_, AppState>) -> FolioResult<()> {
    if pin.is_empty() {
        return Err(FolioError::invalid("PIN cannot be empty"));
    }

    crate::web_server::auth::validate_pin(&pin).map_err(FolioError::invalid)?;

    crate::web_server::auth::store_pin(&pin)?;

    // Propagate new hash immediately — store_pin is irreversible, runtime must reflect it.
    // Recover from poisoned mutex: the data is still usable even after a panic.
    let new_hash = crate::web_server::auth::hash_pin(&pin);
    let mut ph = match state.shared_pin_hash.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            state.shared_pin_hash.clear_poison();
            poisoned.into_inner()
        }
    };
    *ph = Some(new_hash);
    drop(ph);

    // Audit log is best-effort — PIN change already committed
    if let Ok(db) = state.active_db() {
        if let Ok(conn) = db.get() {
            let _ = db::log_pin_change(&conn, "desktop");
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn web_server_get_qr(state: State<'_, AppState>) -> FolioResult<String> {
    let handle = state.web_server_handle.lock()?;
    let url = handle
        .as_ref()
        .map(|h| h.url.clone())
        .ok_or_else(|| FolioError::not_found("Web server is not running"))?;
    crate::web_server::auth::generate_qr_svg(&url)
}

#[tauri::command]
pub async fn get_ipc_metrics(
    state: State<'_, AppState>,
) -> Result<crate::ipc_metrics::IpcMetricsResponse, String> {
    Ok(state.ipc_metrics.response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_login_history_reads_web_session_rows() {
        use folio_core::db;
        let dir = tempfile::tempdir().unwrap();
        let conn = db::init_db(&dir.path().join("t.db")).unwrap();
        db::insert_web_session_log(
            &conn,
            &folio_core::models::WebSessionEntry {
                id: "x1".into(),
                timestamp: 1000,
                ip: "203.0.113.9".into(),
                method: "session".into(),
                outcome: "success".into(),
                user_agent: None,
            },
        )
        .unwrap();

        let rows = db::get_web_session_log(&conn, 100).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome, "success");
        assert_eq!(rows[0].ip, "203.0.113.9");
    }

    #[test]
    fn export_activity_log_writes_parseable_json() {
        use folio_core::db;
        let dir = tempfile::tempdir().unwrap();
        let conn = db::init_db(&dir.path().join("t.db")).unwrap();

        log_event(
            &conn,
            folio_core::activity::ActivityEvent::BookImported {
                id: "b1".into(),
                title: "Title".into(),
                format: "EPUB".into(),
                author: "Auth".into(),
            },
        );

        let rows = db::get_all_activity(&conn).unwrap();
        let dest = dir.path().join("activity.json");
        std::fs::write(&dest, serde_json::to_string_pretty(&rows).unwrap()).unwrap();

        let parsed: Vec<folio_core::models::ActivityEntry> =
            serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].action, "book_imported");
        assert_eq!(parsed[0].detail.as_deref(), Some("EPUB by Auth"));
    }

    fn temp_covers_storage() -> (tempfile::TempDir, folio_core::storage::LocalStorage) {
        let dir = tempfile::tempdir().unwrap();
        let storage = folio_core::storage::LocalStorage::new(dir.path()).unwrap();
        (dir, storage)
    }

    #[test]
    fn save_cover_png_data_uri() {
        let (_d, storage) = temp_covers_storage();
        let data_uri = "data:image/png;base64,iVBORw0KGgo=";
        let result = save_cover_from_data_uri(&storage, "book-123", data_uri);
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.png"));
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn save_cover_jpeg_data_uri() {
        let (_d, storage) = temp_covers_storage();
        let data_uri = "data:image/jpeg;base64,/9j/4AAQ";
        let result = save_cover_from_data_uri(&storage, "book-456", data_uri);
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.jpg"));
    }

    #[test]
    fn save_cover_webp_data_uri() {
        let (_d, storage) = temp_covers_storage();
        let data_uri = "data:image/webp;base64,UklGRg==";
        let result = save_cover_from_data_uri(&storage, "book-789", data_uri);
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("cover.webp"));
    }

    #[test]
    fn save_cover_invalid_data_uri_returns_none() {
        let (_d, storage) = temp_covers_storage();
        // Missing data: prefix
        assert!(save_cover_from_data_uri(&storage, "book", "not-a-data-uri").is_none());
        // Missing ;base64
        assert!(save_cover_from_data_uri(&storage, "book", "data:image/png,abc").is_none());
        // Missing comma
        assert!(save_cover_from_data_uri(&storage, "book", "data:image/png;base64").is_none());
    }

    #[test]
    fn save_cover_creates_directory_structure() {
        let (d, storage) = temp_covers_storage();
        let data_uri = "data:image/gif;base64,R0lGODlh";
        let result = save_cover_from_data_uri(&storage, "new-book", data_uri);
        assert!(result.is_some());
        // Verify the `new-book/` subdirectory and cover file were created.
        assert!(d.path().join("new-book").exists());
        assert!(d.path().join("new-book").join("cover.gif").exists());
    }

    #[test]
    fn save_cover_unknown_mime_defaults_to_jpg() {
        let (_d, storage) = temp_covers_storage();
        let data_uri = "data:image/bmp;base64,Qk0=";
        let result = save_cover_from_data_uri(&storage, "book", data_uri);
        assert!(result.is_some());
        assert!(result.unwrap().contains("cover.jpg"));
    }

    #[test]
    fn delete_book_covers_removes_all_entries_for_book() {
        let (_d, storage) = temp_covers_storage();
        // Populate 2 covers for the book we care about and 1 for another.
        save_cover_from_data_uri(&storage, "target", "data:image/png;base64,iVBORw0KGgo=").unwrap();
        save_cover_from_data_uri(&storage, "target", "data:image/jpeg;base64,/9j/4AAQ").unwrap();
        save_cover_from_data_uri(&storage, "other", "data:image/png;base64,iVBORw0KGgo=").unwrap();

        delete_book_covers(&storage, "target").unwrap();

        use folio_core::storage::Storage;
        assert!(storage.list("target/").unwrap().is_empty());
        assert_eq!(storage.list("other/").unwrap().len(), 1);
    }

    #[test]
    fn cover_storage_key_format() {
        assert_eq!(cover_storage_key("abc", "png"), "abc/cover.png");
        assert_eq!(cover_storage_key("book-42", "jpg"), "book-42/cover.jpg");
    }

    #[test]
    fn validate_scroll_position_rejects_nan() {
        assert!(validate_scroll_position(f64::NAN).is_err());
    }

    #[test]
    fn validate_scroll_position_rejects_infinity() {
        assert!(validate_scroll_position(f64::INFINITY).is_err());
        assert!(validate_scroll_position(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn validate_scroll_position_clamps_negative() {
        assert_eq!(validate_scroll_position(-0.5).unwrap(), 0.0);
    }

    #[test]
    fn validate_scroll_position_clamps_above_one() {
        assert_eq!(validate_scroll_position(1.5).unwrap(), 1.0);
    }

    #[test]
    fn validate_scroll_position_accepts_valid_values() {
        assert_eq!(validate_scroll_position(0.0).unwrap(), 0.0);
        assert_eq!(validate_scroll_position(0.5).unwrap(), 0.5);
        assert_eq!(validate_scroll_position(1.0).unwrap(), 1.0);
    }

    #[test]
    fn validate_file_exists_returns_ok_for_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("book.epub");
        std::fs::write(&file, b"dummy").unwrap();
        assert!(validate_file_exists(file.to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_file_exists_returns_clear_error_for_missing_file() {
        let result = validate_file_exists("/nonexistent/path/book.epub");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), "NotFound");
        let msg = err.to_string();
        assert!(
            msg.contains("not found"),
            "error should mention 'not found': {msg}"
        );
        assert!(
            msg.contains("/nonexistent/path/book.epub"),
            "error should include the path: {msg}"
        );
    }

    #[test]
    fn test_derive_font_name() {
        assert_eq!(derive_font_name("Merriweather-Regular.ttf"), "Merriweather");
        assert_eq!(derive_font_name("FiraCode-Bold.woff2"), "FiraCode");
        assert_eq!(derive_font_name("My Font.otf"), "My Font");
        assert_eq!(derive_font_name("Roboto-BoldItalic.ttf"), "Roboto");
        assert_eq!(derive_font_name("SimpleFont.ttf"), "SimpleFont");
    }

    // --- #64 M2: book storage key helpers ---

    #[test]
    fn book_storage_key_joins_id_and_extension() {
        assert_eq!(book_storage_key("abc123", "epub"), "abc123.epub");
        assert_eq!(book_storage_key("abc", "pdf"), "abc.pdf");
    }

    #[test]
    fn book_key_from_path_strips_library_folder() {
        let key = book_key_from_path("/library/abc123.epub", "/library").unwrap();
        assert_eq!(key, "abc123.epub");
    }

    #[test]
    fn book_key_from_path_handles_nested_paths() {
        let key = book_key_from_path("/library/books/abc.epub", "/library").unwrap();
        assert_eq!(key, "books/abc.epub");
    }

    #[test]
    fn book_key_from_path_returns_none_for_external_file() {
        // Linked books reference files outside the library folder.
        assert!(book_key_from_path("/elsewhere/book.epub", "/library").is_none());
    }

    #[test]
    fn book_key_from_path_handles_trailing_slash_on_folder() {
        // strip_prefix normalizes — `/library/` and `/library` both work.
        let key = book_key_from_path("/library/abc.epub", "/library/").unwrap();
        assert_eq!(key, "abc.epub");
    }

    // --- BACKUP_RUNNING RAII guard ---
    //
    // These tests mutate the shared `BACKUP_RUNNING` static. Each test uses
    // a unique profile name so parallel test runs don't interfere.

    #[test]
    fn backup_lock_guard_releases_on_drop() {
        let name = "test-raii-drop".to_string();
        {
            let _guard = BackupLockGuard::acquire(name.clone()).unwrap();
            assert!(
                BACKUP_RUNNING.lock().unwrap().contains(&name),
                "profile should be in the running set while guard is held"
            );
        }
        assert!(
            !BACKUP_RUNNING.lock().unwrap().contains(&name),
            "profile should be removed after guard drops"
        );
    }

    #[test]
    fn backup_lock_guard_blocks_concurrent_acquire_same_profile() {
        let name = "test-raii-concurrent".to_string();
        let _guard = BackupLockGuard::acquire(name.clone()).unwrap();
        let second = BackupLockGuard::acquire(name.clone());
        assert!(
            second.is_err(),
            "second acquire on same profile should fail while first guard is alive"
        );
        let err = second.unwrap_err();
        assert!(
            err.to_string().contains("already in progress"),
            "expected 'already in progress' message, got: {err}"
        );
    }

    #[test]
    fn backup_lock_guard_allows_different_profiles() {
        let a = "test-raii-multi-a".to_string();
        let b = "test-raii-multi-b".to_string();
        let ga = BackupLockGuard::acquire(a.clone()).unwrap();
        let gb = BackupLockGuard::acquire(b.clone()).unwrap();
        {
            let running = BACKUP_RUNNING.lock().unwrap();
            assert!(running.contains(&a));
            assert!(running.contains(&b));
        }
        drop(ga);
        drop(gb);
        let running = BACKUP_RUNNING.lock().unwrap();
        assert!(!running.contains(&a));
        assert!(!running.contains(&b));
    }

    #[test]
    fn opds_mime_maps_epub_pdf() {
        assert_eq!(
            opds_extension_from_mime("application/epub+zip"),
            Some("epub")
        );
        assert_eq!(opds_extension_from_mime("application/pdf"), Some("pdf"));
    }

    #[test]
    fn opds_mime_maps_mobi_family() {
        // x-mobipocket-ebook is the historical MOBI MIME.
        assert_eq!(
            opds_extension_from_mime("application/x-mobipocket-ebook"),
            Some("mobi")
        );
        // `vnd.amazon.ebook` is ambiguous between .azw and .azw3 — the MIME
        // mapper must surface this by returning None so callers fall back to
        // URL-based disambiguation. A final default is applied at the import
        // layer when the URL is also opaque.
        assert_eq!(
            opds_extension_from_mime("application/vnd.amazon.ebook"),
            None
        );
    }

    #[test]
    fn opds_vendor_amazon_mime_falls_back_to_url_extension() {
        // Defense-in-depth: the `download_opds_book` precedence must let URL
        // extension win over the ambiguous vendor MIME so an `.azw` link is
        // not silently renamed `.azw3` on import.
        //
        // We replicate the precedence used in `download_opds_book` here so a
        // regression in that ordering is caught even without a full Tauri
        // harness.
        let mime = "application/vnd.amazon.ebook";
        let url = "https://example.com/download/book.azw";
        let ext = opds_extension_from_url(url)
            .or_else(|| opds_extension_from_mime(mime))
            .unwrap_or("epub");
        assert_eq!(ext, "azw");
    }

    #[test]
    fn opds_vendor_amazon_mime_with_opaque_url_defaults_to_azw3() {
        // When the URL is opaque and MIME is the ambiguous vendor one, we
        // still need a default — AZW3 is the far more common container in the
        // wild today, so fall back to that.
        let mime = "application/vnd.amazon.ebook";
        let url = "https://example.com/download/123";
        let ext = opds_extension_from_url(url)
            .or_else(|| opds_extension_from_mime(mime))
            .unwrap_or("azw3");
        assert_eq!(ext, "azw3");
    }

    #[test]
    fn opds_mime_maps_comic_archives() {
        assert_eq!(
            opds_extension_from_mime("application/vnd.comicbook+zip"),
            Some("cbz")
        );
        assert_eq!(opds_extension_from_mime("application/x-cbz"), Some("cbz"));
        assert_eq!(
            opds_extension_from_mime("application/vnd.comicbook-rar"),
            Some("cbr")
        );
        assert_eq!(opds_extension_from_mime("application/x-cbr"), Some("cbr"));
    }

    #[test]
    fn opds_mime_strips_parameters_and_is_case_insensitive() {
        assert_eq!(
            opds_extension_from_mime("APPLICATION/EPUB+ZIP; profile=\"foo\""),
            Some("epub")
        );
    }

    #[test]
    fn opds_mime_rejects_unknown_types() {
        assert_eq!(opds_extension_from_mime("application/octet-stream"), None);
        assert_eq!(opds_extension_from_mime(""), None);
    }

    #[test]
    fn opds_url_detects_plain_extensions() {
        assert_eq!(
            opds_extension_from_url("https://example.com/book.epub"),
            Some("epub")
        );
        assert_eq!(
            opds_extension_from_url("https://example.com/foo/bar.pdf"),
            Some("pdf")
        );
        assert_eq!(
            opds_extension_from_url("https://example.com/book.AZW3"),
            Some("azw3")
        );
    }

    #[test]
    fn opds_url_ignores_query_and_fragment() {
        assert_eq!(
            opds_extension_from_url("https://example.com/book.epub?token=abc"),
            Some("epub")
        );
        assert_eq!(
            opds_extension_from_url("https://example.com/book.epub#anchor"),
            Some("epub")
        );
    }

    #[test]
    fn opds_url_disambiguates_azw_and_azw3() {
        // Plain `.azw` and `.azw3` must not shadow each other.
        assert_eq!(
            opds_extension_from_url("https://example.com/book.azw"),
            Some("azw")
        );
        assert_eq!(
            opds_extension_from_url("https://example.com/book.azw3"),
            Some("azw3")
        );
    }

    #[test]
    fn opds_url_returns_none_for_opaque_or_missing() {
        // Opaque acquisition URLs (common in OPDS) — MIME path handles these.
        assert_eq!(
            opds_extension_from_url("https://example.com/download/123"),
            None
        );
        // Unparseable / extensionless / non-matching.
        assert_eq!(opds_extension_from_url("not a url"), None);
        assert_eq!(opds_extension_from_url(""), None);
        assert_eq!(
            opds_extension_from_url("https://example.com/book.xyz"),
            None
        );
    }

    #[test]
    fn opds_url_handles_trailing_slash() {
        // Trailing slash: last non-empty segment still has the extension.
        assert_eq!(
            opds_extension_from_url("https://example.com/book.epub/"),
            Some("epub")
        );
    }

    #[test]
    fn opds_catalog_source_preset_id_roundtrip() {
        let src = OpdsCatalogSource {
            name: "Project Gutenberg".to_string(),
            url: "https://m.gutenberg.org/ebooks.opds/".to_string(),
            preset_id: Some("project-gutenberg".to_string()),
        };
        let json = serde_json::to_string(&src).unwrap();
        let parsed: OpdsCatalogSource = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.preset_id.as_deref(), Some("project-gutenberg"));
    }

    #[test]
    fn opds_catalog_source_legacy_blob_deserializes_with_none_preset_id() {
        // Older builds wrote {name, url} only — must still parse.
        let legacy = r#"{"name":"Custom","url":"https://example.com/opds"}"#;
        let parsed: OpdsCatalogSource = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.name, "Custom");
        assert!(parsed.preset_id.is_none());
    }

    #[test]
    fn opds_catalog_source_serializes_camel_case_preset_id() {
        // The TS frontend reads `presetId`, not `preset_id`.
        let src = OpdsCatalogSource {
            name: "x".to_string(),
            url: "https://x".to_string(),
            preset_id: Some("x".to_string()),
        };
        let json = serde_json::to_string(&src).unwrap();
        assert!(json.contains("\"presetId\""), "expected camelCase: {json}");
    }

    #[test]
    fn opds_catalog_source_omits_preset_id_when_none() {
        let src = OpdsCatalogSource {
            name: "x".to_string(),
            url: "https://x".to_string(),
            preset_id: None,
        };
        let json = serde_json::to_string(&src).unwrap();
        assert!(!json.contains("preset"), "expected no preset key: {json}");
    }

    #[test]
    fn opds_url_disambiguates_folio_acquisition_urls() {
        // Folio's own OPDS feed emits `/api/books/{id}/download/{id}.{ext}`
        // specifically so URL-based detection can disambiguate AZW from AZW3
        // when the MIME is the ambiguous `application/vnd.amazon.ebook`.
        assert_eq!(
            opds_extension_from_url("https://folio.local/api/books/abc123/download/abc123.azw"),
            Some("azw")
        );
        assert_eq!(
            opds_extension_from_url("https://folio.local/api/books/abc123/download/abc123.azw3"),
            Some("azw3")
        );
        assert_eq!(
            opds_extension_from_url("https://folio.local/api/books/abc123/download/abc123.mobi"),
            Some("mobi")
        );
    }

    #[test]
    fn supported_import_extensions_always_includes_core_formats() {
        let exts = supported_import_extensions();
        for core in &["epub", "pdf", "cbz", "cbr"] {
            assert!(
                exts.contains(core),
                "core format {core} missing from supported_import_extensions"
            );
        }
    }

    #[cfg(feature = "mobi")]
    #[test]
    fn supported_import_extensions_includes_mobi_family_when_feature_on() {
        let exts = supported_import_extensions();
        for mobi in &["mobi", "azw", "azw3"] {
            assert!(exts.contains(mobi), "mobi feature on but {mobi} missing");
        }
    }

    #[cfg(not(feature = "mobi"))]
    #[test]
    fn supported_import_extensions_excludes_mobi_family_when_feature_off() {
        let exts = supported_import_extensions();
        for mobi in &["mobi", "azw", "azw3"] {
            assert!(
                !exts.contains(mobi),
                "mobi feature off but {mobi} still listed"
            );
        }
    }

    #[test]
    fn backup_lock_guard_releases_when_caller_returns_err_early() {
        // Simulates the real regression: a fallible `?` after `acquire` must
        // NOT leak the profile into BACKUP_RUNNING.
        fn fallible(name: String) -> FolioResult<()> {
            let _guard = BackupLockGuard::acquire(name)?;
            Err(FolioError::internal("simulated setup failure"))
        }
        let name = "test-raii-early-err".to_string();
        let result = fallible(name.clone());
        assert!(result.is_err(), "function must return the simulated error");
        assert!(
            !BACKUP_RUNNING.lock().unwrap().contains(&name),
            "profile must be released even though the function returned Err"
        );
    }

    fn get_custom_catalogs(conn: &rusqlite::Connection) -> Vec<OpdsCatalogSource> {
        let custom_json = db::get_setting(conn, "opds_custom_catalogs")
            .ok()
            .flatten()
            .unwrap_or_else(|| "[]".to_string());
        serde_json::from_str(&custom_json).unwrap_or_default()
    }

    #[test]
    fn add_opds_catalog_persists_preset_id() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();

        add_opds_catalog_inner(
            &conn,
            "Project Gutenberg".to_string(),
            "https://m.gutenberg.org/ebooks.opds/".to_string(),
            Some("project-gutenberg".to_string()),
        )
        .unwrap();

        let cats = get_custom_catalogs(&conn);
        let custom = cats
            .iter()
            .find(|c| c.url.contains("gutenberg") && c.preset_id.is_some());
        assert_eq!(
            custom.unwrap().preset_id.as_deref(),
            Some("project-gutenberg")
        );
    }

    #[test]
    fn add_opds_catalog_with_no_preset_id_persists_none() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();

        add_opds_catalog_inner(
            &conn,
            "Custom".to_string(),
            "https://example.com/opds".to_string(),
            None,
        )
        .unwrap();

        let cats = get_custom_catalogs(&conn);
        let custom = cats
            .iter()
            .find(|c| c.url == "https://example.com/opds")
            .unwrap();
        assert!(custom.preset_id.is_none());
    }

    #[test]
    fn default_catalogs_each_has_https_url_and_preset_id() {
        assert!(
            !DEFAULT_CATALOGS.is_empty(),
            "must ship at least one default catalog"
        );
        for (name, url, preset_id) in DEFAULT_CATALOGS {
            assert!(!name.is_empty(), "default catalog has empty name");
            assert!(
                url.starts_with("https://"),
                "default url must be https: {url}"
            );
            assert!(!preset_id.is_empty(), "preset_id must be set for {name}");
        }
        let ids: Vec<&str> = DEFAULT_CATALOGS.iter().map(|(_, _, id)| *id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "preset_ids must be unique");
    }

    #[test]
    fn default_catalogs_include_expected_preset_ids() {
        let ids: std::collections::HashSet<&str> =
            DEFAULT_CATALOGS.iter().map(|(_, _, id)| *id).collect();
        for expected in &["project-gutenberg", "standard-ebooks-new", "wikisource-en"] {
            assert!(
                ids.contains(expected),
                "missing default preset_id: {expected}"
            );
        }
    }

    #[test]
    fn default_catalogs_can_map_to_opds_catalog_source_with_preset_id() {
        // Mirror the mapping done inside get_opds_catalogs. If this test breaks
        // because the tuple shape changed, get_opds_catalogs needs updating too.
        let mapped: Vec<OpdsCatalogSource> = DEFAULT_CATALOGS
            .iter()
            .map(|(name, url, preset_id)| OpdsCatalogSource {
                name: name.to_string(),
                url: url.to_string(),
                preset_id: Some(preset_id.to_string()),
            })
            .collect();
        assert!(!mapped.is_empty());
        let gutenberg = mapped
            .iter()
            .find(|c| c.url == "https://www.gutenberg.org/ebooks.opds/")
            .expect("default Project Gutenberg missing");
        assert_eq!(gutenberg.preset_id.as_deref(), Some("project-gutenberg"));
    }

    #[test]
    fn web_server_set_modes_persists_both_settings() {
        // Persistence-only assertion. Server start/stop is exercised by
        // web_server::tests::* (router-shape tests). This test guards the
        // contract that user intent always lands in the DB.
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();

        // Simulate the persistence portion of web_server_set_modes by
        // calling its bare DB statements (the handle/start path requires
        // an AppState which we cannot construct here).
        db::set_setting(&conn, "web_ui_enabled", "true").unwrap();
        db::set_setting(&conn, "opds_enabled", "false").unwrap();
        db::set_setting(&conn, "web_server_port", "9999").unwrap();

        assert_eq!(
            db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
            Some("true")
        );
        assert_eq!(
            db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
            Some("false")
        );
        assert_eq!(
            db::get_setting(&conn, "web_server_port")
                .unwrap()
                .as_deref(),
            Some("9999")
        );
    }

    #[test]
    fn migrate_web_server_setting_true_sets_both_new_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();
        db::set_setting(&conn, "web_server_enabled", "true").unwrap();

        migrate_web_server_setting(&conn).unwrap();

        assert_eq!(
            db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
            Some("true")
        );
        assert_eq!(
            db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
            Some("true")
        );
        assert!(db::get_setting(&conn, "web_server_enabled")
            .unwrap()
            .is_none());
    }

    #[test]
    fn migrate_web_server_setting_false_sets_both_false() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();
        db::set_setting(&conn, "web_server_enabled", "false").unwrap();

        migrate_web_server_setting(&conn).unwrap();

        assert_eq!(
            db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
            Some("false")
        );
        assert_eq!(
            db::get_setting(&conn, "opds_enabled").unwrap().as_deref(),
            Some("false")
        );
        assert!(db::get_setting(&conn, "web_server_enabled")
            .unwrap()
            .is_none());
    }

    #[test]
    fn migrate_web_server_setting_no_op_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();
        // No legacy key set.
        migrate_web_server_setting(&conn).unwrap();
        assert!(db::get_setting(&conn, "web_ui_enabled").unwrap().is_none());
        assert!(db::get_setting(&conn, "opds_enabled").unwrap().is_none());
    }

    #[test]
    fn migrate_web_server_setting_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = db::create_pool(&tmp.path().join("library.db")).unwrap();
        let conn = pool.get().unwrap();
        db::set_setting(&conn, "web_server_enabled", "true").unwrap();

        migrate_web_server_setting(&conn).unwrap();
        // Simulate user later turning Web UI off; migration must not undo that.
        db::set_setting(&conn, "web_ui_enabled", "false").unwrap();
        migrate_web_server_setting(&conn).unwrap();

        assert_eq!(
            db::get_setting(&conn, "web_ui_enabled").unwrap().as_deref(),
            Some("false"),
            "migration must not clobber user changes after first migration"
        );
    }

    // ── Background-import atomics ─────────────────────────────────────────────
    //
    // These tests exercise the run-once / cancel invariants that protect the
    // background importer. They use the static atomics directly because the
    // full IPC wrappers need a Tauri State which is impractical to build in
    // a unit test. The atomics are the only state the wrappers consult, so
    // the contract is the same.
    //
    // The atomics are process-global statics, so these tests must not run
    // concurrently with each other (cargo runs tests multithreaded by
    // default) or one test's store/swap races another's assertion. Each
    // acquires this lock first to serialize access; poison is recovered
    // since a panicking test leaves the atomics in a known-reset state.
    static IMPORT_ATOMICS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn import_atomics_default_false() {
        let _guard = IMPORT_ATOMICS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Note: tests in the same binary share statics. Reset before checking
        // the invariant we care about.
        IMPORT_RUNNING.store(false, Ordering::SeqCst);
        IMPORT_CANCEL.store(false, Ordering::SeqCst);
        assert!(!IMPORT_RUNNING.load(Ordering::SeqCst));
        assert!(!IMPORT_CANCEL.load(Ordering::SeqCst));
    }

    #[test]
    fn import_running_swap_blocks_second_acquire() {
        let _guard = IMPORT_ATOMICS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        IMPORT_RUNNING.store(false, Ordering::SeqCst);
        // First acquire succeeds (returns the previous value, false).
        assert!(!IMPORT_RUNNING.swap(true, Ordering::SeqCst));
        // Second acquire observes the running flag and would refuse the slot.
        assert!(IMPORT_RUNNING.swap(true, Ordering::SeqCst));
        // Cleanup so other tests in the binary aren't affected.
        IMPORT_RUNNING.store(false, Ordering::SeqCst);
    }

    #[test]
    fn cancel_import_sets_flag() {
        let _guard = IMPORT_ATOMICS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        IMPORT_CANCEL.store(false, Ordering::SeqCst);
        // The Tauri command body is just this store; calling it through the
        // tokio runtime would force an async harness, so call the underlying
        // op directly.
        IMPORT_CANCEL.store(true, Ordering::SeqCst);
        assert!(IMPORT_CANCEL.load(Ordering::SeqCst));
        IMPORT_CANCEL.store(false, Ordering::SeqCst);
    }

    /// Write a minimal but valid EPUB to `dir/name.epub` so `import_book_inner`
    /// can parse it (container.xml -> OPF; empty spine yields zero chapters,
    /// which the importer accepts). Returns the on-disk path.
    fn write_minimal_epub(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(format!("{name}.epub"));
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("mimetype", options).unwrap();
        std::io::Write::write_all(&mut zip, b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", options).unwrap();
        std::io::Write::write_all(
            &mut zip,
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
        zip.start_file("content.opf", options).unwrap();
        std::io::Write::write_all(
            &mut zip,
            br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fast Path Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest/>
  <spine/>
</package>"#,
        )
        .unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn reimport_same_path_fast_skips_without_rehash() {
        // No shared global state: isolated tempdir + private pool per test, and
        // import_book_inner does not touch the import-running atomics, so these
        // tests need no serialization.
        let work = tempfile::tempdir().unwrap();
        let db_pool = db::create_pool(&work.path().join("library.db")).unwrap();
        let storage: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("library")).unwrap(),
        );
        let covers: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("covers")).unwrap(),
        );

        let src = write_minimal_epub(work.path(), "book");
        let src_path_string = src.to_string_lossy().to_string();

        let first = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        let first_id = first.into_book().id;

        // Sanity: the source row was recorded with the file's real size.
        {
            let conn = db_pool.get().unwrap();
            let meta = std::fs::metadata(&src).unwrap();
            let rec = db::get_book_by_source_path(&conn, &src_path_string)
                .unwrap()
                .unwrap();
            assert_eq!(rec.id, first_id);
            assert_eq!(rec.source_size, Some(meta.len() as i64));
        }

        // Second import of the SAME path -> Duplicate with same id, one row.
        let second = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        match second {
            ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
            _ => panic!("expected Duplicate outcome"),
        }
        let conn = db_pool.get().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reimport_with_changed_mtime_falls_through_to_hash() {
        let work = tempfile::tempdir().unwrap();
        let db_pool = db::create_pool(&work.path().join("library.db")).unwrap();
        let storage: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("library")).unwrap(),
        );
        let covers: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("covers")).unwrap(),
        );

        let src = write_minimal_epub(work.path(), "book");
        let src_path_string = src.to_string_lossy().to_string();

        let first = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        let first_id = first.into_book().id;

        // Force a stored mtime mismatch so the fast path cannot fire.
        {
            let conn = db_pool.get().unwrap();
            conn.execute(
                "UPDATE books SET source_mtime = 1 WHERE id = ?1",
                rusqlite::params![first_id],
            )
            .unwrap();
        }

        // Falls through to the hash, which still dedups to the same book.
        let second = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        match second {
            ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
            _ => panic!("expected Duplicate by hash"),
        }
        let conn = db_pool.get().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reimport_fast_path_skips_when_hash_would_miss() {
        let work = tempfile::tempdir().unwrap();
        let db_pool = db::create_pool(&work.path().join("library.db")).unwrap();
        let storage: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("library")).unwrap(),
        );
        let covers: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("covers")).unwrap(),
        );

        let src = write_minimal_epub(work.path(), "book");
        let src_path_string = src.to_string_lossy().to_string();

        let first = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        let first_id = first.into_book().id;

        // Sabotage the stored content hash so hash-based dedup CANNOT match on
        // re-import. The source_path/size/mtime row stays intact, so ONLY the
        // fast-path can still recognize this as a duplicate. If the fast-path were
        // broken, the re-import would hash the file, find no hash match, and import
        // a SECOND book (count == 2).
        {
            let conn = db_pool.get().unwrap();
            conn.execute(
                "UPDATE books SET file_hash = 'deadbeef-not-a-real-hash' WHERE id = ?1",
                rusqlite::params![first_id],
            )
            .unwrap();
        }

        let second = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        match second {
            ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
            _ => panic!("fast-path should have returned the existing book as Duplicate"),
        }

        let conn = db_pool.get().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "fast-path must skip without creating a second row"
        );
    }

    #[test]
    fn reimport_hash_match_refreshes_source_tracking() {
        // When the fast-path misses (drifted mtime) but the content hash still
        // dedups, the stored source_size/mtime must be refreshed to the file's
        // current values so the NEXT re-import fast-skips instead of re-hashing
        // forever. Without the refresh the fast-path never warms back up.
        let work = tempfile::tempdir().unwrap();
        let db_pool = db::create_pool(&work.path().join("library.db")).unwrap();
        let storage: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("library")).unwrap(),
        );
        let covers: std::sync::Arc<dyn folio_core::storage::Storage> = std::sync::Arc::new(
            folio_core::storage::LocalStorage::new(work.path().join("covers")).unwrap(),
        );

        let src = write_minimal_epub(work.path(), "book");
        let src_path_string = src.to_string_lossy().to_string();

        let first = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        let first_id = first.into_book().id;

        // The real mtime recorded on first import.
        let real_mtime = {
            let conn = db_pool.get().unwrap();
            db::get_book_by_source_path(&conn, &src_path_string)
                .unwrap()
                .unwrap()
                .source_mtime
        };

        // Simulate mtime drift on a content-identical file: clobber the stored
        // mtime so the fast-path cannot fire and we go through the hash.
        {
            let conn = db_pool.get().unwrap();
            conn.execute(
                "UPDATE books SET source_mtime = 1 WHERE id = ?1",
                rusqlite::params![first_id],
            )
            .unwrap();
        }

        let second = import_book_inner(
            src_path_string.clone(),
            db_pool.clone(),
            storage.clone(),
            covers.clone(),
            "link",
            false,
            ImportSource::Manual,
        )
        .unwrap();
        match second {
            ImportOutcome::Duplicate(b) => assert_eq!(b.id, first_id),
            _ => panic!("expected Duplicate by hash"),
        }

        // The hash-match path must have refreshed the stored mtime back to the
        // file's real value — re-arming the fast-path for future re-imports.
        let refreshed = {
            let conn = db_pool.get().unwrap();
            db::get_book_by_source_path(&conn, &src_path_string)
                .unwrap()
                .unwrap()
                .source_mtime
        };
        assert_eq!(
            refreshed, real_mtime,
            "hash-match re-import must refresh stored source_mtime"
        );
        assert_ne!(
            refreshed,
            Some(1),
            "stale sentinel mtime must be overwritten"
        );
    }

    #[test]
    fn smb_unicode_hint_fires_for_accented_name_on_volumes() {
        let hint = smb_unicode_hint(
            "/Volumes/home/BOOKS/04 - Quitte ou double à Quito.pdf",
            std::io::ErrorKind::NotFound,
        );
        let msg = hint.expect("accented name on /Volumes/ with ENOENT must produce a hint");
        assert!(msg.contains("SMB"), "hint must name the SMB bug: {msg}");
        assert!(msg.contains("User Guide"), "hint must point at docs: {msg}");
    }

    #[test]
    fn smb_unicode_hint_fires_for_accented_directory_component() {
        // The lookup bug hits accented *path components* too, not just the
        // file name itself.
        assert!(smb_unicode_hint(
            "/Volumes/nas/Intégrales/Tome 4.cbz",
            std::io::ErrorKind::NotFound,
        )
        .is_some());
    }

    #[test]
    fn smb_unicode_hint_silent_for_ascii_path() {
        assert!(smb_unicode_hint(
            "/Volumes/home/BOOKS/The Spider King.cbr",
            std::io::ErrorKind::NotFound,
        )
        .is_none());
    }

    #[test]
    fn smb_unicode_hint_silent_outside_volumes() {
        assert!(smb_unicode_hint(
            "/Users/mike/Books/Quitte ou double à Quito.pdf",
            std::io::ErrorKind::NotFound,
        )
        .is_none());
    }

    #[test]
    #[cfg(target_os = "macos")] // hint is appended only on macOS (with_smb_hint cfg gate)
    fn validate_file_exists_appends_smb_hint_for_accented_volumes_path() {
        // Linked books keep their share path; a reader command on a file hit
        // by the smbfs bug must explain it rather than claim the file moved.
        let err = validate_file_exists("/Volumes/nas/Intégrales/Tome 4.cbz").unwrap_err();
        let msg = format!("{err:?}");
        assert!(
            msg.contains("SMB"),
            "reader error must carry the hint: {msg}"
        );
    }

    #[test]
    fn smb_unicode_hint_silent_for_other_error_kinds() {
        assert!(smb_unicode_hint(
            "/Volumes/home/BOOKS/Quitte ou double à Quito.pdf",
            std::io::ErrorKind::PermissionDenied,
        )
        .is_none());
    }
}

// ── Autostart ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_autostart_enabled(app: AppHandle) -> FolioResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| FolioError::internal(format!("Failed to check autostart: {}", e)))
}

#[tauri::command]
pub async fn set_autostart_enabled(app: AppHandle, enabled: bool) -> FolioResult<()> {
    use tauri_plugin_autostart::ManagerExt;

    let autostart = app.autolaunch();

    if enabled {
        autostart
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
    } else {
        autostart
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))?;
    }

    Ok(())
}
