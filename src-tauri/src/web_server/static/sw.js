// Item 9 (PWA): minimal service worker — cache-first for the static app
// shell only. Reading content and API data are never cached (freshness/auth
// complexity isn't worth it for v1; see docs/web-ui-improvements.md Item 9).
//
// Finding 9: CACHE_VERSION must embed a short content hash of the shell
// assets (index.html + app.js + app.css + manifest.json) — enforced by
// `cache_version_embeds_shell_asset_content_hash` in mod.rs, which fails CI
// with the expected hash whenever one of those files changes without this
// being regenerated to match. Don't hand-edit the version without re-running
// that test.
//
// SHELL_ASSETS mirrors `web_ui::PUBLIC_SHELL_ASSETS` in web_ui.rs (Finding
// 11) — that's the source of truth for which paths are public/unauthed on
// the Rust side; keep this array in sync with it by hand (a JS file can't
// import a Rust const), plus `/favicon.ico` which isn't a distinct shell
// asset worth precaching separately from `/favicon.png`.
//
// Secure-context caveat: service workers only register on secure contexts
// (https, or http://localhost). Folio's primary LAN use case — a phone
// hitting http://192.168.x.x:7788 — is plain HTTP and NOT a secure context,
// so the service worker will not register there and this cache never
// activates; app.js's registration call is feature-detected/try-catched so
// this is silent, not an error. The manifest + icons still work for iOS
// Safari "Add to Home Screen" over plain HTTP.
const CACHE_VERSION = "folio-shell-32d57decd42d";

const SHELL_ASSETS = [
  "/",
  "/app.js",
  "/app.css",
  "/favicon.png",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Finding 8: web_ui.rs serves these with `Cache-Control: public,
      // max-age=3600` — a plain `cache.addAll(SHELL_ASSETS)` lets the
      // browser's own HTTP cache satisfy the fetch, which can populate a
      // freshly-versioned SW cache with an hour-old copy of app.js/app.css
      // right after a deploy. `cache: "reload"` forces each request past the
      // HTTP cache to the network.
      cache.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-only passthrough for API and OPDS traffic — do not intercept.
  // Leaving these un-handled lets the browser handle them natively so auth
  // (cookies/session) and streaming semantics are untouched.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/opds/")) {
    return;
  }

  // Only handle GETs to our own origin's shell assets; ignore everything else.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (!SHELL_ASSETS.includes(url.pathname)) {
    return;
  }

  // Cache-first, falling back to network (and re-populating the cache).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // Finding 8: same HTTP-cache concern as the install handler above —
      // this fallback only runs on a cache miss (a shell asset not covered
      // by SHELL_ASSETS/install, or a request racing an in-progress
      // install), but it must still bypass a possibly stale HTTP cache entry
      // rather than trust it into the SW cache.
      return fetch(event.request, { cache: "no-cache" }).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
