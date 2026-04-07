use axum::{extract::State, routing::get, Json, Router};

use super::WebState;

/// Build all `/api/` routes.
pub fn routes(state: WebState) -> Router<WebState> {
    Router::new()
        .route("/health", get(health))
        .route("/auth", axum::routing::post(login))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

#[derive(serde::Deserialize)]
struct LoginRequest {
    pin: String,
}

#[derive(serde::Serialize)]
struct LoginResponse {
    token: String,
}

async fn login(
    State(state): State<WebState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, (axum::http::StatusCode, String)> {
    let valid = state
        .pin_hash
        .lock()
        .map_err(|e| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
            )
        })?
        .as_ref()
        .map(|hash| super::auth::verify_pin(&body.pin, hash))
        .unwrap_or(false);

    if !valid {
        return Err((axum::http::StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }

    let token = super::auth::create_session(&state);
    Ok(Json(LoginResponse { token }))
}
