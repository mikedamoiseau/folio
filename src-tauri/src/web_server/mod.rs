pub mod api;
pub mod auth;
pub mod opds_feed;
pub mod web_ui;

use crate::db::DbPool;
use axum::{middleware, Router};
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
}

impl WebState {
    /// Get a database connection from the active pool.
    pub fn conn(
        &self,
    ) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, String> {
        let pool = self.pool.lock().map_err(|e| e.to_string())?;
        pool.get().map_err(|e| e.to_string())
    }
}

/// Handle to a running web server instance.
pub struct WebServerHandle {
    pub shutdown_tx: oneshot::Sender<()>,
    pub url: String,
    pub port: u16,
}

/// Status returned to the frontend.
#[derive(serde::Serialize)]
pub struct WebServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: u16,
}

/// Detect the local LAN IP address.
pub fn get_local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

/// Build the full axum router with all routes and middleware.
pub fn build_router(state: WebState) -> Router {
    let api_routes = api::routes(state.clone());
    let opds_routes = opds_feed::routes(state.clone());
    let ui_routes = web_ui::routes();

    Router::new()
        .nest("/api", api_routes)
        .nest("/opds", opds_routes)
        .merge(ui_routes)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}

/// Default port for the web server.
pub const DEFAULT_PORT: u16 = 7788;

/// Start the web server on the given port. Returns a handle for shutdown.
pub async fn start(state: WebState, port: u16) -> Result<WebServerHandle, String> {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let router = build_router(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {port}: {e}"))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        axum::serve(listener, router)
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
        let router = build_router(state);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let server_handle = tokio::spawn(async move {
            axum::serve(listener, router)
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
        let router = build_router(state);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(listener, router)
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
        let router = build_router(state);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        let actual_port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(listener, router)
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
}
