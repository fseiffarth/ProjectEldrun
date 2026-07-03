//! Tauri commands for OpenVPN tunnels backing VPN-gated remote projects.
//!
//! Tunnels are keyed by the local `.ovpn` config path so the same config is
//! shared between project setup (browsing the remote) and later activation. The
//! password is taken per call and never persisted (see `services::openvpn`).

use crate::services::openvpn;
use tauri::{AppHandle, Emitter};

/// Bring up (or reuse) the OpenVPN tunnel for `config`. Blocks until the tunnel
/// is up or the attempt fails. While the handshake runs, each line OpenVPN emits
/// is forwarded to the frontend as an `openvpn-progress` event (`{ config, line }`)
/// so a VPN-gated activation / dialog can show the live handshake in a read-only
/// log instead of an opaque spinner.
///
/// A typed `password` wins; a `None`/empty one first falls back to a saved
/// passphrase for this config (silent auto-connect) and errors if none exists, so
/// the caller can then show the prompt. `remember` opts into saving the working
/// passphrase in the OS keychain (keyed by config path), written **only after the
/// tunnel is up**; unticking clears any previously-saved one.
#[tauri::command]
pub async fn openvpn_connect(
    app: AppHandle,
    config: String,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<(), String> {
    use crate::services::remote_credentials as creds;
    let remember = remember.unwrap_or(false);
    let account = creds::openvpn_account(&config);
    let Some(pw) = password
        .filter(|p| !p.is_empty())
        .or_else(|| creds::get(&account))
    else {
        return Err("no VPN password provided and none saved".to_string());
    };
    // Offload to a blocking worker. `connect_streaming` is fully synchronous and
    // blocks for the whole handshake — up to `CONNECT_TIMEOUT` (45s), and longer
    // still while `pkexec` waits on the polkit prompt. Awaiting it directly on the
    // async runtime starves a worker and froze the headless VPN connect; mirror
    // `ssh_connect`, which spawn_blocks its ssh probe for exactly this reason.
    tokio::task::spawn_blocking(move || {
        openvpn::connect_streaming(&config, &pw, |line| {
            let _ = app.emit(
                "openvpn-progress",
                serde_json::json!({ "config": config, "line": line }),
            );
        })?;
        // Tunnel is up — persist (opt-in) or clear per the checkbox. Best-effort: a
        // keychain write failure must not fail an already-successful connect.
        let _ = creds::set(&account, if remember { Some(pw.as_str()) } else { None });
        Ok(())
    })
    .await
    .map_err(|e| format!("openvpn connect task failed: {e}"))?
}

/// Whether a saved VPN passphrase exists for `config`, so the UI can pre-check
/// the "Save password" box without ever receiving the secret.
#[tauri::command]
pub fn vpn_has_saved_password(config: String) -> bool {
    let account = crate::services::remote_credentials::openvpn_account(&config);
    crate::services::remote_credentials::has(&account)
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
