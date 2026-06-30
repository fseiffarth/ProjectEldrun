//! Tauri commands for OpenVPN tunnels backing VPN-gated remote projects.
//!
//! Tunnels are keyed by the local `.ovpn` config path so the same config is
//! shared between project setup (browsing the remote) and later activation. The
//! password is taken per call and never persisted (see `services::openvpn`).

use crate::services::openvpn;
use tauri::{AppHandle, Emitter};

/// Bring up (or reuse) the OpenVPN tunnel for `config`, authenticating with
/// `password`. Blocks until the tunnel is up or the attempt fails. While the
/// handshake runs, each line OpenVPN emits is forwarded to the frontend as an
/// `openvpn-progress` event (`{ config, line }`) so a VPN-gated activation /
/// dialog can show the live handshake in a read-only log instead of an opaque
/// spinner.
#[tauri::command]
pub async fn openvpn_connect(
    app: AppHandle,
    config: String,
    password: String,
) -> Result<(), String> {
    openvpn::connect_streaming(&config, &password, |line| {
        let _ = app.emit(
            "openvpn-progress",
            serde_json::json!({ "config": config, "line": line }),
        );
    })
}

/// Build the shell command that brings the tunnel up **interactively** (the
/// passphrase is typed into a visible terminal, no askpass file). Returned for
/// the frontend to type into a root-scope shell tab when headless connections are
/// off (see `services::openvpn::interactive_connect_command`).
#[tauri::command]
pub async fn openvpn_login_command(config: String) -> Result<String, String> {
    openvpn::interactive_connect_command(&config)
}

/// Tear down the OpenVPN tunnel for `config` if it is up. Idempotent.
#[tauri::command]
pub async fn openvpn_disconnect(config: String) -> Result<(), String> {
    openvpn::disconnect(&config)
}

/// Whether the OpenVPN tunnel for `config` is currently up.
#[tauri::command]
pub async fn openvpn_status(config: String) -> Result<bool, String> {
    Ok(openvpn::is_connected(&config))
}

/// Copy a selected `.ovpn` config into Eldrun's storage and return the stored
/// path, so the project no longer depends on the original file's location.
#[tauri::command]
pub async fn openvpn_store_config(config: String) -> Result<String, String> {
    openvpn::store_config(&config)
}

/// List the `.ovpn` configs Eldrun has previously stored (newest first), so the
/// project dialog can offer a previously-used config for reuse instead of
/// browsing for the file again.
#[tauri::command]
pub async fn openvpn_list_configs() -> Result<Vec<openvpn::StoredConfig>, String> {
    Ok(openvpn::list_configs())
}
