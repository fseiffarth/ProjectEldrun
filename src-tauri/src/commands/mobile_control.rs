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
        config::{
            detect_serve_settings_json, serve_status_json, verify_tailscale_serve,
            DetectedServeSettings, HostConfig,
        },
        discovery::opaque_control_id,
        protocol::{AdminRequest, AdminResponse, DesktopRequest, DesktopResponse},
    },
    storage,
};

pub const MOBILE_DESKTOP_EVENT: &str = "eldrun-mobile-desktop-request";
const INSTALL_PHONE_SCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scripts/install_phone.sh"
));

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

/// Materialize the phone-install handoff where the root terminal can run it.
/// Keep the script embedded so this action also works from a packaged app,
/// whose installation directory does not contain the source checkout.
#[tauri::command]
pub fn mobile_prepare_phone_install_script() -> Result<(), String> {
    let path = storage::state_dir().join("mobile-control/install_phone.sh");
    let parent = path
        .parent()
        .ok_or("could not determine the Mobile control directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    std::fs::write(&path, INSTALL_PHONE_SCRIPT).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Deliberately **no `PrivateTmp=`**.
///
/// The sidecar's entire job is reaching the desktop's tmux server, whose socket
/// lives at `$TMUX_TMPDIR/tmux-$UID/default` — and `TMUX_TMPDIR` is unset in a
/// normal desktop session, so that is `/tmp`. A private `/tmp` hands the service
/// an empty directory instead: `tmux ls` finds nothing, every tab reports
/// `available: false`, and no error anywhere explains why.
///
/// It did not fail that way in testing only because a systemd *user* manager
/// needs an unprivileged user namespace to build a mount namespace, and
/// distributions that set `kernel.apparmor_restrict_unprivileged_userns=1`
/// (Ubuntu 24.04+) deny it. systemd then skips the namespacing options silently
/// — `systemctl show` still reports `PrivateTmp=yes` while the process runs on
/// the host mount table. So the directive bought nothing where userns is
/// blocked and broke tab discovery where it is allowed, with the outcome
/// decided by a kernel policy this unit never checks.
///
/// `NoNewPrivileges` is a `prctl` and applies regardless; the remaining
/// directives need the namespace but are harmless when skipped, and correct
/// when honoured — the sidecar only ever writes inside `ReadWritePaths`.
/// `BindPaths=-/tmp/tmux-%U` was the alternative and is worse: the directory
/// does not exist when tmux has not started yet, and one created later never
/// appears inside an already-built namespace.
///
/// **`StartLimitIntervalSec=0` is load-bearing.** The sidecar exits non-zero on
/// a Tailscale Serve verification failure precisely so `Restart=on-failure`
/// brings it back — but while tailscaled is down, the *startup* verification
/// fails too, and under systemd's default start limit (5 starts in 10 s) a
/// `RestartSec=2` crash loop trips it in ~10 seconds and leaves the unit
/// permanently `failed`: Mobile stays down after the outage ends, the exact
/// outcome the non-zero exit was chosen to avoid. Disabling the limit and
/// pacing the retries at 5 s keeps the loop cheap and self-healing. A disabled
/// configuration cannot spin here: the binary exits 0 for it, which
/// `on-failure` does not restart.
#[cfg(target_os = "linux")]
fn systemd_unit(binary: &Path, state_dir: &Path) -> Result<String, String> {
    Ok(format!("[Unit]\nDescription=Eldrun Mobile Host\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart={} --mobile-host\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths={}\n\n[Install]\nWantedBy=default.target\n", systemd_path(binary)?, systemd_path(state_dir)?))
}

/// Replace the installed sidecar without opening its live executable for
/// writing. `systemctl restart` leaves the old process running until after this
/// install, so copying directly over the target intermittently fails on Linux
/// with `ETXTBSY` ("Text file busy"). Renaming a completed sibling is atomic;
/// the old process keeps its inode while the restarted service sees the new one.
#[cfg(target_os = "linux")]
fn install_mobile_binary(source: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let target = target_dir.join("eldrun-mobile-host");
    let mut staged = tempfile::NamedTempFile::new_in(target_dir)
        .map_err(|error| format!("stage mobile host: {error}"))?;
    let mut source_file =
        std::fs::File::open(source).map_err(|error| format!("read mobile host: {error}"))?;
    std::io::copy(&mut source_file, staged.as_file_mut())
        .map_err(|error| format!("stage mobile host: {error}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("stage mobile host: {error}"))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(staged.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("stage mobile host: {error}"))?;
    staged
        .persist(&target)
        .map_err(|error| format!("install mobile host: {}", error.error))?;
    Ok(target)
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
        let target = install_mobile_binary(&source, &target_dir)?;
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
    pub detected: Option<DetectedServeSettings>,
    pub detection_error: Option<String>,
}

#[tauri::command]
pub async fn mobile_verify_tailscale_serve(origin: String, port: u16) -> Result<(), String> {
    verify_tailscale_serve(&origin, port)
}

#[tauri::command]
pub async fn mobile_tailscale_serve_status() -> TailscaleServeStatus {
    match serve_status_json() {
        Ok(json) => {
            let detection = detect_serve_settings_json(&json);
            TailscaleServeStatus {
                installed: true,
                json: Some(json),
                error: None,
                detected: detection.as_ref().ok().cloned(),
                detection_error: detection.err(),
            }
        }
        Err(error) if error == "Tailscale is not installed" => TailscaleServeStatus {
            installed: false,
            json: None,
            error: None,
            detected: None,
            detection_error: None,
        },
        Err(error) => TailscaleServeStatus {
            installed: true,
            json: None,
            error: Some(error),
            detected: None,
            detection_error: None,
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{install_mobile_binary, systemd_unit};
    use std::{os::unix::fs::PermissionsExt, path::Path};

    #[test]
    fn systemd_unit_quotes_installed_and_state_paths() {
        let unit = systemd_unit(Path::new("/tmp/mobile host%1"), Path::new("/tmp/state dir"))
            .expect("unit");
        assert!(unit.contains("ExecStart=\"/tmp/mobile host%%1\" --mobile-host"));
        assert!(unit.contains("ReadWritePaths=\"/tmp/state dir\""));
    }

    #[test]
    fn systemd_unit_never_hides_the_tmux_socket_behind_a_private_tmp() {
        let unit =
            systemd_unit(Path::new("/opt/eldrun-mobile-host"), Path::new("/state")).expect("unit");
        // tmux listens on /tmp/tmux-$UID/default. A private /tmp makes every tab
        // report `available: false` with nothing in the log to explain it, on
        // exactly those systems that permit unprivileged user namespaces.
        assert!(
            !unit.contains("PrivateTmp"),
            "PrivateTmp hides the desktop's tmux socket from the sidecar"
        );
        assert!(!unit.contains("BindPaths"), "see systemd_unit's rationale");
        // The hardening that costs nothing stays.
        assert!(unit.contains("NoNewPrivileges=true"));
        assert!(unit.contains("ProtectSystem=strict"));
        assert!(unit.contains("ProtectHome=read-only"));
    }

    #[test]
    fn systemd_unit_survives_a_transient_tailscale_outage() {
        let unit =
            systemd_unit(Path::new("/opt/eldrun-mobile-host"), Path::new("/state")).expect("unit");
        // The sidecar exits non-zero while tailscaled is down so it is
        // restarted — but systemd's default start limit (5 in 10s) turns a
        // fast crash loop into a permanently `failed` unit. The limit must be
        // off and the retries paced.
        assert!(
            unit.contains("StartLimitIntervalSec=0"),
            "the default start limit permanently kills the unit mid-outage"
        );
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("RestartSec=5"));
    }

    #[test]
    fn install_mobile_binary_atomically_replaces_an_existing_target() {
        let temp = tempfile::tempdir().expect("temp directory");
        let source = temp.path().join("source");
        let target_dir = temp.path().join("bin");
        std::fs::create_dir(&target_dir).expect("target directory");
        std::fs::write(&source, b"new mobile host").expect("source");
        std::fs::write(target_dir.join("eldrun-mobile-host"), b"old mobile host")
            .expect("existing target");

        let target = install_mobile_binary(&source, &target_dir).expect("install");

        assert_eq!(
            std::fs::read(&target).expect("installed bytes"),
            b"new mobile host"
        );
        assert_eq!(
            std::fs::metadata(&target)
                .expect("installed metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read_dir(&target_dir)
                .expect("target directory")
                .count(),
            1,
            "atomic install should not leave its staged file behind"
        );
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
                // Reading an uncached message may perform one bounded
                // BODY.PEEK. Keep quick control requests on their short SLA.
                let response_timeout = if matches!(&request, DesktopRequest::MailMessage { .. }) {
                    std::time::Duration::from_secs(30)
                } else {
                    std::time::Duration::from_secs(8)
                };
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
                let response = tokio::time::timeout(response_timeout, rx)
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
