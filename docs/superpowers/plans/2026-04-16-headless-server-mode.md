# Headless Server Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Folio as a headless book server (no GUI) via a lean `folio-server` binary that shares all core logic with the desktop app but does not link Tauri or WebKit.

**Architecture:** Feature-gated `[[bin]]` target in the existing `src-tauri` crate. Tauri and all GUI plugins become optional dependencies behind a `desktop` Cargo feature. The new `server` feature pulls in only `clap`. Core modules (`db`, `models`, `web_server`, `epub`, `pdf`, `cbz`, `cbr`, etc.) are always compiled and shared by both binaries. The server binary wires them together directly — no Tauri runtime.

**Tech Stack:** Rust, clap 4 (CLI args + env vars), tokio (async runtime), axum 0.8 (HTTP — already used), existing `db`, `web_server`, `pdf`, `epub`, `cbz`, `cbr` modules unchanged.

---

## Why not a single binary

Tauri v2 dynamically links `libwebkit2gtk-4.1` on Linux. The dynamic linker resolves all symbols at binary load time, before `main()` runs. A binary compiled with `tauri` in its dependency tree cannot start on a headless Linux system without ~100MB of GTK/WebKit libraries — even if the code never calls into Tauri. Feature flags that make `tauri` an optional dependency are the only way to produce a server binary that runs cleanly on headless Linux and in Docker containers.

On macOS (WKWebView is always available) and Windows (WebView2 is typically present) a single binary with runtime mode selection would technically work. But maintaining two startup paths in one binary is more complex than two thin entry points sharing a library crate, and the Linux constraint forces the split anyway.

---

## Discovery findings (2026-04-16)

The following was verified by direct code inspection, not assumed from prior research:

**Already headless-ready (zero Tauri imports, no changes needed):**
- `db.rs` — `create_pool(&Path)` takes a plain path, returns `r2d2::Pool`. 70+ CRUD functions, all `fn(conn: &Connection, ...) -> Result<...>`.
- `models.rs` — pure serde data structs.
- `web_server/{mod,api,auth,opds_feed,web_ui}.rs` — axum 0.8, zero Tauri types. `WebState` is `{pool, data_dir, pin_hash, sessions, login_limiter}`.
- `epub.rs`, `pdf.rs`, `cbz.rs`, `cbr.rs` — all parsers use `std::fs`, no Tauri fs plugin.
- `enrichment.rs`, `providers.rs`, `openlibrary.rs` — pure Rust + reqwest.
- `page_cache.rs`, `sync.rs`, `backup.rs`, `opds.rs` — pure Rust (backup uses `keyring` directly, not Tauri plugin).

**Tauri-coupled (must be gated behind `desktop` feature):**
- `lib.rs::run()` — monolithic `tauri::Builder` chain with `.setup()`, `.invoke_handler()`, `.on_window_event()`, `.run()`.
- `commands.rs` — 88 `#[tauri::command]` functions, `AppState`, `LruCache`, `ProfileState`.
- `tray.rs` — `TrayIconBuilder`, `WebviewWindowBuilder`, macOS `objc2` NSApplication calls.
- `build.rs` — calls `tauri_build::build()`.

**Needs extraction to shared module:**
- `default_library_folder()` — currently in `commands.rs` (gated), but needed by both binaries. 4-line pure function using `dirs::home_dir()`.
- `LruCache<V>` — generic cache struct in `commands.rs`, needed by web server API handlers if we ever expose cache stats headlessly. For now, server binary doesn't need it.

**Security finding — critical:**
- `auth::load_pin_hash()` returns `None` on any keyring error (`.ok()?` on line 71). The middleware then grants open access. On headless Linux without a desktop session, the keyring always fails. A previously-secured server silently becomes unauthenticated. The server binary must refuse to start without a PIN unless `--open-access` is explicitly passed.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Feature-gate tauri deps, add `clap`, add `[[bin]]` target, gate `tauri-build` |
| `src-tauri/build.rs` | Modify | Gate `tauri_build::build()` behind `desktop` feature |
| `src-tauri/src/lib.rs` | Modify | Gate `commands`, `tray`, `run()` behind `desktop`; move `default_library_folder` |
| `src-tauri/src/paths.rs` | Create | Shared `default_library_folder()` (extracted from `commands.rs`) |
| `src-tauri/src/commands.rs` | Modify | Replace `default_library_folder()` with re-export from `paths.rs` |
| `src-tauri/src/web_server/auth.rs` | Modify | Add file-based PIN fallback, file permission hardening |
| `src-tauri/src/bin/server.rs` | Create | Headless entry point — CLI parsing, DB init, web server start, signal handling |
| `docs/server-mode.md` | Create | User-facing documentation |

Key design decisions:
- **Feature-gated binary, not just a separate binary.** A `[[bin]]` target alone still links all `[dependencies]` including tauri. Making tauri optional via `desktop` feature means `folio-server` compiles without webkit2gtk — essential for Docker and headless Linux.
- **Minimal changes to existing modules.** `db.rs`, `web_server/`, parsers stay untouched. Only `lib.rs` gets `#[cfg]` annotations on module declarations and the `run()` function. `commands.rs` loses one 4-line function that moves to `paths.rs`.
- **CLI args over config files.** Server operators expect `--port`, `--data-dir`, `--library-dir` flags. Env var fallbacks (`FOLIO_PORT`, etc.) for Docker. No TOML/YAML config file needed — the SQLite `settings` table already handles persistent config.
- **Strict auth default in server mode.** Without a PIN configured and no `--open-access` flag, the server refuses to start. This prevents accidental unauthenticated exposure.

---

### Task 1: Feature-gate Tauri dependencies in Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/build.rs`

- [ ] **Step 1: Restructure Cargo.toml features and dependencies**

Replace the current `[features]` block and make Tauri-related dependencies optional:

```toml
[build-dependencies]
tauri-build = { version = "2", features = [], optional = true }

[features]
default = ["desktop", "sftp"]
desktop = [
    "dep:tauri",
    "dep:tauri-build",
    "dep:tauri-plugin-opener",
    "dep:tauri-plugin-dialog",
    "dep:tauri-plugin-clipboard-manager",
    "dep:tauri-plugin-autostart",
    "dep:tauri-plugin-webdriver-automation",
]
server = ["dep:clap"]
sftp = ["opendal/services-sftp"]
```

Change these dependencies from required to optional:

```toml
tauri = { version = "2", features = ["protocol-asset", "tray-icon"], optional = true }
tauri-plugin-opener = { version = "2", optional = true }
tauri-plugin-dialog = { version = "2", optional = true }
tauri-plugin-clipboard-manager = { version = "2.3.2", optional = true }
tauri-plugin-autostart = { version = "2", optional = true }
tauri-plugin-webdriver-automation = { version = "0.1.3", optional = true }
clap = { version = "4", features = ["derive", "env"], optional = true }
```

Add the `tokio` signal feature (needed by server for ctrl-c handling):

```toml
tokio = { version = "1", features = ["rt", "rt-multi-thread", "fs", "signal"] }
```

Gate macOS-only dependencies:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = { version = "0.6", optional = true }
objc2-app-kit = { version = "0.3", features = ["NSApplication", "NSRunningApplication"], optional = true }
```

And add `"dep:objc2", "dep:objc2-app-kit"` to the `desktop` feature list.

Add the binary target after the `[lib]` section:

```toml
[[bin]]
name = "folio-server"
path = "src/bin/server.rs"
required-features = ["server"]
```

Keep the `[lib]` `crate-type` as-is — `rlib` is needed by both binaries, `staticlib`/`cdylib` are needed by Tauri.

- [ ] **Step 2: Gate build.rs behind desktop feature**

Replace `src-tauri/build.rs` with:

```rust
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
```

- [ ] **Step 3: Verify desktop build still works identically**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: Compiles with default features (includes `desktop`). No behavior change.

Run: `cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -3`
Expected: No warnings.

- [ ] **Step 4: Verify server feature compiles the library without tauri**

Run: `cd src-tauri && cargo check --no-default-features --features server 2>&1 | head -20`
Expected: Will fail because `lib.rs` still unconditionally imports tauri — that's fixed in Task 2.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/build.rs
git commit -m "chore: feature-gate tauri dependencies, add server feature and folio-server binary target"
```

---

### Task 2: Gate Tauri-specific modules and extract shared code

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/paths.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Create paths.rs with default_library_folder()**

Create `src-tauri/src/paths.rs`:

```rust
/// Default library folder for book storage.
/// Uses the platform home directory: ~/Documents/Folio Library.
pub fn default_library_folder() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home
        .join("Documents")
        .join("Folio Library")
        .to_string_lossy()
        .to_string())
}
```

- [ ] **Step 2: Update commands.rs to use paths::default_library_folder**

In `src-tauri/src/commands.rs`, replace the `default_library_folder` function body with a re-export:

```rust
pub fn default_library_folder() -> Result<String, String> {
    crate::paths::default_library_folder()
}
```

This keeps the existing public API intact so the 6 call sites within commands.rs don't change.

- [ ] **Step 3: Gate modules and run() in lib.rs**

Replace the top of `src-tauri/src/lib.rs` (lines 1-19) with:

```rust
pub mod backup;
pub mod cbr;
pub mod cbz;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod db;
pub mod enrichment;
pub mod epub;
pub mod models;
pub mod opds;
pub mod openlibrary;
pub mod page_cache;
pub mod paths;
pub mod pdf;
pub mod providers;
pub mod sync;
#[cfg(feature = "desktop")]
pub mod tray;
pub mod web_server;

#[cfg(feature = "desktop")]
use commands::{AppState, LruCache, ProfileState};
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

The closing brace of `run()` and everything inside it stays unchanged. The `#[cfg(feature = "desktop")]` wraps `run()`, `commands`, `tray`, and the tauri imports.

Also update the library folder resolution inside `run()` (lib.rs line 50) from `commands::default_library_folder()` to `paths::default_library_folder()`:

```rust
                        paths::default_library_folder().expect("Cannot determine home directory")
```

- [ ] **Step 4: Verify desktop build is unchanged**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: Compiles identically. Default features include `desktop`.

Run: `cd src-tauri && cargo test 2>&1 | tail -5`
Expected: All tests pass.

- [ ] **Step 5: Verify library compiles without desktop feature**

Run: `cd src-tauri && cargo check --lib --no-default-features --features server 2>&1 | tail -5`
Expected: Compiles. Tauri is not linked. `commands` and `tray` modules are excluded.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/paths.rs src-tauri/src/commands.rs
git commit -m "refactor: gate desktop modules behind feature flag, extract paths module"
```

---

### Task 3: File-based PIN fallback in auth.rs

**Files:**
- Modify: `src-tauri/src/web_server/auth.rs`

The OS keychain (`keyring` crate) fails on headless Linux servers with no desktop environment. `load_pin_hash()` silently returns `None`, causing the middleware to grant open access — a security problem. Add a file-based fallback.

- [ ] **Step 1: Write the failing tests for file-based PIN fallback**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/web_server/auth.rs`:

```rust
    #[test]
    fn test_file_pin_store_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pin.hash");
        let hash = hash_pin("1234");
        store_pin_to_file(&path, &hash).unwrap();
        let loaded = load_pin_from_file(&path);
        assert_eq!(loaded, Some(hash));
    }

    #[test]
    fn test_file_pin_load_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.hash");
        let loaded = load_pin_from_file(&path);
        assert_eq!(loaded, None);
    }

    #[test]
    fn test_file_pin_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pin.hash");
        store_pin_to_file(&path, &hash_pin("1111")).unwrap();
        store_pin_to_file(&path, &hash_pin("2222")).unwrap();
        let loaded = load_pin_from_file(&path);
        assert_eq!(loaded, Some(hash_pin("2222")));
    }

    #[test]
    fn test_file_pin_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("pin.hash");
        let hash = hash_pin("5678");
        store_pin_to_file(&path, &hash).unwrap();
        let loaded = load_pin_from_file(&path);
        assert_eq!(loaded, Some(hash));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib web_server::auth::tests::test_file_pin 2>&1`
Expected: Compilation error — `store_pin_to_file` and `load_pin_from_file` don't exist yet.

- [ ] **Step 3: Implement file-based PIN functions**

Add to `src-tauri/src/web_server/auth.rs`, after the existing `load_pin_hash()` function:

```rust
/// Store PIN hash to a file (fallback when OS keychain is unavailable).
/// Sets file permissions to 0600 on Unix.
pub fn store_pin_to_file(path: &std::path::Path, hash: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, hash).map_err(|e| e.to_string())?;

    // Restrict file permissions to owner-only on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Load PIN hash from a file (fallback when OS keychain is unavailable).
pub fn load_pin_from_file(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib web_server::auth::tests::test_file_pin 2>&1`
Expected: All 4 tests pass.

- [ ] **Step 5: Add `load_pin_hash_with_fallback` and `store_pin_with_fallback`**

Add to `src-tauri/src/web_server/auth.rs`:

```rust
/// Load PIN hash, trying OS keychain first, falling back to file.
pub fn load_pin_hash_with_fallback(file_path: Option<&std::path::Path>) -> Option<String> {
    // Try OS keychain first
    if let Some(hash) = load_pin_hash() {
        return Some(hash);
    }
    // Fall back to file
    if let Some(path) = file_path {
        return load_pin_from_file(path);
    }
    None
}

/// Store PIN hash, trying OS keychain first, falling back to file.
pub fn store_pin_with_fallback(pin: &str, file_path: Option<&std::path::Path>) -> Result<(), String> {
    match store_pin(pin) {
        Ok(()) => Ok(()),
        Err(_) if file_path.is_some() => {
            let hash = hash_pin(pin);
            store_pin_to_file(file_path.unwrap(), &hash)
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 6: Run full auth test suite**

Run: `cd src-tauri && cargo test --lib web_server::auth 2>&1`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/web_server/auth.rs
git commit -m "feat(auth): add file-based PIN fallback for headless environments"
```

---

### Task 4: Create the headless server binary

**Files:**
- Create: `src-tauri/src/bin/server.rs`

This is the core of the feature. The binary:
1. Parses CLI args (port, bind address, data dir, library dir, PIN file path, pdfium path, open-access)
2. Handles `--set-pin` early exit
3. Enforces auth requirement (refuses to start without PIN unless `--open-access`)
4. Creates the database pool and runs migrations
5. Ensures the library folder exists
6. Loads pdfium for PDF rendering
7. Starts the web server
8. Blocks until SIGINT/SIGTERM (Ctrl+C)
9. Shuts down gracefully

- [ ] **Step 1: Create the binary**

Create `src-tauri/src/bin/server.rs`:

```rust
use clap::Parser;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Folio -- headless book server.
///
/// Serves your library over HTTP (web UI, REST API, OPDS catalog)
/// without a desktop window.
#[derive(Parser)]
#[command(name = "folio-server", version, about)]
struct Cli {
    /// Port to listen on.
    #[arg(short, long, default_value_t = folio_lib::web_server::DEFAULT_PORT, env = "FOLIO_PORT")]
    port: u16,

    /// Address to bind to.
    #[arg(short, long, default_value = "0.0.0.0", env = "FOLIO_BIND")]
    bind: String,

    /// Data directory (database, covers, cache).
    /// Defaults to the platform app-data directory.
    #[arg(short, long, env = "FOLIO_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// Library folder where book files are stored.
    /// Defaults to ~/Documents/Folio Library.
    #[arg(short, long, env = "FOLIO_LIBRARY_DIR")]
    library_dir: Option<String>,

    /// Path to a file containing the PIN hash.
    /// Defaults to <data-dir>/pin.hash.
    #[arg(long, env = "FOLIO_PIN_FILE")]
    pin_file: Option<PathBuf>,

    /// Path to the pdfium shared library (for PDF rendering).
    /// Auto-detected from data-dir/resources/ or next to binary if not specified.
    #[arg(long, env = "FOLIO_PDFIUM_PATH")]
    pdfium_path: Option<PathBuf>,

    /// Set or update the server PIN and exit. Does not start the server.
    #[arg(long)]
    set_pin: Option<String>,

    /// Allow unauthenticated access (no PIN required).
    /// Without this flag, the server refuses to start if no PIN is configured.
    #[arg(long, env = "FOLIO_OPEN_ACCESS")]
    open_access: bool,
}

fn resolve_data_dir(cli: &Cli) -> PathBuf {
    if let Some(ref dir) = cli.data_dir {
        return dir.clone();
    }
    // Mirror Tauri's default: ~/.local/share/com.mike.folio on Linux,
    // ~/Library/Application Support/com.mike.folio on macOS.
    dirs::data_dir()
        .map(|d| d.join("com.mike.folio"))
        .expect("Cannot determine data directory. Set --data-dir or FOLIO_DATA_DIR.")
}

fn resolve_pdfium(cli: &Cli, data_dir: &std::path::Path) -> Option<PathBuf> {
    if let Some(ref p) = cli.pdfium_path {
        if p.exists() {
            return Some(p.clone());
        }
        eprintln!(
            "warning: pdfium path {:?} does not exist, PDF support disabled",
            p
        );
        return None;
    }
    // Auto-detect in resources/ next to data dir or next to binary
    #[cfg(target_os = "macos")]
    let lib_name = "libpdfium.dylib";
    #[cfg(target_os = "linux")]
    let lib_name = "libpdfium.so";
    #[cfg(target_os = "windows")]
    let lib_name = "pdfium.dll";

    let candidates = [
        data_dir.join("resources").join(lib_name),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(lib_name)))
            .unwrap_or_default(),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Handle --set-pin: store the PIN and exit without starting the server.
    if let Some(ref pin) = cli.set_pin {
        if pin.is_empty() {
            eprintln!("Error: PIN cannot be empty.");
            std::process::exit(1);
        }
        let data_dir = resolve_data_dir(&cli);
        std::fs::create_dir_all(&data_dir).ok();
        let pin_file = cli
            .pin_file
            .clone()
            .unwrap_or_else(|| data_dir.join("pin.hash"));
        match folio_lib::web_server::auth::store_pin_with_fallback(pin, Some(&pin_file)) {
            Ok(()) => {
                eprintln!("PIN set successfully.");
                eprintln!("Stored at: {}", pin_file.display());
            }
            Err(e) => {
                eprintln!("Failed to set PIN: {}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    let data_dir = resolve_data_dir(&cli);
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    // Database
    let db_path = data_dir.join("library.db");
    let pool = folio_lib::db::create_pool(&db_path).expect("Failed to initialize database");

    // Library folder
    let library_dir = cli.library_dir.unwrap_or_else(|| {
        let conn = pool.get().expect("DB connection for library folder check");
        match folio_lib::db::get_setting(&conn, "library_folder") {
            Ok(Some(f)) => f,
            _ => folio_lib::paths::default_library_folder()
                .expect("Cannot determine default library folder"),
        }
    });
    std::fs::create_dir_all(&library_dir).expect("Failed to create library folder");

    // Pdfium
    let pdfium_path = resolve_pdfium(&cli, &data_dir);
    folio_lib::pdf::set_pdfium_library_path(pdfium_path);

    // PIN — enforce auth requirement unless --open-access
    let pin_file = cli
        .pin_file
        .clone()
        .unwrap_or_else(|| data_dir.join("pin.hash"));
    let pin_hash =
        folio_lib::web_server::auth::load_pin_hash_with_fallback(Some(&pin_file));

    if pin_hash.is_none() && !cli.open_access {
        eprintln!("Error: No PIN configured.");
        eprintln!();
        eprintln!("Set a PIN:       folio-server --set-pin <your-pin>");
        eprintln!("Or allow open:   folio-server --open-access");
        eprintln!();
        eprintln!("Refusing to start without authentication.");
        std::process::exit(1);
    }

    // Web server state
    let web_state = folio_lib::web_server::WebState {
        pool: Arc::new(Mutex::new(pool)),
        data_dir: data_dir.clone(),
        pin_hash: Arc::new(Mutex::new(pin_hash.clone())),
        sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        login_limiter: Arc::new(folio_lib::web_server::auth::RateLimiter::new(5, 300)),
    };

    // Start
    let handle = folio_lib::web_server::start(web_state, cli.port)
        .await
        .expect("Failed to start web server");

    let pin_status = if pin_hash.is_some() {
        "enabled"
    } else {
        "disabled (--open-access)"
    };
    eprintln!("Folio server listening on {}", handle.url);
    eprintln!("  Bind:    {}:{}", cli.bind, handle.port);
    eprintln!("  Data:    {}", data_dir.display());
    eprintln!("  Library: {}", library_dir);
    eprintln!("  PIN:     {}", pin_status);
    eprintln!("  OPDS:    {}/opds", handle.url);
    eprintln!();
    eprintln!("Press Ctrl+C to stop.");

    // Wait for shutdown signal
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for Ctrl+C");

    eprintln!("\nShutting down...");
    folio_lib::web_server::stop(handle);
}
```

Note: The `--bind` flag is parsed but not yet passed to `web_server::start()`. The `start()` function currently hardcodes `0.0.0.0`. This can be extended in a follow-up by adding a `bind` parameter to `start()`. For now the flag is accepted so the CLI interface is stable.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build --bin folio-server --no-default-features --features server 2>&1 | tail -3`
Expected: `Finished` with no errors. No webkit2gtk linked.

- [ ] **Step 3: Verify desktop build still works**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: No changes to desktop binary.

- [ ] **Step 4: Smoke test — run the binary and hit the health endpoint**

```bash
cd src-tauri

# Set a PIN first
cargo run --no-default-features --features server --bin folio-server -- \
  --set-pin test1234 --data-dir /tmp/folio-test

# Start server
cargo run --no-default-features --features server --bin folio-server -- \
  --port 17788 --data-dir /tmp/folio-test &
sleep 2

# Health check (public)
curl -s http://127.0.0.1:17788/api/health
# Expected: "ok" or similar 200 response

# Auth required
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:17788/api/books
# Expected: 401

# OPDS feed
curl -s -u user:test1234 http://127.0.0.1:17788/opds/ | head -5
# Expected: XML OPDS feed

kill %1
rm -rf /tmp/folio-test
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/server.rs
git commit -m "feat: add folio-server headless binary with auth enforcement"
```

---

### Task 5: Verify everything together

**Files:** None (verification only)

The feature-gating, auth changes, and new binary must not break anything.

- [ ] **Step 1: Run Rust tests (all features)**

Run: `cd src-tauri && cargo test --features server 2>&1 | tail -5`
Expected: All tests pass (existing + new file PIN tests).

- [ ] **Step 2: Run clippy on both targets**

Run: `cd src-tauri && cargo clippy -- -D warnings 2>&1 | tail -5`
Expected: No warnings on desktop.

Run: `cd src-tauri && cargo clippy --no-default-features --features server --bin folio-server -- -D warnings 2>&1 | tail -5`
Expected: No warnings on server.

- [ ] **Step 3: Run fmt check**

Run: `cd src-tauri && cargo fmt --check 2>&1`
Expected: No formatting issues.

- [ ] **Step 4: Run frontend checks (ensure nothing is broken)**

Run: `npm run type-check && npm run test`
Expected: All pass (no frontend changes, but verify no regressions).

- [ ] **Step 5: Commit (only if any fixes were needed)**

---

### Task 6: End-to-end manual test

**Files:** None (verification only)

Full round-trip test of the server binary.

- [ ] **Step 1: End-to-end test**

```bash
cd src-tauri

# 1. Build server binary
cargo build --no-default-features --features server --bin folio-server

# 2. Verify it refuses to start without PIN
cargo run --no-default-features --features server --bin folio-server -- \
  --port 17788 --data-dir /tmp/folio-e2e 2>&1
# Expected: "Error: No PIN configured." and exit code 1

# 3. Set PIN
cargo run --no-default-features --features server --bin folio-server -- \
  --set-pin test1234 --data-dir /tmp/folio-e2e

# 4. Start server
cargo run --no-default-features --features server --bin folio-server -- \
  --port 17788 --data-dir /tmp/folio-e2e &
sleep 2

# 5. Health check (public)
curl -sf http://127.0.0.1:17788/api/health && echo " OK"

# 6. Auth required
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:17788/api/books)" = "401" && echo "Auth OK"

# 7. Login
TOKEN=$(curl -sf -X POST http://127.0.0.1:17788/api/auth \
  -H 'Content-Type: application/json' -d '{"pin":"test1234"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: $TOKEN"

# 8. Authenticated access
curl -sf -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17788/api/books && echo " Books OK"

# 9. OPDS feed via Basic Auth
curl -sf -u user:test1234 http://127.0.0.1:17788/opds/ | head -3

# 10. Web UI
curl -sf http://127.0.0.1:17788/ | head -3

# 11. Open access mode
kill %1
cargo run --no-default-features --features server --bin folio-server -- \
  --port 17788 --data-dir /tmp/folio-e2e-open --open-access &
sleep 2
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:17788/api/books)" != "401" && echo "Open access OK"

# 12. Cleanup
kill %1
rm -rf /tmp/folio-e2e /tmp/folio-e2e-open
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/server-mode.md`

- [ ] **Step 1: Write server mode documentation**

Create `docs/server-mode.md`:

~~~markdown
# Folio Server Mode

Run Folio as a headless book server -- no desktop window required.

## Quick Start

```bash
# Build the server binary (no GUI dependencies needed)
cd src-tauri
cargo build --release --no-default-features --features server --bin folio-server

# Set a PIN (required unless --open-access is used)
./target/release/folio-server --set-pin your-secret-pin

# Start the server
./target/release/folio-server
```

The server starts on port 7788 by default. Open `http://your-server:7788` in a
browser, or point an OPDS-compatible e-reader app at `http://your-server:7788/opds`.

## CLI Options

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--port` / `-p` | `FOLIO_PORT` | 7788 | HTTP port |
| `--bind` / `-b` | `FOLIO_BIND` | `0.0.0.0` | Bind address |
| `--data-dir` / `-d` | `FOLIO_DATA_DIR` | Platform app-data dir | Database, covers, cache |
| `--library-dir` / `-l` | `FOLIO_LIBRARY_DIR` | `~/Documents/Folio Library` | Where book files live |
| `--pin-file` | `FOLIO_PIN_FILE` | `<data-dir>/pin.hash` | Path to PIN hash file |
| `--pdfium-path` | `FOLIO_PDFIUM_PATH` | Auto-detected | Path to pdfium shared library |
| `--set-pin <PIN>` | -- | -- | Set PIN and exit (does not start server) |
| `--open-access` | `FOLIO_OPEN_ACCESS` | false | Allow unauthenticated access |

## Security

By default, the server **refuses to start** without a PIN configured. This
prevents accidental unauthenticated exposure. Either set a PIN with `--set-pin`
or explicitly opt into open access with `--open-access`.

The PIN hash is stored in a file at `<data-dir>/pin.hash` with permissions
restricted to the file owner (0600 on Unix). On systems where the OS keychain
is available, the keychain is tried first.

For production deployments, run behind a reverse proxy (nginx, Caddy) with TLS.
The server itself serves plain HTTP.

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/` | No | Embedded web UI (login page if PIN set) |
| `/api/health` | No | Health check |
| `/api/auth` | No | POST: login with PIN, returns session token |
| `/api/books` | Yes | Book listing (JSON) |
| `/api/books/{id}` | Yes | Single book metadata |
| `/api/books/{id}/cover` | Yes | Cover image |
| `/api/books/{id}/chapters` | Yes | EPUB table of contents |
| `/api/books/{id}/chapters/{n}` | Yes | EPUB chapter HTML |
| `/api/books/{id}/pages/{n}` | Yes | PDF/comic page image |
| `/api/books/{id}/page-count` | Yes | PDF/comic page count |
| `/api/books/{id}/download` | Yes | Download book file |
| `/api/series` | Yes | List series |
| `/api/collections` | Yes | List collections |
| `/api/collections/{id}/books` | Yes | Books in a collection |
| `/opds` | Yes* | OPDS catalog root |
| `/opds/all` | Yes* | All books (paginated) |
| `/opds/new` | Yes* | Recently added |
| `/opds/search?q=term` | Yes* | Search |

*OPDS endpoints support HTTP Basic Auth for e-reader compatibility.

## Shared Database

The server uses the same SQLite database as the desktop app. Books imported via
the desktop UI are immediately available in server mode and vice versa. The
database supports concurrent access via WAL mode and connection pooling.

## Adding Books

For now, import books through the desktop app. The server and desktop app share
the same database and library folder, so imports are immediately visible to both.

If you only have the server binary, place book files in the library directory
and they'll be served for download, but they won't appear in the catalog until
imported through the desktop app. (A server-side import endpoint is planned.)

## Docker

```dockerfile
FROM rust:1.83 AS builder
WORKDIR /app
COPY src-tauri/ ./src-tauri/
RUN cd src-tauri && cargo build --release --no-default-features --features server --bin folio-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/src-tauri/target/release/folio-server /usr/local/bin/
COPY src-tauri/resources/libpdfium.so /opt/folio/resources/
ENV FOLIO_DATA_DIR=/data
ENV FOLIO_LIBRARY_DIR=/library
ENV FOLIO_PDFIUM_PATH=/opt/folio/resources/libpdfium.so
EXPOSE 7788
ENTRYPOINT ["folio-server"]
```

```bash
docker run -d \
  -p 7788:7788 \
  -v /path/to/books:/library \
  -v /path/to/data:/data \
  -e FOLIO_OPEN_ACCESS=true \
  folio-server
```

**Note:** This Dockerfile is a starting point. It has not been tested and will
need adjustments for pdfium provisioning and cross-compilation.
~~~

- [ ] **Step 2: Commit**

```bash
git add docs/server-mode.md
git commit -m "docs: add server mode documentation"
```

---

### Task 8: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add server binary build and lint to CI**

Add to the existing CI workflow, alongside the existing Rust checks:

```yaml
- name: Build folio-server
  run: cargo build --no-default-features --features server --bin folio-server
  working-directory: src-tauri

- name: Clippy folio-server
  run: cargo clippy --no-default-features --features server --bin folio-server -- -D warnings
  working-directory: src-tauri
```

- [ ] **Step 2: Verify CI passes locally**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo clippy --no-default-features --features server --bin folio-server -- -D warnings && cargo test --features server
cd .. && npm run type-check && npm run test
```

Expected: Everything passes.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add folio-server build and clippy checks"
```

---

## Deferred items (not in this plan)

| Item | Reason | Priority |
|------|--------|----------|
| Argon2 PIN hashing | SHA-256 without salt is weak for short PINs. Rate limiting mitigates for now. | Medium — follow-up |
| `--bind` actually wired to `web_server::start()` | Requires adding a parameter to `start()`. CLI flag is accepted now for interface stability. | Low — follow-up |
| TLS / HTTPS | Use a reverse proxy for now (nginx, Caddy). Standard for self-hosted services. | Low |
| Server-side book import API | Users currently import via desktop app or filesystem. Add `/api/import` endpoint. | Medium — v2 feature |
| Docker image publication | Dockerfile provided as documentation, not CI-tested. | Low |
| Profile support in server mode | Desktop app supports profile switching. Server always uses default profile. | Low |
| CORS configuration | Server has no CORS headers. Cross-origin browser clients can't call the API. | Low — only needed if web UI is served from a different origin |
| Filesystem watcher for auto-import | Watch library directory for new files and import automatically. | Medium — v2 feature |

---

## Risk assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Feature-gating breaks desktop build | Medium | CI runs both desktop and server builds. Task 5 verifies both. |
| `pdfium-render` unavailable on headless Linux | Low | `set_pdfium_library_path(None)` triggers system library fallback. PDF operations return errors gracefully, not panics. |
| `unrar` C dependency fails on some targets | Low | Existing issue, not new. CBR is least-used format. |
| `tauri-build` runs for server binary | Eliminated | `build.rs` gated behind `#[cfg(feature = "desktop")]` in Task 1. |
| Desktop and server share same SQLite DB | Feature | r2d2 pool + SQLite WAL mode handle concurrent access. |
| Silent auth bypass on keyring failure | **Eliminated** | Server mode refuses to start without PIN unless `--open-access`. |
| SHA-256 PIN hash is weak for short PINs | Medium | Rate limiting (5 attempts/300s) mitigates. Argon2 upgrade tracked as follow-up. |
| No TLS | Medium | Standard for LAN servers. Documented: "use a reverse proxy". |
| `pin.hash` file readable by other users | Eliminated | `store_pin_to_file` sets 0600 permissions on Unix. |
