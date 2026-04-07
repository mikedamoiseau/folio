use axum::{routing::get, Router};

use super::WebState;

/// Build all `/opds/` routes.
pub fn routes(_state: WebState) -> Router<WebState> {
    Router::new().route("/", get(root_catalog))
}

async fn root_catalog() -> &'static str {
    // Stub — full OPDS XML generation comes in step 5
    "OPDS catalog placeholder"
}
