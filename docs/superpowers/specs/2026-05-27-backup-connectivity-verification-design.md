# F-3-7: Backup Connectivity Verification and Secret Rotation

**Date:** 2026-05-27
**Research ref:** F-3-7 (Tier 1, 3 supporters, M effort, L risk)
**Dependencies:** None (backup infrastructure already shipped)

## Problem

Backup credentials are saved without any connectivity validation. Users discover broken configs only when a backup or sync attempt fails — silently, sometimes days later. There is no structured error classification: sync failures are stored as free-text strings, making it impossible for the frontend to distinguish auth failures from network blips. Credential rotation has no explicit flow — users must delete and re-create the entire config.

## Solution

Three coordinated changes:

1. **Test-connection command** — verifies auth + write permission before config is saved, and on demand via button
2. **Credential rotation via re-save** — editing and saving config triggers test-then-swap, with keychain rollback on failure
3. **Auth failure toast** — sync errors are classified; auth/permission failures emit a Tauri event that surfaces a non-blocking toast

## Design

### 1. `ConnectionTestResult` Enum

New type in `folio-core/src/backup.rs`:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "status")]
pub enum ConnectionTestResult {
    Ok { latency_ms: u64 },
    AuthFailed { message: String },
    PermissionDenied { message: String },
    NetworkError { message: String },
    Timeout,
}
```

Serializes as tagged JSON for frontend pattern matching:

```json
{ "status": "Ok", "latency_ms": 142 }
{ "status": "AuthFailed", "message": "Invalid access key" }
```

### 2. `classify_opendal_error` Helper

New function in `backup.rs`:

```rust
pub fn classify_opendal_error(err: &opendal::Error) -> ConnectionTestResult
```

Maps OpenDAL error kinds to `ConnectionTestResult`:

| OpenDAL Kind | Result |
|---|---|
| `Unauthorized` | `AuthFailed` |
| `PermissionDenied` | `PermissionDenied` |
| `NotFound` (on list) | `NetworkError` (bad endpoint/bucket) |
| Timeout-related | `Timeout` |
| Everything else | `NetworkError` |

Reused by both test-connection and sync error classification.

### 3. `test_connection` Function

New function in `backup.rs`:

```rust
pub fn test_connection(config: &BackupConfig) -> ConnectionTestResult
```

Steps:

1. `build_operator(config)` — catch builder errors → `NetworkError`
2. `op.list("/")` — confirms authentication. Classify errors via `classify_opendal_error`
3. `op.write(".folio-connection-test", timestamp_bytes)` — confirms write permission. On 403 → `PermissionDenied`
4. `op.delete(".folio-connection-test")` — cleanup. Failure is non-fatal (logged, still returns `Ok`)
5. Measure total elapsed → return `Ok { latency_ms }`

The sentinel file `.folio-connection-test` lives at the configured root. It contains a timestamp so stale sentinels from crashed tests are identifiable. The delete in step 4 runs best-effort — a leftover sentinel is harmless (tiny, overwritten on next test).

### 4. `remove_secrets` Helper

New function in `backup.rs`:

```rust
pub fn remove_secrets(config: &BackupConfig) -> FolioResult<()>
```

Deletes keychain entries for all secret keys of the config's provider type. Called on test failure after `store_secrets` already wrote to keychain — prevents orphaned entries.

### 5. `test_backup_connection` Tauri Command

New command in `commands.rs`:

```rust
#[tauri::command]
pub async fn test_backup_connection(config: BackupConfig) -> Result<ConnectionTestResult, String>
```

Takes raw config with secrets in the values map (same shape frontend sends). Does NOT touch keychain or DB — builds operator directly from provided values. Runs `test_connection` on a blocking thread.

Used by the standalone "Test Connection" button.

### 6. Modified `save_backup_config` Command

Updated signature:

```rust
#[tauri::command]
pub async fn save_backup_config(config: BackupConfig, state: State<'_, AppState>)
    -> Result<ConnectionTestResult, String>
```

Returns `ConnectionTestResult` instead of `()`.

Flow:

1. `store_secrets(&config)` → write secrets to keychain, get clean config
2. `test_connection(&config)` → run connectivity check with original (secret-bearing) config
3. If `Ok` → save clean config to DB via `db::set_setting`, return `Ok`
4. If failure → `remove_secrets(&config)` (rollback keychain), return the failure result

Credential rotation is implicit: editing fields and re-saving triggers this same flow. On success, `store_secrets` overwrites old keychain entries atomically. On failure, `remove_secrets` cleans up the new entries and the old config remains in DB untouched.

### 7. Sync Error Classification

**New setting:** `last_sync_error_kind` stored alongside existing `last_sync_error_at` and `last_sync_error_message`.

Values: `"auth_failed"`, `"permission_denied"`, `"network"`, `"timeout"`, `"other"`.

**Modified sync commands** (`sync_pull_book`, `sync_push_book`):

On catching a `SyncError::Transport`:
1. Read the `kind` field from the `Transport` variant (see enum change below)
2. Map `kind` to a `last_sync_error_kind` string value
3. Store kind + message in settings
4. If kind is `auth_failed` or `permission_denied`, emit `backup-auth-error` Tauri event with payload `{ message: String }`

**Modified `SyncError` enum** — add optional `opendal::ErrorKind` field to `Transport` variant so classification can operate on the structured error rather than parsing strings:

```rust
pub enum SyncError {
    Transport { message: String, kind: Option<opendal::ErrorKind> },
    Timeout,
    Malformed(String),
}
```

### 8. Frontend — SettingsPanel Changes

**Save button:** Text changes from "Save" to "Save & Test".

On click:
1. Show spinner + "Testing connection..."
2. Call `save_backup_config` with form values
3. On `Ok { latency_ms }` → green inline message: "Connected ({latency_ms}ms)" + switch to saved view
4. On failure → red inline message matching the variant. Fields stay editable. Config not saved.

**Test Connection button:** Appears next to saved config info (provider name, last backup time).

On click:
1. Show spinner on button
2. Call `test_backup_connection` with config from `get_backup_config`
3. Show result inline (same color-coded messages as save flow)

Button disabled while backup is running.

### 9. Frontend — Auth Failure Toast

**Location:** `App.tsx` or top-level layout component.

**Listener:** Register global `backup-auth-error` event listener on mount.

**Toast behavior:**
- Non-blocking, fixed-position bottom-right
- Text: "Backup authentication failed — check credentials in Settings"
- Auto-dismiss after 8 seconds
- Manual dismiss via close button
- Click body → navigate to Settings (or scroll to backup section if already on settings route)
- Session dedup: `useRef<boolean>` tracks whether toast has been shown this session. Reset only on app restart. Prevents repeated toasts from multiple failed sync attempts.

**No new toast component** if one already exists. If none, minimal implementation: fixed-position div with fade-in/out animation, absolute minimum styling consistent with existing UI patterns.

### 10. Command Registration

Add `test_backup_connection` to `invoke_handler` in `src-tauri/src/lib.rs`. The modified `save_backup_config` keeps its existing registration — only the return type changes.

## Files Changed

| File | Change |
|---|---|
| `folio-core/src/backup.rs` | Add `ConnectionTestResult`, `classify_opendal_error`, `test_connection`, `remove_secrets` |
| `folio-core/src/sync.rs` | Extend `SyncError::Transport` with optional `ErrorKind` |
| `src-tauri/src/commands.rs` | Add `test_backup_connection`, modify `save_backup_config` return type, classify errors in sync commands |
| `src-tauri/src/lib.rs` | Register `test_backup_connection` in invoke handler |
| `src/components/SettingsPanel.tsx` | "Save & Test" flow, "Test Connection" button, inline result display |
| `src/App.tsx` (or layout) | `backup-auth-error` event listener + toast |

## Out of Scope

- Background periodic health checks — detection is reactive (on actual sync failure)
- Cached test results / 24h skip — can be added later if saves feel slow
- Credential expiry prediction — no provider APIs expose token TTLs reliably
- Retry on auth failure — user must manually fix credentials
