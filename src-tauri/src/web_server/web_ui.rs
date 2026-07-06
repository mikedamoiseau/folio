use axum::{
    http::header,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};

use super::WebState;

const INDEX_HTML: &str = include_str!("static/index.html");
const APP_JS: &str = include_str!("static/app.js");
const APP_CSS: &str = include_str!("static/app.css");
const FAVICON: &[u8] = include_bytes!("static/favicon.png");
// Item 9 (PWA): app-shell assets cached by sw.js. Whenever any embed on this
// page changes (this list, app.js, app.css, index.html, favicon), bump
// CACHE_VERSION in static/sw.js so clients evict the stale cached copies.
const MANIFEST_JSON: &str = include_str!("static/manifest.json");
const SW_JS: &str = include_str!("static/sw.js");
const ICON_192: &[u8] = include_bytes!("static/icon-192.png");
const ICON_512: &[u8] = include_bytes!("static/icon-512.png");

/// Finding 11: every path this module serves as a public, unauthenticated
/// static shell asset — the single source of truth shared by [`routes`]
/// below (each path here must have a matching `.route(...)` registration,
/// checked by `mod::tests::all_public_shell_assets_are_reachable_without_auth`)
/// and by `auth::auth_middleware`'s public-path carve-out, which matches
/// against this constant directly instead of duplicating the path list.
/// `static/sw.js`'s `SHELL_ASSETS` mirrors this list for precaching — see
/// the pointer comment there.
pub(crate) const PUBLIC_SHELL_ASSETS: &[&str] = &[
    "/",
    "/app.js",
    "/app.css",
    "/favicon.ico",
    "/favicon.png",
    "/manifest.json",
    "/sw.js",
    "/icon-192.png",
    "/icon-512.png",
];

/// Build routes for the embedded web UI.
pub fn routes() -> Router<WebState> {
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(serve_js))
        .route("/app.css", get(serve_css))
        .route("/favicon.png", get(serve_favicon))
        .route("/favicon.ico", get(serve_favicon))
        .route("/manifest.json", get(serve_manifest))
        .route("/sw.js", get(serve_sw))
        .route("/icon-192.png", get(serve_icon_192))
        .route("/icon-512.png", get(serve_icon_512))
}

async fn index() -> Response {
    // no-cache so the entry document (and thus any shell-asset changes it
    // pulls in) is revalidated on every load rather than held for an hour by
    // the browser HTTP cache on the plain-HTTP LAN path (no service worker).
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Html(INDEX_HTML),
    )
        .into_response()
}

async fn serve_js() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            // no-cache (revalidate each load), not max-age: the primary
            // mobile use case is a plain-HTTP LAN URL where the service
            // worker never registers, so a long max-age would hide UI updates
            // for up to an hour. Matches sw.js. Assets are small; the SW still
            // owns offline caching on secure contexts.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_JS,
    )
        .into_response()
}

async fn serve_css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            // no-cache (revalidate each load), not max-age: the primary
            // mobile use case is a plain-HTTP LAN URL where the service
            // worker never registers, so a long max-age would hide UI updates
            // for up to an hour. Matches sw.js. Assets are small; the SW still
            // owns offline caching on secure contexts.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_CSS,
    )
        .into_response()
}

async fn serve_favicon() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        FAVICON,
    )
        .into_response()
}

async fn serve_manifest() -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/manifest+json"),
            // no-cache (revalidate each load), not max-age: the primary
            // mobile use case is a plain-HTTP LAN URL where the service
            // worker never registers, so a long max-age would hide UI updates
            // for up to an hour. Matches sw.js. Assets are small; the SW still
            // owns offline caching on secure contexts.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        MANIFEST_JSON,
    )
        .into_response()
}

async fn serve_sw() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            // Never cache the service worker file itself — the browser needs
            // to see updates promptly to pick up a bumped CACHE_VERSION.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        SW_JS,
    )
        .into_response()
}

async fn serve_icon_192() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        ICON_192,
    )
        .into_response()
}

async fn serve_icon_512() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        ICON_512,
    )
        .into_response()
}
