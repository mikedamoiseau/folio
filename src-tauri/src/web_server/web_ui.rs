use axum::{response::Html, routing::get, Router};

use super::WebState;

/// Build routes for the embedded web UI.
pub fn routes() -> Router<WebState> {
    Router::new().route("/", get(index))
}

async fn index() -> Html<&'static str> {
    // Stub — full embedded web UI comes in step 6
    Html("<html><body><h1>Folio</h1><p>Web UI coming soon.</p></body></html>")
}
