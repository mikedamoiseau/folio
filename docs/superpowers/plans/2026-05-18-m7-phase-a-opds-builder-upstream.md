# Phase A Hand-off — Lift OPDS Feed-Builder Primitives into `folio-core::opds`

> **For the executing agent:** You are operating in `/Users/mike/Documents/www/folio` (the **public** GitHub `mikedamoiseau/folio` repo). This is a self-contained Phase A spec — you do NOT need to read folio-server's spec or plans. All neutral wording is mandatory: commit messages, branch names, PR title, and PR body must NOT mention any of the words **`folio-server`**, **multi-user**, **paid tier**, **commercial**, **downstream tooling for a specific app**, **headless**, or **tenant**. Frame the work as a generic upstream gap-fill: tooling that needs to render OPDS feeds without depending on the desktop app's `web_server` module.

**Goal:** Add a set of `pub fn` builder primitives to `folio-core::opds` (or a new `folio-core::opds_feed` submodule — see "Module placement" below) that allow external callers to render OPDS Atom XML feeds from `Book` rows without depending on the desktop app's `src-tauri/src/web_server/opds_feed.rs` module.

**Architecture:** The desktop app currently houses the entire OPDS feed-builder stack inside its app-specific axum router. The pure XML/MIME/escape primitives are reusable and belong upstream. Phase A lifts those primitives (~150 LOC) into `folio-core::opds`, ports their unit tests, and tags `v2.0.3`. Axum routing, pagination glue, and `WebState` extraction stay in the desktop app and are NOT touched by this Phase A.

**Tech stack:** Rust 2021, `folio_core` crate, `tempfile` (already a dev-dep), no new dependencies.

---

## Spec references (in this hand-off — there is no external spec for the executing agent)

- Module placement decision: see "Module placement" below.
- Cross-repo Phase A pattern: this hand-off is itself the spec for the upstream change.

## File Structure

### Files to create / modify

- **Modify:** `folio-core/src/opds.rs` OR **Create:** `folio-core/src/opds_feed.rs` (your call — see "Module placement" below). The new code goes into one of these.
- **Modify (if new module):** `folio-core/src/lib.rs` — add `pub mod opds_feed;` if you choose the new-module path.
- **Modify:** `folio-core/CHANGELOG.md` (or `CHANGELOG.md` at the workspace root, whichever holds release notes — read it to confirm) — add a `## [2.0.3]` section.
- **Modify:** `Cargo.toml` at the workspace root — bump `[workspace.package].version` from `2.0.2` to `2.0.3`.
- **New tag:** `v2.0.3` on `main` after the PR merges.

### Module placement

Two options. Pick one before you start:

**Option A: extend `folio-core::opds`.** Current `opds.rs` is a *client* — `fetch_feed`, `is_safe_url`, etc. — for ingesting external OPDS catalogs. Adding feed-building primitives to the same module mixes inbound and outbound responsibilities. Reader has to scan a larger file to find what they want.

**Option B (recommended): new `folio-core::opds_feed` module.** A second file, `folio-core/src/opds_feed.rs`, holds only the feed-building primitives. The existing `opds.rs` keeps its client surface intact. Two small, single-purpose modules instead of one mixed one. Aligns with the "files have one clear responsibility" principle in the project's coding conventions.

Default to Option B. If you prefer Option A and have a reason (e.g. existing prior art in the repo for mixing inbound + outbound in a single module — confirm via grep first), it is acceptable, but state the reason in the PR description.

The rest of this plan describes the surface assuming Option B (`opds_feed.rs`). For Option A, prefix every identifier with `feed_` to disambiguate from the client functions (e.g. `pub fn feed_xml_escape`).

### Boundary contract (locked here, do not invent variants)

The new module exposes exactly these public items. Reject any temptation to also lift the axum handlers, the pagination structs, or the cover-MIME-guess fallback for filesystem paths — those are server-app glue and stay in the desktop app.

```rust
//! folio-core/src/opds_feed.rs

use crate::models::Book;

/// OPDS Atom navigation feed content type.
pub const ATOM_CONTENT_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";

/// OPDS Atom acquisition feed content type.
pub const ATOM_ACQ_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";

/// Per-book link block: caller supplies the cover and download URLs because
/// the route shape is server-app-specific. The builder uses the URLs as-is
/// (no escaping inside the function — caller passes pre-validated values).
pub struct EntryUrls {
    /// Absolute or app-relative URL for the cover image.
    pub cover_href: String,
    /// Absolute or app-relative URL for the book file download.
    pub download_href: String,
}

/// Feed kind for `wrap_feed`.
pub enum FeedKind {
    Navigation,
    Acquisition,
}

/// Escape XML 1.0 entities (`& < > " '`). Returns owned `String`.
pub fn xml_escape(s: &str) -> String;

/// Map a MOBI-family file path to its `(extension_without_dot, mime_type)`.
/// `Book::format == BookFormat::Mobi` collapses `.mobi`, `.azw`, `.azw3`
/// at import time; on download we want to preserve the original extension.
///
/// Fallback when no recognised extension: `("mobi", "application/x-mobipocket-ebook")`.
pub fn mobi_ext_and_mime(file_path: &str) -> (&'static str, &'static str);

/// Map a cover image path's extension to a MIME type.
///
/// Recognised: `.jpg`/`.jpeg` → `image/jpeg`, `.png` → `image/png`,
/// `.webp` → `image/webp`. Fallback: `image/jpeg`. Accepts `None` to
/// return the fallback directly.
pub fn cover_mime(cover_path: Option<&str>) -> &'static str;

/// Render a single Atom `<entry>` element for `book`.
///
/// The returned string is the entry XML alone (no `<feed>` wrapper).
/// Caller-supplied `urls` are inlined verbatim into `href=` attributes;
/// they MUST already be valid URLs. All metadata fields (title, author,
/// description) are XML-escaped internally.
pub fn book_to_entry(book: &Book, urls: &EntryUrls) -> String;

/// Wrap a sequence of pre-built entry XML strings into a complete Atom feed.
///
/// `entries` content is inlined as-is (callers pass strings from
/// `book_to_entry`). `title`, `feed_id`, `self_href`, and `next_href`
/// are XML-escaped inside the function.
///
/// `next_href = Some(...)` adds a `rel="next"` pagination link to the feed.
pub fn wrap_feed(
    title: &str,
    feed_id: &str,
    entries: &[String],
    self_href: &str,
    kind: FeedKind,
    next_href: Option<&str>,
) -> String;
```

That is the entire upstream surface for Phase A. No other items become public.

---

## Source-of-truth for the lift

The reference implementation lives at `src-tauri/src/web_server/opds_feed.rs` in this same repo (the desktop app). Read it before you start. **You will copy logic from there**, with two adaptations:

1. **`book_to_entry` takes `&EntryUrls` instead of building `/api/books/{id}/...` URLs internally.** The desktop app's hardcoded paths are server-app-specific; lifting them upstream is the wrong move. The caller injects the URLs.
2. **No axum / `Router` / `WebState` references.** Strip them. Everything in the lifted module returns owned `String` or primitive tuple/enum types.

You should preserve, verbatim where possible:
- The XML escaping rules
- The MOBI extension fallback table
- The cover MIME fallback table
- The Atom XML structure produced by `book_to_entry` (`<entry>`, `<id>`, `<title>`, `<author><name>...`, `<published>`, `<updated>`, `<summary>`, `<link rel="http://opds-spec.org/image" ...>`, `<link rel="http://opds-spec.org/acquisition" ...>`)
- The Atom XML structure produced by `wrap_feed` (`<feed xmlns="..." xmlns:dc="..." xmlns:opds="...">`, `<id>`, `<title>`, `<updated>`, `<link rel="self" ...>`, `<link rel="start" ...>`, the entries block, and the optional `<link rel="next" ...>`)
- Treatment of `Option<String>` fields: missing description → omit `<summary>`; missing cover_path → omit the cover `<link>` block.

---

## Task 0: Verify source state + open question

**Files:** read-only verification.

- [ ] **Step 1: Confirm the desktop module is at the expected location and size.**
   ```bash
   wc -l /Users/mike/Documents/www/folio/src-tauri/src/web_server/opds_feed.rs
   grep -n 'pub fn\|fn book_to_entry\|fn xml_escape\|fn mobi_ext_and_mime\|fn cover_mime\|fn wrap_feed\|ATOM_CONTENT_TYPE\|ATOM_ACQ_TYPE' /Users/mike/Documents/www/folio/src-tauri/src/web_server/opds_feed.rs
   ```
   Expected: file is ~500–600 LOC; `book_to_entry`, `xml_escape`, `mobi_ext_and_mime`, `cover_mime` are present; the two `ATOM_*` consts are at the top.

   If any helper is missing or has been renamed since this plan was drafted, STOP and surface the discrepancy.

- [ ] **Step 2: Identify whether `wrap_feed` exists as a single function or is inlined in the handlers.**

   Search:
   ```bash
   grep -n 'wrap_feed\|fn wrap_feed' /Users/mike/Documents/www/folio/src-tauri/src/web_server/opds_feed.rs
   ```

   If `wrap_feed` exists as a named function: lift it verbatim with adaptations from "Source-of-truth for the lift". If it doesn't exist (the Atom envelope is inlined in `root_catalog`, `all_books`, etc.), you'll need to factor it out yourself. Read 3–5 of the handlers, identify the common envelope, and write a single `wrap_feed` that captures it. Test it with at least one round-trip case (envelope + 1 entry + envelope) where you can compare against one of the desktop handler outputs.

- [ ] **Step 3: Confirm the workspace version is `2.0.2`.**
   ```bash
   grep '^version' /Users/mike/Documents/www/folio/Cargo.toml
   ```
   Expected: `version = "2.0.2"` under `[workspace.package]`. If not, STOP and report.

- [ ] **Step 4: Confirm `tempfile` is in folio-core's dev-deps.**
   ```bash
   grep tempfile /Users/mike/Documents/www/folio/folio-core/Cargo.toml
   ```
   Expected: a line under `[dev-dependencies]`. (You don't strictly need `tempfile` for these tests — they're string-in/string-out — but if you find you need it for a feed-end-to-end test, it's available.)

- [ ] **Step 5: Confirm `cargo fmt --check` and `cargo clippy -p folio-core -- -D warnings` are clean on `main` for `folio-core` BEFORE you start.**

  Background context: pre-existing repo-wide lint debt may exist in OTHER crates (`src-tauri/` etc.). That's not your concern. Verify only `folio-core` is clean.

   ```bash
   cd /Users/mike/Documents/www/folio
   cargo fmt --check -- folio-core/src/*.rs folio-core/src/**/*.rs
   cargo clippy -p folio-core -- -D warnings
   ```

   If either is dirty on `main`, STOP and surface — the Phase A PR cannot assert cleanliness when the baseline is dirty.

---

## Task 1: Create branch + write failing tests

**Files:**
- Modify: `folio-core/src/opds_feed.rs` (or `folio-core/src/opds.rs` per Module placement)

- [ ] **Step 1: Branch from a clean main.**
   ```bash
   cd /Users/mike/Documents/www/folio
   git checkout main && git pull --ff-only
   git checkout -b feat/opds-feed-builder-primitives
   ```

- [ ] **Step 2: Stub the module.**

   Create `folio-core/src/opds_feed.rs` with the full public surface from the "Boundary contract" section above, but with every function body as `unimplemented!()` and the structs/enum/consts defined. Also `pub mod opds_feed;` in `folio-core/src/lib.rs`.

- [ ] **Step 3: Add failing tests.**

   Append a `#[cfg(test)] mod tests { ... }` block at the end of `opds_feed.rs` containing the tests from the desktop app's `opds_feed.rs` module (lines 332–506 in the source-of-truth file), with these adaptations:

   - **`test_xml_escape`** — verbatim. Strings only.
   - **`mobi_ext_and_mime_*`** — verbatim. Strings only.
   - **`cover_mime_*`** — verbatim. Strings only.
   - **`test_book_to_entry_contains_required_elements`** — the desktop version asserts presence of `/api/books/<id>/...` strings. Replace those with assertions against the new contract: pass a fixed `EntryUrls { cover_href: "https://example.test/cover/abc".into(), download_href: "https://example.test/file/abc".into() }` and assert the rendered entry contains those literal hrefs.
   - **`opds_cover_link_uses_real_cover_mime`** — same treatment.
   - **`download_url_carries_extension_for_*`** — these tested the URL-extension logic; with `EntryUrls` injected, the test should assert that for a MOBI book the `<link rel="acquisition">` MIME type matches `mobi_ext_and_mime(book.file_path).1`. Re-state the assertion against the new contract.

   New tests to add:

   - **`wrap_feed_includes_entries_and_self_link`** — pass 2 stub entry strings; assert the returned feed contains both, the `<title>`, `<id>`, `<link rel="self">`, and no `<link rel="next">`.
   - **`wrap_feed_includes_next_link_when_provided`** — same but with `next_href = Some(...)`; assert the `<link rel="next">` is present and its `href` is XML-escaped if the input contained an ampersand.
   - **`wrap_feed_kind_sets_correct_content_type_marker`** — assert that for `FeedKind::Navigation` the rendered feed's `<feed>` element has the navigation content-type hint where the desktop app's wrappers put it. (Read the desktop's `wrap_feed`-equivalent code to see exactly how `kind` is reflected; the spec phrasing here is intentionally vague because the desktop's source is the source-of-truth.)

   Total tests: ~12–15 (lift 9–10 from desktop, add 3 new ones for `wrap_feed`).

- [ ] **Step 4: Run, expect failure.**
   ```bash
   cargo test -p folio-core --lib opds_feed
   ```
   Expected: every test panics with `not implemented`. If any compile error appears, fix the *test* code first, not the stubs.

---

## Task 2: Implement the primitives

**Files:**
- Modify: `folio-core/src/opds_feed.rs`

- [ ] **Step 1: Port `xml_escape`, `mobi_ext_and_mime`, `cover_mime` verbatim.**

   These are pure string functions; copy them as-is from `src-tauri/src/web_server/opds_feed.rs`.

- [ ] **Step 2: Port `book_to_entry` with `EntryUrls` injection.**

   Two changes vs desktop:
   - Function signature: `pub fn book_to_entry(book: &Book, urls: &EntryUrls) -> String`
   - Inside, replace the hardcoded `format!("/api/books/{}/cover", book.id)` with `urls.cover_href` (and similarly for download).

   Preserve everything else verbatim: the field-by-field rendering, the `Option` handling, the call-out to `mobi_ext_and_mime` / `cover_mime`.

- [ ] **Step 3: Port `wrap_feed`.**

   If `wrap_feed` already exists in the desktop file, port verbatim and add the `FeedKind` enum + the `kind` parameter (the desktop probably hardcodes one of the two content types per handler — your `wrap_feed` receives it as a parameter). If it doesn't exist as a named function, factor it out: identify the shared envelope across the desktop's `root_catalog`/`all_books`/`new_books`/etc. handlers and capture the common shape.

- [ ] **Step 4: Run targeted tests, expect pass.**
   ```bash
   cargo test -p folio-core --lib opds_feed
   ```
   Expected: every test passes.

- [ ] **Step 5: Run the full folio-core test suite.**
   ```bash
   cargo test -p folio-core
   ```
   Expected: all green, including any pre-existing tests in `opds.rs` (the client module — should be unaffected).

- [ ] **Step 6: Lint + format.**
   ```bash
   cd /Users/mike/Documents/www/folio
   cargo fmt --check folio-core/src/opds_feed.rs
   cargo clippy -p folio-core -- -D warnings
   ```
   Both clean. If clippy fires on the new code, fix the lint — do NOT `#[allow]`.

- [ ] **Step 7: Commit (neutral wording).**

   ```bash
   git add folio-core/src/opds_feed.rs folio-core/src/lib.rs
   git commit -m "feat(folio-core/opds_feed): pub primitives for rendering OPDS Atom feeds

   Adds a small module of pure builder primitives — xml_escape,
   mobi_ext_and_mime, cover_mime, book_to_entry, wrap_feed — plus the
   ATOM_CONTENT_TYPE / ATOM_ACQ_TYPE constants and an EntryUrls struct
   for injecting caller-controlled cover and download hrefs.

   The desktop app's OPDS feed module previously held this logic inline
   alongside axum handlers and a WebState extractor. Lifting the pure
   string/MIME primitives upstream lets any tool that renders OPDS
   feeds — exporters, alternative front-ends, test harnesses — reuse
   the canonical Atom rendering without depending on the desktop's
   web_server module.

   Public surface:
   - pub fn xml_escape(s: &str) -> String
   - pub fn mobi_ext_and_mime(file_path: &str) -> (&'static str, &'static str)
   - pub fn cover_mime(cover_path: Option<&str>) -> &'static str
   - pub fn book_to_entry(book: &Book, urls: &EntryUrls) -> String
   - pub fn wrap_feed(title, feed_id, entries, self_href, kind, next_href) -> String
   - pub struct EntryUrls
   - pub enum FeedKind { Navigation, Acquisition }
   - pub const ATOM_CONTENT_TYPE
   - pub const ATOM_ACQ_TYPE

   Tests cover the escape rules, MIME fallback tables, and round-trip
   render shape for both feed kinds.
   "
   ```

   No `Co-Authored-By` / `Generated with Claude Code` trailers.

---

## Task 3: Version bump + CHANGELOG + PR + tag

**Files:**
- Modify: `Cargo.toml` workspace version
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump workspace version to 2.0.3.**

   In `/Users/mike/Documents/www/folio/Cargo.toml`, change `[workspace.package].version` from `"2.0.2"` to `"2.0.3"`.

- [ ] **Step 2: Add CHANGELOG entry.**

   In `CHANGELOG.md`, locate `## [Unreleased]` and insert below it (above the previously released `## [2.0.2]` section):

   ```markdown
   ## [2.0.3] - <today's date in YYYY-MM-DD>

   ### Added
   - `folio_core::opds_feed` — public primitives for rendering OPDS Atom feeds: `xml_escape`, `mobi_ext_and_mime`, `cover_mime`, `book_to_entry`, `wrap_feed`, `EntryUrls`, `FeedKind`, and the two content-type constants. Lets external tooling render OPDS feeds from `Book` rows without depending on the desktop app's `web_server` module.
   ```

- [ ] **Step 3: Run cargo check + tests.**
   ```bash
   cargo check --workspace
   cargo test -p folio-core
   ```
   Both green.

- [ ] **Step 4: Commit + push + open PR.**

   ```bash
   git add Cargo.toml CHANGELOG.md
   git commit -m "chore: bump version to 2.0.3"
   git push -u origin feat/opds-feed-builder-primitives
   ```

   PR body should be written to a temp file (to keep backticks literal under shell HEREDOC), then passed via `--body-file`:

   ```bash
   cat > /tmp/pr-body.md <<'EOF'
   ## Summary

   Add a small `folio_core::opds_feed` module with pure builder primitives for rendering OPDS Atom feeds. Lets tooling that needs to render OPDS feeds from `Book` rows reuse the canonical Atom rendering without depending on the desktop app's `web_server` module — which couples that logic to axum handlers, `WebState`, and a hardcoded `/api/books/...` URL scheme.

   Public surface (all `pub`):

   - `xml_escape(s: &str) -> String`
   - `mobi_ext_and_mime(file_path: &str) -> (&'static str, &'static str)`
   - `cover_mime(cover_path: Option<&str>) -> &'static str`
   - `book_to_entry(book: &Book, urls: &EntryUrls) -> String` — caller supplies cover and download URLs via `EntryUrls` so the entry render is server-route-agnostic
   - `wrap_feed(title, feed_id, entries, self_href, kind, next_href) -> String` — adds optional `rel="next"` pagination link
   - `pub struct EntryUrls { cover_href, download_href }`
   - `pub enum FeedKind { Navigation, Acquisition }`
   - `pub const ATOM_CONTENT_TYPE`, `pub const ATOM_ACQ_TYPE`

   Existing client functions in `folio_core::opds` are untouched.

   Workspace bumped to 2.0.3.

   ## Test plan

   - [x] `cargo test -p folio-core` — full suite green. New `opds_feed` tests cover the escape rules, MIME fallback tables, entry rendering with injected `EntryUrls`, and feed wrapping for both `Navigation` and `Acquisition` kinds with/without a `next` pagination link.
   - [x] `cargo fmt --check` clean on the new file.
   - [x] `cargo clippy -p folio-core -- -D warnings` clean.
   EOF

   gh pr create \
     --title "feat(folio-core/opds_feed): pub primitives for OPDS Atom rendering + v2.0.3" \
     --body-file /tmp/pr-body.md
   ```

   **Forbidden substrings in PR title, PR body, branch name, and commit messages:** `folio-server`, `multi-user`, `paid tier`, `commercial`, `downstream tooling for a specific app`, `headless`, `tenant`. Re-read everything before pushing.

- [ ] **Step 5: Wait for PR review and merge to `main`.**

   Phase A runs through `folio`'s own review cadence. Mark complete only when the PR has merged to `main`. Do not proceed to Step 6 until then.

- [ ] **Step 6: Tag v2.0.3 on `main`.**

   After the PR merges:
   ```bash
   cd /Users/mike/Documents/www/folio
   git checkout main && git pull --ff-only
   git tag v2.0.3
   git push origin v2.0.3
   ```

   **Critical:** the `origin` push above MUST target `github.com:mikedamoiseau/folio.git`. Verify with `git remote -v | grep '(push)'` BEFORE running `git push origin v2.0.3`. If the remote is anything else (especially the Bitbucket folio-server repo), STOP — you are in the wrong working directory.

---

## Hand-off back to folio-server

When Task 3 Step 6 completes — `v2.0.3` is tagged on `github.com/mikedamoiseau/folio` `main` — notify the folio-server controller. The folio-server M7 plan (`docs/superpowers/plans/2026-05-18-m7-opds-feed.md`, in the **other** repo) picks up from here by bumping the `folio-core` git dependency tag and wrapping the new primitives.

## Self-review (run after writing the Phase A code)

- **Surface match:** every item in the "Boundary contract" section is exposed, and nothing else has been made `pub`. The internal helpers (none expected, but if you factored anything out during implementation) stay `pub(crate)` or private.
- **No app coupling:** the new `opds_feed` module imports only from `crate::models` (for `Book`). No axum, no `tracing` (unless you have a strong reason — the current desktop code does not log inside these helpers), no filesystem access.
- **Neutral wording check:** open the PR description and the two commit messages. Search them yourself for the forbidden substrings. Re-read the doc comments inside the new module — they should describe the API in app-agnostic terms.
- **Repo verify:** `git remote -v | grep '(push)'` MUST show `github.com:mikedamoiseau/folio.git`. If it does not, you are in the wrong working directory; stop.

## What this plan does NOT cover (out of scope)

- The desktop app's `src-tauri/src/web_server/opds_feed.rs` is **not refactored** to call the new upstream primitives. That migration is a follow-up the desktop maintainer can pick up after v2.0.3 ships. It is non-blocking for the downstream consumer that needs the upstream surface.
- Pagination logic and `OPDS_PAGE_SIZE` semantics stay in the desktop app.
- Cover/file route construction stays in the consuming app.
- No new dependencies are added to `folio-core`. If `wrap_feed` factoring requires a string-building helper that's not in the standard library, write it inline rather than pulling a crate.
