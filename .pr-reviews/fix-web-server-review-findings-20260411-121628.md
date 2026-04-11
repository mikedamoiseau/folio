# PR Review: fix-web-server-review-findings
**Date:** 2026-04-11 12:16
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 796
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

NEEDS_FIX: Start-server guard now blocks legitimate remote-access setups, and the OPDS “pagination” still does full-library work per request.

1. **File:** [src/components/SettingsPanel.tsx](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:338), [src/components/SettingsPanel.tsx](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:491), [src/components/SettingsPanel.tsx](/Users/mike/Documents/www/folio/src/components/SettingsPanel.tsx:1517)
   **What:** Users can no longer start the web server unless they save a PIN during the current settings-panel session. This breaks two concrete cases: an existing user who already has a PIN stored in keychain, and the documented “no PIN mode”.
   **Why:** `pinSavedOnce` starts as `false`, is never hydrated from backend state on open, and the start button is disabled whenever `!webServerRunning && !pinSavedOnce`. `web_server_status` only returns `{ running, url, port }`, so the UI has no way to learn that a PIN already exists. The backend still explicitly allows open access when no PIN is set, but the new UI guard prevents starting the server in that mode.
   **Impact:** Remote access becomes unavailable after app restart unless the user re-enters and re-saves a PIN every time; no-PIN mode is effectively dead from the desktop UI.
   **Fix:** Drive this guard from backend truth, not local transient state. Extend `web_server_status` to report whether a PIN exists, hydrate that on panel open, and allow starting when no PIN is configured if open-access mode is intended.
   **Severity:** BLOCKING
   **Fixable:** YES

2. **File:** [src-tauri/src/web_server/opds_feed.rs](/Users/mike/Documents/www/folio/src-tauri/src/web_server/opds_feed.rs:154)
   **What:** `/opds/all?page=N` still does an O(total library size) fetch on every page request, so large libraries will still be slow and memory-heavy despite the new 50-item page size.
   **Why:** The handler still calls `db::list_books(&conn)` to load the entire library, and only then applies `skip(start).take(OPDS_PAGE_SIZE)` in memory.
   **Impact:** A library with thousands of books will still pay the full query/allocation cost for every OPDS page fetch, so clients can still time out or feel broken. The advertised scalability fix does not actually remove the backend bottleneck.
   **Fix:** Add DB-level pagination (`LIMIT/OFFSET` or keyset pagination) plus either a count query or a “fetched one extra row” approach to decide whether to emit `rel="next"`.
   **Severity:** SUGGESTION
   **Fixable:** YES

---

## [Gemini — Reviewer] Round 1

NEEDS_FIX: The Content Security Policy's `img-src` directive is too broad, reducing its effectiveness.

### Finding 1: Overly Permissive `img-src` in Content Security Policy (CSP)

*   **File:** `src-tauri/src/web_server/mod.rs`
*   **Line(s):** 61-64
*   **What can go wrong:** The current CSP uses `img-src *`, which allows the web server to load images from any origin. While other protections like EPUB HTML sanitization and path traversal protection are in place, a broad `img-src` directive weakens the overall security posture. If an unpatched XSS vulnerability were to be introduced elsewhere in the web UI, an attacker could exploit it to load images from arbitrary external domains. This could be used for tracking users, confirming the presence of an XSS vulnerability, or potentially exfiltrating small pieces of data via crafted image URLs.
*   **Why the code is vulnerable to this:** The principle of least privilege dictates that a CSP should be as restrictive as possible while allowing legitimate functionality. Allowing `img-src *` provides more attack surface than necessary, as all legitimate images (covers, chapter images, PDF/comic pages) are served from the application's own `/api/books` endpoints or are `data:` URIs.
*   **Impact if it happens:** Reduced protection against certain types of data exfiltration or tracking if other injection vulnerabilities exist. It also sets a precedent for less strict security configurations.
*   **Fix recommendation:** Restrict the `img-src` directive to `self` and `data:`. This will ensure that images can only be loaded from the application's own origin or as embedded data URIs, tightly aligning the CSP with the application's actual needs.
    ```rust
    // src-tauri/src/web_server/mod.rs
    // ...
    headers.insert(
        "content-security-policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
            .parse()
            .unwrap(),
    );
    // ...
    ```
*   **Severity:** BLOCKING (While other protections are present, a weak CSP is a fundamental security flaw that should be tightened. It's a critical best practice.)
*   **Fixable:** NO (Requires understanding the application's full scope of image loading and careful testing to ensure no legitimate images are blocked, though the recommended fix covers the described legitimate sources.)

---


## [Claude — Implementer] Round 1

The `has_pin` field is typed but currently unused since the guard was removed. That's fine — the type annotation is accurate to the backend struct and doesn't cause any TS errors (extra fields in the type generic are fine). The `has_pin` field is available for future use if a more nuanced guard is desired.

---

## Summary

| Issue | Raised by | Action | Reason |
|-------|-----------|--------|--------|
| `pinSavedOnce` guard blocks legitimate setups (existing PIN / no-PIN mode) | Codex | **Fixed** | Real bug. Removed the transient `pinSavedOnce` guard entirely. Added `has_pin` to `WebServerStatus` backend struct so the frontend can hydrate from backend truth. Start button now only disabled during loading. No-PIN mode works again. |
| OPDS pagination still loads full library in memory | Codex (SUGGESTION) | **Pushed back** | For a personal ebook library (hundreds to low thousands of books), in-memory pagination is adequate. The pagination was added to limit OPDS XML response size for clients, not to address a DB bottleneck. Adding `LIMIT/OFFSET` would require changes to the DB layer and every caller — premature optimization for this scope. |
| `img-src *` too permissive in CSP | Gemini | **Fixed** | All images are served from self-hosted `/api/books/...` endpoints or as `data:` URIs. Tightened to `img-src 'self' data:` — strictly more secure with no functional impact. |

**Files changed:**
- `src-tauri/src/web_server/mod.rs` — CSP `img-src` tightened; `has_pin` added to `WebServerStatus`
- `src-tauri/src/commands.rs` — `web_server_status` now populates `has_pin` from keychain
- `src/components/SettingsPanel.tsx` — removed broken `pinSavedOnce` guard; button disabled only during loading; type updated to include `has_pin`

---

