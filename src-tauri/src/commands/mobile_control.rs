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

/// Materialize the phone-install handoff where the root terminal can run it,
/// returning the script's path — the state dir differs per OS, so the caller
/// must not re-derive it. Keep the script embedded so this action also works
/// from a packaged app, whose installation directory does not contain the
/// source checkout.
#[tauri::command]
pub fn mobile_prepare_phone_install_script() -> Result<String, String> {
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
    Ok(path.to_string_lossy().into_owned())
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

/// The sidecar is the Eldrun binary itself, run with `--mobile-host`. A
/// separate `eldrun-mobile-host` bin target used to exist, but it linked the
/// whole `eldrun_lib` anyway (same size, nothing gained) and Tauri's
/// `universal-apple-darwin` build never lipo-merges secondary cargo binaries,
/// which broke every macOS bundle at the copy step.
fn mobile_binary_source() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
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
/// writing. A service-manager restart leaves the old process running until
/// after this install, so copying directly over the target intermittently
/// fails on Linux with `ETXTBSY` ("Text file busy"). Renaming a completed
/// sibling is atomic; the old process keeps its inode while the restarted
/// service sees the new one.
#[cfg(unix)]
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

/// Stage the sidecar copy on Windows. `NamedTempFile::persist` is a `rename`,
/// which Windows refuses over an existing file — and refuses entirely while
/// that file backs a running process, so callers stop the live host first.
#[cfg(windows)]
fn install_mobile_binary(source: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let target = target_dir.join("eldrun-mobile-host.exe");
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
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    staged
        .persist(&target)
        .map_err(|error| format!("install mobile host: {}", error.error))?;
    Ok(target)
}

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "io.github.fseiffarth.eldrun.mobile-host";

#[cfg(target_os = "macos")]
fn plist_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The macOS twin of `systemd_unit`, with the same two lifecycle rules mapped
/// onto launchd's vocabulary. `KeepAlive.SuccessfulExit=false` is
/// `Restart=on-failure`: a Tailscale Serve verification failure exits non-zero
/// so launchd brings the agent back, while the disabled configuration exits 0
/// and stays down. `ThrottleInterval` paces the retries the way `RestartSec`
/// does — and launchd has no systemd-style start limit, so a transient
/// tailscaled outage can never park the agent in a permanently failed state.
#[cfg(target_os = "macos")]
fn launchd_plist(binary: &Path) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "\t<key>Label</key>\n\t<string>{label}</string>\n",
            "\t<key>ProgramArguments</key>\n",
            "\t<array>\n\t\t<string>{binary}</string>\n\t\t<string>--mobile-host</string>\n\t</array>\n",
            "\t<key>RunAtLoad</key>\n\t<true/>\n",
            "\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n",
            "\t<key>ThrottleInterval</key>\n\t<integer>5</integer>\n",
            "\t<key>ProcessType</key>\n\t<string>Background</string>\n",
            "</dict>\n",
            "</plist>\n",
        ),
        label = LAUNCHD_LABEL,
        binary = plist_escape(&binary.to_string_lossy()),
    )
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "EldrunMobileHost";

#[cfg(windows)]
fn run_command_line(binary: &Path) -> Result<String, String> {
    let raw = binary.to_string_lossy();
    if raw.contains('"') || raw.contains(['\n', '\r', '\0']) {
        return Err("Mobile service path contains unsupported characters".into());
    }
    Ok(format!("\"{raw}\" --mobile-host"))
}

/// Windows has no user service manager watching the host, so stopping it is a
/// cooperative shutdown over the admin pipe followed by waiting for it to be
/// gone — the port must be free before a replacement can bind, and the staged
/// executable cannot be renamed over while the old process still backs it.
#[cfg(windows)]
async fn stop_running_host() {
    if mobile_admin(AdminRequest::Shutdown).await.is_err() {
        return;
    }
    for _ in 0..12 {
        if mobile_admin(AdminRequest::Status).await.is_err() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[cfg(target_os = "linux")]
async fn disable_host_service() -> Result<(), String> {
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
    Ok(())
}

#[cfg(target_os = "linux")]
async fn enable_host_service(target: &Path, config: &HostConfig) -> Result<(), String> {
    let unit_dir = crate::paths::home_dir().join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        unit_dir.join("eldrun-mobile-host.service"),
        systemd_unit(target, &config.state_dir)?,
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

#[cfg(target_os = "macos")]
async fn disable_host_service() -> Result<(), String> {
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // `bootout` fails when the agent is not loaded, which is not a problem —
    // ask first so a genuine unload failure is not confused with "was off".
    let loaded = crate::paths::command_no_window("launchctl")
        .args(["print", &service_target])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if loaded {
        let bootout = crate::paths::command_no_window("launchctl")
            .args(["bootout", &service_target])
            .status()
            .map_err(|error| error.to_string())?;
        if !bootout.success() {
            return Err(if shutdown.is_ok() {
                "Mobile host stopped, but its launch agent could not be unloaded".into()
            } else {
                "Could not stop or unload the Eldrun Mobile launch agent".into()
            });
        }
    }
    let plist = crate::paths::home_dir()
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let _ = std::fs::remove_file(plist);
    Ok(())
}

#[cfg(target_os = "macos")]
async fn enable_host_service(target: &Path, _config: &HostConfig) -> Result<(), String> {
    let plist_dir = crate::paths::home_dir().join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir).map_err(|e| e.to_string())?;
    let plist_path = plist_dir.join(format!("{LAUNCHD_LABEL}.plist"));
    std::fs::write(&plist_path, launchd_plist(target)).map_err(|e| e.to_string())?;
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // Replace any loaded copy; a failure here just means it was not loaded.
    let _ = crate::paths::command_no_window("launchctl")
        .args(["bootout", &service_target])
        .status();
    // Lift a persisted disable from an earlier launchctl-level opt-out.
    let _ = crate::paths::command_no_window("launchctl")
        .args(["enable", &service_target])
        .status();
    let bootstrap = crate::paths::command_no_window("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist_path)
        .status()
        .map_err(|e| e.to_string())?;
    if !bootstrap.success() {
        return Err("could not start the Eldrun Mobile launch agent".into());
    }
    Ok(())
}

#[cfg(windows)]
async fn disable_host_service() -> Result<(), String> {
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    // A missing value makes `reg delete` fail, which is the state we want
    // anyway; HKCU needs no elevation, so other failures are not expected.
    let _ = crate::paths::command_no_window("reg")
        .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
        .status();
    if shutdown.is_err() && mobile_admin(AdminRequest::Status).await.is_ok() {
        return Err("Could not stop the Eldrun Mobile host".into());
    }
    Ok(())
}

#[cfg(windows)]
async fn enable_host_service(target: &Path, _config: &HostConfig) -> Result<(), String> {
    let command_line = run_command_line(target)?;
    let add = crate::paths::command_no_window("reg")
        .args([
            "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &command_line, "/f",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !add.success() {
        return Err("could not register the Eldrun Mobile autostart entry".into());
    }
    let mut child = crate::paths::command_no_window(target)
        .arg("--mobile-host")
        .spawn()
        .map_err(|e| format!("start mobile host: {e}"))?;
    // No service manager is watching this process: confirm it came up, and
    // surface an immediate exit (bad config, port taken) instead of silence.
    for _ in 0..12 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if mobile_admin(AdminRequest::Status).await.is_ok() {
            return Ok(());
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
    }
    Err("the Eldrun Mobile host did not start".into())
}

/// The Mobile host's lifetime is the app's, and these two are the pair that
/// make it so. The service manager still supervises the sidecar *while Eldrun
/// runs* (a Tailscale Serve verification failure exits non-zero and
/// `Restart=on-failure` brings it back), but a host with no desktop behind it
/// can create no tab and — since the clean quit now reaps every local tmux
/// session too — has no session left to attach a phone to. It used to keep
/// listening after the window was gone anyway, one of several leftovers a quit
/// left running on the machine.
///
/// Stop is best-effort and bounded: the cooperative admin `Shutdown` (the
/// sidecar exits 0, which `on-failure` does not restart), then the platform's
/// own stop as the net for a wedged host. The `enable` (login autostart) is
/// deliberately left as the Settings toggle set it — it is the user's stated
/// choice, and the next launch's [`start_host_on_launch`] starts the host
/// whether or not the login did.
pub async fn stop_host_for_exit() {
    // A missing socket answers immediately (ENOENT / connection refused);
    // only a live-but-wedged host costs the admin timeouts.
    let shutdown = mobile_admin(AdminRequest::Shutdown).await;
    if HostConfig::load(&storage::state_dir()).is_err() {
        return;
    }
    stop_installed_host(shutdown.is_ok()).await;
}

/// Start the Mobile host at launch when the configuration says it should be
/// running — the counterpart of [`stop_host_for_exit`], without which the
/// first quit would leave Mobile down until the next login. Off the main
/// thread; a no-op when Mobile is off (`HostConfig::load` refuses a disabled
/// or absent configuration) or the host already answers on its socket.
pub fn start_host_on_launch() {
    tauri::async_runtime::spawn(async {
        let Ok(config) = HostConfig::load(&storage::state_dir()) else {
            return;
        };
        if mobile_admin(AdminRequest::Status).await.is_ok() {
            return;
        }
        if let Err(error) = start_installed_host(&config).await {
            eprintln!("mobile host: start at launch: {error}");
        }
    });
}

#[cfg(target_os = "linux")]
async fn stop_installed_host(_shutdown_ok: bool) {
    // `--no-block`: the unit is normally already inactive after the admin
    // shutdown, and a wedged one should not hold the app's exit for systemd's
    // stop timeout.
    let _ = crate::paths::command_no_window("systemctl")
        .args(["--user", "stop", "--no-block", "eldrun-mobile-host.service"])
        .status();
}

#[cfg(target_os = "linux")]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    // `start`, not `restart`: idempotent against a host the login already
    // brought up between the status probe and here.
    let status = crate::paths::command_no_window("systemctl")
        .args(["--user", "start", "eldrun-mobile-host.service"])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("systemctl --user start failed (Settings → Mobile can reinstall the service)".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn stop_installed_host(shutdown_ok: bool) {
    if shutdown_ok {
        return;
    }
    let uid = unsafe { libc::getuid() };
    let _ = crate::paths::command_no_window("launchctl")
        .args(["kill", "TERM", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
}

#[cfg(target_os = "macos")]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    let service_target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    // A loaded agent that exited 0 stays loaded and idle; `kickstart` runs it
    // again. One that was never bootstrapped this login is loaded from its
    // plist instead.
    let kicked = crate::paths::command_no_window("launchctl")
        .args(["kickstart", &service_target])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if kicked {
        return Ok(());
    }
    let plist = crate::paths::home_dir()
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    if !plist.exists() {
        return Err("launch agent is not installed (Settings → Mobile can reinstall it)".into());
    }
    let bootstrap = crate::paths::command_no_window("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist)
        .status()
        .map_err(|e| e.to_string())?;
    if !bootstrap.success() {
        return Err("launchctl bootstrap failed".into());
    }
    Ok(())
}

/// No service manager to ask on Windows: the cooperative shutdown already sent
/// is the whole stop, and waiting for the process to be gone (what
/// `stop_running_host` adds for a reinstall) is nothing an exit needs.
#[cfg(windows)]
async fn stop_installed_host(_shutdown_ok: bool) {}

/// Windows has no service manager holding the binary's path, so the launch
/// start looks in the install directory itself: this version's copy first,
/// else the newest one present (an older host still serves; the Settings
/// panel offers the update).
#[cfg(windows)]
async fn start_installed_host(config: &HostConfig) -> Result<(), String> {
    let bin_dir = config.control_dir.join("bin");
    let current = bin_dir
        .join(env!("CARGO_PKG_VERSION"))
        .join("eldrun-mobile-host.exe");
    let target = if current.is_file() {
        current
    } else {
        let mut candidates: Vec<PathBuf> = std::fs::read_dir(&bin_dir)
            .map_err(|e| format!("mobile host is not installed: {e}"))?
            .flatten()
            .map(|entry| entry.path().join("eldrun-mobile-host.exe"))
            .filter(|path| path.is_file())
            .collect();
        candidates.sort();
        candidates
            .pop()
            .ok_or("mobile host is not installed (Settings → Mobile can install it)")?
    };
    crate::paths::command_no_window(&target)
        .arg("--mobile-host")
        .spawn()
        .map_err(|e| format!("start mobile host: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn stop_installed_host(_shutdown_ok: bool) {}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn start_installed_host(_config: &HostConfig) -> Result<(), String> {
    Err("unsupported platform".into())
}

#[tauri::command]
pub async fn mobile_host_apply(enabled: bool) -> Result<(), String> {
    if !enabled {
        return disable_host_service().await;
    }
    let config = HostConfig::load(&storage::state_dir())?;
    verify_tailscale_serve(&config.origin, config.host.port)?;
    let source = mobile_binary_source()?;
    let version = env!("CARGO_PKG_VERSION");
    let target_dir = config.control_dir.join("bin").join(version);
    // Windows locks a running executable's file: the live host must be gone
    // before its same-version copy can be replaced. The Unix installs rename
    // atomically and restart through the service manager instead.
    #[cfg(windows)]
    stop_running_host().await;
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target = install_mobile_binary(&source, &target_dir)?;
    enable_host_service(&target, &config).await
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
    use super::systemd_unit;
    use std::path::Path;

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
}


#[cfg(all(test, unix))]
mod unix_install_tests {
    use super::install_mobile_binary;
    use std::os::unix::fs::PermissionsExt;

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

#[cfg(all(test, target_os = "macos"))]
mod launchd_tests {
    use super::{launchd_plist, LAUNCHD_LABEL};
    use std::path::Path;

    #[test]
    fn launchd_plist_escapes_the_binary_path_and_runs_the_host_flag() {
        let plist = launchd_plist(Path::new("/tmp/mobile <&> host"));
        assert!(plist.contains("<string>/tmp/mobile &lt;&amp;&gt; host</string>"));
        assert!(plist.contains("<string>--mobile-host</string>"));
        assert!(plist.contains(&format!("<string>{LAUNCHD_LABEL}</string>")));
    }

    #[test]
    fn launchd_plist_restarts_on_failure_but_not_on_a_disabled_exit() {
        let plist = launchd_plist(Path::new("/opt/eldrun-mobile-host"));
        // The disabled configuration exits 0 and must stay down; a Serve
        // verification failure exits non-zero and must come back.
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<false/>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>ThrottleInterval</key>"));
    }
}

#[cfg(all(test, windows))]
mod windows_service_tests {
    use super::run_command_line;
    use std::path::Path;

    #[test]
    fn run_command_line_quotes_the_binary_and_refuses_quote_smuggling() {
        let line = run_command_line(Path::new(r"C:\Users\a b\eldrun-mobile-host.exe"))
            .expect("command line");
        assert_eq!(line, "\"C:\\Users\\a b\\eldrun-mobile-host.exe\" --mobile-host");
        assert!(run_command_line(Path::new("C:\\a\"b.exe")).is_err());
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

/// One accepted, already-authenticated desktop-control connection: read the
/// sidecar's request, relay it to the main window, and write the answer back.
async fn handle_desktop_stream<S>(mut stream: S, app: AppHandle, state: MobileDesktopState)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
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
        while let Ok((stream, _)) = listener.accept().await {
            if !trusted_peer(&stream) {
                continue;
            }
            let app = app.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(handle_desktop_stream(stream, app, state));
        }
    });
}

/// The Windows bridge speaks the same frames over a named pipe, with the
/// sidecar proving itself via the same-user token the listener writes beside
/// the nominal socket path — see `services::mobile_control::admin::pipe`.
#[cfg(windows)]
pub fn start_desktop_bridge(app: AppHandle, state: MobileDesktopState) {
    use crate::services::mobile_control::admin::pipe;
    let socket = storage::state_dir().join("mobile-control/desktop-control.sock");
    tauri::async_runtime::spawn(async move {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = pipe::pipe_name(&socket);
        let Ok(token) = pipe::create_token(&socket) else {
            return;
        };
        let Ok(mut server) = ServerOptions::new().first_pipe_instance(true).create(&name) else {
            return;
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            let Ok(next) = ServerOptions::new().create(&name) else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let mut stream = std::mem::replace(&mut server, next);
            let app = app.clone();
            let state = state.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let presented = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    read_frame::<String>(&mut stream),
                )
                .await;
                let authorized =
                    matches!(&presented, Ok(Ok(value)) if pipe::token_matches(value, &token));
                if !authorized {
                    return;
                }
                handle_desktop_stream(stream, app, state).await;
            });
        }
    });
}

#[cfg(not(any(unix, windows)))]
pub fn start_desktop_bridge(_: AppHandle, _: MobileDesktopState) {}
