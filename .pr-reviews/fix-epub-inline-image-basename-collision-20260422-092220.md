# PR Review: fix-epub-inline-image-basename-collision
**Date:** 2026-04-22 09:22
**Mode:** review + fix (3-agent voting)
**Agents:** Codex (reviewer) + Gemini (reviewer) + Claude (implementer)
**Base:** main
**Diff lines:** 239
**Approval rule:** 2/3 majority vote

---


## [Codex — Reviewer] Round 1

LGTM: The basename collision fix keys cached EPUB inline images by resolved zip path hash plus basename, and I did not find a blocking regression in the changed code.

Detailed findings: none.

I checked the new key construction against `Storage::validate_key`, the EPUB image extraction path, and the web server `asset://localhost/...` to HTTP rewrite. The new `{hash}-{basename}` filename still maps to the existing `/api/books/{id}/images/{chapter}/{filename}` route because the web server extracts the final path segment from the generated local path.

Residual risk: the 64-bit truncated SHA-256 prefix is a pragmatic collision reducer rather than a formal uniqueness guarantee, but for per-chapter EPUB image keys this is not a merge-blocking issue. I did not run the test suite; this is a code review of the provided diff.

---

## [Gemini — Reviewer] Round 1

LGTM: The diff correctly addresses the image key collision issue by introducing a hash of the resolved zip path into the storage key, and includes a comprehensive test to verify the fix.

---

