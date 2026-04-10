# PR Review: feat-web-server-step3-auth-middleware
**Date:** 2026-04-10 22:30
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 244
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

(Codex encountered an error this round)

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Web server defaults to unauthenticated access if no PIN is configured, creating a potential security vulnerability.

## Detailed Findings

### 1. Default Unauthenticated Web Server Access

*   **File:** `src-tauri/src/web_server/auth.rs`
*   **Line numbers:** 126-135
*   **What can go wrong:** If the application's web server is enabled and binds to any network interface other than `127.0.0.1` (e.g., `0.0.0.0` or a specific LAN IP), and the user has not configured a PIN, any entity on the network can access all web server endpoints without authentication. This could expose personal library data, reading progress, and other application functionalities. Even when bound to `127.0.0.1`, a user's system could have other services or configurations that inadvertently expose localhost ports.
*   **Why the code is vulnerable to this:** The `auth_middleware` explicitly checks if `state.pin_hash` is `None` (indicating no PIN is set) and, if so, allows the request to bypass all authentication checks (`return next.run(req).await;`). While the intention might be to facilitate initial setup or a completely unsecured local deployment, this design means the web server starts in a potentially vulnerable state by default, without explicit user consent for open access.
*   **Impact if it happens:** Unauthorized access to a user's entire library and potentially sensitive data. This is a significant privacy and security risk, as an attacker on the same network could browse or extract personal information from the Folio instance.
*   **Fix recommendation:**
    1.  **Secure by Default:** Modify the `auth_middleware` to *always* require authentication. If `pin_hash` is `None`, instead of allowing open access, the server should respond with a `401 Unauthorized` status. For browser requests, consider a redirect to an internal page prompting the user to set up a PIN.
    2.  **Explicit Opt-In:** If unauthenticated access is a desired feature (e.g., for specific local network sharing scenarios), it must be an explicit opt-in setting in the application's configuration, accompanied by clear security warnings to the user about the implications.
    3.  **Binding Configuration:** Ensure the web server *defaults* to binding only to `127.0.0.1` (localhost). Allow binding to `0.0.0.0` or other network interfaces only through explicit user configuration, again with prominent security warnings.
*   **Severity:** BLOCKING
*   **Fixable:** NO (Requires design decisions regarding default security posture, user experience for first-time setup, and potentially UI/UX changes for configuration and warnings).

### 2. Verbose Internal Error Message on Mutex Poisoning

*   **File:** `src-tauri/src/web_server/api.rs`
*   **Line numbers:** 37-38 (`.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?`)
*   **What can go wrong:** If the `pin_hash` mutex becomes poisoned (e.g., due to a panic in a thread holding the lock), the `login` endpoint will return a `500 INTERNAL_SERVER_ERROR` with a detailed error message derived from the `PoisonError`. This message typically includes internal details about the mutex state.
*   **Why the code is vulnerable to this:** The `e.to_string()` call directly serializes the internal Rust error into the HTTP response body. While mutex poisoning is an extreme case, exposing any raw internal error details can inadvertently provide information to an attacker about the application's internal structure or potential weak points.
*   **Impact if it happens:** Minor information leakage. In a desktop application served locally, the risk is low, but it's a general security best practice to avoid exposing raw backend error messages to clients.
*   **Fix recommendation:** Replace `e.to_string()` with a generic, non-descriptive error message for the client (e.g., "Internal server error: authentication system temporarily unavailable.") and ensure the detailed error is logged internally for debugging.
*   **Severity:** SUGGESTION
*   **Fixable:** YES

---


## [Claude — Implementer] Round 1

All 18 tests pass.

---

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Default unauthenticated access when no PIN set | Gemini | **No fix** (Fixable: NO) | Valid concern, but requires design decisions about default security posture and setup UX. The web server is user-initiated, binding to `0.0.0.0` is intentional for LAN access, and "no PIN = open" is a common pattern in personal media servers. This is a product decision for the project owner. |
| Verbose error message on mutex poisoning | Gemini | **Fixed** | Agreed — replaced `e.to_string()` with a generic "Internal server error" message at `api.rs:40`. Low risk but good hygiene; no internal details should leak to HTTP clients. |

---

