//! OpenVPN tunnel lifecycle for remote (SSH) projects.
//!
//! Some remote hosts are only reachable through a VPN. When a project carries an
//! `OpenVpnSpec` (a `.ovpn` config path), Eldrun brings the tunnel up *before*
//! the sshfs mount / ssh sessions and tears it down at app exit.
//!
//! OpenVPN needs root to create the tun device and adjust routing, so it is
//! launched via `pkexec` (the user authenticates through the system polkit
//! agent). The password for the VPN itself (encrypted-key passphrase) is never
//! persisted: callers pass it in, we write it to an owner-only temp file that
//! OpenVPN reads via `--askpass`, then delete it once the tunnel is up.
//!
//! Tunnels are tracked in a process-global registry keyed by the **config path**
//! so the same config is never connected twice and a connect made during project
//! setup is reused at activation. As elsewhere, the config path is validated
//! (no leading `-`, no control characters) and passed to the child as a separate
//! argv item.

#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::collections::HashMap;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::process::{Child, Stdio};
#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::sync::{Mutex, OnceLock};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::time::{Duration, Instant};

use crate::services::ssh_mount::validate_arg;
use crate::storage;

/// OpenVPN prints this once the tunnel is fully up.
#[cfg(any(target_os = "linux", target_os = "windows"))]
const READY_MARKER: &str = "Initialization Sequence Completed";
/// Give the tunnel this long to come up before we give up and kill it.
#[cfg(any(target_os = "linux", target_os = "windows"))]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);

/// A running tunnel: the OpenVPN child plus the pidfile OpenVPN wrote. On Linux
/// the child is `pkexec openvpn` and the pidfile lets us `pkexec kill` the root
/// process; on Windows the child *is* `openvpn.exe`, torn down via its handle /
/// `taskkill` (the pidfile is still written but unused for teardown).
#[cfg(any(target_os = "linux", target_os = "windows"))]
struct VpnProc {
    child: Child,
    pidfile: PathBuf,
}

/// Process-global registry of live tunnels, keyed by config path.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn registry() -> &'static Mutex<HashMap<String, VpnProc>> {
    static REG: OnceLock<Mutex<HashMap<String, VpnProc>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Directory holding OpenVPN runtime files (askpass + pidfiles), created 0700.
fn runtime_dir() -> PathBuf {
    storage::state_dir().join("openvpn")
}

/// Directory where selected `.ovpn` configs are copied so a project no longer
/// depends on the original file's location.
fn configs_dir() -> PathBuf {
    runtime_dir().join("configs")
}

/// Copy a selected `.ovpn` config into Eldrun's storage and return the stored
/// absolute path, so the project's config survives the original being moved or
/// deleted. Idempotent: a `src` already inside the configs dir is returned
/// unchanged. The stored copy is owner-only (0600) since configs may inline
/// private keys.
pub fn store_config(src: &str) -> Result<String, String> {
    let src = src.trim();
    validate_arg("OpenVPN config", src)?;
    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(format!("OpenVPN config not found: {src}"));
    }
    let dir = configs_dir();
    if src_path.starts_with(&dir) {
        return Ok(src.to_string()); // already stored
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create configs dir: {e}"))?;
    let file_name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config.ovpn");
    let dest = dir.join(format!("{}__{file_name}", safe_stem(src)));
    std::fs::copy(src_path, &dest).map_err(|e| format!("copy config: {e}"))?;
    #[cfg(unix)]
    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
    Ok(dest.to_string_lossy().into_owned())
}

/// True if `openvpn` and `pkexec` are both available on `PATH` (both are needed:
/// OpenVPN to build the tunnel, polkit's `pkexec` to launch it elevated).
#[cfg(target_os = "linux")]
pub fn openvpn_available() -> bool {
    crate::paths::binary_on_path("openvpn") && crate::paths::binary_on_path("pkexec")
}

/// True if `openvpn.exe` can be located (PATH, a per-user dir, or the standard
/// `Program Files\OpenVPN\bin` location). Windows has no `pkexec`/polkit, so
/// only the OpenVPN binary itself is probed (see [`connect`] for how elevation
/// is handled).
#[cfg(target_os = "windows")]
pub fn openvpn_available() -> bool {
    resolve_openvpn().is_some()
}

/// Build the `openvpn` argv (without the leading `pkexec`/`openvpn`) for a
/// connect. Returned as `Vec<String>` so it is unit-testable without launching.
///
/// Shape: `--config <cfg> --askpass <credfile> --auth-nocache
///         --writepid <pidfile> --connect-timeout 20 --connect-retry-max 3`.
pub fn openvpn_args(config: &str, askpass: &Path, pidfile: &Path) -> Result<Vec<String>, String> {
    let config = config.trim();
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    validate_arg("OpenVPN config", config)?;
    Ok(vec![
        "--config".to_string(),
        config.to_string(),
        "--askpass".to_string(),
        askpass.to_string_lossy().into_owned(),
        "--auth-nocache".to_string(),
        "--writepid".to_string(),
        pidfile.to_string_lossy().into_owned(),
        "--connect-timeout".to_string(),
        "20".to_string(),
        "--connect-retry-max".to_string(),
        "3".to_string(),
    ])
}

/// Derive a filesystem-safe stem from a config path for naming its runtime
/// files (askpass/pidfile). Non-alphanumerics collapse to `_`.
fn safe_stem(config: &str) -> String {
    let stem: String = config
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    // Bound the length; a trailing hash keeps distinct configs distinct.
    let mut h: u64 = 1469598103934665603; // FNV-1a
    for b in config.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    // Keep the last 40 chars. Slice on a char boundary, not a byte offset: a
    // byte-index slice (`&stem[stem.len()-40..]`) would panic if it landed in the
    // middle of a multibyte char. `stem` is ASCII today (every non-ascii-alnum
    // char is mapped to `_`), but iterating chars is panic-proof regardless.
    let tail: String = {
        let chars: Vec<char> = stem.chars().collect();
        let start = chars.len().saturating_sub(40);
        chars[start..].iter().collect()
    };
    format!("{tail}_{h:016x}")
}

/// Write `password` to an owner-only (0600) askpass file and return its path.
/// On Windows the 0600 mode is skipped (no `mode()`); the file lives under the
/// per-user `%APPDATA%\eldrun\openvpn` dir, which is already user-scoped, and is
/// deleted as soon as OpenVPN has read it.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn write_askpass(stem: &str, password: &str) -> Result<PathBuf, String> {
    let dir = runtime_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create openvpn dir: {e}"))?;
    let path = dir.join(format!("{stem}.pass"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts
        .open(&path)
        .map_err(|e| format!("create askpass file: {e}"))?;
    writeln!(f, "{password}").map_err(|e| format!("write askpass file: {e}"))?;
    Ok(path)
}

/// True if a tunnel for `config` is currently up (registered and its process is
/// still alive). Shared by Linux and Windows since both track the spawned child
/// in [`registry`].
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn is_connected(config: &str) -> bool {
    let mut reg = registry().lock().unwrap();
    match reg.get_mut(config) {
        Some(proc) => match proc.child.try_wait() {
            Ok(Some(_)) => {
                // Exited — drop the dead entry.
                reg.remove(config);
                false
            }
            Ok(None) => true,
            Err(_) => true,
        },
        None => false,
    }
}

/// Bring up the OpenVPN tunnel for `config`, authenticating with `password`.
/// No-op (returns `Ok`) if already connected. Blocks until OpenVPN reports the
/// tunnel up, the process exits, or `CONNECT_TIMEOUT` elapses.
#[cfg(target_os = "linux")]
pub fn connect(config: &str, password: &str) -> Result<(), String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if !Path::new(config).is_file() {
        return Err(format!("OpenVPN config not found: {config}"));
    }
    if is_connected(config) {
        return Ok(());
    }
    if !openvpn_available() {
        return Err(
            "openvpn/pkexec not found — install openvpn (and polkit) to use VPN-gated projects"
                .to_string(),
        );
    }

    let stem = safe_stem(config);
    let askpass = write_askpass(&stem, password)?;
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(config, &askpass, &pidfile)?;

    let spawn_result = Command::new("pkexec")
        .arg("openvpn")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&askpass);
            return Err(format!("failed to launch pkexec openvpn: {e}"));
        }
    };

    // Stream stdout until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child);
    // The passphrase has been read by now; remove it regardless of outcome.
    let _ = std::fs::remove_file(&askpass);

    match ready {
        Ok(()) => {
            registry()
                .lock()
                .unwrap()
                .insert(config.to_string(), VpnProc { child, pidfile });
            Ok(())
        }
        Err(msg) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(msg)
        }
    }
}

/// Read the child's stdout until the ready marker appears (Ok), the stream ends
/// (Err with the tail), or the timeout elapses (Err). Shared by Linux/Windows.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn wait_for_ready(child: &mut Child) -> Result<(), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "openvpn produced no stdout".to_string())?;
    let start = Instant::now();
    let mut tail: Vec<String> = Vec::new();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        if start.elapsed() > CONNECT_TIMEOUT {
            return Err("OpenVPN connection timed out".to_string());
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.contains(READY_MARKER) {
            return Ok(());
        }
        tail.push(line);
        if tail.len() > 8 {
            tail.remove(0);
        }
    }
    // Stream ended without the marker → connection failed.
    let detail = tail.join("; ");
    if detail.is_empty() {
        Err("OpenVPN exited before the tunnel came up".to_string())
    } else {
        Err(format!("OpenVPN failed: {detail}"))
    }
}

/// Tear down the tunnel for `config` if it is up. Best-effort: signals the root
/// OpenVPN process via `pkexec kill` (reading the pid OpenVPN wrote), then reaps
/// our child. A missing/already-dead tunnel is treated as success.
#[cfg(target_os = "linux")]
pub fn disconnect(config: &str) -> Result<(), String> {
    let proc = registry().lock().unwrap().remove(config);
    let Some(mut proc) = proc else {
        return Ok(());
    };
    kill_pidfile(&proc.pidfile);
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    let _ = std::fs::remove_file(&proc.pidfile);
    Ok(())
}

/// `pkexec kill` the pid recorded in `pidfile` (the root OpenVPN process).
#[cfg(target_os = "linux")]
fn kill_pidfile(pidfile: &Path) {
    let Ok(contents) = std::fs::read_to_string(pidfile) else {
        return;
    };
    let pid = contents.trim();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return;
    }
    let _ = Command::new("pkexec")
        .arg("kill")
        .arg("-TERM")
        .arg(pid)
        .status();
}

/// Tear down every live tunnel. Used at app exit; errors are swallowed so
/// shutdown never blocks. Shared by Linux/Windows (each dispatches to its own
/// platform [`disconnect`]).
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn disconnect_all() {
    let keys: Vec<String> = {
        let reg = registry().lock().unwrap();
        reg.keys().cloned().collect()
    };
    for k in keys {
        let _ = disconnect(&k);
    }
}

// --- Windows: best-effort tunnel management --------------------------------
//
// Windows has no `pkexec`/polkit, so there is no non-interactive privilege
// escalation analogue. OpenVPN on Windows instead expects to run either elevated
// (Administrator) or via the bundled OpenVPN interactive service. Eldrun spawns
// `openvpn.exe` directly with the same `--askpass`-file credential flow as Linux
// (the askpass file is cross-platform), suppressing the console window, parsing
// stdout for the ready marker, and tracking the child so teardown can terminate
// it via its handle / `taskkill`.
//
// NOTE (runtime-verify): creating the VPN adapter (TAP/Wintun) typically needs
// Administrator rights. If Eldrun is not elevated, the spawn or the handshake
// will fail and the error message points the user at running as Administrator.
// A non-elevated flow would require integrating with the OpenVPN interactive
// service (named-pipe IPC), which is out of scope and needs runtime testing.

/// Actionable "openvpn not found" message for Windows.
#[cfg(target_os = "windows")]
const OPENVPN_MISSING: &str = "openvpn.exe not found — install OpenVPN (the community build, \
     https://openvpn.net/community-downloads/) to use VPN-gated projects on Windows";

/// Locate `openvpn.exe`: on `PATH`, in a per-user install dir, or under the
/// standard `Program Files\OpenVPN\bin` location a GUI app's PATH usually omits.
#[cfg(target_os = "windows")]
fn resolve_openvpn() -> Option<PathBuf> {
    if crate::paths::binary_on_path("openvpn") {
        return Some(PathBuf::from("openvpn"));
    }
    if let Some(p) = crate::paths::resolve_offpath_binary("openvpn") {
        return Some(p);
    }
    for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(key) {
            let cand = PathBuf::from(pf)
                .join("OpenVPN")
                .join("bin")
                .join("openvpn.exe");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Bring up the OpenVPN tunnel for `config`, authenticating with `password`.
/// No-op (returns `Ok`) if already connected. Blocks until OpenVPN reports the
/// tunnel up, the process exits, or `CONNECT_TIMEOUT` elapses.
#[cfg(target_os = "windows")]
pub fn connect(config: &str, password: &str) -> Result<(), String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if !Path::new(config).is_file() {
        return Err(format!("OpenVPN config not found: {config}"));
    }
    if is_connected(config) {
        return Ok(());
    }
    let exe = resolve_openvpn().ok_or_else(|| OPENVPN_MISSING.to_string())?;

    let stem = safe_stem(config);
    let askpass = write_askpass(&stem, password)?;
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(config, &askpass, &pidfile)?;

    // `command_no_window` adds CREATE_NO_WINDOW so the long-lived openvpn.exe
    // does not own a flashing console window.
    let spawn_result = crate::paths::command_no_window(&exe.to_string_lossy())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&askpass);
            return Err(format!(
                "failed to launch openvpn.exe: {e} — creating the VPN adapter usually \
                 requires running Eldrun as Administrator"
            ));
        }
    };

    // Stream stdout until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child);
    // The passphrase has been read by now; remove it regardless of outcome.
    let _ = std::fs::remove_file(&askpass);

    match ready {
        Ok(()) => {
            registry()
                .lock()
                .unwrap()
                .insert(config.to_string(), VpnProc { child, pidfile });
            Ok(())
        }
        Err(msg) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{msg} — if this is a permissions/adapter error, run Eldrun as \
                 Administrator or (re)install the OpenVPN TAP/Wintun driver"
            ))
        }
    }
}

/// Tear down the tunnel for `config` if it is up. Best-effort: terminates the
/// `openvpn.exe` child (and any descendants) via `taskkill /T`, then reaps it.
/// A missing/already-dead tunnel is treated as success.
#[cfg(target_os = "windows")]
pub fn disconnect(config: &str) -> Result<(), String> {
    let proc = registry().lock().unwrap().remove(config);
    let Some(mut proc) = proc else {
        return Ok(());
    };
    let pid = proc.child.id();
    let _ = crate::paths::command_no_window("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    let _ = std::fs::remove_file(&proc.pidfile);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openvpn_args_basic_shape() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            Path::new("/run/eldrun/openvpn/x.pass"),
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        // --config then the path as a single item.
        let ci = args.iter().position(|a| a == "--config").unwrap();
        assert_eq!(args[ci + 1], "/home/u/work.ovpn");
        let ai = args.iter().position(|a| a == "--askpass").unwrap();
        assert_eq!(args[ai + 1], "/run/eldrun/openvpn/x.pass");
        let pi = args.iter().position(|a| a == "--writepid").unwrap();
        assert_eq!(args[pi + 1], "/run/eldrun/openvpn/x.pid");
        assert!(args.iter().any(|a| a == "--auth-nocache"));
    }

    #[test]
    fn openvpn_args_rejects_leading_dash_config() {
        assert!(openvpn_args("-evil", Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_control_chars() {
        assert!(openvpn_args("/a\nb.ovpn", Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_empty_config() {
        assert!(openvpn_args("   ", Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn safe_stem_is_filesystem_safe_and_distinct() {
        let a = safe_stem("/home/u/a.ovpn");
        let b = safe_stem("/home/u/b.ovpn");
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    fn safe_stem_handles_multibyte_paths_without_panicking() {
        // A long path of multibyte chars must not panic on the length-bounding
        // slice (the bug was byte-index slicing into the middle of a char).
        let path = format!("/home/{}/файл-конфигурации-очень-длинное-имя.ovpn", "ü".repeat(60));
        let stem = safe_stem(&path);
        // Still filesystem-safe (non-ascii-alnum collapses to '_') and bounded.
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        // 40-char tail + '_' + 16 hex digits.
        assert!(stem.len() <= 40 + 1 + 16);
    }

    #[test]
    fn is_connected_false_for_unknown_config() {
        assert!(!is_connected("/no/such/config-unit-test.ovpn"));
    }
}
