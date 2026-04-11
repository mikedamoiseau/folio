# PR Review: fix-web-server-critical-findings
**Date:** 2026-04-11 11:17
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 627
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: the new login rate limit can still be bypassed, so the PIN remains brute-forceable over the LAN server.

1. **File:** [src-tauri/src/web_server/api.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/api.rs:55), [src-tauri/src/web_server/mod.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/mod.rs:82)  
**What:** A remote client can evade the new per-IP limiter by sending arbitrary `X-Forwarded-For` values on each `/api/auth` request.  
**Why:** The server binds directly to `0.0.0.0` and is not behind a trusted reverse proxy, but `login()` treats `X-Forwarded-For` as authoritative client identity. On a direct socket, that header is fully attacker-controlled.  
**Impact:** An attacker on the LAN can rotate spoofed header values and get effectively unlimited PIN guesses, defeating the intended brute-force protection.  
**Fix:** Derive the peer IP from the connection metadata (`ConnectInfo<SocketAddr>` / `into_make_service_with_connect_info`) and only honor `X-Forwarded-For` when requests come through an explicitly trusted proxy.  
**Severity:** BLOCKING  
**Fixable:** YES

2. **File:** [src-tauri/src/web_server/api.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/api.rs:63), [src-tauri/src/web_server/api.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/api.rs:92), [src-tauri/src/web_server/auth.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/auth.rs:31)  
**What:** The limiter can also be bypassed with concurrent login attempts from the same client.  
**Why:** `check()` and `record_failure()` are separate operations on separate lock acquisitions. If an attacker fires many bad PIN requests in parallel, multiple requests can all pass `check()` before any of them records its failure.  
**Impact:** The advertised `5 attempts / 300s` ceiling is not enforced under load; a client can burst well past the limit and accelerate brute-force attempts.  
**Fix:** Make the rate-limit decision atomic, e.g. replace the split `check()`/`record_failure()` flow with one method that prunes, counts, and records the attempt under a single lock before returning allow/deny.  
**Severity:** BLOCKING  
**Fixable:** YES

No other blocking issue in this diff stood out beyond those auth bypasses.

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: Login rate limit can be bypassed by spoofing X-Forwarded-For header, rendering it ineffective against brute-force attacks.

## Detailed Findings

### 1. Login Rate Limit Bypass via Spoofed X-Forwarded-For Header

*   **File:** `src-tauri/src/web_server/api.rs`
*   **Line(s):** 53-57
*   **What can go wrong:** An attacker can easily bypass the login rate limiting mechanism by crafting requests with different, spoofed `X-Forwarded-For` HTTP header values. Since the web server is part of a desktop application, it's highly unlikely to be deployed behind a trusted reverse proxy that correctly sets and validates this header. Therefore, the `X-Forwarded-For` header is untrustworthy as it is user-controlled.
*   **Why the code is vulnerable:** The `client_ip` used for rate limiting is extracted directly from the `X-Forwarded-For` header, which an attacker can manipulate at will.
*   **Impact if it happens:** The implemented rate limiting mechanism for login attempts becomes ineffective. An attacker can perform an unlimited number of login attempts with incorrect PINs by cycling through different spoofed IP addresses in the `X-Forwarded-For` header. This makes the web server vulnerable to brute-force attacks on the PIN, potentially leading to unauthorized access if the PIN is weak or eventually guessed.
*   **Fix recommendation:** For a web server intended for direct client connections (not behind a trusted proxy), the actual peer IP address from the TCP connection should be used for rate limiting.
    1.  In `src-tauri/src/web_server/mod.rs`, modify the `app` initialization to use `into_make_service_with_connect_info` to enable `ConnectInfo` extraction:
        ```rust
        // In src-tauri/src/web_server/mod.rs, inside start function
        let app = Router::new()
            .route("/api/login", post(api::login))
            // ... other routes
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.map_err(|e| e.to_string())?;
        ```
    2.  In `src-tauri/src/web_server/api.rs`, modify the `login` function signature to accept `ConnectInfo<std::net::SocketAddr>` and use the extracted IP:
        ```rust
        // In src-tauri/src/web_server/api.rs
        async fn login(
            ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>, // Add this extractor
            State(state): State<WebState>,
            req: axum::extract::Request,
        ) -> Result<Response, (StatusCode, String)> {
            let client_ip = addr.ip().to_string(); // Use the actual peer IP
            // ... rest of the login logic
        }
        ```
*   **Severity:** BLOCKING
*   **Fixable:** YES

### 2. Login Rate Limit Incomplete for Malformed Requests

*   **File:** `src-tauri/src/web_server/api.rs`
*   **Line(s):** 60-63, 67
*   **What can go wrong:** The `record_failure` method of the `RateLimiter` is only called if the PIN is invalid (`!valid`). If a client sends a login request with a malformed JSON body (e.g., invalid syntax, missing fields), the request will fail at the `serde_json::from_slice` step (lines 60-63), and the `record_failure` function will not be invoked. This means an attacker can send an unlimited number of malformed login attempts without being subjected to the rate limit.
*   **Why the code is vulnerable:** The condition for recording a failed login attempt is too narrow, excluding failures that occur before PIN validation.
*   **Impact if it happens:** While this doesn't directly bypass the PIN brute-force protection (as they still can't log in without a correct PIN), it allows an attacker to consume server resources with arbitrary invalid requests without being rate-limited. This could potentially contribute to a denial-of-service attack or make it harder to detect malicious activity if the attacker cycles through request types (malformed JSON vs. valid JSON with wrong PIN).
*   **Fix recommendation:** Ensure `record_failure` is called for any failed login attempt within the `login` function. Modify the error handling for `axum::body::to_bytes` and `serde_json::from_slice` to call `state.login_limiter.record_failure(&client_ip);` before returning the error.
    ```rust
    // In src-tauri/src/web_server/api.rs, inside login function
    let body: LoginRequest = {
        let bytes = axum::body::to_bytes(req.into_body(), 1024)
            .await
            .map_err(|_| {
                state.login_limiter.record_failure(&client_ip); // Record failure for bad body
                (StatusCode::BAD_REQUEST, "Invalid request body".to_string())
            })?;
        serde_json::from_slice(&bytes)
            .map_err(|_| {
                state.login_limiter.record_failure(&client_ip); // Record failure for bad JSON
                (StatusCode::BAD_REQUEST, "Invalid JSON".to_string())
            })?
    };
    // ...
    // Existing call for invalid PIN:
    if !valid {
        state.login_limiter.record_failure(&client_ip);
        return Err((StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }
    ```
*   **Severity:** SUGGESTION
*   **Fixable:** YES

---


## [Claude — Implementer] Round 1

All changes look correct. Here's the analysis and summary:

---

## Issue-by-Issue Analysis

### Issue 1: X-Forwarded-For spoofing (Codex #1 + Gemini #1) — FIXED

**Raised by:** Both reviewers (majority confirmed)

Both reviewers correctly identified that `X-Forwarded-For` is fully attacker-controlled when the server binds directly to `0.0.0.0` with no reverse proxy. An attacker could rotate spoofed header values to get unlimited PIN guesses.

**Fix:** Replaced `X-Forwarded-For` extraction with `ConnectInfo<SocketAddr>` from axum, which provides the actual TCP peer address. Updated `axum::serve()` to use `into_make_service_with_connect_info::<SocketAddr>()` in both production code and all tests.

### Issue 2: TOCTOU race in check/record_failure (Codex #2) — FIXED

**Raised by:** Codex only. **I agree.**

The split `check()` / `record_failure()` pattern used two separate lock acquisitions. Under concurrent requests, N requests from the same IP could all pass `check()` before any recorded their failure, allowing burst past the limit.

**Fix:** Replaced with atomic `attempt()` method that prunes, checks, and records under a single lock acquisition. Added `clear()` method called on successful login to reset the counter. This also addresses Gemini's Issue 2 as a side effect (malformed requests now consume an attempt slot since the attempt is recorded before body parsing).

### Issue 3: Malformed requests not rate-limited (Gemini #2) — FIXED (side effect)

**Raised by:** Gemini only. **I partially agree.**

While malformed requests can't guess the PIN, the atomic `attempt()` approach naturally fixes this: the attempt is recorded *before* body parsing, so junk payloads consume an attempt slot. No additional code was needed.

---

## Summary Table

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| X-Forwarded-For spoofing bypasses rate limit | Both (Codex + Gemini) | **Fixed** — use `ConnectInfo<SocketAddr>` for peer IP | Majority confirmed. Server binds directly, header is attacker-controlled. |
| TOCTOU race in check/record_failure | Codex only | **Fixed** — atomic `attempt()` method | Agree. Concurrent requests could burst past limit under separate locks. |
| Malformed requests not rate-limited | Gemini only | **Fixed** (side effect of atomic approach) | Partially agree. Attempt is now recorded before body parsing. |

---


## [Codex — Reviewer] Round 2

NEEDS_FIX: the PIN is still brute-forceable through the unthrottled HTTP Basic Auth path, so the login limiter does not fully protect the web server.

1. **File:** [src-tauri/src/web_server/auth.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/auth.rs:143), [src-tauri/src/web_server/auth.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/auth.rs:181), [src-tauri/src/web_server/api.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/api.rs:51)  
**What:** A remote client can bypass the new `/api/auth` rate limit entirely by sending repeated `Authorization: Basic ...` requests with guessed PINs to a protected route such as `/opds` (and, as written, any non-public route).  
**Why:** The new limiter is only enforced inside `login()` for `/api/auth`, but `auth_middleware()` independently accepts the raw PIN from Basic Auth and verifies it directly without consulting `login_limiter`. That leaves a second authentication path with no throttling.  
**Impact:** An attacker on the LAN can brute-force the PIN by hitting Basic-authenticated endpoints instead of `/api/auth`, so the core security issue remains.  
**Fix:** Apply the same rate limiting to Basic Auth verification, keyed by the real peer IP, or restrict Basic Auth to a narrower flow that cannot be used for repeated PIN guesses. If OPDS must keep Basic Auth, move PIN verification behind a shared throttled helper so both `/api/auth` and middleware enforce the same ceiling.  
**Severity:** BLOCKING  
**Fixable:** YES

---

## [Gemini — Reviewer] Round 2

NEEDS_FIX: The rate limiter remains vulnerable to a TOCTOU race condition and could be bypassed with concurrent login attempts.

## Detailed Findings

### 1. Login Rate Limit TOCTOU Race Condition Still Possible

*   **File:** `src-tauri/src/web_server/auth.rs`
*   **Line(s):** 28-56
*   **What can go wrong:** The `RateLimiter::attempt` method, intended to be atomic, still has a Time-of-Check to Time-of-Use (TOCTOU) race condition. Multiple concurrent requests can still increment the counter and update the timestamp before the check (`last_attempt.elapsed() > Duration::from_secs(300)`) effectively prunes old attempts for *all* concurrent requests.
*   **Why the code is vulnerable:** The `attempt` method first locks the mutex, then performs the check based on `last_attempt` and `attempts` count, and then updates them. However, for a burst of concurrent requests, each request will acquire the lock, see the *same* `last_attempt` and `attempts` values, potentially increment `attempts`, and update `last_attempt`. If multiple requests come in quickly within the `300s` window, they could all increment `attempts` past the `MAX_ATTEMPTS` before any `last_attempt` update triggers the reset for subsequent requests. The critical issue is that `last_attempt` is updated *after* the `attempts` count is potentially incremented within the same window, meaning previous concurrent requests might not see the `last_attempt` update from a slightly earlier concurrent request until after they've already passed their checks and incremented the counter.
*   **Impact if it happens:** The advertised `5 attempts / 300s` ceiling is not strictly enforced under load. An attacker can send a rapid burst of login attempts and bypass the rate limit, allowing more than 5 attempts within 300 seconds, accelerating brute-force attacks.
*   **Fix recommendation:** The rate limiting logic needs to be fully atomic such that the state (attempts, last\_attempt) is updated and then checked, or a single operation checks and then conditionally updates. A simpler and more robust approach is to:
    1.  Always record the attempt first, regardless of `MAX_ATTEMPTS`.
    2.  Then, check the conditions: if `attempts > MAX_ATTEMPTS` AND `last_attempt.elapsed() <= Duration::from_secs(300)`, then deny the request.
    3.  Reset `attempts` and `last_attempt` if `last_attempt.elapsed() > Duration::from_secs(300)` *before* checking the `MAX_ATTEMPTS` condition. This ensures that a new window correctly starts.

    Example (conceptual, might need adjustments for `RateLimiter` structure):

    ```rust
    // In src-tauri/src/web_server/auth.rs, inside RateLimiter
    pub fn attempt(&self, ip: &str) -> bool {
        let mut map = self.0.lock().unwrap();
        let entry = map.entry(ip.to_string()).or_insert_with(|| RateLimitEntry::new());

        // Always record the attempt immediately
        entry.attempts += 1;
        entry.last_attempt = Instant::now(); // Update timestamp with every attempt

        // Reset if the window has passed, even if MAX_ATTEMPTS was hit
        if entry.last_attempt.elapsed() > Duration::from_secs(300) {
             entry.attempts = 1; // Start a new window with the current attempt
        }

        // Only allow if within the limits after the potential reset
        entry.attempts <= MAX_ATTEMPTS
    }
    ```
*   **Severity:** BLOCKING
*   **Fixable:** YES

### 2. X-Forwarded-For Fix is Incomplete/Inconsistent

*   **File:** `src-tauri/src/web_server/mod.rs`, `src-tauri/src/web_server/api.rs`
*   **Line(s):** `mod.rs`: 83, `api.rs`: 53
*   **What can go wrong:** While the `login` function now correctly uses `ConnectInfo` to extract the client IP, the `axum::serve` setup in `src-tauri/src/web_server/mod.rs` still uses `app.into_make_service()` instead of `app.into_make_service_with_connect_info::<std::net::SocketAddr>()`. This means the `ConnectInfo` extractor in `api::login` will likely not receive the actual `SocketAddr` and might default to a placeholder or panic, rendering the fix ineffective for the production server.
*   **Why the code is vulnerable:** The server is not configured to provide `ConnectInfo` to the handlers, even though the handler expects it.
*   **Impact if it happens:** The `login` function's `ConnectInfo` will not correctly provide the client's socket address, falling back to an incorrect or default IP. This makes the `ConnectInfo` fix ineffective, potentially reintroducing the `X-Forwarded-For` bypass (if `X-Forwarded-For` is then relied upon as a fallback or if the placeholder IP is constant) or causing runtime errors.
*   **Fix recommendation:** Update `src-tauri/src/web_server/mod.rs` to use `into_make_service_with_connect_info` as originally suggested.

    ```rust
    // In src-tauri/src/web_server/mod.rs, inside start function
    let app = Router::new()
        .route("/api/login", post(api::login))
        // ... other routes
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    // CHANGE THIS LINE
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.map_err(|e| e.to_string())?;
    ```
*   **Severity:** BLOCKING
*   **Fixable:** YES

---


## [Claude — Implementer] Round 2

---

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| Basic Auth bypasses rate limiting | Codex only | **Fixed** — added `ConnectInfo` + rate limiter to `auth_middleware` Basic Auth path | Agree. Second unthrottled auth path allowed unlimited PIN guesses via `/opds`. |
| TOCTOU race in `RateLimiter::attempt` | Gemini only | **Pushed back** | Disagree. The entire method runs under a single `Mutex` lock — only one thread can execute at a time. There is no TOCTOU; the Mutex *is* the atomicity guarantee. |
| `into_make_service_with_connect_info` missing | Gemini only | **Pushed back** | Factually wrong. `mod.rs:95` already uses `into_make_service_with_connect_info::<SocketAddr>()`. This was fixed in Round 1. Gemini appears to be reviewing stale code. |

**Changes made:** One file modified (`auth.rs`) — added `ConnectInfo<SocketAddr>` extractor to `auth_middleware` and wired the Basic Auth PIN verification through the same `login_limiter.attempt()` / `clear()` flow used by `/api/auth`. All 268 tests pass, clippy clean.

---

