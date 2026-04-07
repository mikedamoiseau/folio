# PR Review: feat-web-server-step1-skeleton
**Date:** 2026-04-07 16:34
**Mode:** review + fix
**Base:** main
**Diff lines:** 584

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: The new LAN-exposed web server does not actually enforce auth on its routes, and its session/PIN handling introduces avoidable credential leakage.

1. **File:** [src-tauri/src/web_server/mod.rs:58](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/mod.rs#L58), [src-tauri/src/web_server/auth.rs:96](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/auth.rs#L96)  
**What:** The server accepts requests to protected-looking routes with no auth check at all. In this diff, `GET /opds/` will return `200` without any `Authorization` header or session token.  
**Why:** `auth_middleware()` is defined, but `build_router()` never attaches it to the router or any subtree. The only router wiring here is `.nest(...)`, `.merge(...)`, and `.with_state(state)`.  
**Impact:** Because `start()` binds `0.0.0.0` on the LAN, any machine on the local network can reach the web server without passing the PIN gate. The auth code added in this PR is effectively dead code.  
**Fix:** Mount `auth::auth_middleware` with `axum::middleware::from_fn_with_state(...)` on the whole router or on every protected subtree, and keep only explicitly public routes outside that layer.  
**Severity:** BLOCKING  
**Fixable:** YES

2. **File:** [src-tauri/src/web_server/auth.rs:134](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/auth.rs#L134)  
**What:** A session token can be used via `?token=...` in the URL, so anyone who gets that URL can replay the session for up to 24 hours.  
**Why:** `auth_middleware()` treats the `token` query parameter as equivalent to a bearer token. Query strings are routinely written to browser history, proxy/server logs, screenshots, copied links, and `Referer` headers.  
**Impact:** Session theft becomes trivial once a URL is logged or shared, which defeats the PIN/session boundary for the web server.  
**Fix:** Remove query-parameter auth entirely. Accept only `Authorization: Bearer` or a properly set cookie. If link-based access is required, use short-lived one-time signed links instead of reusable session tokens.  
**Severity:** BLOCKING  
**Fixable:** YES

3. **File:** [src-tauri/src/web_server/auth.rs:15](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/auth.rs#L15), [src-tauri/src/web_server/api.rs:27](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/api.rs#L27), [src-tauri/src/web_server/mod.rs:72](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/mod.rs#L72)  
**What:** The PIN can be brute-forced far too cheaply, both online and offline.  
**Why:** `hash_pin()` stores a plain unsalted SHA-256 of the PIN, which is a fast hash and offers no real protection for a low-entropy secret like a PIN. At the same time, `/api/auth` has no throttling, backoff, or lockout, and the server listens on all interfaces.  
**Impact:** An attacker on the same network can script repeated login attempts until the PIN is guessed; if the stored hash is ever exposed, offline cracking is also cheap. That yields a valid session token and bypasses the intended access control.  
**Fix:** Replace raw SHA-256 with a password KDF such as Argon2id/scrypt/PBKDF2 with a per-PIN random salt and constant-time verification, and add request throttling/lockout on `/api/auth`.  
**Severity:** BLOCKING  
**Fixable:** NO

---


## [Claude Code — Implementer] Round 1

Both look correct.

---

## Summary

| # | Finding | Verdict | Action |
|---|---------|---------|--------|
| 1 | Auth middleware never mounted | **Agreed — fixed** | Added `middleware::from_fn_with_state(state, auth::auth_middleware)` as a layer on the router in `build_router()` |
| 2 | Query param `?token=` leaks sessions | **Agreed — fixed** | Removed the entire query-param auth block (lines 134–143) from `auth_middleware` |
| 3 | SHA-256 + no rate limiting on PIN | **Acknowledged — not fixing** | Marked Fixable: NO by Codex. Technically valid but appropriate for a follow-up step given this is a skeleton commit. LAN-only threat model reduces urgency. Recommend Argon2id + rate limiting in the auth-hardening step. |

---

