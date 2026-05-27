# F-3-7: Backup Connectivity Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify backup credentials before saving, classify sync errors by kind, and surface auth failures as toasts.

**Architecture:** New `ConnectionTestResult` enum in folio-core classifies connectivity outcomes. `test_connection()` probes list + write on the remote. `save_backup_config` auto-tests before persisting, rolling back keychain on failure. Sync errors carry `opendal::ErrorKind` for structured classification, emitting `backup-auth-error` events that the frontend shows as toasts.

**Tech Stack:** Rust (folio-core + src-tauri), OpenDAL 0.55, React 19, Tauri v2 IPC + event system, existing Toast component.

**Important note on OpenDAL 0.55 ErrorKind:** There is no `Unauthorized` variant. Auth failures surface as `PermissionDenied` or `Unexpected`. The `test_connection` function distinguishes auth vs. write-permission by *which operation* failed: `list("/")` failure → auth problem; `write` failure → write-permission problem.

---

### Task 1: Add `ConnectionTestResult` enum and `classify_opendal_error` to folio-core

**Files:**
- Modify: `folio-core/src/backup.rs` (add after `BackupConfig` struct, ~line 108)

- [ ] **Step 1: Add the `ConnectionTestResult` enum**

Add after the `BackupConfig` struct definition in `backup.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum ConnectionTestResult {
    Ok { latency_ms: u64 },
    AuthFailed { message: String },
    PermissionDenied { message: String },
    NetworkError { message: String },
    Timeout,
}
```

- [ ] **Step 2: Add the `classify_opendal_error` function**

Add below the enum:

```rust
pub fn classify_opendal_error(err: &opendal::Error) -> ConnectionTestResult {
    match err.kind() {
        opendal::ErrorKind::PermissionDenied => ConnectionTestResult::AuthFailed {
            message: err.to_string(),
        },
        opendal::ErrorKind::ConfigInvalid => ConnectionTestResult::NetworkError {
            message: err.to_string(),
        },
        opendal::ErrorKind::NotFound => ConnectionTestResult::NetworkError {
            message: err.to_string(),
        },
        _ => ConnectionTestResult::NetworkError {
            message: err.to_string(),
        },
    }
}
```

Note: This classifies all `PermissionDenied` as `AuthFailed` by default. The `test_connection` function (Task 2) overrides this for write-specific failures.

- [ ] **Step 3: Verify it compiles**

Run from project root:
```bash
cargo check -p folio-core
```
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add folio-core/src/backup.rs
git commit -m "feat(core/backup): add ConnectionTestResult enum and classify_opendal_error"
```

---

### Task 2: Add `test_connection` and `remove_secrets` to folio-core

**Files:**
- Modify: `folio-core/src/backup.rs` (add after `classify_opendal_error`)

- [ ] **Step 1: Write tests for `test_connection` with Fs provider**

Add to the bottom of `backup.rs` inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn test_connection_ok_with_fs_provider() {
    let dir = tempfile::tempdir().unwrap();
    let mut values = std::collections::HashMap::new();
    values.insert("root".to_string(), dir.path().to_string_lossy().to_string());
    let config = BackupConfig {
        provider_type: ProviderType::Fs,
        values,
    };
    let result = test_connection(&config);
    match result {
        ConnectionTestResult::Ok { latency_ms } => {
            assert!(latency_ms < 5000, "latency should be reasonable");
        }
        other => panic!("Expected Ok, got {:?}", other),
    }
    // Sentinel file should be cleaned up
    assert!(!dir.path().join(".folio-connection-test").exists());
}

#[test]
fn test_connection_network_error_bad_path() {
    let mut values = std::collections::HashMap::new();
    values.insert("root".to_string(), "/nonexistent/path/that/does/not/exist".to_string());
    let config = BackupConfig {
        provider_type: ProviderType::Fs,
        values,
    };
    let result = test_connection(&config);
    match result {
        ConnectionTestResult::NetworkError { .. } | ConnectionTestResult::PermissionDenied { .. } => {}
        ConnectionTestResult::Ok { .. } => panic!("Expected error for nonexistent path"),
        other => panic!("Expected NetworkError or PermissionDenied, got {:?}", other),
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p folio-core test_connection -- --nocapture
```
Expected: FAIL — `test_connection` function not found.

- [ ] **Step 3: Implement `test_connection`**

Add after `classify_opendal_error` in `backup.rs`:

```rust
pub fn test_connection(config: &BackupConfig) -> ConnectionTestResult {
    let start = std::time::Instant::now();

    let op = match build_operator(config) {
        Ok(op) => op,
        Err(e) => {
            return ConnectionTestResult::NetworkError {
                message: e.to_string(),
            }
        }
    };

    // Step 1: List root — confirms authentication
    if let Err(e) = op.list("/") {
        return classify_opendal_error(&e);
    }

    // Step 2: Write sentinel — confirms write permission
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    if let Err(e) = op.write(".folio-connection-test", timestamp.into_bytes()) {
        return ConnectionTestResult::PermissionDenied {
            message: e.to_string(),
        };
    }

    // Step 3: Cleanup — best-effort, don't fail on delete errors
    let _ = op.delete(".folio-connection-test");

    let latency_ms = start.elapsed().as_millis() as u64;
    ConnectionTestResult::Ok { latency_ms }
}
```

- [ ] **Step 4: Implement `remove_secrets`**

Add after `load_secrets` in `backup.rs`:

```rust
pub fn remove_secrets(config: &BackupConfig) -> FolioResult<()> {
    let secrets = secret_keys(&config.provider_type);
    for key in &secrets {
        let service = format!("folio-backup-{:?}-{}", config.provider_type, key);
        if let Ok(entry) = keyring::Entry::new(&service, "default") {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p folio-core test_connection -- --nocapture
```
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add folio-core/src/backup.rs
git commit -m "feat(core/backup): add test_connection and remove_secrets functions"
```

---

### Task 3: Add `test_backup_connection` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add after `save_backup_config`)
- Modify: `src-tauri/src/lib.rs` (register new command)

- [ ] **Step 1: Add the command in `commands.rs`**

Add after the existing `save_backup_config` function (~line 3980):

```rust
#[tauri::command]
pub async fn test_backup_connection(
    config: crate::backup::BackupConfig,
) -> Result<crate::backup::ConnectionTestResult, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::backup::test_connection(&config);
        let _ = tx.send(result);
    });
    rx.recv()
        .map_err(|e| format!("Connection test failed: {e}"))
}
```

- [ ] **Step 2: Register in `lib.rs` invoke handler**

Add `commands::test_backup_connection` to the `tauri::generate_handler!` list, next to the existing `commands::save_backup_config` entry:

```rust
commands::save_backup_config,
commands::test_backup_connection,  // ← add this line
commands::get_backup_config,
```

- [ ] **Step 3: Verify it compiles**

```bash
cargo check -p folio
```
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add test_backup_connection Tauri command"
```

---

### Task 4: Modify `save_backup_config` to auto-test and return `ConnectionTestResult`

**Files:**
- Modify: `src-tauri/src/commands.rs` (~lines 3971-3980)

- [ ] **Step 1: Replace the existing `save_backup_config` function**

Replace the function at ~lines 3971-3980:

```rust
#[tauri::command]
pub async fn save_backup_config(
    config: crate::backup::BackupConfig,
    state: State<'_, AppState>,
) -> Result<crate::backup::ConnectionTestResult, String> {
    // Store secrets in OS keychain first
    let clean = crate::backup::store_secrets(&config).map_err(|e| e.to_string())?;

    // Test connection with the original config (secrets still in values map)
    let (tx, rx) = std::sync::mpsc::channel();
    let test_config = config.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::backup::test_connection(&test_config);
        let _ = tx.send(result);
    });
    let test_result = rx.recv().map_err(|e| format!("Connection test failed: {e}"))?;

    match &test_result {
        crate::backup::ConnectionTestResult::Ok { .. } => {
            // Test passed — persist clean config to DB
            let conn = state.active_db().map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
            let json = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
            db::set_setting(&conn, "backup_config", &json).map_err(|e| e.to_string())?;
        }
        _ => {
            // Test failed — rollback keychain entries
            let _ = crate::backup::remove_secrets(&config);
        }
    }

    Ok(test_result)
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cargo check -p folio
```
Expected: compiles with no errors. The return type changed from `FolioResult<()>` to `Result<ConnectionTestResult, String>` — the frontend will be updated in Task 6 to handle this.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): save_backup_config auto-tests connection before persisting"
```

---

### Task 5: Extend `SyncError::Transport` and classify sync errors

**Files:**
- Modify: `folio-core/src/sync.rs` (~lines 62-82)
- Modify: `src-tauri/src/commands.rs` (sync_pull_book ~line 5340, sync_push_book ~line 5420)

- [ ] **Step 1: Write test for the new `SyncError::Transport` variant**

In `folio-core/src/sync.rs`, find the existing `sync_error_display` test and update it. The current test creates `SyncError::Transport("connection refused".to_string())`. Replace it to use the new struct variant:

```rust
#[test]
fn sync_error_display() {
    let transport = SyncError::Transport {
        message: "connection refused".to_string(),
        kind: None,
    };
    assert!(transport.to_string().contains("connection refused"));

    let transport_with_kind = SyncError::Transport {
        message: "access denied".to_string(),
        kind: Some(opendal::ErrorKind::PermissionDenied),
    };
    assert!(transport_with_kind.to_string().contains("access denied"));
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p folio-core sync_error_display -- --nocapture
```
Expected: FAIL — struct variant doesn't match current tuple variant.

- [ ] **Step 3: Change `SyncError::Transport` to struct variant**

In `sync.rs`, replace the enum definition (~line 62):

```rust
#[derive(Debug)]
pub enum SyncError {
    Transport {
        message: String,
        kind: Option<opendal::ErrorKind>,
    },
    Timeout,
    Malformed(String),
}
```

Update the `Display` impl:

```rust
impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Transport { message, .. } => write!(f, "Transport error: {message}"),
            SyncError::Timeout => write!(f, "Sync operation timed out"),
            SyncError::Malformed(msg) => write!(f, "Malformed sync data: {msg}"),
        }
    }
}
```

Update the `From<SyncError> for FolioError` impl:

```rust
impl From<SyncError> for crate::error::FolioError {
    fn from(e: SyncError) -> Self {
        use crate::error::FolioError;
        match e {
            SyncError::Transport { message, .. } => FolioError::network(message),
            SyncError::Timeout => FolioError::network("Sync operation timed out"),
            SyncError::Malformed(msg) => FolioError::invalid(format!("Malformed sync data: {msg}")),
        }
    }
}
```

- [ ] **Step 4: Update all `SyncError::Transport` construction sites in `sync.rs`**

Line 325 — in `fetch_remote_sync`:
```rust
Err(e) => {
    let kind = Some(e.kind());
    return Err(SyncError::Transport {
        message: format!("Failed to read {path}: {e}"),
        kind,
    });
}
```

Line 347 — in `push_remote_sync`:
```rust
op.write(&path, json.into_bytes()).map_err(|e| {
    let kind = Some(e.kind());
    SyncError::Transport {
        message: format!("Failed to write {path}: {e}"),
        kind,
    }
})?;
```

- [ ] **Step 5: Update `friendly_sync_error` in commands.rs to use struct pattern**

In `src-tauri/src/commands.rs` (~line 5259), update the pattern match:

```rust
crate::sync::SyncError::Transport { .. } => {
    "Could not reach remote storage. Check your internet connection and backup settings."
        .to_string()
}
```

- [ ] **Step 6: Add `sync_error_kind_str` helper in commands.rs**

Add near `friendly_sync_error` (~line 5254):

```rust
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
```

- [ ] **Step 7: Classify errors in `sync_pull_book`**

In `sync_pull_book` (~line 5340), find the `Ok(Err(e))` arm and add error kind storage + event emission. Replace the existing error handling block:

```rust
Ok(Err(e)) => {
    let msg = friendly_sync_error(&e);
    let kind = sync_error_kind_str(&e);
    let _ = db::set_setting(&conn, "last_sync_error_at", &now_unix_secs().to_string());
    let _ = db::set_setting(&conn, "last_sync_error_message", &msg);
    let _ = db::set_setting(&conn, "last_sync_error_kind", kind);
    if kind == "auth_failed" || kind == "permission_denied" {
        let _ = app.emit("backup-auth-error", serde_json::json!({ "message": msg }));
    }
    log_activity(
        &conn,
        "sync_pull_failed",
        "book",
        Some(&book_id),
        Some(&book.title),
        Some(&e.to_string()),
    );
}
```

- [ ] **Step 8: Classify errors in `sync_push_book`**

In `sync_push_book`, find the error handling inside the `spawn_blocking` closure where `sync_book_on_close` fails. The error is a `SyncError`. Add kind classification in the `Err` match arm. Find the block that logs `sync_push_failed` and add:

```rust
Err(e) => {
    let msg = friendly_sync_error(&e);
    let kind = sync_error_kind_str(&e);
    let _ = db::set_setting(&bg_conn, "last_sync_error_at", &now_unix_secs().to_string());
    let _ = db::set_setting(&bg_conn, "last_sync_error_message", &msg);
    let _ = db::set_setting(&bg_conn, "last_sync_error_kind", kind);
    log_activity(
        &bg_conn,
        "sync_push_failed",
        "book",
        Some(&book_id),
        Some(&book_title),
        Some(&e.to_string()),
    );
}
```

Note: `sync_push_book` is fire-and-forget (no `app` handle in the closure). It cannot emit events. Auth failure toasts from push errors will surface on the next `sync_pull_book` call instead, which does have the `app` handle.

- [ ] **Step 9: Run tests**

```bash
cargo test -p folio-core sync_error_display -- --nocapture
cargo check -p folio
```
Expected: test passes, full crate compiles.

- [ ] **Step 10: Commit**

```bash
git add folio-core/src/sync.rs src-tauri/src/commands.rs
git commit -m "feat(sync): classify sync errors by kind and emit backup-auth-error events"
```

---

### Task 6: Frontend — "Save & Test" flow and "Test Connection" button

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add `ConnectionTestResult` TypeScript type**

At the top of `SettingsPanel.tsx` with other type definitions, add:

```typescript
interface ConnectionTestResult {
  status: "Ok" | "AuthFailed" | "PermissionDenied" | "NetworkError" | "Timeout";
  latency_ms?: number;
  message?: string;
}
```

- [ ] **Step 2: Add state for test result display**

Near the other backup state declarations:

```typescript
const [testingConnection, setTestingConnection] = useState(false);
const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(null);
```

- [ ] **Step 3: Add `connectionResultMessage` helper**

Add near the other helper functions in the component:

```typescript
const connectionResultMessage = (result: ConnectionTestResult): { text: string; isError: boolean } => {
  switch (result.status) {
    case "Ok":
      return { text: t("settings.connected", { ms: result.latency_ms ?? 0 }), isError: false };
    case "AuthFailed":
      return { text: t("settings.authFailed"), isError: true };
    case "PermissionDenied":
      return { text: t("settings.writePermissionDenied"), isError: true };
    case "NetworkError":
      return { text: result.message || t("settings.networkError"), isError: true };
    case "Timeout":
      return { text: t("settings.connectionTimeout"), isError: true };
  }
};
```

- [ ] **Step 4: Update `handleSaveBackupConfig` to handle `ConnectionTestResult`**

Replace the existing handler (~lines 886-911):

```typescript
const handleSaveBackupConfig = async () => {
  if (!selectedProvider || !currentProviderInfo) return;
  const missing = currentProviderInfo.fields.filter(
    (f) => f.required && !backupFieldValues[f.key]?.trim()
  );
  if (missing.length > 0) {
    setRemoteBackupMessage(`Required: ${missing.map((f) => f.label).join(", ")}`);
    return;
  }
  setSavingBackupConfig(true);
  setRemoteBackupMessage(null);
  setConnectionTestResult(null);
  try {
    const config: BackupConfig = {
      providerType: selectedProvider,
      values: backupFieldValues,
    };
    const result = await invoke<ConnectionTestResult>("save_backup_config", { config });
    setConnectionTestResult(result);
    if (result.status === "Ok") {
      setSavedBackupConfig(config);
      const { text } = connectionResultMessage(result);
      setRemoteBackupMessage(text);
    } else {
      const { text } = connectionResultMessage(result);
      setRemoteBackupMessage(text);
    }
  } catch (err) {
    setRemoteBackupMessage(t("settings.saveFailed", { error: friendlyError(err, t) }));
  } finally {
    setSavingBackupConfig(false);
  }
};
```

- [ ] **Step 5: Add `handleTestConnection` function**

Add after `handleSaveBackupConfig`:

```typescript
const handleTestConnection = async () => {
  if (!savedBackupConfig) return;
  setTestingConnection(true);
  setConnectionTestResult(null);
  setRemoteBackupMessage(null);
  try {
    const config = await invoke<BackupConfig | null>("get_backup_config");
    if (!config) {
      setRemoteBackupMessage(t("settings.noConfigSaved"));
      return;
    }
    const result = await invoke<ConnectionTestResult>("test_backup_connection", { config });
    setConnectionTestResult(result);
    const { text } = connectionResultMessage(result);
    setRemoteBackupMessage(text);
  } catch (err) {
    setRemoteBackupMessage(t("settings.testFailed", { error: friendlyError(err, t) }));
  } finally {
    setTestingConnection(false);
  }
};
```

- [ ] **Step 6: Update save button text and add Test Connection button**

In the JSX, find the save config button and update its text:

```tsx
<button
  onClick={handleSaveBackupConfig}
  disabled={savingBackupConfig || !selectedProvider}
  className="w-full px-3 py-2 text-sm font-medium bg-accent text-surface rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
>
  {savingBackupConfig ? t("settings.testingConnection") : t("settings.saveAndTest")}
</button>
```

Add the Test Connection button after the "Backup Now" button, inside the `{savedBackupConfig && (...)}` block:

```tsx
{savedBackupConfig && (
  <button
    onClick={handleTestConnection}
    disabled={testingConnection || runningBackup}
    className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40 flex items-center gap-2"
  >
    {testingConnection && (
      <svg className="animate-spin w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
    )}
    {testingConnection ? t("settings.testingConnection") : t("settings.testConnection")}
  </button>
)}
```

- [ ] **Step 7: Color-code the status message**

Find the status message display (`{remoteBackupMessage && ...}`) and update to use color based on test result:

```tsx
{remoteBackupMessage && (
  <p className={`text-xs px-1 ${connectionTestResult && connectionTestResult.status !== "Ok" ? "text-red-500" : connectionTestResult?.status === "Ok" ? "text-green-600" : "text-ink-muted"}`}>
    {remoteBackupMessage}
  </p>
)}
```

- [ ] **Step 8: Add translation keys**

Find the i18n translation file (likely `src/i18n/` or inline translations) and add keys. If translations are inline in the component via a `t()` function backed by a translations object, add:

```
settings.saveAndTest → "Save & Test"
settings.testConnection → "Test Connection"
settings.testingConnection → "Testing connection…"
settings.connected → "Connected ({{ms}}ms)"
settings.authFailed → "Authentication failed — check your credentials"
settings.writePermissionDenied → "Write permission denied — check bucket/folder permissions"  
settings.networkError → "Could not connect to remote storage"
settings.connectionTimeout → "Connection timed out"
settings.noConfigSaved → "No backup configuration saved"
settings.testFailed → "Connection test failed: {{error}}"
```

Locate the translations file by searching for existing keys like `settings.configSaved` and add the new keys in the same file/pattern.

- [ ] **Step 9: Verify the frontend compiles**

```bash
npm run type-check
```
Expected: no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/SettingsPanel.tsx src/i18n/
git commit -m "feat(ui): add Save & Test flow and Test Connection button to backup settings"
```

---

### Task 7: Frontend — Auth failure toast on sync errors

**Files:**
- Modify: `src/App.tsx` (inside `AppShell` component)

- [ ] **Step 1: Add auth error listener in `AppShell`**

In `AppShell`, add imports at the top of the file:

```typescript
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useToast } from "./components/Toast";
```

Note: `useState`, `useCallback` are already imported. Add `useEffect` and `useRef` to the existing import if not present. Check existing imports first.

- [ ] **Step 2: Add the event listener inside `AppShell`**

Inside the `AppShell` function, after the existing state declarations:

```typescript
const { addToast } = useToast();
const authErrorShown = useRef(false);

useEffect(() => {
  const unlisten = listen<{ message: string }>("backup-auth-error", () => {
    if (authErrorShown.current) return;
    authErrorShown.current = true;
    addToast(t("toast.backupAuthFailed"), "error");
  });
  return () => { unlisten.then((fn) => fn()); };
}, [addToast]);
```

Note: `t` function must be available in `AppShell`. If i18n isn't used in App.tsx, use a hardcoded string: `"Backup authentication failed — check credentials in Settings"`.

- [ ] **Step 3: Add translation key for the toast**

In the translations file:

```
toast.backupAuthFailed → "Backup authentication failed — check credentials in Settings"
```

- [ ] **Step 4: Verify the frontend compiles**

```bash
npm run type-check
```
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/i18n/
git commit -m "feat(ui): add backup auth failure toast on sync errors"
```

---

### Task 8: Full integration verification

**Files:** None (verification only)

- [ ] **Step 1: Run Rust tests**

```bash
cd src-tauri && cargo test && cd ..
```
Expected: all tests pass.

- [ ] **Step 2: Run Rust lints**

```bash
cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check && cd ..
```
Expected: no warnings or format issues.

- [ ] **Step 3: Run frontend checks**

```bash
npm run type-check && npm run test
```
Expected: no type errors, all tests pass.

- [ ] **Step 4: Manual verification with `npm run tauri dev`**

Start the app and verify:

1. **Save & Test flow:** Go to Settings → Remote Backup. Enter valid credentials for any provider (Filesystem is easiest — just enter a local directory path). Click "Save & Test". Should see green "Connected (Xms)" message. Config should be saved.

2. **Save & Test with bad credentials:** Enter an invalid path/credential. Click "Save & Test". Should see red error message. Config should NOT be saved (verify by reloading settings — old config should still be there, or no config if first time).

3. **Test Connection button:** With a saved config, click "Test Connection". Should see spinner then result message.

4. **Auth failure toast:** This requires a sync failure with auth error. To test: save a valid config, enable sync, then change the remote credentials externally (e.g., change the directory permissions). Open a book to trigger sync. Should see error toast in library view.

- [ ] **Step 5: Commit any fixups**

If any issues found during manual testing, fix and commit with descriptive messages.
