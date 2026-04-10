# PR Review: feat-web-server-step2-appstate-commands
**Date:** 2026-04-10 22:22
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 480
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

(Codex encountered an error this round)

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Web server PIN hash can become stale, leading to an authentication bypass.

### **File**: `src-tauri/src/commands.rs` (lines 3925-3970, `web_server_start` and `web_server_set_pin`)

-   **What can go wrong**: The web server's PIN hash, used for authentication, can become out of sync with the actual PIN stored in the keychain. If a user starts the web server (possibly without a PIN, or with a weak one) and then later sets or changes the PIN using `web_server_set_pin`, the running web server instance will continue to use the old (or non-existent) PIN hash for authentication.
-   **Why the code is vulnerable to this**:
    1.  In `web_server_start`, the `WebState` is initialized with `pin_hash` from `crate::web_server::auth::load_pin_hash()`. This is a snapshot of the PIN hash at the time the server starts.
    2.  `web_server_set_pin` correctly calls `crate::web_server::auth::store_pin()`, which updates the PIN in the system keychain. However, it *does not* propagate this change to the `pin_hash` `Arc<Mutex<Option<String>>>` held by the `WebState` of the *already running* web server.
    3.  Because the `auth_middleware` relies on the `WebState`'s `pin_hash`, it will continue to validate against the old, stale hash.
-   **Impact if it happens**: Authentication bypass. A user might believe they have secured their web server with a new PIN, but an attacker (or anyone who knew the old PIN/no PIN) could still gain access until the web server is manually restarted. This is a critical security vulnerability.
-   **Fix recommendation**: When `web_server_set_pin` is called, it should not only store the new PIN in the keychain but also acquire a lock on the `AppState`'s `web_server_handle`. If a server is running, it should then acquire a lock on the running server's `WebState`'s `pin_hash` `Arc<Mutex>` and update it with the newly hashed PIN.
    ```rust
    // In web_server_set_pin:
    pub async fn web_server_set_pin(pin: String, state: State<'_, AppState>) -> Result<(), String> {
        if pin.is_empty() {
            return Err("PIN cannot be empty".to_string());
        }
        crate::web_server::auth::store_pin(&pin)?; // Store in keychain
    
        // Update the pin hash in the running web server's state, if it exists
        if let Some(handle) = state.web_server_handle.lock().map_err(|e| e.to_string())?.as_ref() {
            let new_hash = crate::web_server::auth::hash_pin(&pin);
            *handle.web_state.pin_hash.lock().map_err(|e| e.to_string())? = Some(new_hash);
        }
        Ok(())
    }
    ```
    (Note: This fix recommendation assumes `WebServerHandle` can expose `WebState` or a mutable reference to its `pin_hash`. The current `WebServerHandle` definition in `src-tauri/src/web_server/mod.rs` would need to be updated to make the `WebState` accessible, perhaps by storing `Arc<WebState>` in the handle).
-   **Severity**: BLOCKING
-   **Fixable**: NO (requires design judgment on how to safely update the state of a running server process).

---

### **File**: `src-tauri/src/web_server/mod.rs` (lines 77-80, `start` function)

-   **What can go wrong**: The web server is hardcoded to bind to `0.0.0.0` (all network interfaces). This means it will listen for connections from any device on the network.
-   **Why the code is vulnerable to this**: There is no option for the user to specify a more restrictive binding address (e.g., `127.0.0.1` for localhost only). While exposing to the local network might be the desired default, forcing it without user control could lead to unintended exposure on less secure networks.
-   **Impact if it happens**: Increased attack surface. If the user is on a public or untrusted Wi-Fi network and starts the server, it could be accessible to other devices on that network, even if they only intended it for local use.
-   **Fix recommendation**: Add an optional `bind_address: Option<String>` parameter to the `web_server_start` command and the `crate::web_server::start` function. Default to `127.0.0.1` (localhost) for enhanced security, or `0.0.0.0` if the intention is broad local network access, but *always* provide a user-configurable option.
-   **Severity**: SUGGESTION
-   **Fixable**: NO (design choice).

---


## [Claude — Implementer] Round 1

## Review Analysis

Both issues were raised by **Gemini only** (Codex errored out), and both are marked **Fixable: NO**. Per the response rules, I will not attempt to fix them — I'll evaluate each and provide my perspective.

---

### Issue 1: PIN hash staleness in `web_server_set_pin`

**Raised by:** Gemini | **Severity:** BLOCKING | **Fixable:** NO

**My verdict: I agree this is a real bug.** Gemini's analysis is correct:

1. `web_server_start` creates a *new* `Arc::new(Mutex::new(pin_hash))` at `commands.rs:3951` — this `Arc` is only held by the spawned `WebState`
2. `web_server_set_pin` at `commands.rs:4014` only writes to the keychain via `store_pin()` — it doesn't even take `State<'_, AppState>` as a parameter
3. The `WebServerHandle` struct (`mod.rs:38-42`) holds only `shutdown_tx`, `url`, and `port` — no reference back to `WebState`

So there's no path from `set_pin` to the running server's `pin_hash`. If a user sets a PIN while the server is running, the server continues using the old (or empty) hash until restart.

**Recommended fix direction:** Store the `pin_hash` `Arc<Mutex<Option<String>>>` on `AppState` itself (alongside `shared_active_pool`), and share the same `Arc` into `WebState` when starting the server. Then `web_server_set_pin` takes `State<'_, AppState>` and updates the shared `Arc` directly. This avoids needing to reach through `WebServerHandle` at all — the same pattern already used for `shared_active_pool`.

Leaving this for the human to decide on the approach.

---

### Issue 2: `0.0.0.0` bind address

**Raised by:** Gemini | **Severity:** SUGGESTION | **Fixable:** NO

**My verdict: I disagree — the current design is correct.** The entire purpose of this web server is to serve the book library to other devices on the LAN (phones, tablets, e-readers via OPDS). Binding to `127.0.0.1` by default would make the feature useless for its primary use case. The PIN-based auth + session tokens are the security layer for network access.

A `bind_address` option could be a nice-to-have for power users, but defaulting to `127.0.0.1` would be actively wrong here. The current `0.0.0.0` default is the right call for a LAN-sharing feature.

---

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| PIN hash staleness in `web_server_set_pin` | Gemini | **Acknowledged, not fixed** (Fixable: NO) | Agree it's a real security bug. Recommend storing `pin_hash` Arc on `AppState` and sharing into `WebState`. Human decides on approach. |
| `0.0.0.0` bind address | Gemini | **Pushed back** | Binding to all interfaces is intentional — this is a LAN-sharing server. Localhost-only would defeat its purpose. PIN auth is the security boundary. |

---


## [Codex — Reviewer] Round 2

(Codex encountered an error this round)

---

## [Gemini — Reviewer] Round 2

NEEDS_FIX: Web server PIN hash can become stale, leading to an authentication bypass.

### **File**: `src-tauri/src/commands.rs` (lines 3925-3970, `web_server_start` and `web_server_set_pin`)

-   **What can go wrong**: The web server's PIN hash, used for authentication, can become out of sync with the actual PIN stored in the keychain. If a user starts the web server (possibly without a PIN, or with a weak one) and then later sets or changes the PIN using `web_server_set_pin`, the running web server instance will continue to use the old (or non-existent) PIN hash for authentication.
-   **Why the code is vulnerable to this**:
    1.  In `web_server_start`, the `WebState` is initialized with `pin_hash` from `crate::web_server::auth::load_pin_hash()`. This is a snapshot of the PIN hash at the time the server starts.
    2.  `web_server_set_pin` correctly calls `crate::web_server::auth::store_pin()`, which updates the PIN in the system keychain. However, it *does not* propagate this change to the `pin_hash` `Arc<Mutex<Option<String>>>` held by the `WebState` of the *already running* web server.
    3.  Because the `auth_middleware` relies on the `WebState`'s `pin_hash`, it will continue to validate against the old, stale hash.
-   **Impact if it happens**: Authentication bypass. A user might believe they have secured their web server with a new PIN, but an attacker (or anyone who knew the old PIN/no PIN) could still gain access until the web server is manually restarted. This is a critical security vulnerability.
-   **Fix recommendation**: The `pin_hash` `Arc<Mutex<Option<String>>>` should be stored on `AppState` (similar to `shared_active_pool`) and the same `Arc` should be passed to `WebState` when starting the server. This would allow `web_server_set_pin` to update the shared `Arc` directly, ensuring the running server uses the correct PIN hash without needing to restart.
-   **Severity**: BLOCKING
-   **Fixable**: NO (requires design judgment on how to safely update the state of a running server process).

---

