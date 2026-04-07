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


## [Codex — Reviewer] Round 2

NEEDS_FIX: `/api/auth` still allows cheap online PIN brute-forcing, and the stored PIN hash is still trivial to crack offline if exposed.

1. **File:** [src-tauri/src/web_server/auth.rs](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/auth.rs#L15), [src-tauri/src/web_server/auth.rs](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/auth.rs#L37), [src-tauri/src/web_server/api.rs](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/api.rs#L27), [src-tauri/src/web_server/mod.rs](/Users/mike/Documents/www/private/ebook-reader/src-tauri/src/web_server/mod.rs#L75)  
**What:** A machine on the same network can script repeated `POST /api/auth` attempts until it guesses the PIN, and if the keychain-stored hash is ever disclosed, the PIN can be cracked offline cheaply.  
**Why:** `hash_pin()` uses plain unsalted SHA-256 for a low-entropy secret, `verify_pin()` just recomputes that fast hash, and `login()` performs no throttling, backoff, or lockout before minting a session. The server is also started on `0.0.0.0`, so this endpoint is reachable from the LAN.  
**Impact:** An attacker can recover the PIN and obtain a valid session token, bypassing the intended access control for the LAN-exposed web server.  
**Fix:** Replace the PIN storage/verification path with a password KDF such as Argon2id using a per-PIN random salt, perform constant-time verification through that library, and add rate limiting or lockout on `/api/auth` keyed to client identity.  
**Severity:** BLOCKING  
**Fixable:** NO

---


## [Claude Code — Implementer] Round 2

## Round 2 Analysis

### Finding 1: SHA-256 PIN hashing + no rate limiting on `/api/auth`

**Verdict: Acknowledged — NOT fixing (Fixable: NO)**

This is the exact same finding as Round 1 #3, re-raised verbatim. Codex has again marked it **Fixable: NO** (requires human judgment), so per the review protocol I will not attempt to fix it.

My technical perspective:

- **The concern is technically valid.** SHA-256 is a fast hash, and a 4–6 digit PIN has negligible entropy against offline brute-force. Argon2id with a random salt would be the correct choice for production.
- **However, the threat model is bounded.** This server is LAN-only (not internet-exposed), user-initiated (not always-on), and the PIN hash lives in the OS keychain — not in a file or database that's easily exfiltrated. Offline cracking requires the attacker to already have compromised the keychain, at which point they likely have broader access anyway.
- **Rate limiting is a fair ask** and would be straightforward to add (an in-memory counter per IP with exponential backoff). This should go in the auth-hardening step.
- **This is a skeleton commit.** The branch name is literally `feat/web-server-step1-skeleton`. Swapping to Argon2id means adding a new crate dependency (`argon2`), changing the stored format (salt+hash), updating `store_pin`/`load_pin_hash`/`verify_pin`, and handling migration of any existing keychain entries. That's real work that belongs in a dedicated auth-hardening step, not shoehorned into a skeleton PR.

**Recommendation for the human reviewer:** Schedule Argon2id + rate limiting as a follow-up before this feature ships to users. Do not merge to `main` without it. But it doesn't need to block this skeleton PR from being reviewed for its structural correctness.

---

## Round 2 Summary

| # | Finding | Severity | Fixable | Verdict | Action |
|---|---------|----------|---------|---------|--------|
| 1 | SHA-256 + no rate limiting on PIN (re-raise of R1 #3) | BLOCKING | NO | **Acknowledged — not fixing in this PR** | Deferred to auth-hardening step. LAN-only threat model + skeleton scope. Recommend Argon2id + per-IP rate limiting before shipping. |

**Code changes this round: none.** The only finding is marked Fixable: NO and is a repeat of a previously acknowledged issue. The Round 1 fixes (middleware mounting, query-param auth removal) remain in place and address the two fixable findings from that round.

---

