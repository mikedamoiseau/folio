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

// Reader typography faces (web reader typography controls). Content-addressed
// woff2 (filename carries a 12-char sha256 prefix), served `immutable`. Each
// entry's path MUST also appear in PUBLIC_SHELL_ASSETS below and in sw.js's
// SHELL_ASSETS array (enforced by mod::tests::font_assets_are_public_and_precached);
// the filename<->content-hash link is enforced by font_filenames_are_content_addressed
// and folded into the CACHE_VERSION hash by cache_version_embeds_shell_asset_content_hash.
const FONT_LORA_LATIN_NORMAL: &[u8] =
    include_bytes!("static/fonts/lora-latin-normal-ddb8c6603510.woff2");
const FONT_LORA_LATIN_ITALIC: &[u8] =
    include_bytes!("static/fonts/lora-latin-italic-d824d807d4d8.woff2");
const FONT_LORA_LATINEXT_NORMAL: &[u8] =
    include_bytes!("static/fonts/lora-latinext-normal-2a2d9c22c986.woff2");
const FONT_LORA_LATINEXT_ITALIC: &[u8] =
    include_bytes!("static/fonts/lora-latinext-italic-45f989df83f3.woff2");
const FONT_LITERATA_LATIN_NORMAL: &[u8] =
    include_bytes!("static/fonts/literata-latin-normal-9adbeac5b167.woff2");
const FONT_LITERATA_LATIN_ITALIC: &[u8] =
    include_bytes!("static/fonts/literata-latin-italic-ab198d6616c7.woff2");
const FONT_LITERATA_LATINEXT_NORMAL: &[u8] =
    include_bytes!("static/fonts/literata-latinext-normal-46792f7cd10b.woff2");
const FONT_LITERATA_LATINEXT_ITALIC: &[u8] =
    include_bytes!("static/fonts/literata-latinext-italic-ba0e6a12e2f0.woff2");
const FONT_DMSANS_LATIN_NORMAL: &[u8] =
    include_bytes!("static/fonts/dmsans-latin-normal-9fea608a947e.woff2");
const FONT_DMSANS_LATIN_ITALIC: &[u8] =
    include_bytes!("static/fonts/dmsans-latin-italic-f1a235db5bcb.woff2");
const FONT_DMSANS_LATINEXT_NORMAL: &[u8] =
    include_bytes!("static/fonts/dmsans-latinext-normal-a5d38fe99f93.woff2");
const FONT_DMSANS_LATINEXT_ITALIC: &[u8] =
    include_bytes!("static/fonts/dmsans-latinext-italic-6e646d202280.woff2");
const FONT_OPENDYSLEXIC_REGULAR: &[u8] =
    include_bytes!("static/fonts/opendyslexic-regular-f007004af3cd.woff2");
const FONT_OPENDYSLEXIC_BOLD: &[u8] =
    include_bytes!("static/fonts/opendyslexic-bold-dd9fa9c79911.woff2");
const FONT_OPENDYSLEXIC_ITALIC: &[u8] =
    include_bytes!("static/fonts/opendyslexic-italic-eb6a1bacf7e7.woff2");
const FONT_OPENDYSLEXIC_BOLDITALIC: &[u8] =
    include_bytes!("static/fonts/opendyslexic-bolditalic-a20d82c2a1a0.woff2");

/// The embedded reader fonts, as (route path, bytes). Single source of truth
/// for route registration, the public-asset lists, and the content-hash tests.
pub(crate) const FONT_ASSETS: &[(&str, &[u8])] = &[
    (
        "/fonts/lora-latin-normal-ddb8c6603510.woff2",
        FONT_LORA_LATIN_NORMAL,
    ),
    (
        "/fonts/lora-latin-italic-d824d807d4d8.woff2",
        FONT_LORA_LATIN_ITALIC,
    ),
    (
        "/fonts/lora-latinext-normal-2a2d9c22c986.woff2",
        FONT_LORA_LATINEXT_NORMAL,
    ),
    (
        "/fonts/lora-latinext-italic-45f989df83f3.woff2",
        FONT_LORA_LATINEXT_ITALIC,
    ),
    (
        "/fonts/literata-latin-normal-9adbeac5b167.woff2",
        FONT_LITERATA_LATIN_NORMAL,
    ),
    (
        "/fonts/literata-latin-italic-ab198d6616c7.woff2",
        FONT_LITERATA_LATIN_ITALIC,
    ),
    (
        "/fonts/literata-latinext-normal-46792f7cd10b.woff2",
        FONT_LITERATA_LATINEXT_NORMAL,
    ),
    (
        "/fonts/literata-latinext-italic-ba0e6a12e2f0.woff2",
        FONT_LITERATA_LATINEXT_ITALIC,
    ),
    (
        "/fonts/dmsans-latin-normal-9fea608a947e.woff2",
        FONT_DMSANS_LATIN_NORMAL,
    ),
    (
        "/fonts/dmsans-latin-italic-f1a235db5bcb.woff2",
        FONT_DMSANS_LATIN_ITALIC,
    ),
    (
        "/fonts/dmsans-latinext-normal-a5d38fe99f93.woff2",
        FONT_DMSANS_LATINEXT_NORMAL,
    ),
    (
        "/fonts/dmsans-latinext-italic-6e646d202280.woff2",
        FONT_DMSANS_LATINEXT_ITALIC,
    ),
    (
        "/fonts/opendyslexic-regular-f007004af3cd.woff2",
        FONT_OPENDYSLEXIC_REGULAR,
    ),
    (
        "/fonts/opendyslexic-bold-dd9fa9c79911.woff2",
        FONT_OPENDYSLEXIC_BOLD,
    ),
    (
        "/fonts/opendyslexic-italic-eb6a1bacf7e7.woff2",
        FONT_OPENDYSLEXIC_ITALIC,
    ),
    (
        "/fonts/opendyslexic-bolditalic-a20d82c2a1a0.woff2",
        FONT_OPENDYSLEXIC_BOLDITALIC,
    ),
];

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
    // Reader typography fonts — kept in lockstep with FONT_ASSETS by
    // mod::tests::font_assets_are_public_and_precached.
    "/fonts/lora-latin-normal-ddb8c6603510.woff2",
    "/fonts/lora-latin-italic-d824d807d4d8.woff2",
    "/fonts/lora-latinext-normal-2a2d9c22c986.woff2",
    "/fonts/lora-latinext-italic-45f989df83f3.woff2",
    "/fonts/literata-latin-normal-9adbeac5b167.woff2",
    "/fonts/literata-latin-italic-ab198d6616c7.woff2",
    "/fonts/literata-latinext-normal-46792f7cd10b.woff2",
    "/fonts/literata-latinext-italic-ba0e6a12e2f0.woff2",
    "/fonts/dmsans-latin-normal-9fea608a947e.woff2",
    "/fonts/dmsans-latin-italic-f1a235db5bcb.woff2",
    "/fonts/dmsans-latinext-normal-a5d38fe99f93.woff2",
    "/fonts/dmsans-latinext-italic-6e646d202280.woff2",
    "/fonts/opendyslexic-regular-f007004af3cd.woff2",
    "/fonts/opendyslexic-bold-dd9fa9c79911.woff2",
    "/fonts/opendyslexic-italic-eb6a1bacf7e7.woff2",
    "/fonts/opendyslexic-bolditalic-a20d82c2a1a0.woff2",
];

/// Build routes for the embedded web UI.
pub fn routes() -> Router<WebState> {
    let mut router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(serve_js))
        .route("/app.css", get(serve_css))
        .route("/favicon.png", get(serve_favicon))
        .route("/favicon.ico", get(serve_favicon))
        .route("/manifest.json", get(serve_manifest))
        .route("/sw.js", get(serve_sw))
        .route("/icon-192.png", get(serve_icon_192))
        .route("/icon-512.png", get(serve_icon_512));
    // Register the content-addressed reader fonts from the single FONT_ASSETS
    // table so routes, public list, and precache list cannot drift.
    for &(path, bytes) in FONT_ASSETS {
        router = router.route(path, get(move || serve_font(bytes)));
    }
    router
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

async fn serve_font(bytes: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
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
