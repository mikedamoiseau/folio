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

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn serve_js() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        APP_JS,
    )
        .into_response()
}

async fn serve_css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
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
            (header::CACHE_CONTROL, "public, max-age=3600"),
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
