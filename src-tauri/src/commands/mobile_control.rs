use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::{
    services::mobile_control::{
        admin::{self, read_frame, write_frame},
        config::{serve_status_json, verify_tailscale_serve, HostConfig},
        discovery::opaque_control_id,
        protocol::{AdminRequest, AdminResponse, DesktopRequest, DesktopResponse},
    },
    storage,
};

pub const MOBILE_DESKTOP_EVENT: &str = "eldrun-mobile-desktop-request";

#[derive(Clone, Default)]
pub struct MobileDesktopState {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<DesktopResponse>>>>,
}

#[tauri::command]
pub fn mobile_desktop_respond(
    state: State<'_, MobileDesktopState>,
    request_id: String,
    response: DesktopResponse,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or("mobile request expired")?;
    sender
        .send(response)
        .map_err(|_| "mobile request receiver closed".into())
}

#[tauri::command]
pub fn mobile_opaque_id(domain: String, value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > 256 {
        return Err("invalid opaque id input".into());
    }
    opaque_control_id(&storage::state_dir(), &domain, &value)
}

#[tauri::command]
pub async fn mobile_admin(request: AdminRequest) -> Result<AdminResponse, String> {
    admin::admin_call(
        &storage::state_dir().join("mobile-control/admin.sock"),
        &request,
    )
    .await
}

#[derive(serde::Serialize)]
pub struct MobileHostRuntimeStatus {
    pub configured: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub origin: Option<String>,
    pub error: Option<String>,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

#[tauri::command]
pub async fn mobile_host_status() -> MobileHostRuntimeStatus {
    let config = HostConfig::load(&storage::state_dir()).ok();
    match mobile_admin(AdminRequest::Status).await {
        Ok(AdminResponse::Host {
            running,
            port,
            origin,
            version,
        }) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running,
            port: Some(port),
            origin,
            error: None,
            update_available: version.as_deref() != Some(env!("CARGO_PKG_VERSION")),
            installed_version: version,
        },
        Ok(_) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running: false,
            port: config.as_ref().map(|c| c.host.port),
            origin: config.as_ref().map(|c| c.origin.clone()),
            error: Some("unexpected sidecar response".into()),
            installed_version: None,
            update_available: false,
        },
        Err(error) => MobileHostRuntimeStatus {
            configured: config.is_some(),
            running: false,
            port: config.as_ref().map(|c| c.host.port),
            origin: config.as_ref().map(|c| c.origin.clone()),
            error: Some(error),
            installed_version: None,
            update_available: false,
        },
    }
}

fn mobile_binary_source() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = current.with_file_name("eldrun-mobile-host");
    if sibling.is_file() {
        return Ok(sibling);
    }
    let debug = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/eldrun-mobile-host");
    let release =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release/eldrun-mobile-host");
    Ok([release, debug]
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or(current))
}

#[cfg(target_os = "linux")]
fn systemd_path(path: &Path) -> Result<String, String> {
    let raw = path.to_string_lossy();
    if raw.contains(['\n', '\r', '\0']) {
        return Err("Mobile service path contains unsupported control characters".into());
    }
    Ok(format!(
        "\"{}\"",
        raw.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    ))
}

#[cfg(target_os = "linux")]
fn systemd_unit(binary: &Path, state_dir: &Path) -> Result<String, String> {
    Ok(format!("[Unit]\nDescription=Eldrun Mobile Host\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} --mobile-host\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths={}\n\n[Install]\nWantedBy=default.target\n", systemd_path(binary)?, systemd_path(state_dir)?))
}

#[tauri::command]
pub async fn mobile_host_apply(enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = enabled;
        return Err("Mobile host service installation is currently available on Linux".into());
    }
    #[cfg(target_os = "linux")]
    {
        if !enabled {
            // Stop the live listener through its authenticated same-user socket
            // first. This remains effective even if systemd is temporarily
            // unavailable; the unit command then prevents it returning at login.
            let shutdown = mobile_admin(AdminRequest::Shutdown).await;
            let stop = crate::paths::command_no_window("systemctl")
                .args(["--user", "disable", "--now", "eldrun-mobile-host.service"])
                .status()
                .map_err(|error| error.to_string())?;
            if !stop.success() {
                return Err(if shutdown.is_ok() {
                    "Mobile host stopped, but its systemd user service could not be disabled".into()
                } else {
                    "Could not stop or disable the Eldrun Mobile user service".into()
                });
            }
            return Ok(());
        }
        let config = HostConfig::load(&storage::state_dir())?;
        verify_tailscale_serve(&config.origin, config.host.port)?;
        let source = mobile_binary_source()?;
        let version = env!("CARGO_PKG_VERSION");
        let target_dir = config.control_dir.join("bin").join(version);
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        let target = target_dir.join("eldrun-mobile-host");
        std::fs::copy(source, &target).map_err(|e| format!("install mobile host: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let unit_dir = crate::paths::home_dir().join(".config/systemd/user");
        std::fs::create_dir_all(&unit_dir).map_err(|e| e.to_string())?;
        std::fs::write(
            unit_dir.join("eldrun-mobile-host.service"),
            systemd_unit(&target, &config.state_dir)?,
        )
        .map_err(|e| e.to_string())?;
        let reload = crate::paths::command_no_window("systemctl")
            .args(["--user", "daemon-reload"])
            .status()
            .map_err(|e| e.to_string())?;
        if !reload.success() {
            return Err("systemd user daemon-reload failed".into());
        }
        let start = crate::paths::command_no_window("systemctl")
            .args(["--user", "enable", "eldrun-mobile-host.service"])
            .status()
            .map_err(|e| e.to_string())?;
        if !start.success() {
            return Err("could not enable the Eldrun Mobile user service".into());
        }
        let restart = crate::paths::command_no_window("systemctl")
            .args(["--user", "restart", "eldrun-mobile-host.service"])
            .status()
            .map_err(|e| e.to_string())?;
        if !restart.success() {
            return Err("could not start the Eldrun Mobile user service".into());
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct TailscaleServeStatus {
    pub installed: bool,
    pub json: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn mobile_verify_tailscale_serve(origin: String, port: u16) -> Result<(), String> {
    verify_tailscale_serve(&origin, port)
}

#[tauri::command]
pub async fn mobile_tailscale_serve_status() -> TailscaleServeStatus {
    match serve_status_json() {
        Ok(json) => TailscaleServeStatus {
            installed: true,
            json: Some(json),
            error: None,
        },
        Err(error) if error == "Tailscale is not installed" => TailscaleServeStatus {
            installed: false,
            json: None,
            error: None,
        },
        Err(error) => TailscaleServeStatus {
            installed: true,
            json: None,
            error: Some(error),
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::systemd_unit;
    use std::path::Path;

    #[test]
    fn systemd_unit_quotes_installed_and_state_paths() {
        let unit = systemd_unit(Path::new("/tmp/mobile host%1"), Path::new("/tmp/state dir"))
            .expect("unit");
        assert!(unit.contains("ExecStart=\"/tmp/mobile host%%1\" --mobile-host"));
        assert!(unit.contains("ReadWritePaths=\"/tmp/state dir\""));
    }
}

#[cfg(unix)]
fn trusted_peer(stream: &tokio::net::UnixStream) -> bool {
    stream
        .peer_cred()
        .ok()
        .map(|c| c.uid())
        .is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

#[cfg(unix)]
pub fn start_desktop_bridge(app: AppHandle, state: MobileDesktopState) {
    let socket = storage::state_dir().join("mobile-control/desktop-control.sock");
    tauri::async_runtime::spawn(async move {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = socket.parent() {
            let _ = std::fs::create_dir_all(parent);
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_file(&socket);
        let Ok(listener) = tokio::net::UnixListener::bind(&socket) else {
            return;
        };
        let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
        while let Ok((mut stream, _)) = listener.accept().await {
            if !trusted_peer(&stream) {
                continue;
            }
            let app = app.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(Ok(request)) = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    read_frame::<DesktopRequest>(&mut stream),
                )
                .await
                else {
                    return;
                };
                let id = request.request_id().to_string();
                let (tx, rx) = oneshot::channel();
                state.pending.lock().unwrap().insert(id.clone(), tx);
                if app.emit_to("main", MOBILE_DESKTOP_EVENT, request).is_err() {
                    state.pending.lock().unwrap().remove(&id);
                    let _ = write_frame(
                        &mut stream,
                        &DesktopResponse::Error {
                            code: "desktop_unavailable".into(),
                            message: "No desktop window is available".into(),
                        },
                    )
                    .await;
                    return;
                }
                let response = tokio::time::timeout(std::time::Duration::from_secs(8), rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(DesktopResponse::Error {
                        code: "desktop_unavailable".into(),
                        message: "Desktop did not answer".into(),
                    });
                state.pending.lock().unwrap().remove(&id);
                let _ = write_frame(&mut stream, &response).await;
            });
        }
    });
}

#[cfg(not(unix))]
pub fn start_desktop_bridge(_: AppHandle, _: MobileDesktopState) {}
