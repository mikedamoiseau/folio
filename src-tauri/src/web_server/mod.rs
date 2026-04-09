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
