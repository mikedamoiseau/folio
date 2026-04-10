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

/// Build routes for the embedded web UI.
pub fn routes() -> Router<WebState> {
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(serve_js))
        .route("/app.css", get(serve_css))
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
