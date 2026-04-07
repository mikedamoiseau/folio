use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::WebState;

const KEYRING_SERVICE: &str = "folio-web-server";
const KEYRING_USER: &str = "pin";
const SESSION_TTL_SECS: u64 = 86400; // 24 hours

/// Hash a PIN using SHA-256.
pub fn hash_pin(pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(pin.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Store the PIN hash in the OS keychain.
pub fn store_pin(pin: &str) -> Result<(), String> {
    let hash = hash_pin(pin);
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    entry.set_password(&hash).map_err(|e| e.to_string())
}

/// Load the PIN hash from the OS keychain (None if not set).
pub fn load_pin_hash() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    entry.get_password().ok()
}

/// Verify a PIN against the stored hash.
pub fn verify_pin(pin: &str, stored_hash: &str) -> bool {
    hash_pin(pin) == stored_hash
}

/// Create a new session token and store it.
pub fn create_session(state: &WebState) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(token.clone(), std::time::Instant::now());
    }
    token
}

/// Check if a session token is valid (exists and not expired).
pub fn validate_session(state: &WebState, token: &str) -> bool {
    if let Ok(mut sessions) = state.sessions.lock() {
        // Clean expired sessions opportunistically
        let ttl = std::time::Duration::from_secs(SESSION_TTL_SECS);
        sessions.retain(|_, created| created.elapsed() < ttl);

        sessions.contains_key(token)
    } else {
        false
    }
}

/// Extract a bearer token from the Authorization header.
fn extract_bearer(req: &Request<Body>) -> Option<String> {
    let header = req.headers().get("authorization")?.to_str().ok()?;
    header.strip_prefix("Bearer ").map(|s| s.to_string())
}

/// Extract a PIN from HTTP Basic Auth (for OPDS clients).
fn extract_basic_pin(req: &Request<Body>) -> Option<String> {
    use base64::Engine;
    let header = req.headers().get("authorization")?.to_str().ok()?;
    let encoded = header.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    // Format: "username:password" — we only care about the password (PIN)
    text.split_once(':').map(|(_, pin)| pin.to_string())
}

/// Extract session token from cookie.
fn extract_cookie_token(req: &Request<Body>) -> Option<String> {
    let cookie_header = req.headers().get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some(token) = trimmed.strip_prefix("folio_session=") {
            return Some(token.to_string());
        }
    }
    None
}

/// Auth middleware — checks for valid session or Basic Auth PIN.
pub async fn auth_middleware(
    State(state): State<WebState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();

    // Allow unauthenticated access to login-related routes and static assets
    if path == "/api/auth"
        || path == "/"
        || path == "/app.js"
        || path == "/app.css"
        || path == "/favicon.ico"
    {
        return next.run(req).await;
    }

    // Check bearer token (from header or cookie)
    if let Some(token) = extract_bearer(&req).or_else(|| extract_cookie_token(&req)) {
        if validate_session(&state, &token) {
            return next.run(req).await;
        }
    }

    // Check HTTP Basic Auth (for OPDS clients)
    if let Some(pin) = extract_basic_pin(&req) {
        let valid = state
            .pin_hash
            .lock()
            .ok()
            .and_then(|h| h.as_ref().map(|hash| verify_pin(&pin, hash)))
            .unwrap_or(false);

        if valid {
            return next.run(req).await;
        }
    }

    (StatusCode::UNAUTHORIZED, "Authentication required").into_response()
}
