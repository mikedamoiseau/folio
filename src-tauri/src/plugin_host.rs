//! Desktop-side glue for the plugin/hook system (spec 2026-06-12).
//!
//! `folio-core` owns the runtime and manager but stays UI-free; this module
//! provides the `HostServices` implementation (OS notifications) and the
//! Tauri command surface for the Plugins settings panel.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use folio_core::activity::ActivityEvent;
use folio_core::plugins::manifest::is_valid_plugin_id;
use folio_core::plugins::permissions::{self, Permission};
use folio_core::plugins::runtime::{HostServices, RuntimeDeps};
use folio_core::plugins::{PluginInfo, PluginManager, PluginStatus};

use crate::commands::{log_event, AppState};
use crate::db::DbPool;
use crate::error::{FolioError, FolioResult};

/// `HostServices` backed by the Tauri notification plugin.
pub struct DesktopHostServices {
    app: AppHandle,
}

impl DesktopHostServices {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl HostServices for DesktopHostServices {
    fn notify(&self, title: &str, body: &str) {
        if let Err(e) = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            tracing::warn!(error = %e, "plugin notification failed");
        }
    }
}

/// Resolve the per-profile plugins directory: `{app_data}/plugins`.
pub fn plugins_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("plugins")
}

/// Build a `PluginManager` bound to `pool` (the active profile's DB).
/// Returns `None` (logged) if initialization fails, so a plugin problem
/// never blocks app startup or a profile switch.
///
/// This does NOT subscribe to the event bus — the bus has no unsubscribe,
/// so a single forwarding subscriber is installed once at startup (see
/// `lib.rs`) and reads whichever manager currently occupies the shared slot.
/// Rebuilding here on profile switch therefore can't leak subscribers.
pub fn init_manager(
    app: &AppHandle,
    data_dir: &std::path::Path,
    pool: DbPool,
) -> Option<Arc<PluginManager>> {
    let dir = plugins_dir(data_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, "cannot create plugins dir");
        return None;
    }
    let deps = RuntimeDeps {
        pool,
        services: Arc::new(DesktopHostServices::new(app.clone())),
    };
    match PluginManager::new(dir, deps) {
        Ok(manager) => Some(manager),
        Err(e) => {
            tracing::error!(error = %e, "plugin manager init failed");
            None
        }
    }
}

/// The shared slot holding the active-profile plugin manager.
pub type ManagerSlot = Arc<std::sync::Mutex<Option<Arc<PluginManager>>>>;

/// Rebuild the plugin manager for a newly-activated profile and swap it into
/// `slot`. Called from `switch_profile`. Failure is logged, never fatal.
pub fn rebuild_for_profile(
    app: &AppHandle,
    data_dir: &std::path::Path,
    pool: DbPool,
    slot: &ManagerSlot,
) {
    let manager = init_manager(app, data_dir, pool);
    if let Ok(mut guard) = slot.lock() {
        *guard = manager;
    }
}

/// Serializable view of one permission for the consent dialog.
#[derive(Serialize)]
pub struct PermissionView {
    /// Wire id, e.g. `write:tags`.
    pub id: String,
    /// i18n key suffix the frontend maps to a plain-language data category.
    pub category_key: String,
}

#[derive(Serialize)]
pub struct PluginView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub events: Vec<String>,
    pub permissions: Vec<PermissionView>,
    /// `active` | `disabled` | `auto_disabled` | `invalid`.
    pub status: String,
    pub invalid_reason: Option<String>,
    pub needs_consent: bool,
}

fn permission_category_key(p: Permission) -> &'static str {
    match p {
        Permission::ReadLibrary => "read_library",
        Permission::ReadHighlights => "read_highlights",
        Permission::WriteTags => "write_tags",
        Permission::WriteMetadata => "write_metadata",
        Permission::WriteFiles => "write_files",
        Permission::Notify => "notify",
        Permission::Network => "network",
        Permission::ImportBooks => "import_books",
    }
}

fn to_view(info: PluginInfo) -> PluginView {
    let (status, invalid_reason) = match &info.status {
        PluginStatus::Active => ("active".to_string(), None),
        PluginStatus::Disabled => ("disabled".to_string(), None),
        PluginStatus::AutoDisabled => ("auto_disabled".to_string(), None),
        PluginStatus::Invalid(reason) => ("invalid".to_string(), Some(reason.clone())),
    };
    PluginView {
        id: info.id,
        name: info.name,
        version: info.version,
        description: info.description,
        author: info.author,
        events: info.subscribe,
        permissions: info
            .permissions
            .into_iter()
            .map(|p| PermissionView {
                id: p.as_str().to_string(),
                category_key: permission_category_key(p).to_string(),
            })
            .collect(),
        status,
        invalid_reason,
        needs_consent: info.needs_consent,
    }
}

fn manager(state: &AppState) -> FolioResult<Arc<PluginManager>> {
    state
        .plugin_manager
        .lock()?
        .clone()
        .ok_or_else(|| FolioError::internal("plugin system not initialized"))
}

#[tauri::command]
pub async fn plugin_list(state: State<'_, AppState>) -> FolioResult<Vec<PluginView>> {
    let mgr = manager(&state)?;
    Ok(mgr.list()?.into_iter().map(to_view).collect())
}

/// Enable a plugin, recording consent for its permissions first. The
/// frontend shows the consent dialog and calls this with the user's
/// approval; passing the plugin's full required-permission list is the
/// approval record.
#[tauri::command]
pub async fn plugin_enable(
    plugin_id: String,
    granted_permissions: Vec<String>,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    if !is_valid_plugin_id(&plugin_id) {
        return Err(FolioError::invalid("invalid plugin id"));
    }
    let mgr = manager(&state)?;

    // Parse the approved permissions; unknown strings are rejected rather
    // than silently dropped.
    let approved: Vec<Permission> = granted_permissions
        .iter()
        .map(|p| {
            Permission::parse(p)
                .ok_or_else(|| FolioError::invalid(format!("unknown permission: {p}")))
        })
        .collect::<FolioResult<_>>()?;

    // The grant set must match the manifest exactly: every required
    // permission must be approved, and nothing beyond the manifest may be
    // recorded. This stops a crafted IPC call from inflating a plugin's
    // recorded grants past what its manifest declares.
    let info = mgr
        .list()?
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| FolioError::not_found(format!("plugin not found: {plugin_id}")))?;
    let required: Vec<Permission> = info.permissions.clone();
    for req in &required {
        if !approved.contains(req) {
            return Err(FolioError::invalid(format!(
                "consent missing for required permission: {}",
                req.as_str()
            )));
        }
    }
    for got in &approved {
        if !required.contains(got) {
            return Err(FolioError::invalid(format!(
                "permission '{}' is not declared in the plugin manifest",
                got.as_str()
            )));
        }
    }

    let grants: Vec<(Permission, Option<String>)> = required.iter().map(|p| (*p, None)).collect();
    let name = info.name.clone();
    {
        let conn = state.active_db()?.get()?;
        permissions::record_grants(&conn, &plugin_id, &grants, now_unix_secs())?;
    }

    mgr.enable(&plugin_id)?;

    let conn = state.active_db()?.get()?;
    log_event(
        &conn,
        ActivityEvent::PluginEnabled {
            id: plugin_id,
            name,
            detail: format!("granted: {}", granted_permissions.join(", ")),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_disable(plugin_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    if !is_valid_plugin_id(&plugin_id) {
        return Err(FolioError::invalid("invalid plugin id"));
    }
    let mgr = manager(&state)?;
    let name = mgr
        .list()?
        .into_iter()
        .find(|p| p.id == plugin_id)
        .map(|p| p.name)
        .unwrap_or_else(|| plugin_id.clone());
    mgr.disable(&plugin_id)?;
    let conn = state.active_db()?.get()?;
    log_event(
        &conn,
        ActivityEvent::PluginDisabled {
            id: plugin_id,
            name,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_reload(state: State<'_, AppState>) -> FolioResult<()> {
    manager(&state)?.reload()
}

/// Wipe all grants and runtime state for a plugin ("Remove plugin data").
#[tauri::command]
pub async fn plugin_remove_data(plugin_id: String, state: State<'_, AppState>) -> FolioResult<()> {
    if !is_valid_plugin_id(&plugin_id) {
        return Err(FolioError::invalid("invalid plugin id"));
    }
    let mgr = manager(&state)?;
    mgr.disable(&plugin_id)?;
    let conn = state.active_db()?.get()?;
    permissions::remove_plugin_data(&conn, &plugin_id)?;
    Ok(())
}

/// One bundled example plugin, for the "Install example" gallery.
#[derive(Serialize)]
pub struct ExamplePlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    /// True if a folder with this id already exists in the user plugins dir.
    pub installed: bool,
}

/// List the example plugins shipped in app resources.
#[tauri::command]
pub async fn plugin_list_examples(
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<Vec<ExamplePlugin>> {
    let examples_dir = app
        .path()
        .resolve("resources/example-plugins", BaseDirectory::Resource)
        .map_err(|e| FolioError::internal(format!("cannot resolve example plugins: {e}")))?;
    let user_dir = plugins_dir(&state.data_dir);

    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&examples_dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let raw = match std::fs::read_to_string(dir.join("plugin.toml")) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Ok(manifest) = folio_core::plugins::manifest::parse_manifest(&raw) else {
            continue;
        };
        let installed = user_dir.join(&manifest.id).join("plugin.toml").is_file();
        out.push(ExamplePlugin {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            installed,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Copy a bundled example plugin into the user plugins directory, then
/// rescan. The plugin lands disabled — the user enables it (with consent)
/// from the list like any other plugin.
#[tauri::command]
pub async fn plugin_install_example(
    example_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> FolioResult<()> {
    if !is_valid_plugin_id(&example_id) {
        return Err(FolioError::invalid("invalid plugin id"));
    }
    let src = app
        .path()
        .resolve(
            format!("resources/example-plugins/{example_id}"),
            BaseDirectory::Resource,
        )
        .map_err(|e| FolioError::internal(format!("cannot resolve example: {e}")))?;
    if !src.join("plugin.toml").is_file() {
        return Err(FolioError::not_found(format!(
            "example plugin not found: {example_id}"
        )));
    }
    let dest = plugins_dir(&state.data_dir).join(&example_id);
    if dest.exists() {
        return Err(FolioError::invalid(format!(
            "a plugin named '{example_id}' is already installed"
        )));
    }
    std::fs::create_dir_all(&dest)?;
    for file in ["plugin.toml", "main.rhai", "config.toml"] {
        let from = src.join(file);
        if from.is_file() {
            std::fs::copy(&from, dest.join(file))?;
        }
    }
    manager(&state)?.reload()?;
    Ok(())
}

/// Open the plugins directory in the OS file manager.
#[tauri::command]
pub async fn plugin_open_dir(state: State<'_, AppState>) -> FolioResult<()> {
    let dir = plugins_dir(&state.data_dir);
    std::fs::create_dir_all(&dir)?;
    open::that(&dir).map_err(|e| FolioError::internal(format!("cannot open plugins dir: {e}")))?;
    Ok(())
}

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
