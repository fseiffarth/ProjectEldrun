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

use std::collections::HashMap;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::io::{BufRead, BufReader};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::process::{Child, Stdio};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::services::ssh_common::validate_arg;
use crate::storage;

/// OpenVPN prints this once the tunnel is fully up.
const READY_MARKER: &str = "Initialization Sequence Completed";
/// Give the tunnel this long to come up before we give up and kill it.
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

/// A previously-used `.ovpn` config copied into Eldrun's store, offered for
/// reuse so a config need only be browsed for once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredConfig {
    /// Absolute path to the stored copy (what callers pass to `connect`).
    pub path: String,
    /// Friendly display name (the original `.ovpn` file name).
    pub name: String,
}

/// List the `.ovpn` configs Eldrun has previously stored, newest first (by file
/// mtime). Every config passed through [`store_config`] lands here, so the dir
/// doubles as the "recently used" history. Returns empty if nothing is stored.
pub fn list_configs() -> Vec<StoredConfig> {
    let dir = configs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items: Vec<(std::time::SystemTime, StoredConfig)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let name = display_name(file_name);
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        items.push((
            mtime,
            StoredConfig {
                path: path.to_string_lossy().into_owned(),
                name,
            },
        ));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.into_iter().map(|(_, c)| c).collect()
}

/// Recover an `.ovpn` config's display name from its stored file name. Stored
/// as `{stem}__{original_name}`; `rsplit_once` keeps the last segment as the
/// name (the stem can itself contain `__` since non-alnums collapse to `_`,
/// while the original file name rarely does). Falls back to the whole name.
fn display_name(file_name: &str) -> String {
    file_name
        .rsplit_once("__")
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| file_name.to_string())
}

/// Single-quote `s` for a POSIX shell so a config path with spaces or
/// metacharacters stays a single inert argument when the built command is typed
/// into a terminal. Embedded single quotes become `'\''`.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Build a ready-to-run shell command string that brings up the OpenVPN tunnel
/// for `config` **interactively**, so the encrypted-key passphrase is typed
/// directly into a visible terminal (no `--askpass` temp file, nothing for Eldrun
/// to handle). Typed into a root-scope shell tab (see the frontend
/// `openConnectionInRoot`) when headless connections are turned off.
///
/// Linux launches it elevated via `pkexec` (the tun device / routing need root);
/// the polkit prompt comes first, then OpenVPN prompts for the passphrase on the
/// same tty. `--auth-nocache` keeps the passphrase out of OpenVPN's memory across
/// re-keys. Windows runs `openvpn.exe` directly (it must be started elevated).
/// The config path is validated and shell-quoted as a single argument.
#[cfg(target_os = "linux")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    Ok(format!(
        "pkexec openvpn --config {} --auth-nocache",
        shell_quote(config)
    ))
}

/// Windows variant: no `pkexec`; `openvpn.exe` must already be running elevated.
#[cfg(target_os = "windows")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    Ok(format!(
        "openvpn --config {} --auth-nocache",
        shell_quote(config)
    ))
}

/// macOS variant: `sudo` on the visible tty (no `pkexec`/polkit on macOS; the
/// interactive root-tab path types the password straight into the terminal).
#[cfg(target_os = "macos")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    Ok(format!(
        "sudo openvpn --config {} --auth-nocache",
        shell_quote(config)
    ))
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

/// True if an `openvpn` binary can be located (PATH or the usual Homebrew /
/// local prefixes). Elevation rides `osascript … with administrator privileges`
/// (see [`connect_streaming`]), which is always present, so only the binary is
/// probed.
#[cfg(target_os = "macos")]
pub fn openvpn_available() -> bool {
    resolve_openvpn().is_some()
}

/// Build the `openvpn` argv (without the leading `pkexec`/`openvpn`) for a
/// connect. Returned as `Vec<String>` so it is unit-testable without launching.
///
/// `credfile` holds the secret OpenVPN reads non-interactively. `userpass`
/// selects *which* credential the file is:
/// - `true`  → `--auth-user-pass <credfile>` (a two-line `username\npassword`
///   file), for configs with a bare `auth-user-pass` directive (server-side
///   username+password auth). Without this OpenVPN would prompt for the username
///   on stdin and, with stdin closed, hang until the connect times out.
/// - `false` → `--askpass <credfile>` (a one-line passphrase file), for an
///   encrypted private key.
///
/// Shape: `--config <cfg> {--auth-user-pass|--askpass} <credfile> --auth-nocache
///         --writepid <pidfile> --connect-timeout 20 --connect-retry-max 3`.
pub fn openvpn_args(
    config: &str,
    userpass: bool,
    credfile: &Path,
    pidfile: &Path,
) -> Result<Vec<String>, String> {
    let config = config.trim();
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    validate_arg("OpenVPN config", config)?;
    let cred_flag = if userpass { "--auth-user-pass" } else { "--askpass" };
    Ok(vec![
        "--config".to_string(),
        config.to_string(),
        cred_flag.to_string(),
        credfile.to_string_lossy().into_owned(),
        "--auth-nocache".to_string(),
        "--writepid".to_string(),
        pidfile.to_string_lossy().into_owned(),
        "--connect-timeout".to_string(),
        "20".to_string(),
        "--connect-retry-max".to_string(),
        "3".to_string(),
    ])
}

/// Whether `config` uses server-side username+password auth that OpenVPN would
/// otherwise prompt for interactively — i.e. it contains a bare `auth-user-pass`
/// directive with **no** inline credentials file argument. Such configs need a
/// username (collected in the UI, stored in [`OpenVpnSpec`]) fed via
/// `--auth-user-pass`; a directive that already names a file (`auth-user-pass
/// creds.txt`) supplies its own and is treated as not needing one.
///
/// Best-effort: an unreadable config returns `false` (the connect then falls back
/// to the `--askpass` path, matching the pre-username behaviour). Comment lines
/// (`#`/`;`) and inline trailing comments are ignored.
pub fn config_requires_userpass(config: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(config.trim()) else {
        return false;
    };
    text.lines().any(|line| {
        // Strip trailing `# ...` / `; ...` comments, then tokenize on whitespace.
        let body = line
            .split(['#', ';'])
            .next()
            .unwrap_or("")
            .trim();
        let mut tok = body.split_whitespace();
        tok.next() == Some("auth-user-pass") && tok.next().is_none()
    })
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

/// Write a two-line `username\npassword` credentials file (owner-only, 0600) for
/// `--auth-user-pass` and return its path. Same lifetime/permissions story as
/// [`write_askpass`]: it lives under the per-user runtime dir and is deleted as
/// soon as OpenVPN has read it. A newline in either field would forge extra lines
/// OpenVPN misreads, so both are rejected (they can't occur in a real credential
/// anyway).
fn write_userpass(stem: &str, username: &str, password: &str) -> Result<PathBuf, String> {
    if username.contains(['\n', '\r']) || password.contains(['\n', '\r']) {
        return Err("VPN username/password must not contain newlines".to_string());
    }
    let dir = runtime_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create openvpn dir: {e}"))?;
    let path = dir.join(format!("{stem}.auth"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts
        .open(&path)
        .map_err(|e| format!("create auth-user-pass file: {e}"))?;
    writeln!(f, "{username}\n{password}").map_err(|e| format!("write auth-user-pass file: {e}"))?;
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

/// True if a tunnel for `config` is currently up: registered and its recorded
/// daemon pid probes alive via `kill(pid, 0)` — where **EPERM counts as
/// alive** (the daemon is root; see [`pid_alive`]). This feeds `openvpn_status`,
/// so getting EPERM wrong keeps the VPN lamp dark (the 28l bug). A registered
/// tunnel whose pid is gone is dropped from the registry.
#[cfg(target_os = "macos")]
pub fn is_connected(config: &str) -> bool {
    let mut reg = mac_registry().lock().unwrap();
    match reg.get(config) {
        Some(proc) => match pidfile_pid(&proc.pidfile) {
            Some(pid) if pid_alive(pid) => true,
            _ => {
                let dead = reg.remove(config);
                if let Some(dead) = dead {
                    let _ = std::fs::remove_file(&dead.pidfile);
                    let _ = std::fs::remove_file(&dead.logfile);
                }
                false
            }
        },
        None => false,
    }
}

/// Bring up the OpenVPN tunnel for `config`, authenticating with `password`.
/// No-op (returns `Ok`) if already connected. Blocks until OpenVPN reports the
/// tunnel up, the process exits, or `CONNECT_TIMEOUT` elapses.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub fn connect(config: &str, username: Option<&str>, password: &str) -> Result<(), String> {
    connect_streaming(config, username, password, |_| {})
}

/// Like [`connect`], but invokes `on_line` for every line OpenVPN emits while the
/// tunnel comes up (stdout + stderr), so the caller can stream the live handshake
/// into a read-only log. The callback runs on the calling thread, before the
/// ready-marker check, so the marker line is reported too.
#[cfg(target_os = "linux")]
pub fn connect_streaming(
    config: &str,
    username: Option<&str>,
    password: &str,
    on_line: impl Fn(&str),
) -> Result<(), String> {
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
    // Feed the secret through the channel the config actually reads: a two-line
    // user+pass file for `auth-user-pass` configs, else a one-line key passphrase.
    let userpass = config_requires_userpass(config);
    let credfile = if userpass {
        write_userpass(&stem, username.unwrap_or(""), password)?
    } else {
        write_askpass(&stem, password)?
    };
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(config, userpass, &credfile, &pidfile)?;

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
            let _ = std::fs::remove_file(&credfile);
            return Err(format!("failed to launch pkexec openvpn: {e}"));
        }
    };

    // Stream stdout/stderr until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child, &on_line);
    // The credential has been read by now; remove it regardless of outcome.
    let _ = std::fs::remove_file(&credfile);

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

/// Wait until OpenVPN reports the tunnel up (Ok), the process ends without the
/// marker (Err with the tail), or [`CONNECT_TIMEOUT`] elapses (Err). Shared by
/// Linux/Windows.
///
/// Both stdout *and* stderr are drained on background threads feeding a channel,
/// and the wait loop blocks on `recv_timeout` rather than directly on a read.
/// This is deliberate: a plain `for line in reader.lines()` only re-checks the
/// deadline once a line arrives, so a child that emits *nothing* — e.g. `pkexec`
/// blocked on a polkit prompt that is never answered (or has no agent), or a
/// stalled handshake — would hang indefinitely instead of timing out. Reading
/// stderr too means `pkexec`/driver errors (which never touch stdout) surface in
/// the failure message instead of being lost.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn wait_for_ready(child: &mut Child, on_line: &dyn Fn(&str)) -> Result<(), String> {
    use std::sync::mpsc::{self, RecvTimeoutError};

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "openvpn produced no stdout".to_string())?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<String>();
    let tx_err = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break; // receiver gone (timed out / found marker)
                    }
                }
                Err(_) => break,
            }
        }
    });
    match stderr {
        Some(stderr) => {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => {
                            if tx_err.send(l).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        // No stderr pipe: drop the spare sender so the channel can disconnect
        // once the stdout reader finishes (otherwise `Disconnected` never fires).
        None => drop(tx_err),
    }

    let start = Instant::now();
    let mut tail: Vec<String> = Vec::new();
    loop {
        let remaining = match CONNECT_TIMEOUT.checked_sub(start.elapsed()) {
            Some(r) if !r.is_zero() => r,
            _ => return Err("OpenVPN connection timed out".to_string()),
        };
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                // Surface every line (stdout + stderr) to the caller so the UI can
                // render the live handshake, then keep the marker/tail bookkeeping.
                on_line(&line);
                if line.contains(READY_MARKER) {
                    return Ok(());
                }
                tail.push(line);
                if tail.len() > 8 {
                    tail.remove(0);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err("OpenVPN connection timed out".to_string());
            }
            // Both readers ended → the process exited without the marker.
            Err(RecvTimeoutError::Disconnected) => {
                let detail = tail.join("; ");
                return if detail.is_empty() {
                    Err("OpenVPN exited before the tunnel came up".to_string())
                } else {
                    Err(format!("OpenVPN failed: {detail}"))
                };
            }
        }
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

/// Like [`connect`], but invokes `on_line` for every line OpenVPN emits while the
/// tunnel comes up (stdout + stderr), so the caller can stream the live handshake
/// into a read-only log.
#[cfg(target_os = "windows")]
pub fn connect_streaming(
    config: &str,
    username: Option<&str>,
    password: &str,
    on_line: impl Fn(&str),
) -> Result<(), String> {
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
    // Feed the secret through the channel the config actually reads: a two-line
    // user+pass file for `auth-user-pass` configs, else a one-line key passphrase.
    let userpass = config_requires_userpass(config);
    let credfile = if userpass {
        write_userpass(&stem, username.unwrap_or(""), password)?
    } else {
        write_askpass(&stem, password)?
    };
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(config, userpass, &credfile, &pidfile)?;

    // `command_no_window` adds CREATE_NO_WINDOW so the long-lived openvpn.exe
    // does not own a flashing console window.
    let spawn_result = crate::paths::command_no_window(&exe)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&credfile);
            return Err(format!(
                "failed to launch openvpn.exe: {e} — creating the VPN adapter usually \
                 requires running Eldrun as Administrator"
            ));
        }
    };

    // Stream stdout/stderr until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child, &on_line);
    // The credential has been read by now; remove it regardless of outcome.
    let _ = std::fs::remove_file(&credfile);

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

// --- macOS: osascript-elevated daemon + logfile tail -------------------------
//
// macOS has no `pkexec`/polkit analogue; privileged one-shots go through
// `osascript -e 'do shell script … with administrator privileges'` (the system
// admin-auth dialog). That call BLOCKS until the launched command exits, so
// OpenVPN must not run in the foreground — it is started with `--daemon --log
// <file>`: the parent exits as soon as the daemon forks (osascript returns),
// and the handshake is followed by tailing the logfile for the ready marker.
// There is consequently no `Child` to track: the macOS registry keys the
// config to its pidfile/logfile, liveness is `kill(pid, 0)` (EPERM = alive —
// the daemon is root; treating EPERM as dead is the exact 28l lamp bug), and
// teardown is a second admin-prompted `kill -TERM <pid>` (accepted for v1;
// management-interface teardown would avoid the prompt but needs the config
// to opt in — follow-up note in TODO 31e).

/// Escape `s` for embedding inside an AppleScript double-quoted string
/// literal: backslashes and double quotes are the only metacharacters.
/// Compiled cfg-free so it is unit-tested on Linux.
pub fn applescript_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Build the AppleScript source that runs `shell_cmd` elevated with the given
/// dialog `prompt` — the macOS analog of prefixing `pkexec`. `shell_cmd` must
/// already be shell-quoted (see [`shell_quote`]); this wraps it for the
/// AppleScript string context. Compiled cfg-free for Linux-run unit tests.
pub fn macos_admin_shell_command(shell_cmd: &str, prompt: &str) -> String {
    format!(
        "do shell script \"{}\" with administrator privileges with prompt \"{}\"",
        applescript_escape(shell_cmd),
        applescript_escape(prompt)
    )
}

/// Read and validate the pid recorded in `pidfile`: digits only (same
/// validation as `kill_pidfile` — the file is root-written, but never feed a
/// non-numeric string to `kill`). `None` when missing/empty/invalid. Compiled
/// cfg-free for Linux-run unit tests.
pub fn pidfile_pid(pidfile: &Path) -> Option<i32> {
    let contents = std::fs::read_to_string(pidfile).ok()?;
    let pid = contents.trim();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// Follow `logfile` until the OpenVPN ready marker appears (`Ok`), the daemon
/// dies without it (`Err` with the log tail), or `timeout` elapses (`Err`).
/// The logfile analog of `wait_for_ready`'s pipe loop, for a daemonized
/// OpenVPN whose parent already exited. Emits every COMPLETE line to
/// `on_line` (a trailing partial line is held until its newline arrives).
/// `still_alive` is consulted after each drain so a death right after writing
/// the failure reason still surfaces that reason. std-only and cfg-free so it
/// is unit-tested on Linux with a temp file.
pub fn wait_for_ready_logfile(
    logfile: &Path,
    timeout: Duration,
    poll: Duration,
    still_alive: impl Fn() -> bool,
    on_line: impl Fn(&str),
) -> Result<(), String> {
    let start = Instant::now();
    let mut seen = 0usize; // byte offset of consumed (complete) lines
    let mut tail: Vec<String> = Vec::new();
    loop {
        // Raw bytes + lossy per-line decode: a log with a stray non-UTF-8 byte
        // must not stall the whole tail.
        let bytes = std::fs::read(logfile).unwrap_or_default();
        while let Some(nl) = bytes[seen.min(bytes.len())..].iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&bytes[seen..seen + nl]);
            let line = line.trim_end_matches('\r');
            on_line(line);
            if line.contains(READY_MARKER) {
                return Ok(());
            }
            tail.push(line.to_string());
            if tail.len() > 8 {
                tail.remove(0);
            }
            seen += nl + 1;
        }
        if !still_alive() {
            let detail = tail.join("; ");
            return if detail.is_empty() {
                Err("OpenVPN exited before the tunnel came up".to_string())
            } else {
                Err(format!("OpenVPN failed: {detail}"))
            };
        }
        if start.elapsed() >= timeout {
            return Err("OpenVPN connection timed out".to_string());
        }
        std::thread::sleep(poll);
    }
}

/// A live macOS tunnel: the root daemon's pidfile + its logfile. No `Child` —
/// osascript exits once OpenVPN daemonizes.
#[cfg(target_os = "macos")]
struct MacVpn {
    pidfile: PathBuf,
    logfile: PathBuf,
}

/// macOS-own registry of live tunnels, keyed by config path (the pid-tracked
/// analog of [`registry`]).
#[cfg(target_os = "macos")]
fn mac_registry() -> &'static Mutex<HashMap<String, MacVpn>> {
    static REG: OnceLock<Mutex<HashMap<String, MacVpn>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether `pid` is alive. **EPERM counts as ALIVE**: the daemon runs as root,
/// so an unprivileged probe gets EPERM for a perfectly healthy tunnel —
/// treating that as dead keeps the VPN lamp dark (the exact 28l bug).
#[cfg(target_os = "macos")]
fn pid_alive(pid: i32) -> bool {
    // SAFETY: kill with signal 0 only probes for existence/permission.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Locate `openvpn` as an ABSOLUTE path: PATH first, then the Homebrew /
/// usr-local prefixes a GUI app's environment usually lacks. Absolute because
/// the command runs under `do shell script`, whose /bin/sh gets a minimal
/// PATH without any of those prefixes.
#[cfg(target_os = "macos")]
fn resolve_openvpn() -> Option<PathBuf> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let extra = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ];
    for dir in path_var
        .split(':')
        .filter(|d| !d.is_empty())
        .chain(extra.iter().copied())
    {
        let cand = Path::new(dir).join("openvpn");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Like [`connect`], but invokes `on_line` for every line OpenVPN writes to
/// its logfile while the tunnel comes up, so the caller can stream the live
/// handshake into a read-only log. See the section comment above for the
/// osascript + `--daemon` + logfile-tail design.
#[cfg(target_os = "macos")]
pub fn connect_streaming(
    config: &str,
    username: Option<&str>,
    password: &str,
    on_line: impl Fn(&str),
) -> Result<(), String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if !Path::new(config).is_file() {
        return Err(format!("OpenVPN config not found: {config}"));
    }
    if is_connected(config) {
        return Ok(());
    }
    let exe = resolve_openvpn().ok_or_else(|| {
        "openvpn not found — install it (e.g. `brew install openvpn`) to use VPN-gated projects"
            .to_string()
    })?;

    let stem = safe_stem(config);
    // Feed the secret through the channel the config actually reads: a two-line
    // user+pass file for `auth-user-pass` configs, else a one-line key passphrase.
    let userpass = config_requires_userpass(config);
    let credfile = if userpass {
        write_userpass(&stem, username.unwrap_or(""), password)?
    } else {
        write_askpass(&stem, password)?
    };
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let logfile = runtime_dir().join(format!("{stem}.log"));
    // Stale files from a previous run would satisfy the tail/liveness checks
    // spuriously — start clean.
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&logfile);

    let mut args = openvpn_args(config, userpass, &credfile, &pidfile)?;
    args.push("--daemon".to_string());
    args.push("--log".to_string());
    args.push(logfile.to_string_lossy().into_owned());

    let shell_cmd = std::iter::once(exe.to_string_lossy().into_owned())
        .chain(args)
        .map(|a| shell_quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let script = macos_admin_shell_command(
        &shell_cmd,
        "Eldrun needs to start the OpenVPN tunnel.",
    );

    // Blocks until the admin dialog is answered AND openvpn daemonizes (its
    // parent exits) — or fails. "User canceled." on stderr = dialog declined.
    let output = crate::paths::command_no_window("osascript")
        .arg("-e")
        .arg(&script)
        .output();
    let output = match output {
        Ok(out) => out,
        Err(e) => {
            let _ = std::fs::remove_file(&credfile);
            return Err(format!("failed to run osascript: {e}"));
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&credfile);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.contains("User canceled") {
            "administrator authorization was declined".to_string()
        } else {
            let msg = stderr.trim();
            if msg.is_empty() {
                "osascript failed to start OpenVPN".to_string()
            } else {
                format!("failed to start OpenVPN: {msg}")
            }
        });
    }

    // Tail the logfile until the marker / dead daemon / timeout. A missing
    // pidfile means the daemon is still writing it — only a RECORDED pid that
    // fails the probe counts as dead.
    let ready = wait_for_ready_logfile(
        &logfile,
        CONNECT_TIMEOUT,
        Duration::from_millis(200),
        || pidfile_pid(&pidfile).map(pid_alive).unwrap_or(true),
        &on_line,
    );
    // The credential has been read by now; remove it regardless of outcome.
    let _ = std::fs::remove_file(&credfile);

    match ready {
        Ok(()) => {
            mac_registry()
                .lock()
                .unwrap()
                .insert(config.to_string(), MacVpn { pidfile, logfile });
            Ok(())
        }
        Err(msg) => Err(msg),
    }
}

/// Tear down the tunnel for `config` if it is up: an admin-prompted
/// `kill -TERM <pid>` (the daemon is root — a plain kill gets EPERM). The
/// second prompt per disconnect is accepted for v1. A missing/already-dead
/// tunnel is treated as success.
#[cfg(target_os = "macos")]
pub fn disconnect(config: &str) -> Result<(), String> {
    let proc = mac_registry().lock().unwrap().remove(config);
    let Some(proc) = proc else {
        return Ok(());
    };
    if let Some(pid) = pidfile_pid(&proc.pidfile) {
        if pid_alive(pid) {
            let script = macos_admin_shell_command(
                &format!("kill -TERM {pid}"),
                "Eldrun needs to stop the OpenVPN tunnel.",
            );
            let _ = crate::paths::command_no_window("osascript")
                .arg("-e")
                .arg(&script)
                .output();
        }
    }
    let _ = std::fs::remove_file(&proc.pidfile);
    let _ = std::fs::remove_file(&proc.logfile);
    Ok(())
}

/// Tear down every live tunnel at app exit; errors are swallowed so shutdown
/// never blocks (mirrors the Linux/Windows `disconnect_all`).
#[cfg(target_os = "macos")]
pub fn disconnect_all() {
    let keys: Vec<String> = {
        let reg = mac_registry().lock().unwrap();
        reg.keys().cloned().collect()
    };
    for k in keys {
        let _ = disconnect(&k);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("/home/u/a.ovpn"), "'/home/u/a.ovpn'");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn interactive_connect_command_linux_shape() {
        let cmd = interactive_connect_command("/home/u/work.ovpn").unwrap();
        // Elevated via pkexec; passphrase typed interactively (no --askpass file).
        assert!(cmd.starts_with("pkexec openvpn --config "));
        assert!(cmd.contains("'/home/u/work.ovpn'"));
        assert!(cmd.contains("--auth-nocache"));
        assert!(!cmd.contains("--askpass"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn interactive_connect_command_rejects_bad_config() {
        assert!(interactive_connect_command("-evil").is_err());
        assert!(interactive_connect_command("/a\nb.ovpn").is_err());
        assert!(interactive_connect_command("   ").is_err());
    }

    #[test]
    fn openvpn_args_askpass_shape() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            false,
            Path::new("/run/eldrun/openvpn/x.pass"),
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        // --config then the path as a single item.
        let ci = args.iter().position(|a| a == "--config").unwrap();
        assert_eq!(args[ci + 1], "/home/u/work.ovpn");
        // Passphrase-only configs feed the secret via --askpass.
        let ai = args.iter().position(|a| a == "--askpass").unwrap();
        assert_eq!(args[ai + 1], "/run/eldrun/openvpn/x.pass");
        assert!(!args.iter().any(|a| a == "--auth-user-pass"));
        let pi = args.iter().position(|a| a == "--writepid").unwrap();
        assert_eq!(args[pi + 1], "/run/eldrun/openvpn/x.pid");
        assert!(args.iter().any(|a| a == "--auth-nocache"));
    }

    #[test]
    fn openvpn_args_userpass_uses_auth_user_pass() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            true,
            Path::new("/run/eldrun/openvpn/x.auth"),
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        // auth-user-pass configs feed username+password via --auth-user-pass,
        // never --askpass (which OpenVPN only reads for an encrypted key).
        let ai = args.iter().position(|a| a == "--auth-user-pass").unwrap();
        assert_eq!(args[ai + 1], "/run/eldrun/openvpn/x.auth");
        assert!(!args.iter().any(|a| a == "--askpass"));
    }

    #[test]
    fn openvpn_args_rejects_leading_dash_config() {
        assert!(openvpn_args("-evil", false, Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_control_chars() {
        assert!(openvpn_args("/a\nb.ovpn", false, Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_empty_config() {
        assert!(openvpn_args("   ", false, Path::new("/a"), Path::new("/b")).is_err());
    }

    #[test]
    fn config_requires_userpass_detects_bare_directive() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("eldrun-ovpn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Bare `auth-user-pass` → needs a username.
        let bare = dir.join("bare.ovpn");
        let mut f = std::fs::File::create(&bare).unwrap();
        writeln!(f, "client\nremote vpn.example.com 1194\nauth-user-pass\nauth-nocache").unwrap();
        assert!(config_requires_userpass(bare.to_str().unwrap()));

        // `auth-user-pass creds.txt` supplies its own file → does not.
        let withfile = dir.join("withfile.ovpn");
        let mut f = std::fs::File::create(&withfile).unwrap();
        writeln!(f, "client\nauth-user-pass /etc/creds.txt").unwrap();
        assert!(!config_requires_userpass(withfile.to_str().unwrap()));

        // Commented-out directive → does not.
        let commented = dir.join("commented.ovpn");
        let mut f = std::fs::File::create(&commented).unwrap();
        writeln!(f, "client\n# auth-user-pass\n;auth-user-pass").unwrap();
        assert!(!config_requires_userpass(commented.to_str().unwrap()));

        // Cert-only config → does not.
        let cert = dir.join("cert.ovpn");
        let mut f = std::fs::File::create(&cert).unwrap();
        writeln!(f, "client\nremote vpn.example.com 1194\ncert a.crt\nkey a.key").unwrap();
        assert!(!config_requires_userpass(cert.to_str().unwrap()));

        // Missing file → false (best-effort fallback).
        assert!(!config_requires_userpass(
            dir.join("nope.ovpn").to_str().unwrap()
        ));

        let _ = std::fs::remove_dir_all(&dir);
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
    fn display_name_recovers_original_from_stored() {
        // `{stem}__{original}` → original; stem may contain `__`.
        assert_eq!(display_name("_home_u_work_ovpn_abcd1234__work.ovpn"), "work.ovpn");
        assert_eq!(display_name("a__b__client.conf"), "client.conf");
        // No separator → whole name (defensive; shouldn't happen for stored copies).
        assert_eq!(display_name("loose.ovpn"), "loose.ovpn");
    }

    #[test]
    fn is_connected_false_for_unknown_config() {
        assert!(!is_connected("/no/such/config-unit-test.ovpn"));
    }

    // ── macOS pure helpers (run on any OS) ──────────────────────────────────

    #[test]
    fn applescript_escape_handles_quotes_and_backslashes() {
        assert_eq!(applescript_escape("plain"), "plain");
        assert_eq!(applescript_escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(applescript_escape(r"a\b"), r"a\\b");
        assert_eq!(applescript_escape(r#"\""#), r#"\\\""#);
    }

    #[test]
    fn macos_admin_shell_command_wraps_and_escapes() {
        let cmd = macos_admin_shell_command("'/opt/x/openvpn' --config 'a\"b.ovpn'", "Prompt.");
        assert!(cmd.starts_with("do shell script \""));
        assert!(cmd.ends_with("with prompt \"Prompt.\""));
        assert!(cmd.contains("with administrator privileges"));
        // The embedded double quote survived AppleScript-escaped.
        assert!(cmd.contains(r#"a\"b.ovpn"#));
    }

    #[test]
    fn pidfile_pid_accepts_digits_only() {
        let dir = std::env::temp_dir().join(format!("eldrun-pidfile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            p
        };
        assert_eq!(pidfile_pid(&write("ok.pid", "1234\n")), Some(1234));
        assert_eq!(pidfile_pid(&write("ws.pid", "  567  ")), Some(567));
        // Anything non-numeric must never reach `kill`.
        assert_eq!(pidfile_pid(&write("evil.pid", "123; rm -rf /")), None);
        assert_eq!(pidfile_pid(&write("neg.pid", "-1")), None);
        assert_eq!(pidfile_pid(&write("empty.pid", "")), None);
        assert_eq!(pidfile_pid(&dir.join("missing.pid")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_for_ready_logfile_finds_marker() {
        let dir = std::env::temp_dir().join(format!("eldrun-ovpnlog-a-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.log");
        std::fs::write(&log, "line one\nInitialization Sequence Completed\nafter\n").unwrap();
        let seen = std::sync::Mutex::new(Vec::<String>::new());
        let result = wait_for_ready_logfile(
            &log,
            Duration::from_secs(5),
            Duration::from_millis(10),
            || true,
            |l| seen.lock().unwrap().push(l.to_string()),
        );
        assert!(result.is_ok());
        let seen = seen.lock().unwrap();
        // Every line up to AND INCLUDING the marker is streamed; nothing after.
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], "line one");
        assert!(seen[1].contains("Initialization Sequence Completed"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_for_ready_logfile_reports_death_with_tail() {
        let dir = std::env::temp_dir().join(format!("eldrun-ovpnlog-b-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.log");
        std::fs::write(&log, "AUTH: Received control message: AUTH_FAILED\n").unwrap();
        let result = wait_for_ready_logfile(
            &log,
            Duration::from_secs(5),
            Duration::from_millis(10),
            || false, // daemon died
            |_| {},
        );
        let err = result.unwrap_err();
        // The failure reason from the log is surfaced, not swallowed.
        assert!(err.contains("AUTH_FAILED"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_for_ready_logfile_times_out_and_holds_partial_lines() {
        let dir = std::env::temp_dir().join(format!("eldrun-ovpnlog-c-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.log");
        // No trailing newline: the partial line must NOT be emitted.
        std::fs::write(&log, "partial without newline").unwrap();
        let seen = std::sync::Mutex::new(Vec::<String>::new());
        let result = wait_for_ready_logfile(
            &log,
            Duration::from_millis(50),
            Duration::from_millis(10),
            || true, // alive but silent → timeout path
            |l| seen.lock().unwrap().push(l.to_string()),
        );
        assert_eq!(result.unwrap_err(), "OpenVPN connection timed out");
        assert!(seen.lock().unwrap().is_empty(), "partial line must be held back");
        // A missing logfile behaves like an empty one (daemon hasn't created it
        // yet) rather than erroring out of the wait.
        let result = wait_for_ready_logfile(
            &dir.join("never-created.log"),
            Duration::from_millis(30),
            Duration::from_millis(10),
            || true,
            |_| {},
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
