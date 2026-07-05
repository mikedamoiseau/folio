pub mod api;
pub mod auth;
pub mod opds_feed;
pub mod web_ui;

use crate::db::DbPool;
use crate::error::{FolioError, FolioResult};
use axum::{http::StatusCode, middleware, Router};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// State shared with all axum handlers.
#[derive(Clone)]
pub struct WebState {
    /// The currently-active profile's DB pool (swapped on profile switch).
    pub pool: Arc<Mutex<DbPool>>,
    /// App data directory (covers, EPUB images, etc.).
    pub data_dir: PathBuf,
    /// SHA-256 hash of the PIN (None if no PIN configured).
    pub pin_hash: Arc<Mutex<Option<String>>>,
    /// Active session tokens → creation time.
    pub sessions: Arc<Mutex<HashMap<String, std::time::Instant>>>,
    /// Rate limiter for login attempts (R2-2).
    pub login_limiter: Arc<auth::RateLimiter>,
}

impl WebState {
    /// Get a database connection from the active pool.
    pub fn conn(
        &self,
    ) -> FolioResult<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
        let pool = self.pool.lock()?;
        Ok(pool.get()?)
    }

    /// Resolve a book's stored `file_path` to an absolute local path,
    /// applying the same #64 M4 semantics the Tauri app uses:
    /// - linked books → return unchanged
    /// - legacy imported rows with an absolute path → return unchanged
    /// - imported rows with a storage key → resolve through the library
    ///   folder setting (falls back to the platform default)
    pub fn resolve_book_path(&self, book: &folio_core::models::Book) -> FolioResult<String> {
        if !book.is_imported {
            return Ok(book.file_path.clone());
        }
        let p = std::path::Path::new(&book.file_path);
        if p.is_absolute() {
            return Ok(book.file_path.clone());
        }
        let folder = {
            let conn = self.conn()?;
            match folio_core::db::get_setting(&conn, "library_folder")? {
                Some(f) => f,
                None => folio_core::paths::default_library_folder()?,
            }
        };
        let storage = folio_core::storage::LocalStorage::new(folder)?;
        use folio_core::storage::Storage;
        Ok(storage
            .local_path(&book.file_path)?
            .to_string_lossy()
            .to_string())
    }

    /// Returns a `Storage` handle for EPUB inline chapter images, rooted at
    /// `{data_dir}/images`. Mirrors `AppState::images_storage` so the Tauri
    /// and web-server flows write to the same physical layout. Introduced
    /// for #64 M6.
    pub fn images_storage(&self) -> FolioResult<Arc<dyn folio_core::storage::Storage>> {
        let root = self.data_dir.join("images");
        Ok(Arc::new(folio_core::storage::LocalStorage::new(root)?))
    }

    /// The app-managed covers root, `{data_dir}/covers` — mirrors
    /// `AppState::covers_storage`'s layout. Used by
    /// `api::cover_write_path_is_safe` to confirm a book's (DB-backed, so
    /// potentially malformed) `cover_path` resolves inside this directory
    /// before the `?size=thumb` cache is allowed to write a sibling
    /// `thumb.jpg` next to it.
    pub fn covers_root(&self) -> PathBuf {
        self.data_dir.join("covers")
    }

    /// Whether a PIN is currently configured (i.e. web auth is enabled).
    /// Mirrors the check `auth_middleware` performs. A poisoned lock is
    /// treated as "PIN configured" so callers fail toward the safer choice
    /// (e.g. a non-cacheable response) rather than toward open access.
    pub fn has_pin(&self) -> bool {
        self.pin_hash
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(true)
    }
}

/// Map any error convertible to [`FolioError`] into an HTTP `(status, message)`
/// tuple for axum handlers.
///
/// `NotFound` → 404, `PermissionDenied` → 403, `InvalidInput` → 400,
/// `Network` → 502; everything else → 500. Accepts `FolioError` directly or
/// any source error with a `From<E> for FolioError` impl (e.g. `std::io::Error`).
pub fn folio_status<E: Into<FolioError>>(e: E) -> (StatusCode, String) {
    let err: FolioError = e.into();
    let status = match err.kind() {
        "NotFound" => StatusCode::NOT_FOUND,
        "PermissionDenied" => StatusCode::FORBIDDEN,
        "InvalidInput" => StatusCode::BAD_REQUEST,
        "Network" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, err.to_string())
}

/// Handle to a running web server instance.
pub struct WebServerHandle {
    pub shutdown_tx: oneshot::Sender<()>,
    pub url: String,
    pub port: u16,
}

/// Which user-facing surfaces the embedded HTTP server exposes.
#[derive(Debug, Clone, Copy)]
pub struct ServerModes {
    pub web_ui: bool,
    pub opds: bool,
}

impl ServerModes {
    /// Whether the server should run at all.
    pub fn any(&self) -> bool {
        self.web_ui || self.opds
    }
}

/// Status returned to the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
    pub has_pin: bool,
    pub web_ui_enabled: bool,
    pub opds_enabled: bool,
}

/// Detect the local LAN IP address.
/// Uses a UDP socket connecting to Google DNS (8.8.8.8:53) to determine
/// which local interface would be used for outbound traffic.
pub fn get_local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // R2-3: Use port 53 (DNS), not 80 (HTTP). No actual packet is sent —
    // connect() on a UDP socket just sets the default destination and lets
    // us read the local address the OS chose.
    socket.connect("8.8.8.8:53").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    // Don't return loopback — it's useless for LAN access
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

/// Item 6: CSP hash for the tiny inline bootstrap script in index.html's
/// `<head>` that sets `data-theme` before first paint (avoids a flash of the
/// wrong theme). Must be regenerated (sha256, base64) if that script's exact
/// text ever changes — a mismatch here means the browser silently blocks the
/// script instead of erroring, so `test_csp_allows_theme_bootstrap_script_hash`
/// exists to catch drift in CI.
const THEME_BOOTSTRAP_SCRIPT_HASH: &str = "'sha256-FGUWTgqSoem8FWO0BBhrwgmMQsdK1kJ8wuiBBS6w55w='";

/// Middleware that adds security headers to all responses (R3-3).
async fn security_headers_middleware(
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert(
        "content-security-policy",
        format!(
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
             script-src 'self' {THEME_BOOTSTRAP_SCRIPT_HASH}"
        )
        .parse()
        .unwrap(),
    );
    response
}

/// Build the full axum router with all routes and middleware.
/// Routes are conditionally mounted based on `modes`. Calling with
/// `ServerModes { web_ui: false, opds: false }` returns a router that
/// 404s every path — safe to call but the reconciler in commands.rs
/// short-circuits before reaching this state in production.
pub fn build_router(state: WebState, modes: ServerModes) -> Router {
    let mut router = Router::new();

    if modes.web_ui {
        // Web UI consumes /api, so /api lives alongside web_ui mode.
        // Without web_ui there's no consumer for /api.
        let api_routes = api::routes(state.clone());
        router = router.nest("/api", api_routes).merge(web_ui::routes());
    }
    if modes.opds {
        let opds_routes = opds_feed::routes(state.clone());
        router = router.nest("/opds", opds_routes);
    }

    router
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}

/// Default port for the web server.
pub const DEFAULT_PORT: u16 = 7788;

/// Start the web server on the given port. Returns a handle for shutdown.
pub async fn start(
    state: WebState,
    port: u16,
    modes: ServerModes,
) -> crate::error::FolioResult<WebServerHandle> {
    use crate::error::FolioError;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let router = build_router(state, modes);

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            FolioError::invalid(format!(
                "Port {port} is already in use. Try a different port (1024\u{2013}65535)."
            ))
        } else if e.kind() == std::io::ErrorKind::PermissionDenied {
            FolioError::permission(format!(
                "Permission denied for port {port}. Use a port above 1024."
            ))
        } else {
            FolioError::network(format!("Failed to start server on port {port}: {e}"))
        }
    })?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .ok();
    });

    let ip = get_local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    let url = format!("http://{}:{}", ip, port);

    Ok(WebServerHandle {
        shutdown_tx,
        url,
        port,
    })
}

/// Stop a running web server by sending on its shutdown channel.
pub fn stop(handle: WebServerHandle) {
    let _ = handle.shutdown_tx.send(());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> WebState {
        let pool =
            crate::db::create_pool(&std::path::PathBuf::from(":memory:")).expect("in-memory DB");
        WebState {
            pool: Arc::new(Mutex::new(pool)),
            data_dir: PathBuf::from("/tmp"),
            pin_hash: Arc::new(Mutex::new(None)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            login_limiter: Arc::new(auth::RateLimiter::new(5, 300)),
        }
    }

    #[test]
    fn test_get_local_ip() {
        // Should return Some on machines with network access
        let ip = get_local_ip();
        if let Some(ref addr) = ip {
            assert!(!addr.is_empty());
            // Should look like an IP address (contains dots)
            assert!(addr.contains('.'));
            // R2-3: Should not be 127.0.0.1 on a machine with a LAN interface
            // (can't strictly assert this in CI, but verify it's a valid IP)
            assert!(addr.parse::<std::net::IpAddr>().is_ok());
        }
    }

    #[test]
    fn test_default_port() {
        assert_eq!(DEFAULT_PORT, 7788);
    }

    #[test]
    fn test_web_state_conn() {
        let state = test_state();
        // Should be able to get a connection from the pool
        let conn = state.conn();
        assert!(conn.is_ok());
    }

    #[tokio::test]
    async fn test_start_and_stop_server() {
        let state = test_state();
        // Use port 0 to let the OS assign a free port
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let server_handle = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
        });

        // Server should be responding
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{actual_port}/api/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Shutdown
        let _ = shutdown_tx.send(());
        let _ = server_handle.await;
    }

    #[tokio::test]
    async fn test_server_auth_blocks_protected_routes() {
        let state = test_state();
        // Set a PIN so auth is required
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        // Protected route without auth should return 401
        let resp = client
            .get(format!("http://127.0.0.1:{actual_port}/api/books"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        // Public routes should work without auth
        let resp = client
            .get(format!("http://127.0.0.1:{actual_port}/api/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let _ = shutdown_tx.send(());
    }

    #[tokio::test]
    async fn test_server_login_and_access() {
        let state = test_state();
        let pin_hash = auth::hash_pin("9876");
        *state.pin_hash.lock().unwrap() = Some(pin_hash);

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        // Login with correct PIN
        let resp = client
            .post(format!("http://127.0.0.1:{actual_port}/api/auth"))
            .json(&serde_json::json!({"pin": "9876"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        let token = body["token"].as_str().unwrap();
        assert!(!token.is_empty());

        // Login with wrong PIN
        let resp = client
            .post(format!("http://127.0.0.1:{actual_port}/api/auth"))
            .json(&serde_json::json!({"pin": "0000"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        let _ = shutdown_tx.send(());
    }

    #[tokio::test]
    async fn test_login_sets_cookie() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{port}/api/auth"))
            .json(&serde_json::json!({"pin": "1234"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Check Set-Cookie header
        let cookie = resp
            .headers()
            .get("set-cookie")
            .expect("login should set a cookie");
        let cookie_str = cookie.to_str().unwrap();
        assert!(cookie_str.contains("folio_session="));
        assert!(cookie_str.contains("HttpOnly"));
        assert!(cookie_str.contains("SameSite=Strict"));

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_bearer_token_grants_access() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("5555"));

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        // Login to get token
        let resp = client
            .post(format!("http://127.0.0.1:{port}/api/auth"))
            .json(&serde_json::json!({"pin": "5555"}))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = resp.json().await.unwrap();
        let token = body["token"].as_str().unwrap();

        // Use bearer token to access protected route
        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/books"))
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .unwrap();
        // Should not be 401 (might be 404 since /api/books isn't implemented yet, that's ok)
        assert_ne!(resp.status(), 401);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_basic_auth_grants_access() {
        use base64::Engine;

        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("7777"));

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode("user:7777");

        // Basic auth with correct PIN should grant access to OPDS
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .header("Authorization", format!("Basic {encoded}"))
            .send()
            .await
            .unwrap();
        assert_ne!(resp.status(), 401);

        // Basic auth with wrong PIN should be rejected
        let wrong = base64::engine::general_purpose::STANDARD.encode("user:0000");
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .header("Authorization", format!("Basic {wrong}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_no_pin_allows_all_access() {
        let state = test_state();
        // pin_hash is None — no PIN set, should allow open access

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        // Protected route should be accessible without auth when no PIN is set
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .send()
            .await
            .unwrap();
        assert_ne!(
            resp.status(),
            401,
            "No PIN = open access, should not get 401"
        );

        let _ = tx.send(());
    }

    // R3-3: CSP headers present on responses
    #[tokio::test]
    async fn test_responses_have_security_headers() {
        let state = test_state();
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .send()
            .await
            .unwrap();

        assert!(resp.headers().contains_key("x-content-type-options"));
        assert!(resp.headers().contains_key("x-frame-options"));
        assert!(resp.headers().contains_key("content-security-policy"));

        let _ = tx.send(());
    }

    // Item 6: the theme bootstrap inline script in index.html (sets
    // data-theme before first paint, avoiding a flash of the wrong theme)
    // must be allowed by CSP via a script-src hash rather than a blanket
    // 'unsafe-inline'. Finding 7: the hash is computed here independently
    // from the actual served index.html (the same file web_ui.rs embeds via
    // include_str!) rather than compared against THEME_BOOTSTRAP_SCRIPT_HASH
    // itself — comparing the constant to the constant it also builds the CSP
    // header from could never catch drift between the script text and the
    // hash, which is exactly the case this test exists to catch.
    #[tokio::test]
    async fn test_csp_allows_theme_bootstrap_script_hash() {
        use base64::Engine;
        use sha2::{Digest, Sha256};

        // Same source of truth web_ui.rs embeds as INDEX_HTML.
        const INDEX_HTML: &str = include_str!("static/index.html");
        let open_tag = "<script>";
        let start = INDEX_HTML
            .find(open_tag)
            .expect("bootstrap <script> tag not found in index.html")
            + open_tag.len();
        let end = INDEX_HTML[start..]
            .find("</script>")
            .expect("closing </script> tag not found after bootstrap script")
            + start;
        let script_body = &INDEX_HTML[start..end];

        let digest = Sha256::digest(script_body.as_bytes());
        let computed_hash = format!(
            "'sha256-{}'",
            base64::engine::general_purpose::STANDARD.encode(digest)
        );
        assert_eq!(
            computed_hash, THEME_BOOTSTRAP_SCRIPT_HASH,
            "THEME_BOOTSTRAP_SCRIPT_HASH is out of date with index.html's actual bootstrap \
             script text — regenerate it if the script was intentionally changed"
        );

        let state = test_state();
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();

        let csp = resp
            .headers()
            .get("content-security-policy")
            .expect("CSP header present")
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            csp.contains(&computed_hash),
            "CSP script-src should allow the independently-computed bootstrap script hash: {csp}"
        );
        assert!(
            csp.contains("script-src 'self'"),
            "script-src should still allow the external app.js: {csp}"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn build_router_web_ui_only_serves_root_not_opds() {
        let state = test_state();
        let modes = ServerModes {
            web_ui: true,
            opds: false,
        };
        let router = build_router(state, modes);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        // / → 200 (HTML UI)
        let resp = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // /opds → 404 (not mounted)
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn build_router_opds_only_serves_opds_not_root() {
        let state = test_state();
        let modes = ServerModes {
            web_ui: false,
            opds: true,
        };
        let router = build_router(state, modes);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        // /opds → 200
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // / → 404 (web UI not mounted)
        let resp = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
        // /api/* → 404 (api lives with web_ui)
        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn build_router_both_serves_root_and_opds() {
        let state = test_state();
        let modes = ServerModes {
            web_ui: true,
            opds: true,
        };
        let router = build_router(state, modes);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let r1 = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(r1.status(), 200);
        let r2 = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .send()
            .await
            .unwrap();
        assert_eq!(r2.status(), 200);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn data_export_requires_auth() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/data-export"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        let _ = tx.send(());
    }

    #[tokio::test]
    async fn data_export_forbidden_without_pin() {
        // No PIN configured: `auth_middleware` lets every route through, but the
        // bulk personal-data export must still refuse to serve on an
        // unauthenticated server.
        let state = test_state();
        assert!(state.pin_hash.lock().unwrap().is_none());

        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/data-export"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
        let _ = tx.send(());
    }

    #[tokio::test]
    async fn data_export_returns_zip_for_authed_request() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        // Authenticate via HTTP Basic Auth (PIN as password).
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/data-export"))
            .basic_auth("folio", Some("1234"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/zip"
        );
        let disp = resp
            .headers()
            .get("content-disposition")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(disp.contains("folio-export-"));
        assert!(disp.ends_with(".zip\""));

        let bytes = resp.bytes().await.unwrap();
        let reader = std::io::Cursor::new(bytes.to_vec());
        let mut archive = zip::ZipArchive::new(reader).expect("valid zip");
        assert_eq!(archive.len(), 1);
        let mut entry = archive.by_index(0).unwrap();
        assert!(entry.name().starts_with("folio-export-"));
        assert!(entry.name().ends_with(".json"));
        let mut contents = String::new();
        std::io::Read::read_to_string(&mut entry, &mut contents).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("valid json");
        assert!(parsed["books"].is_array());
        assert!(parsed["activity_log"].is_array());
        assert!(parsed["settings"].is_object());

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn build_router_neither_serves_nothing() {
        let state = test_state();
        let modes = ServerModes {
            web_ui: false,
            opds: false,
        };
        // Must not panic. Every request 404s.
        let router = build_router(state, modes);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
        let resp = client
            .get(format!("http://127.0.0.1:{port}/opds"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let _ = tx.send(());
    }

    /// Minimal CBZ fixture with a single (fake) page image, for the
    /// page-image/page-count cache-control tests below.
    fn write_cache_test_cbz(dir: &std::path::Path) -> std::path::PathBuf {
        let cbz_path = dir.join("test.cbz");
        let file = std::fs::File::create(&cbz_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("page01.jpg", options).unwrap();
        std::io::Write::write_all(&mut zip, b"fake jpg bytes").unwrap();
        zip.finish().unwrap();
        cbz_path
    }

    fn cache_test_book(cbz_path: &std::path::Path) -> crate::models::Book {
        crate::models::Book {
            id: "cache-test-book".to_string(),
            title: "Cache Test".to_string(),
            author: "Author".to_string(),
            file_path: cbz_path.to_string_lossy().to_string(),
            cover_path: None,
            total_chapters: 1,
            added_at: 0,
            format: crate::models::BookFormat::Cbz,
            file_hash: None,
            description: None,
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: false,
        }
    }

    #[tokio::test]
    async fn page_image_and_page_count_cache_control_no_pin() {
        let state = test_state();
        // pin_hash is None — no PIN configured, so responses are safe to
        // cache in the browser for a while.

        let dir = tempfile::tempdir().unwrap();
        let cbz_path = write_cache_test_cbz(dir.path());
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cache_test_book(&cbz_path)).unwrap();
        }

        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/cache-test-book/pages/0"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .unwrap()
                .to_str()
                .unwrap(),
            "private, max-age=3600",
            "pages/{{index}} should be cacheable when no PIN is configured"
        );

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/cache-test-book/page-count"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .unwrap()
                .to_str()
                .unwrap(),
            "private, max-age=3600",
            "page-count should be cacheable when no PIN is configured"
        );

        let _ = tx.send(());
    }

    // S2: once a PIN is configured, a cached page image/page-count response
    // would let the same browser keep serving protected pages for up to an
    // hour after the session expires — those requests never reach
    // `auth_middleware` at all. `no-store` closes that gap.
    #[tokio::test]
    async fn page_image_and_page_count_cache_control_with_pin_is_no_store() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));

        let dir = tempfile::tempdir().unwrap();
        let cbz_path = write_cache_test_cbz(dir.path());
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cache_test_book(&cbz_path)).unwrap();
        }

        let router = build_router(
            state,
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });

        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/cache-test-book/pages/0"
            ))
            .basic_auth("folio", Some("1234"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .unwrap()
                .to_str()
                .unwrap(),
            "no-store",
            "pages/{{index}} must not be cacheable once a PIN is configured"
        );

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/cache-test-book/page-count"
            ))
            .basic_auth("folio", Some("1234"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .unwrap()
                .to_str()
                .unwrap(),
            "no-store",
            "page-count must not be cacheable once a PIN is configured"
        );

        let _ = tx.send(());
    }

    // ── Item 11: cover thumbnails ────────────────────────────────────────────

    /// Encodes a solid-color JPEG of the given dimensions to `path`.
    fn write_test_jpeg(path: &std::path::Path, w: u32, h: u32) {
        let buf: image::ImageBuffer<image::Rgb<u8>, Vec<u8>> =
            image::ImageBuffer::from_fn(w, h, |_, _| image::Rgb([180u8, 90, 60]));
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 90);
        encoder.encode_image(&buf).unwrap();
    }

    fn cover_test_book(id: &str, cover_path: Option<&std::path::Path>) -> crate::models::Book {
        crate::models::Book {
            id: id.to_string(),
            title: "Cover Test".to_string(),
            author: "Author".to_string(),
            file_path: "/nonexistent/cover-test.epub".to_string(),
            cover_path: cover_path.map(|p| p.to_string_lossy().to_string()),
            total_chapters: 1,
            added_at: 0,
            format: crate::models::BookFormat::Epub,
            file_hash: None,
            description: None,
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: false,
        }
    }

    fn dims_of(bytes: &[u8]) -> (u32, u32) {
        image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap()
    }

    #[tokio::test]
    async fn cover_thumb_returns_downscaled_jpeg() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-1", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-1/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "image/jpeg"
        );
        let bytes = resp.bytes().await.unwrap();
        let (w, _h) = dims_of(&bytes);
        assert!(
            w <= crate::commands::THUMB_WIDTH,
            "thumb width {w} must be <= desktop THUMB_WIDTH {}",
            crate::commands::THUMB_WIDTH
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_thumb_persists_and_second_request_serves_cached_file() {
        let mut state = test_state();
        let dir = tempfile::tempdir().unwrap();
        // Finding 1 requires the thumbnail write to land inside
        // `{data_dir}/covers` — lay the fixture out like the real app does
        // (`{data_dir}/covers/{book_id}/cover.jpg`) so the persist isn't
        // skipped by the new safety guard.
        state.data_dir = dir.path().to_path_buf();
        let cover_dir = dir.path().join("covers").join("thumb-2");
        std::fs::create_dir_all(&cover_dir).unwrap();
        let cover_path = cover_dir.join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-2", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-2/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let thumb_path = cover_dir.join("thumb.jpg");
        assert!(thumb_path.exists(), "first request must persist thumb.jpg");

        // Overwrite the persisted thumbnail with a marker so we can prove
        // the second request serves the cached file instead of regenerating.
        let marker = b"MARKER-BYTES-NOT-A-REAL-JPEG-BUT-READ-AS-IS".to_vec();
        std::fs::write(&thumb_path, &marker).unwrap();

        let resp2 = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-2/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp2.status(), 200);
        let bytes2 = resp2.bytes().await.unwrap();
        assert_eq!(
            bytes2.as_ref(),
            marker.as_slice(),
            "second request must serve the persisted thumb.jpg unchanged, not regenerate"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_thumb_returns_original_bytes_for_small_cover() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        // Below THUMB_WIDTH (320) — make_thumbnail returns Ok(None).
        write_test_jpeg(&cover_path, 200, 300);
        let original_bytes = std::fs::read(&cover_path).unwrap();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-3", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-3/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = resp.bytes().await.unwrap();
        assert_eq!(
            bytes.as_ref(),
            original_bytes.as_slice(),
            "small cover must be served unchanged when thumb is requested"
        );

        let thumb_path = dir.path().join("thumb.jpg");
        assert!(
            !thumb_path.exists(),
            "no thumb.jpg should be persisted for an already-small cover"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_no_size_param_is_byte_identical_to_previous_behavior() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        let original_bytes = std::fs::read(&cover_path).unwrap();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-4", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/books/thumb-4/cover"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = resp.bytes().await.unwrap();
        assert_eq!(bytes.as_ref(), original_bytes.as_slice());

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_unknown_size_value_falls_back_to_full() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        let original_bytes = std::fs::read(&cover_path).unwrap();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-5", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-5/cover?size=banana"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = resp.bytes().await.unwrap();
        assert_eq!(bytes.as_ref(), original_bytes.as_slice());

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_no_cover_404s_for_both_sizes() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("no-cover-1", None)).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/no-cover-1/cover"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/no-cover-1/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_cache_control_no_pin() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-6", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        for url in [
            format!("http://127.0.0.1:{port}/api/books/thumb-6/cover"),
            format!("http://127.0.0.1:{port}/api/books/thumb-6/cover?size=thumb"),
        ] {
            let resp = client.get(&url).send().await.unwrap();
            assert_eq!(resp.status(), 200);
            assert_eq!(
                resp.headers()
                    .get("cache-control")
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "private, max-age=86400",
                "{url} should be cacheable when no PIN is configured"
            );
        }

        let _ = tx.send(());
    }

    // Finding 8: covers are decorative artwork, not book content — unlike
    // page images/page-count, they stay cacheable even once a PIN is
    // configured (OPDS e-reader clients re-fetch full covers constantly
    // under per-request Basic Auth, and a blanket `no-store` regressed them
    // for little real security benefit).
    #[tokio::test]
    async fn cover_cache_control_with_pin_is_still_cacheable() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1234"));
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-7", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        for url in [
            format!("http://127.0.0.1:{port}/api/books/thumb-7/cover"),
            format!("http://127.0.0.1:{port}/api/books/thumb-7/cover?size=thumb"),
        ] {
            let resp = client
                .get(&url)
                .basic_auth("folio", Some("1234"))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
            assert_eq!(
                resp.headers()
                    .get("cache-control")
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "private, max-age=86400",
                "{url} should stay cacheable even once a PIN is configured — covers aren't \
                 session-sensitive like page content"
            );
        }

        let _ = tx.send(());
    }

    // Finding 1: a `cover_path` outside the app's covers root (e.g. a
    // malformed/adversarial DB row) must still be servable — reading it is
    // pre-existing behavior — but the thumbnail-cache write this feature
    // introduces must never be steered outside that directory.
    #[tokio::test]
    async fn cover_thumb_write_skipped_outside_covers_root() {
        let state = test_state();
        // `test_state()` fixes `data_dir` to `/tmp`, so a cover living in an
        // unrelated tempdir (same shape every other cover test used before
        // this review pass) resolves outside `{data_dir}/covers`.
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-8", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-8/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = resp.bytes().await.unwrap();
        let (w, _h) = dims_of(&bytes);
        assert!(
            w <= crate::commands::THUMB_WIDTH,
            "must still serve an in-memory-generated thumbnail even when the write is skipped"
        );

        let thumb_path = dir.path().join("thumb.jpg");
        assert!(
            !thumb_path.exists(),
            "a cover_path outside the covers root must never get a thumb.jpg written next to it"
        );

        let _ = tx.send(());
    }

    // Finding 2a: a persisted thumbnail must not be served forever once the
    // cover it was made from has been replaced.
    #[tokio::test]
    async fn cover_thumb_regenerates_after_cover_replaced() {
        let mut state = test_state();
        let dir = tempfile::tempdir().unwrap();
        state.data_dir = dir.path().to_path_buf();
        let cover_dir = dir.path().join("covers").join("thumb-9");
        std::fs::create_dir_all(&cover_dir).unwrap();
        let cover_path = cover_dir.join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-9", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-9/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let (_w1, h1) = dims_of(&resp.bytes().await.unwrap());

        let thumb_path = cover_dir.join("thumb.jpg");
        assert!(thumb_path.exists(), "first request must persist thumb.jpg");

        // Replace the cover with a differently-shaped image and force its
        // mtime strictly ahead of the persisted thumbnail's — the freshness
        // check (finding 2a) has nothing else to key off of.
        write_test_jpeg(&cover_path, 900, 300);
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cover_path)
            .unwrap()
            .set_modified(future)
            .unwrap();

        let resp2 = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-9/cover?size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp2.status(), 200);
        let (_w2, h2) = dims_of(&resp2.bytes().await.unwrap());

        assert_ne!(
            h1, h2,
            "thumbnail must reflect the replaced cover's new aspect ratio, not stale cached art"
        );

        let _ = tx.send(());
    }

    // Finding 5: `Query<CoverQuery>` used to hard-400 on request shapes real
    // clients send (duplicate params from a proxy, malformed percent
    // encoding). Both must now serve a normal 200 instead.
    #[tokio::test]
    async fn cover_duplicate_size_param_is_lenient() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-10", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-10/cover?size=thumb&size=thumb"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "duplicate size params must not 400");

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn cover_malformed_percent_encoding_falls_back_to_full() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let cover_path = dir.path().join("cover.jpg");
        write_test_jpeg(&cover_path, 1200, 1800);
        let original_bytes = std::fs::read(&cover_path).unwrap();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cover_test_book("thumb-11", Some(&cover_path))).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // `%zz` isn't valid percent-encoding — it must fall back to serving
        // the full cover rather than 400ing.
        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/thumb-11/cover?size=%zz"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = resp.bytes().await.unwrap();
        assert_eq!(bytes.as_ref(), original_bytes.as_slice());

        let _ = tx.send(());
    }

    // ── Item 4: Two-way reading progress sync ───────────────────────────────

    fn progress_test_book(id: &str, total_chapters: u32) -> crate::models::Book {
        crate::models::Book {
            id: id.to_string(),
            title: "Progress Test".to_string(),
            author: "Author".to_string(),
            file_path: "/nonexistent/progress-test.cbz".to_string(),
            cover_path: None,
            total_chapters,
            added_at: 0,
            format: crate::models::BookFormat::Cbz,
            file_hash: None,
            description: None,
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: false,
        }
    }

    /// Spins up a real server on a random port for a progress-sync test.
    /// Returns the (moved-back) state for direct DB assertions, the port,
    /// and the shutdown sender the caller must fire when done.
    async fn spawn_progress_test_server(state: WebState) -> (WebState, u16, oneshot::Sender<()>) {
        let router = build_router(
            state.clone(),
            ServerModes {
                web_ui: true,
                opds: true,
            },
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
        });
        (state, port, tx)
    }

    #[tokio::test]
    async fn progress_put_then_get_roundtrip() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-1", 50)).unwrap();
        }
        let (state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let put_resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-1/progress"))
            .json(&serde_json::json!({"chapter_index": 5, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(put_resp.status(), 200);

        let get_resp = client
            .get(format!("http://127.0.0.1:{port}/api/books/prog-1/progress"))
            .send()
            .await
            .unwrap();
        assert_eq!(get_resp.status(), 200);
        let body: serde_json::Value = get_resp.json().await.unwrap();
        assert_eq!(body["chapter_index"], 5);
        assert_eq!(body["book_id"], "prog-1");

        // The same row must be readable through the desktop app's own db
        // function — the web write path must not diverge from the shape
        // the desktop persists.
        let conn = state.conn().unwrap();
        let progress = crate::db::get_reading_progress(&conn, "prog-1")
            .unwrap()
            .expect("progress should exist");
        assert_eq!(progress.chapter_index, 5);
        assert_eq!(progress.scroll_position, 0.0);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn progress_get_with_no_progress_returns_null() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-2", 50)).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/books/prog-2/progress"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert!(body.is_null(), "expected null progress, got {body:?}");

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn progress_unknown_book_returns_404() {
        let state = test_state();
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .put(format!(
                "http://127.0.0.1:{port}/api/books/does-not-exist/progress"
            ))
            .json(&serde_json::json!({"chapter_index": 0, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/does-not-exist/progress"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn progress_put_malformed_body_returns_400() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-3", 50)).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // Negative index doesn't fit the u32 field — rejected at deserialization.
        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-3/progress"))
            .json(&serde_json::json!({"chapter_index": -1, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);

        // Garbage body.
        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-3/progress"))
            .header("content-type", "application/json")
            .body("not json")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);

        let _ = tx.send(());
    }

    // F4: `total_chapters` can be stale relative to the reader's live
    // /page-count (e.g. re-paginated PDF/CBZ). Rejecting indices beyond the
    // stored total made saves beyond that stale bound silently fail. The web
    // PUT now accepts any non-negative index and stores it as-is; the client
    // clamps when reading progress back.
    #[tokio::test]
    async fn progress_put_chapter_index_beyond_total_is_accepted() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-4", 10)).unwrap();
        }
        let (state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-4/progress"))
            .json(&serde_json::json!({"chapter_index": 10, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let conn = state.conn().unwrap();
        let progress = crate::db::get_reading_progress(&conn, "prog-4")
            .unwrap()
            .expect("progress should be stored even though it exceeds total_chapters");
        assert_eq!(progress.chapter_index, 10);

        let _ = tx.send(());
    }

    // F1: a web-driven completion (PUT landing on the last chapter) must
    // perform the same activity-log side effect the desktop
    // `save_reading_progress` command performs, and must not fire twice.
    #[tokio::test]
    async fn progress_put_last_chapter_logs_completion_activity() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-6", 5)).unwrap();
        }
        let (state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // Land on the last chapter (index 4 of 5).
        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-6/progress"))
            .json(&serde_json::json!({"chapter_index": 4, "scroll_position": 0.5}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        {
            let conn = state.conn().unwrap();
            let activity = crate::db::get_all_activity(&conn).unwrap();
            let completions: Vec<_> = activity
                .iter()
                .filter(|a| {
                    a.action == "book_completed" && a.entity_id.as_deref() == Some("prog-6")
                })
                .collect();
            assert_eq!(
                completions.len(),
                1,
                "expected exactly one completion activity entry, got {activity:?}"
            );
        }

        // A second save that stays on the last chapter (e.g. a scroll-only
        // update) must not log a second completion.
        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-6/progress"))
            .json(&serde_json::json!({"chapter_index": 4, "scroll_position": 0.9}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let conn = state.conn().unwrap();
        let activity = crate::db::get_all_activity(&conn).unwrap();
        let completions: Vec<_> = activity
            .iter()
            .filter(|a| a.action == "book_completed" && a.entity_id.as_deref() == Some("prog-6"))
            .collect();
        assert_eq!(
            completions.len(),
            1,
            "completion must not be logged twice for repeat saves on the last chapter"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn progress_put_requires_auth_when_pin_configured() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("4321"));
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &progress_test_book("prog-5", 50)).unwrap();
        }
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // Unauthenticated PUT is rejected.
        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-5/progress"))
            .json(&serde_json::json!({"chapter_index": 3, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        // Log in, then retry authenticated (bearer token — validated by the
        // same `validate_session` path as the cookie the browser sends).
        let login_resp = client
            .post(format!("http://127.0.0.1:{port}/api/auth"))
            .json(&serde_json::json!({"pin": "4321"}))
            .send()
            .await
            .unwrap();
        let login_body: serde_json::Value = login_resp.json().await.unwrap();
        let token = login_body["token"].as_str().unwrap();

        let resp = client
            .put(format!("http://127.0.0.1:{port}/api/books/prog-5/progress"))
            .header("Authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({"chapter_index": 3, "scroll_position": 0.0}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let _ = tx.send(());
    }

    // ── Item 5: Continue Reading shelf ──────────────────────────────────────

    /// `progress_test_book` reuses one fixed `file_path` for every call — fine
    /// when a test inserts a single book, but the `books.file_path` unique
    /// constraint rejects a second one. These tests insert several, so give
    /// each a distinct path.
    fn cr_test_book(id: &str, total_chapters: u32) -> crate::models::Book {
        crate::models::Book {
            file_path: format!("/nonexistent/{id}.cbz"),
            ..progress_test_book(id, total_chapters)
        }
    }

    // Finding J: these HTTP-layer tests cover route concerns only —
    // registration/status, the JSON shape returned over the wire, limit-param
    // parsing/capping, and auth gating. The underlying SQL filter/order/
    // exclusion logic (unread vs. finished vs. in-progress, most-recent-first
    // ordering, total_chapters=0 exclusion) is exercised exhaustively by
    // `db::tests::test_get_continue_reading_books_*` and must not be
    // duplicated here.

    #[tokio::test]
    async fn continue_reading_returns_json_shape_for_one_item() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cr_test_book("cr-shape", 10)).unwrap();
            crate::db::upsert_reading_progress(
                &conn,
                &crate::models::ReadingProgress {
                    book_id: "cr-shape".to_string(),
                    chapter_index: 5,
                    scroll_position: 0.4,
                    last_read_at: 400,
                },
            )
            .unwrap();
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/continue-reading"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1, "route returns the JSON array shape over HTTP");
        assert_eq!(arr[0]["id"], "cr-shape");
        assert_eq!(arr[0]["chapter_index"], 5);
        assert_eq!(arr[0]["total_chapters"], 10);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn continue_reading_respects_limit_param() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for i in 0..5 {
                let id = format!("cr-limit-{i}");
                crate::db::insert_book(&conn, &cr_test_book(&id, 10)).unwrap();
                crate::db::upsert_reading_progress(
                    &conn,
                    &crate::models::ReadingProgress {
                        book_id: id,
                        chapter_index: 3,
                        scroll_position: 0.2,
                        last_read_at: 1000 + i,
                    },
                )
                .unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/continue-reading?limit=2"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 2, "limit param must cap the result count");

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn continue_reading_limit_param_caps_at_50() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for i in 0..55 {
                let id = format!("cr-cap-{i}");
                crate::db::insert_book(&conn, &cr_test_book(&id, 10)).unwrap();
                crate::db::upsert_reading_progress(
                    &conn,
                    &crate::models::ReadingProgress {
                        book_id: id,
                        chapter_index: 3,
                        scroll_position: 0.1,
                        last_read_at: 1000 + i,
                    },
                )
                .unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/continue-reading?limit=1000"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(
            body.as_array().unwrap().len(),
            50,
            "limit param must be capped at 50 regardless of the requested value"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn continue_reading_requires_auth_when_pin_configured() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("9999"));

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books/continue-reading"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        let _ = tx.send(());
    }

    // ── Item 15: bulk reading-progress endpoint (grid progress badges) ──────
    //
    // `GET /api/reading-progress` is a thin wrapper over the existing
    // `db::get_all_reading_progress` (already used internally for the
    // `last_read` sort) — no new query, no `BookGridItem` model change. It's
    // PIN-gated like the other `/api/books*` reads (not a public shell
    // asset), so no auth.rs carve-out entry is needed.

    #[tokio::test]
    async fn reading_progress_returns_empty_for_fresh_db() {
        let state = test_state();
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/reading-progress"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body.as_array().unwrap().len(), 0);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn reading_progress_returns_rows_with_progress() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            crate::db::insert_book(&conn, &cr_test_book("rp-1", 10)).unwrap();
            crate::db::insert_book(&conn, &cr_test_book("rp-2", 10)).unwrap();
            crate::db::upsert_reading_progress(
                &conn,
                &crate::models::ReadingProgress {
                    book_id: "rp-1".to_string(),
                    chapter_index: 3,
                    scroll_position: 0.5,
                    last_read_at: 123,
                },
            )
            .unwrap();
            // rp-2 has no progress row — must not appear in the response.
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/reading-progress"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1, "only books with a progress row are returned");
        assert_eq!(arr[0]["book_id"], "rp-1");
        assert_eq!(arr[0]["chapter_index"], 3);
        assert_eq!(arr[0]["scroll_position"], 0.5);
        assert_eq!(arr[0]["last_read_at"], 123);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn reading_progress_requires_auth_when_pin_configured() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("9999"));

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/reading-progress"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        let _ = tx.send(());
    }

    // ── Item 14: paginate the library grid (infinite scroll) ────────────────
    //
    // `list_books` stays backward-compatible: `limit`/`offset` are optional
    // and only change behavior when `limit` is present. Pagination is applied
    // strictly after the existing in-memory filter+sort pipeline, so a slice
    // is the only difference from the pre-pagination response — total via the
    // `X-Total-Count` header, body stays a bare array (Decisions locked in
    // docs/web-ui-improvements.md Item 14).

    fn pagination_test_book(id: &str, title: &str, added_at: i64) -> crate::models::Book {
        crate::models::Book {
            title: title.to_string(),
            added_at,
            ..cr_test_book(id, 10)
        }
    }

    #[tokio::test]
    async fn list_books_limit_and_offset_returns_slice_and_total_count_header() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for i in 0..5 {
                crate::db::insert_book(
                    &conn,
                    &pagination_test_book(&format!("pg-{i}"), &format!("Book {i}"), 1000 + i),
                )
                .unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // Default sort is date_added DESC, so page 0 is the two most-recently
        // added books (pg-4, pg-3), page 1 the next two (pg-2, pg-1) — no
        // overlap and no gap across the boundary.
        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books?limit=2&offset=0"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("x-total-count")
                .unwrap()
                .to_str()
                .unwrap(),
            "5"
        );
        let page0: Vec<serde_json::Value> = resp.json().await.unwrap();
        assert_eq!(page0.len(), 2);
        assert_eq!(page0[0]["id"], "pg-4");
        assert_eq!(page0[1]["id"], "pg-3");

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books?limit=2&offset=2"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("x-total-count")
                .unwrap()
                .to_str()
                .unwrap(),
            "5"
        );
        let page1: Vec<serde_json::Value> = resp.json().await.unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0]["id"], "pg-2");
        assert_eq!(page1[1]["id"], "pg-1");

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn list_books_offset_past_end_returns_empty_with_correct_total() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for i in 0..3 {
                crate::db::insert_book(
                    &conn,
                    &pagination_test_book(&format!("pgpe-{i}"), &format!("Book {i}"), 1000 + i),
                )
                .unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books?limit=10&offset=100"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "offset past the end must not 500");
        assert_eq!(
            resp.headers()
                .get("x-total-count")
                .unwrap()
                .to_str()
                .unwrap(),
            "3"
        );
        let body: Vec<serde_json::Value> = resp.json().await.unwrap();
        assert!(body.is_empty());

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn list_books_without_limit_returns_full_list_unchanged() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for i in 0..7 {
                crate::db::insert_book(
                    &conn,
                    &pagination_test_book(&format!("pgfull-{i}"), &format!("Book {i}"), 1000 + i),
                )
                .unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        // Backward-compat guard: omitting `limit` must return every book,
        // exactly as it did before pagination existed — OPDS/desktop and any
        // other caller of this endpoint never send `limit`.
        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/books"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: Vec<serde_json::Value> = resp.json().await.unwrap();
        assert_eq!(body.len(), 7);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn list_books_limit_composes_with_filter_and_sort() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            let mut charlie = pagination_test_book("pgfs-1", "Charlie", 1001);
            charlie.series = Some("Wanted".to_string());
            crate::db::insert_book(&conn, &charlie).unwrap();
            let mut alpha = pagination_test_book("pgfs-2", "Alpha", 1002);
            alpha.series = Some("Wanted".to_string());
            crate::db::insert_book(&conn, &alpha).unwrap();
            let mut bravo = pagination_test_book("pgfs-3", "Bravo", 1003);
            bravo.series = Some("Wanted".to_string());
            crate::db::insert_book(&conn, &bravo).unwrap();
            // A fourth book in a different series must be excluded from both
            // the slice and the total.
            let mut other = pagination_test_book("pgfs-4", "Zulu", 1004);
            other.series = Some("Other".to_string());
            crate::db::insert_book(&conn, &other).unwrap();
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!(
                "http://127.0.0.1:{port}/api/books?series=Wanted&sort=title&limit=1&offset=0"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("x-total-count")
                .unwrap()
                .to_str()
                .unwrap(),
            "3",
            "total must reflect the filtered set, not the whole table"
        );
        let page: Vec<serde_json::Value> = resp.json().await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(
            page[0]["id"], "pgfs-2",
            "page 0 of sort=title must start at the alphabetically-first title \
             within the filtered series — slice is taken after sort"
        );

        let _ = tx.send(());
    }

    // Fix D: `added_at` only has second-granularity, so concurrent/batch
    // imports can tie — without a unique tiebreaker (`id`) in the SQL
    // ORDER BY, offset pagination isn't guaranteed stable across requests
    // and a tied book could land on two pages or be skipped entirely.
    #[tokio::test]
    async fn list_books_tied_added_at_paginates_without_dup_or_skip() {
        let state = test_state();
        {
            let conn = state.conn().unwrap();
            for id in ["tie-c", "tie-a", "tie-b"] {
                crate::db::insert_book(&conn, &pagination_test_book(id, id, 5000)).unwrap();
            }
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let mut seen = Vec::new();
        for offset in 0..3 {
            let resp = client
                .get(format!(
                    "http://127.0.0.1:{port}/api/books?limit=1&offset={offset}"
                ))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
            let page: Vec<serde_json::Value> = resp.json().await.unwrap();
            assert_eq!(page.len(), 1);
            seen.push(page[0]["id"].as_str().unwrap().to_string());
        }

        seen.sort();
        assert_eq!(
            seen,
            vec!["tie-a", "tie-b", "tie-c"],
            "tied added_at must still paginate deterministically — no book \
             duplicated across pages or skipped entirely"
        );

        let _ = tx.send(());
    }

    // ── Item 8: richer book detail (file_size) ──────────────────────────────

    #[tokio::test]
    async fn get_book_detail_includes_file_size() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("detail-test.cbz");
        std::fs::write(&file_path, b"0123456789").unwrap(); // 10 bytes
        {
            let conn = state.conn().unwrap();
            let mut book = progress_test_book("detail-1", 10);
            book.file_path = file_path.to_string_lossy().to_string();
            crate::db::insert_book(&conn, &book).unwrap();
        }

        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}/api/books/detail-1"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["file_size"], 10);
        assert_eq!(body["id"], "detail-1");
        // The rest of the `Book` shape must still be present alongside it.
        assert_eq!(body["total_chapters"], 10);

        let _ = tx.send(());
    }

    // ── Item 9: PWA shell (manifest/sw/icons) ───────────────────────────────
    // Each new static route must be reachable WITHOUT auth even when a PIN is
    // configured (auth.rs's public carve-out) — otherwise a PIN-protected
    // setup would 401 the install/offline shell before the user ever logs in.

    async fn assert_public_route_ok(path: &str, expected_content_type: &str) {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("2468"));
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("http://127.0.0.1:{port}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            200,
            "{path} should be public (200) even with a PIN configured"
        );
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            content_type.starts_with(expected_content_type),
            "{path} content-type was {content_type:?}, expected to start with {expected_content_type:?}"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn manifest_json_is_public_and_correct_content_type() {
        assert_public_route_ok("/manifest.json", "application/manifest+json").await;
    }

    #[tokio::test]
    async fn sw_js_is_public_and_correct_content_type() {
        assert_public_route_ok("/sw.js", "application/javascript").await;
    }

    #[tokio::test]
    async fn icon_192_is_public_and_correct_content_type() {
        assert_public_route_ok("/icon-192.png", "image/png").await;
    }

    #[tokio::test]
    async fn icon_512_is_public_and_correct_content_type() {
        assert_public_route_ok("/icon-512.png", "image/png").await;
    }

    // Finding 9: a manual CACHE_VERSION bump enforced only by a code-comment
    // reminder means a changed app.js/app.css/index.html/manifest.json can
    // ship without invalidating browsers' already-installed SW caches,
    // serving the stale shell forever. This computes a short content hash
    // over the concatenated shell assets — independently of sw.js — and
    // asserts CACHE_VERSION embeds it, so any future asset edit without
    // regenerating the version fails here with the expected hash to paste
    // in, the same pattern `test_csp_allows_theme_bootstrap_script_hash`
    // (web_server::tests, this file) already uses for the CSP hash.
    #[tokio::test]
    async fn cache_version_embeds_shell_asset_content_hash() {
        use sha2::{Digest, Sha256};

        const INDEX_HTML: &str = include_str!("static/index.html");
        const APP_JS: &str = include_str!("static/app.js");
        const APP_CSS: &str = include_str!("static/app.css");
        const MANIFEST_JSON: &str = include_str!("static/manifest.json");
        const SW_JS: &str = include_str!("static/sw.js");

        let mut hasher = Sha256::new();
        hasher.update(INDEX_HTML.as_bytes());
        hasher.update(APP_JS.as_bytes());
        hasher.update(APP_CSS.as_bytes());
        hasher.update(MANIFEST_JSON.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        let expected_fragment = &digest[..12];

        let cache_version_line = SW_JS
            .lines()
            .find(|l| l.trim_start().starts_with("const CACHE_VERSION"))
            .expect("sw.js must define a CACHE_VERSION so shell-asset changes can invalidate old caches");

        assert!(
            cache_version_line.contains(expected_fragment),
            "sw.js's CACHE_VERSION is stale relative to the current shell asset content \
             (index.html + app.js + app.css + manifest.json). Update it to embed \
             {expected_fragment:?}, e.g. CACHE_VERSION = \"folio-shell-{expected_fragment}\"; \
             found: {cache_version_line}"
        );
    }

    // Finding 11: PUBLIC_SHELL_ASSETS is the single source of truth shared by
    // web_ui::routes() and auth::auth_middleware's carve-out — this walks the
    // list end-to-end against a live, PIN-protected server, so a path added
    // to one but not the other (or simply mistyped) fails loudly here rather
    // than as a silent 401 on someone's PWA install screen.
    #[tokio::test]
    async fn all_public_shell_assets_are_reachable_without_auth() {
        let state = test_state();
        *state.pin_hash.lock().unwrap() = Some(auth::hash_pin("1357"));
        let (_state, port, tx) = spawn_progress_test_server(state).await;
        let client = reqwest::Client::new();

        for path in web_ui::PUBLIC_SHELL_ASSETS {
            let resp = client
                .get(format!("http://127.0.0.1:{port}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                200,
                "{path} is listed in PUBLIC_SHELL_ASSETS but is not publicly reachable"
            );
        }

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn manifest_json_parses_with_required_fields() {
        const MANIFEST_JSON: &str = include_str!("static/manifest.json");
        let value: serde_json::Value =
            serde_json::from_str(MANIFEST_JSON).expect("manifest.json must be valid JSON");
        assert_eq!(value["name"], "Folio");
        assert_eq!(value["display"], "standalone");
        assert!(value["theme_color"].is_string());
        assert!(value["background_color"].is_string());
        let icons = value["icons"].as_array().expect("icons array");
        assert!(
            icons.len() >= 2,
            "manifest should list at least the 192 and 512 icons"
        );
        let sizes: Vec<&str> = icons.iter().filter_map(|i| i["sizes"].as_str()).collect();
        assert!(sizes.contains(&"192x192"));
        assert!(sizes.contains(&"512x512"));
    }
}
