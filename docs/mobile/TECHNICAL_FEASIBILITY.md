# Folio Mobile — Technical Feasibility Report

**Date:** 2026-04-12
**Scope:** Android (ARM64) and iOS (ARM64) via Tauri v2 mobile targets
**Approach:** Same repo, feature-gated mobile builds
**Recommended mobile v1 scope:** EPUB + CBZ only (PDF and CBR deferred)

---

## Table of Contents

1. [Mobile v1 Scope](#1-mobile-v1-scope)
2. [Rust Dependency Audit](#2-rust-dependency-audit)
3. [Filesystem & Path Assumptions](#3-filesystem--path-assumptions)
4. [Platform-Specific Code](#4-platform-specific-code)
5. [Frontend Audit](#5-frontend-audit)
6. [Web Server Assessment](#6-web-server-assessment)
7. [Blockers & Critical Path](#7-blockers--critical-path)
8. [Implementation Plan](#8-implementation-plan)

---

## 1. Mobile v1 Scope

### In scope

- EPUB reading (reflowable, paginated + continuous scroll)
- CBZ reading (comic archive, ZIP-based — pure Rust)
- Library management (import, collections, tags, search, filter, sort)
- Reading progress, bookmarks, highlights
- Theme system (presets + saved custom themes)
- Metadata enrichment (Google Books, OpenLibrary, BnF, Comic Vine)
- Backup/restore (local + S3/FTP/WebDAV — no SFTP)
- Multi-device sync (via remote storage)
- Profiles

### Deferred to mobile v2+

- **PDF support** — requires cross-compiling PDFium C library for Android ARM64 and static linking for iOS. Biggest single dependency blocker.
- **CBR support** — requires cross-compiling unrar C++ library via NDK/Xcode. Medium effort but fragile build setup.
- **Web server** — background process restrictions on Android/iOS make persistent HTTP serving unreliable. Feature-gate for desktop only.
- **SFTP backup** — `libssh2` C dependency. Other providers (S3, FTP, WebDAV) cover the use case.
- **OPDS catalog browsing** — works technically but the temp file download path needs fixing. Defer to simplify v1.

### Rationale

EPUB + CBZ covers the majority use case (reflowable books + comics) without any C/C++ cross-compilation blockers. PDF and CBR can be added incrementally once the mobile build pipeline is stable.

---

## 2. Rust Dependency Audit

### WORKS_AS_IS (pure Rust, no changes needed)

| Crate | Purpose |
|-------|---------|
| `serde` / `serde_json` | Serialization |
| `uuid` | ID generation |
| `chrono` | Date/time |
| `quick-xml` | XML parsing (EPUB, OPDS) |
| `ammonia` | HTML sanitization |
| `base64` | Encoding |
| `sha2` | Hashing |
| `regex` | Pattern matching |
| `url` / `urlencoding` | URL handling |
| `log` | Logging |
| `mime_guess` | MIME detection |
| `qrcode` | QR generation |
| `r2d2` | Connection pooling |
| `zip` | ZIP/CBZ archive extraction |
| `image` | Image encoding/decoding |
| `rusqlite` (bundled) | SQLite (compiles C source via cc crate — well-tested on mobile) |
| `tokio` | Async runtime |

### BLOCKER (will not compile or function on mobile)

#### `pdfium-render` v0.8

- **What:** C library FFI. Dynamically loads platform-specific PDFium shared library.
- **Where:** `src-tauri/src/pdf.rs`, `src-tauri/src/lib.rs:43-72`
- **Android problem:** No `#[cfg(target_os = "android")]` case in lib.rs. Missing pre-built `libpdfium.so` for ARM64. Can be obtained from `bblanchon/pdfium-binaries` but needs integration.
- **iOS problem:** Dynamic library loading (`dlopen`) is prohibited on iOS. Must use `Pdfium::bind_to_statically_linked_library()` with a static `.a` or xcframework. Fundamentally different linking approach.
- **Resolution for mobile v1:** Feature-gate PDF behind `#[cfg(feature = "pdf")]`. Exclude from mobile builds. No PDF commands registered on mobile.

#### `unrar` v0.5

- **What:** C++ FFI. Compiles unrar C++ source via build script.
- **Where:** `src-tauri/src/cbr.rs`, `src-tauri/src/page_cache.rs:186-270`
- **Android problem:** Needs NDK C++ toolchain (`CXX`/`AR` set to NDK clang++). Historically finicky.
- **iOS problem:** Needs Xcode C++ toolchain for ARM64. Achievable but untested.
- **Resolution for mobile v1:** Feature-gate CBR behind `#[cfg(feature = "cbr")]`. Exclude from mobile builds.

#### `keyring` v3

- **What:** OS credential store API (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- **Where:** `src-tauri/src/backup.rs:29,48` (backup secrets), `src-tauri/src/web_server/auth.rs:65,71` (web server PIN)
- **Android problem:** No supported backend. Runtime "no backend available" error.
- **iOS problem:** Uses macOS Keychain API, not iOS Keychain (`Security.framework` SecItem API).
- **Resolution:** Replace with one of:
  - `tauri-plugin-stronghold` (encrypted storage, cross-platform)
  - Encrypted SQLite column with app-derived key
  - Platform-specific JNI/Swift bridge to Android Keystore / iOS Keychain
- **Effort:** Medium. The `keyring` usage is isolated to 2 files with 4 call sites.

#### `dirs` v5

- **What:** Desktop directory resolution (`home_dir()`, `document_dir()`, etc.).
- **Where:** `src-tauri/src/commands.rs:2407` — `default_library_folder()` constructs `~/Documents/Folio Library`
- **Problem:** `dirs::home_dir()` returns `None` on Android and iOS. No `~/Documents/` equivalent.
- **Resolution:** Replace with `app.path().app_data_dir()` from Tauri's path API. Already used correctly elsewhere in the codebase.
- **Effort:** Low. Single function replacement.

### NEEDS_WORK (compiles but requires changes)

#### `reqwest` v0.12

- **Issue:** Default TLS backend may link against system OpenSSL (missing on Android NDK). Blocking mode spawns threads.
- **Fix:** Add `features = ["rustls-tls"]` for pure-Rust TLS. Blocking calls are already wrapped in `spawn_blocking` via Tauri commands, so no ANR risk.
- **Effort:** Low (Cargo.toml feature change).

#### `opendal` v0.55

- **Issue:** SFTP service depends on `libssh2` C bindings.
- **Fix:** Already has `#[cfg(feature = "sftp")]` / `#[cfg(not(feature = "sftp"))]` fallback in `backup.rs:335-366`. Disable `sftp` feature for mobile builds.
- **Effort:** Low (Cargo.toml feature gate).

#### `tauri-plugin-dialog` v2

- **Issue:** File picker works on mobile, but the "pick a library folder" UX is invalid (iOS is sandboxed, Android has Scoped Storage).
- **Fix:** On mobile, remove folder picker. Books stored in app-internal directory only.
- **Effort:** Medium (conditional UI + backend logic).

#### `tauri-plugin-opener` v2

- **Issue:** Registered but no invocations found in the codebase. Has Android/iOS support.
- **Fix:** Verify if needed. Remove if unused to simplify build.
- **Effort:** Low.

---

## 3. Filesystem & Path Assumptions

### Blockers

| Location | Issue | Fix |
|----------|-------|-----|
| `commands.rs:2407` | `dirs::home_dir()` in `default_library_folder()` — returns `None` on mobile | Use `app.path().app_data_dir()` |
| Library folder concept | Entire pattern of user-chosen arbitrary filesystem paths | On mobile: books stored in app-internal directory, no folder picker |

### Needs work

| Location | Issue | Fix |
|----------|-------|-----|
| `commands.rs:2276` | `std::env::temp_dir()` for OPDS download — may not be writable on Android | Use `app.path().app_cache_dir()` |
| `lib.rs:50` | `app.path().resource_dir()` for pdfium — resource bundling differs on mobile | Moot if PDF is feature-gated out |

### Works as-is

| Location | Why |
|----------|-----|
| `lib.rs:27,75` | `app.path().app_data_dir()` — resolves correctly on all platforms |
| `commands.rs:418,485,543,612` | `app.path().app_data_dir()` for covers — correct |
| `commands.rs:1314,1383,1420,1429` | `app.path().app_cache_dir()` for page cache — correct |
| `commands.rs:3535` | `app.path().app_data_dir()` for fonts — correct |

---

## 4. Platform-Specific Code

### Already mobile-aware

- `lib.rs:20` — `#[cfg_attr(mobile, tauri::mobile_entry_point)]` already present
- `Cargo.toml:16` — `crate-type = ["staticlib", "cdylib", "rlib"]` includes `staticlib` (needed for iOS)
- `backup.rs:335-366` — SFTP feature gated with fallback

### Missing mobile cases

| Location | Issue | Fix |
|----------|-------|-----|
| `lib.rs:43-48` | pdfium `#[cfg(target_os)]` has no Android/iOS cases | Feature-gate PDF entirely for v1 |
| `lib.rs:296-308` | `WindowEvent::Destroyed` for web server shutdown | Use Tauri mobile lifecycle events or feature-gate web server |

### Good news

- **No `std::process::Command` usage** anywhere in the Rust codebase
- **No `#[cfg(target_os = "linux")]` that would incorrectly match Android** (Android is Linux, but the pdfium case uses the same `.so` extension which partially helps)

---

## 5. Frontend Audit

### Touch interaction gaps

| Issue | Files | Severity | Fix |
|-------|-------|----------|-----|
| `opacity-0 group-hover:opacity-100` hides UI elements entirely on touch | `HighlightsPanel.tsx:188`, `BookmarksPanel.tsx:167`, `SavedThemesList.tsx`, `Library.tsx:837` | **High** | Add `group-focus-within:opacity-100` (already done for SavedThemesList) or always show on mobile via `@media (hover: none)` |
| Mouse-only drag for book-to-collection | `dragState.ts`, `CollectionsSidebar.tsx`, `Library.tsx:939-1029` | **Medium** | Use select mode + "Add to collection" button (partly exists). Disable drag on touch. |
| Desktop file drag-and-drop | `Library.tsx:327-339` (`onDragDropEvent`) | **Low** | Feature doesn't exist on mobile. Gate with platform check. Mobile uses document picker. |
| No swipe gesture for page navigation | `PageViewer.tsx`, `Reader.tsx` | **High** | Add `touchstart`/`touchmove`/`touchend` handlers for swipe left/right |
| No pinch-to-zoom on touch | `PageViewer.tsx` | **Medium** | Add touch gesture zoom (currently mouse wheel + Cmd/Ctrl +/-) |

### Layout concerns

| Issue | Files | Fix |
|-------|-------|-----|
| Side panels (`w-80`) on small screens | `BookmarksPanel.tsx:129`, `HighlightsPanel.tsx:101` | Already has `max-w-[90vw]` — acceptable but may want full-screen overlay on phones |
| Top nav bar | `App.tsx:31` | Consider bottom tab navigation for mobile |
| Fixed cover dimensions | `BookDetailModal.tsx:102` | Use relative sizing |
| Keyboard shortcuts help overlay | `KeyboardShortcutsHelp.tsx` | Hide entirely on mobile |

### Keyboard shortcuts without touch alternatives

| Feature | Has button? | Needs mobile action? |
|---------|-------------|---------------------|
| `b` — bookmark | No visible button in reader | Yes — add bookmark button to reader header |
| `d` — focus mode | Clock icon button exists | Works |
| `Cmd/Ctrl+F` — search | No touch trigger | Yes — add search button to reader header |
| `t` — TOC | Button exists | Works |
| `?` — help | No touch trigger | Hide on mobile |

### Works as-is

- `localStorage` — works in Android WebView and iOS WKWebView
- `window.matchMedia("prefers-color-scheme")` — supported
- `convertFileSrc` / asset protocol — Tauri v2 mobile support
- Most Tailwind responsive layouts — flex/grid based

---

## 6. Web Server Assessment

**Recommendation: exclude from mobile v1 builds entirely.**

| Platform | Constraint |
|----------|-----------|
| Android | Aggressive background process killing. Socket stays open only while app is foreground. `INTERNET` permission needed. |
| iOS | Terminates background TCP listeners within ~30 seconds. Apple may reject apps running HTTP servers without clear justification. |

The web server depends on `keyring` (blocker) and `WindowEvent::Destroyed` lifecycle (needs mobile adaptation). The complexity of making it work reliably on mobile outweighs the benefit — users access the mobile app directly, not via a web browser.

**Implementation:** Feature-gate the entire `web_server` module behind `#[cfg(not(mobile))]` or a `desktop` feature flag. Exclude web server commands from the mobile `invoke_handler`.

---

## 7. Blockers & Critical Path

### Minimum changes to compile EPUB + CBZ on mobile

| # | Change | Effort | Files |
|---|--------|--------|-------|
| 1 | Feature-gate `pdfium-render` / PDF module | Low | `Cargo.toml`, `lib.rs`, `commands.rs`, `pdf.rs` |
| 2 | Feature-gate `unrar` / CBR module | Low | `Cargo.toml`, `lib.rs`, `commands.rs`, `cbr.rs` |
| 3 | Feature-gate web server module | Low | `Cargo.toml`, `lib.rs`, `web_server/` |
| 4 | Replace `keyring` with encrypted SQLite or Tauri secure storage | Medium | `backup.rs`, `web_server/auth.rs` |
| 5 | Replace `dirs::home_dir()` with `app.path().app_data_dir()` | Low | `commands.rs:2407` |
| 6 | Disable SFTP feature for mobile | Low | `Cargo.toml` |
| 7 | Add `rustls-tls` feature to `reqwest` | Low | `Cargo.toml` |
| 8 | Run `tauri android init` + `tauri ios init` | Low | generates `gen/android/`, `gen/apple/` |
| 9 | Fix `std::env::temp_dir()` usage | Low | `commands.rs:2276` |

### After compilation: UX essentials for mobile v1

| # | Change | Effort |
|---|--------|--------|
| 10 | Touch swipe gestures for page navigation | Medium |
| 11 | Always-visible action buttons (remove hover-only patterns) | Low |
| 12 | Mobile navigation pattern (bottom tabs or drawer) | Medium |
| 13 | Reader header buttons for bookmark + search (touch alternatives) | Low |
| 14 | Disable/hide desktop-only features (drag-drop, keyboard help, web server UI, library folder picker) | Low |
| 15 | Touch-friendly book-to-collection flow (use select mode) | Low |

---

## 8. Implementation Plan

### Phase 1: Platform abstraction (in current codebase, no mobile build yet)

Add feature flags in `Cargo.toml`:

```toml
[features]
default = ["pdf", "cbr", "web-server", "sftp"]
pdf = ["pdfium-render"]
cbr = ["unrar"]
web-server = ["axum", "tower-http"]
sftp = ["opendal/services-sftp"]
mobile = []  # excludes pdf, cbr, web-server, sftp
```

Gate modules with `#[cfg(feature = "...")]`. Replace `keyring` and `dirs` with platform-portable alternatives. Verify desktop builds still pass with all features enabled.

**This phase changes no behavior on desktop.** It only adds the abstraction layer.

### Phase 2: Mobile scaffold

Run `tauri android init` and `tauri ios init`. Configure:
- Android: `AndroidManifest.xml` (permissions: `INTERNET`, `READ_EXTERNAL_STORAGE`)
- iOS: `Info.plist` (document types for EPUB/CBZ import via share sheet)
- Mobile-specific Tauri config (no `windows` section)

Attempt first compilation targeting Android emulator. Fix any remaining compile errors.

### Phase 3: Core reading on mobile

- EPUB reader working on mobile WebView
- CBZ reader working
- Touch swipe navigation
- Basic library view (responsive grid)
- Import via document picker

### Phase 4: Mobile UX polish

- Bottom navigation
- Touch-optimized panels (full-screen overlays for bookmarks/highlights/TOC)
- Hover-to-always-visible adaptations
- Reader header with bookmark + search buttons
- Hide desktop-only features

### Phase 5: Mobile-specific features

- Share sheet integration (receive EPUB/CBZ from other apps)
- System back button handling (Android)
- App lifecycle (save state on background, restore on resume)
- Push notification for sync status (optional)

---

## Appendix: File-by-File Impact Map

Files that need changes for mobile compilation (Phase 1):

| File | Change |
|------|--------|
| `Cargo.toml` | Add feature flags, gate deps |
| `lib.rs` | Gate PDF init, web server init, pdfium cfg blocks |
| `commands.rs` | Gate PDF/CBR/web-server commands in invoke_handler, fix `default_library_folder()`, fix `temp_dir()` |
| `pdf.rs` | Wrap in `#[cfg(feature = "pdf")]` |
| `cbr.rs` | Wrap in `#[cfg(feature = "cbr")]` |
| `web_server/` (all) | Wrap in `#[cfg(feature = "web-server")]` |
| `backup.rs` | Replace `keyring` calls |
| `page_cache.rs` | Gate CBR-specific cache code |

Files that need changes for mobile UX (Phases 3-4):

| File | Change |
|------|--------|
| `PageViewer.tsx` | Add touch swipe + pinch-zoom gestures |
| `Reader.tsx` | Add bookmark/search buttons to header for touch |
| `Library.tsx` | Gate drag-drop, adapt hover patterns |
| `HighlightsPanel.tsx` | Always-visible action buttons on touch |
| `BookmarksPanel.tsx` | Same |
| `App.tsx` | Mobile navigation pattern |
| `SettingsPanel.tsx` | Hide web server section, library folder picker on mobile |
| `KeyboardShortcutsHelp.tsx` | Hide on mobile |
