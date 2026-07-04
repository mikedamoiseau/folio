// Item 9 (PWA): minimal service worker — cache-first for the static app
// shell only. Reading content and API data are never cached (freshness/auth
// complexity isn't worth it for v1; see docs/web-ui-improvements.md Item 9).
//
// Bump CACHE_VERSION whenever any shell asset below changes (app.js, app.css,
// index.html, favicon, manifest, icons) so clients pick up the new files
// instead of serving stale ones from the old cache. See the matching
// reminder comment in web_ui.rs next to the include_str!/include_bytes!
// embeds.
//
// Secure-context caveat: service workers only register on secure contexts
// (https, or http://localhost). Folio's primary LAN use case — a phone
// hitting http://192.168.x.x:7788 — is plain HTTP and NOT a secure context,
// so the service worker will not register there and this cache never
// activates; app.js's registration call is feature-detected/try-catched so
// this is silent, not an error. The manifest + icons still work for iOS
// Safari "Add to Home Screen" over plain HTTP.
const CACHE_VERSION = "folio-shell-v1";

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
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
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
      return fetch(event.request).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
