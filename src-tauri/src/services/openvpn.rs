//! OpenVPN tunnel lifecycle for remote (SSH) projects.
//!
//! Some remote hosts are only reachable through a VPN. When a project carries an
//! `OpenVpnSpec` (a `.ovpn` config path), Eldrun brings the tunnel up *before*
//! the sshfs mount / ssh sessions and tears it down at app exit.
//!
//! OpenVPN needs root to create the tun device and adjust routing, so it is
//! launched via `pkexec` (the user authenticates through the system polkit
//! agent) — that local password is the system's to collect, never Eldrun's.
//!
//! The VPN's own secrets are two *independent* channels, and a config can need
//! either or **both** — OpenVPN prompts for them separately, so answering only
//! one leaves the other prompt hanging (stdin is closed) until the connect times
//! out:
//!   - an `auth-user-pass` account (username + password) → `--auth-user-pass`, and
//!   - an encrypted private key's passphrase → `--askpass`.
//! Which ones a config needs is read off the config itself
//! ([`config_requires_userpass`] / [`config_requires_key_passphrase`]). Neither
//! secret is persisted here: callers pass them in, we write them to owner-only
//! temp files OpenVPN reads, and delete those once the tunnel is up.
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

/// Registry of **interactive** tunnels (`connections_headless: false`), keyed by
/// config path → the pidfile OpenVPN writes. Value is a pidfile rather than a
/// `Child` because Eldrun does not spawn these: they run as `pkexec openvpn` (or
/// `sudo openvpn`) inside a *terminal tab*, typed into by the user, so there is no
/// child handle to hold — only the pid the daemon records.
///
/// Without this, an interactive tunnel was invisible and unkillable: absent from
/// [`registry`], it could not be seen by [`is_connected`] / [`active_configs`], nor
/// killed by [`disconnect`] / [`disconnect_all`] — so it **outlived Eldrun with the
/// machine's routing still changed**. [`interactive_connect_command`] now appends a
/// `--writepid` we own and registers it here, which closes all four gaps at once.
///
/// Not cfg-gated (unlike [`registry`]) so the bookkeeping unit-tests run anywhere.
fn interactive_registry() -> &'static Mutex<HashMap<String, PathBuf>> {
    static REG: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where an interactive tunnel for `config` records its pid. Deliberately a
/// different file from the headless `{stem}.pid`, so a stale file from one flavour
/// can never be mistaken for a live tunnel of the other.
fn interactive_pidfile(config: &str) -> PathBuf {
    runtime_dir().join(format!("{}.interactive.pid", safe_stem(config)))
}

/// Whether `pid` is alive. **EPERM counts as ALIVE**: the OpenVPN daemon runs as
/// root, so an unprivileged probe gets EPERM for a perfectly healthy tunnel —
/// treating that as dead is what keeps a VPN lamp dark while the tunnel is up
/// (the 28l bug).
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // SAFETY: kill with signal 0 only probes for existence/permission.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows analog: no `kill(0)`, so ask the task list. An elevated `openvpn.exe`
/// is still enumerated for an unelevated query, so there is no EPERM-style trap
/// here — but a failed probe is treated as *not* alive rather than guessed at.
#[cfg(target_os = "windows")]
fn pid_alive(pid: i32) -> bool {
    let out = crate::paths::command_no_window("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

/// State of the interactive tunnel registered for `config`.
#[derive(PartialEq, Eq, Debug)]
enum Interactive {
    /// No interactive tunnel registered for this config.
    None,
    /// Registered, but OpenVPN has not written its pid yet — the user is still at
    /// the polkit/sudo prompt or typing the passphrase. **Not dead**: the entry is
    /// kept, or a tunnel would be forgotten in the seconds before it comes up.
    Pending,
    /// Registered and its recorded pid is alive: the tunnel is up.
    Alive(i32),
}

/// Classify (and reap) the interactive entry for `config`.
fn interactive_state(config: &str) -> Interactive {
    let pidfile = match interactive_registry().lock().unwrap().get(config) {
        Some(p) => p.clone(),
        None => return Interactive::None,
    };
    match pidfile_pid(&pidfile) {
        Some(pid) if pid_alive(pid) => Interactive::Alive(pid),
        Some(_) => {
            // The pid was written and is now gone: the tunnel died (or the user
            // closed its terminal). Reap the entry and its stale pidfile.
            interactive_registry().lock().unwrap().remove(config);
            let _ = std::fs::remove_file(&pidfile);
            Interactive::None
        }
        None => Interactive::Pending,
    }
}

/// Whether an interactive tunnel for `config` is *up* (not merely registered).
fn interactive_connected(config: &str) -> bool {
    matches!(interactive_state(config), Interactive::Alive(_))
}

/// Tear down the interactive tunnel for `config`, if any. The daemon is root, so
/// the kill is elevated the same way the connect was.
fn disconnect_interactive(config: &str) {
    let alive = match interactive_state(config) {
        Interactive::Alive(pid) => Some(pid),
        // Pending: nothing to kill yet, but drop the claim so a never-authenticated
        // connect doesn't linger in the registry forever.
        Interactive::Pending => None,
        Interactive::None => return,
    };
    let pidfile = interactive_registry().lock().unwrap().remove(config);
    if let Some(pid) = alive {
        kill_root_pid(pid);
    }
    if let Some(pidfile) = pidfile {
        let _ = std::fs::remove_file(&pidfile);
    }
}

/// `kill -TERM` a **root-owned** pid, escalating the same way the platform's
/// connect does (a plain kill would get EPERM).
#[cfg(target_os = "linux")]
fn kill_root_pid(pid: i32) {
    let _ = Command::new("pkexec")
        .arg("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

#[cfg(target_os = "macos")]
fn kill_root_pid(pid: i32) {
    let script = macos_admin_shell_command(
        &format!("kill -TERM {pid}"),
        "Eldrun needs to stop the OpenVPN tunnel.",
    );
    let _ = crate::paths::command_no_window("osascript")
        .arg("-e")
        .arg(&script)
        .output();
}

/// Windows analog: `taskkill /F`. A service-started tunnel's `openvpn.exe` runs
/// with this user's token (the privilege lives in the interactive service), so
/// an unelevated kill reaches it; a direct-spawn tunnel was started from an
/// already-elevated context, whose `taskkill` is equally elevated.
#[cfg(target_os = "windows")]
fn kill_root_pid(pid: i32) {
    let _ = crate::paths::command_no_window("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output();
}

/// No supported escalation path on other platforms; nothing spawns tunnels there.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn kill_root_pid(_pid: i32) {}

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

/// Remove a stored `.ovpn` config from Eldrun's store. Deletes only Eldrun's
/// copy — the path must be inside [`configs_dir`], so the user's original file
/// is never touched. Refused while the config's tunnel is up: the row offering
/// removal should be a dead tunnel's, and a live one must be disconnected
/// first, not have its config pulled out from under it. Removing an
/// already-gone file succeeds — the goal state is "not stored".
pub fn remove_config(config: &str) -> Result<(), String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    let path = Path::new(config);
    if !path.starts_with(configs_dir()) {
        return Err("not a stored OpenVPN config".to_string());
    }
    if is_connected(config) {
        return Err("this tunnel is up — disconnect it before removing its config".to_string());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove config: {e}")),
    }
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
///
/// **Side effect (deliberate):** every variant appends `--writepid <pidfile>` and
/// registers that pidfile in [`interactive_registry`] via [`arm_interactive`]. The
/// tunnel this command starts is not Eldrun's child, so the pid it records is the
/// *only* handle on a root process that is rerouting the whole machine. Without it,
/// the tunnel is invisible to [`is_connected`] / [`active_configs`] and unkillable
/// by [`disconnect`] / [`disconnect_all`] — it outlives the app with the routing
/// still changed. Building the command is therefore also *claiming* it.
#[cfg(target_os = "linux")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let (config, pidfile) = arm_interactive(config)?;
    Ok(format!(
        "pkexec openvpn --config {} --auth-nocache --writepid {}",
        shell_quote(&config),
        shell_quote(&pidfile.to_string_lossy())
    ))
}

/// Windows variant: no `pkexec`; `openvpn.exe` must already be running elevated.
#[cfg(target_os = "windows")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let (config, pidfile) = arm_interactive(config)?;
    Ok(format!(
        "openvpn --config {} --auth-nocache --writepid {}",
        shell_quote(&config),
        shell_quote(&pidfile.to_string_lossy())
    ))
}

/// macOS variant: `sudo` on the visible tty (no `pkexec`/polkit on macOS; the
/// interactive root-tab path types the password straight into the terminal).
#[cfg(target_os = "macos")]
pub fn interactive_connect_command(config: &str) -> Result<String, String> {
    let (config, pidfile) = arm_interactive(config)?;
    Ok(format!(
        "sudo openvpn --config {} --auth-nocache --writepid {}",
        shell_quote(&config),
        shell_quote(&pidfile.to_string_lossy())
    ))
}

/// Validate `config` and claim an interactive tunnel for it: pick the pidfile,
/// delete any stale one (a leftover from a previous run would otherwise read as a
/// live tunnel), ensure the runtime dir exists for root to write into, and register
/// the claim. Returns the trimmed config and the pidfile the command must use.
///
/// Shared by all three [`interactive_connect_command`] variants so a platform
/// cannot forget the `--writepid` bookkeeping. Compiled cfg-free so the claim logic
/// is unit-testable on any host.
fn arm_interactive(config: &str) -> Result<(String, PathBuf), String> {
    let config = config.trim();
    validate_arg("OpenVPN config", config)?;
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    let pidfile = interactive_pidfile(config);
    let _ = std::fs::create_dir_all(runtime_dir());
    let _ = std::fs::remove_file(&pidfile);
    interactive_registry()
        .lock()
        .unwrap()
        .insert(config.to_string(), pidfile.clone());
    Ok((config.to_string(), pidfile))
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
/// The two credential files are **independent channels**, and a config can need
/// one, the other, or *both* — OpenVPN prompts for them separately, so feeding
/// only one leaves the other prompt unanswered and (stdin closed) hangs the
/// handshake until it times out:
/// - `userpass_file` → `--auth-user-pass <f>` (a two-line `username\npassword`
///   file), for configs with a bare `auth-user-pass` directive (server-side
///   username+password auth).
/// - `askpass_file` → `--askpass <f>` (a one-line passphrase file), for an
///   encrypted private key.
///
/// Shape: `--config <cfg> [--auth-user-pass <f>] [--askpass <f>] --auth-nocache
///         --writepid <pidfile> --connect-timeout 20 --connect-retry-max 3
///         --verb 3 --mute 0`.
pub fn openvpn_args(
    config: &str,
    userpass_file: Option<&Path>,
    askpass_file: Option<&Path>,
    pidfile: &Path,
) -> Result<Vec<String>, String> {
    let config = config.trim();
    if config.is_empty() {
        return Err("OpenVPN config path must not be empty".to_string());
    }
    validate_arg("OpenVPN config", config)?;
    let mut args = vec!["--config".to_string(), config.to_string()];
    if let Some(f) = userpass_file {
        args.push("--auth-user-pass".to_string());
        args.push(f.to_string_lossy().into_owned());
    }
    if let Some(f) = askpass_file {
        args.push("--askpass".to_string());
        args.push(f.to_string_lossy().into_owned());
    }
    args.extend([
        "--auth-nocache".to_string(),
        "--writepid".to_string(),
        pidfile.to_string_lossy().into_owned(),
        "--connect-timeout".to_string(),
        "20".to_string(),
        "--connect-retry-max".to_string(),
        "3".to_string(),
        // Readiness is detected by watching OpenVPN's output for READY_MARKER,
        // so logging must be deterministic no matter what the config says: a
        // config's `mute N` suppresses consecutive same-category lines — the
        // marker follows a burst of route additions, so it was exactly the line
        // a `mute 16` swallowed, and Eldrun then "timed out" on (and killed) a
        // tunnel that was up. `verb 0` would hide the marker the same way.
        // Command-line options are applied after `--config`, so these override.
        "--verb".to_string(),
        "3".to_string(),
        "--mute".to_string(),
        "0".to_string(),
    ]);
    Ok(args)
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

/// Whether a PEM blob holds an *encrypted* private key — the two markers OpenSSL
/// writes: `Proc-Type: 4,ENCRYPTED` (traditional/PKCS#1) and the PKCS#8
/// `BEGIN ENCRYPTED PRIVATE KEY` header. An unencrypted key has neither.
fn pem_is_encrypted(text: &str) -> bool {
    text.contains("Proc-Type: 4,ENCRYPTED") || text.contains("BEGIN ENCRYPTED PRIVATE KEY")
}

/// Whether `config` uses a private key whose passphrase OpenVPN would prompt for
/// (`Enter Private Key Password:`). This is an **independent** channel from
/// [`config_requires_userpass`]: a config can need both, and OpenVPN asks for
/// them as two separate prompts, so a connect that supplies only one hangs on the
/// other. Callers feed this one via `--askpass` (see [`openvpn_args`]).
///
/// True when the key is encrypted, whether inlined in a `<key>` block or named by
/// a `key <file>` directive (resolved relative to the config), and for a `pkcs12`
/// bundle — PKCS#12 is DER, so its encryption can't be sniffed the way PEM's can,
/// and the bundles OpenVPN ships are effectively always passphrase-protected.
/// False when the config carries its own `askpass <file>` (it supplies the
/// passphrase itself), and false for an unreadable config — best-effort, matching
/// [`config_requires_userpass`].
///
/// Erring toward `true` is the safe bias: a false positive shows one extra field
/// that, left blank, writes no askpass file and changes nothing; a false negative
/// hangs the handshake on an unanswered prompt.
pub fn config_requires_key_passphrase(config: &str) -> bool {
    let config = config.trim();
    let Ok(text) = std::fs::read_to_string(config) else {
        return false;
    };
    let config_dir = Path::new(config).parent();

    let mut in_key_block = false;
    let mut key_file: Option<String> = None;
    let mut pkcs12 = false;
    for line in text.lines() {
        let raw = line.trim();
        if raw.eq_ignore_ascii_case("<key>") {
            in_key_block = true;
            continue;
        }
        if raw.eq_ignore_ascii_case("</key>") {
            in_key_block = false;
            continue;
        }
        // Inside the inline key: the PEM body itself is the evidence. Base64 never
        // contains `#`/`;`, so no comment-stripping is needed (or wanted) here.
        if in_key_block {
            if pem_is_encrypted(raw) {
                return true;
            }
            continue;
        }
        let body = line.split(['#', ';']).next().unwrap_or("").trim();
        let mut tok = body.split_whitespace();
        match tok.next() {
            // `askpass <file>` supplies the passphrase itself; a bare `askpass`
            // means "prompt on the console" and still needs one from us.
            Some("askpass") if tok.next().is_some() => return false,
            Some("key") => key_file = tok.next().map(str::to_string),
            Some("pkcs12") => pkcs12 = true,
            _ => {}
        }
    }

    if pkcs12 {
        return true;
    }
    // An out-of-line key: resolve it against the config's directory when relative,
    // then sniff the same PEM markers. Unreadable → false (best-effort).
    let Some(key_file) = key_file else {
        return false;
    };
    let key_path = Path::new(&key_file);
    let key_path = match (key_path.is_absolute(), config_dir) {
        (false, Some(dir)) => dir.join(key_path),
        _ => key_path.to_path_buf(),
    };
    std::fs::read_to_string(key_path)
        .map(|k| pem_is_encrypted(&k))
        .unwrap_or(false)
}

/// The credential files a connect must hand OpenVPN, resolved from what the
/// config actually asks for. Shared by the Linux/Windows/macOS `connect_streaming`
/// implementations so all three feed the same channels.
///
/// `password` is the primary secret and `key_passphrase` the (optional) second
/// one. Which channel `password` lands in depends on the config:
/// - bare `auth-user-pass` → `password` is the *account* password, written with
///   `username` into the two-line userpass file, and `key_passphrase` (when the
///   config also has an encrypted key) becomes the askpass file.
/// - otherwise → there is no account to log into, so `password` *is* the key
///   passphrase and goes to askpass. This is the long-standing single-secret path.
///
/// Returns `(userpass_file, askpass_file)`; the caller passes them to
/// [`openvpn_args`] and deletes both once OpenVPN has read them.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn write_credfiles(
    config: &str,
    stem: &str,
    username: Option<&str>,
    password: &str,
    key_passphrase: Option<&str>,
) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
    let userpass = config_requires_userpass(config);
    let userpass_file = if userpass {
        Some(write_userpass(stem, username.unwrap_or(""), password)?)
    } else {
        None
    };
    let key_passphrase = key_passphrase.filter(|p| !p.is_empty());
    let askpass_file = match key_passphrase {
        Some(kp) => Some(write_askpass(stem, kp)?),
        None if !userpass => Some(write_askpass(stem, password)?),
        None => None,
    };
    Ok((userpass_file, askpass_file))
}

/// Turn OpenVPN's output into a message that names which secret was wrong.
///
/// This is the payoff of feeding the two credential channels separately: OpenVPN
/// reports an `auth-user-pass` rejection (`AUTH_FAILED`) and a bad private-key
/// passphrase (a decrypt error) with completely different lines, so a headless
/// connect can tell the user *which* of the fields to retype instead of dumping
/// the handshake log at them.
///
/// `log` is the failure tail (or the whole handshake). Returns `None` when nothing
/// is recognized, so the caller falls back to the raw tail rather than replacing a
/// specific error with a vague guess. Most-specific checks run first.
pub fn explain_openvpn_error(log: &str) -> Option<String> {
    let s = log.to_ascii_lowercase();

    // Wrong private-key passphrase. OpenVPN/OpenSSL word this several ways
    // depending on version and key format; all of them mean the same thing.
    if s.contains("private key password verification failed")
        || s.contains("error parsing private key")
        || s.contains("bad decrypt")
        || s.contains("decryption error")
        || s.contains("could not load private key")
    {
        return Some("Wrong private-key passphrase for this VPN config.".to_string());
    }

    // Wrong account username/password. AUTH_FAILED is the server explicitly
    // rejecting the `auth-user-pass` credentials.
    if s.contains("auth_failed") || s.contains("authenticate/decrypt packet error") {
        return Some(
            "VPN authentication failed — check the username and password.".to_string(),
        );
    }

    // Elevation: the polkit / macOS admin prompt was dismissed or unavailable. No
    // credential the user types into Eldrun can fix this one.
    if s.contains("authorization was declined")
        || s.contains("request dismissed")
        || s.contains("not authorized")
    {
        return Some(
            "Elevation was declined — OpenVPN needs root to create the tunnel device."
                .to_string(),
        );
    }

    // Reachability / config problems, which a user easily mistakes for bad creds.
    if s.contains("cannot resolve host address") || s.contains("resolve: cannot resolve") {
        return Some(
            "Cannot resolve the VPN server's address — check the config, and that you're online."
                .to_string(),
        );
    }
    if s.contains("tls key negotiation failed") || s.contains("tls handshake failed") {
        return Some(
            "VPN TLS handshake failed — the server never completed the key exchange. Check \
             that this config is current and the server is reachable."
                .to_string(),
        );
    }
    if s.contains("cannot open tun/tap") || s.contains("cannot allocate tun/tap") {
        return Some(
            "Could not create the VPN tunnel device — OpenVPN needs root, and the tun module \
             must be available."
                .to_string(),
        );
    }
    if s.contains("connection refused") {
        return Some("The VPN server refused the connection — check the config's port/protocol."
            .to_string());
    }

    None
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
    {
        let mut reg = registry().lock().unwrap();
        let headless = match reg.get_mut(config) {
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
        };
        if headless {
            return true;
        }
    }
    // A service-started tunnel (Windows): the control pipe is the liveness
    // signal — the service closes it when the openvpn.exe it spawned exits.
    #[cfg(target_os = "windows")]
    {
        if svc_connected(config) {
            return true;
        }
    }
    // Not one of ours — but an *interactive* tunnel (started in a terminal tab) is
    // just as up, and just as much in charge of the machine's routing.
    interactive_connected(config)
}

/// True if a tunnel for `config` is currently up: registered and its recorded
/// daemon pid probes alive via `kill(pid, 0)` — where **EPERM counts as
/// alive** (the daemon is root; see [`pid_alive`]). This feeds `openvpn_status`,
/// so getting EPERM wrong keeps the VPN lamp dark (the 28l bug). A registered
/// tunnel whose pid is gone is dropped from the registry.
#[cfg(target_os = "macos")]
pub fn is_connected(config: &str) -> bool {
    {
        let mut reg = mac_registry().lock().unwrap();
        let headless = match reg.get(config) {
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
        };
        if headless {
            return true;
        }
    }
    // ...or an interactive tunnel from a terminal tab (see `interactive_registry`).
    interactive_connected(config)
}

/// Every config whose tunnel is currently up.
///
/// A tunnel is a **machine-level** object — it owns the box's routing (and often
/// its DNS) for as long as it lives, no matter which project asked for it — so the
/// UI needs to be able to ask "what is up right now?" without going project by
/// project. This is that question. It also re-seats the frontend after a reload or
/// a renderer crash, where the tunnel outlives the window that started it.
///
/// Keys are snapshotted before probing: [`is_connected`] takes the registry lock
/// itself (and reaps dead entries under it), so holding it across the filter would
/// deadlock.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn active_configs() -> Vec<String> {
    let mut keys: Vec<String> = registry().lock().unwrap().keys().cloned().collect();
    keys.extend(interactive_registry().lock().unwrap().keys().cloned());
    #[cfg(target_os = "windows")]
    keys.extend(svc_registry().lock().unwrap().keys().cloned());
    keys.sort();
    keys.dedup();
    keys.into_iter().filter(|c| is_connected(c)).collect()
}

/// macOS analog of the above (its tunnels live in [`mac_registry`], keyed the same
/// way — by config path).
#[cfg(target_os = "macos")]
pub fn active_configs() -> Vec<String> {
    let mut keys: Vec<String> = mac_registry().lock().unwrap().keys().cloned().collect();
    keys.extend(interactive_registry().lock().unwrap().keys().cloned());
    keys.sort();
    keys.dedup();
    keys.into_iter().filter(|c| is_connected(c)).collect()
}

/// Bring up the OpenVPN tunnel for `config`, authenticating with `password` (and
/// `key_passphrase` for a config that *also* has an encrypted private key — see
/// [`write_credfiles`]). No-op (returns `Ok`) if already connected. Blocks until
/// OpenVPN reports the tunnel up, the process exits, or `CONNECT_TIMEOUT` elapses.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub fn connect(
    config: &str,
    username: Option<&str>,
    password: &str,
    key_passphrase: Option<&str>,
) -> Result<(), String> {
    connect_streaming(config, username, password, key_passphrase, |_| {})
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
    key_passphrase: Option<&str>,
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
    // Feed the secrets through whichever channels the config actually reads —
    // both, when it has an `auth-user-pass` account *and* an encrypted key.
    let (userpass_file, askpass_file) =
        write_credfiles(config, &stem, username, password, key_passphrase)?;
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(
        config,
        userpass_file.as_deref(),
        askpass_file.as_deref(),
        &pidfile,
    )?;
    // The credentials have been read once OpenVPN is up (or has failed); remove
    // whichever files we wrote, on every exit path.
    let remove_credfiles = || {
        for f in [userpass_file.as_deref(), askpass_file.as_deref()].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
    };

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
            remove_credfiles();
            return Err(format!("failed to launch pkexec openvpn: {e}"));
        }
    };

    // Stream stdout/stderr until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child, &on_line);
    remove_credfiles();

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
            // Say which secret was wrong; fall back to the raw handshake tail.
            Err(explain_openvpn_error(&msg).unwrap_or(msg))
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
    // An interactive tunnel has no child of ours — kill it by the pid it wrote.
    disconnect_interactive(config);
    let proc = registry().lock().unwrap().remove(config);
    let Some(mut proc) = proc else {
        return Ok(());
    };
    let _ = kill_pidfile(&proc.pidfile);
    let _ = proc.child.kill();
    let _ = proc.child.wait();
    let _ = std::fs::remove_file(&proc.pidfile);
    Ok(())
}

/// Interactive-tunnel teardown that reports whether the tunnel is down afterwards.
/// Mirrors [`disconnect_interactive`] but keeps the registry claim when the elevated
/// kill is refused, so a cancelled polkit prompt leaves the tunnel visible and
/// killable rather than forgotten-but-alive.
#[cfg(target_os = "linux")]
fn disconnect_interactive_checked(config: &str) -> bool {
    match interactive_state(config) {
        Interactive::Alive(pid) => {
            if !kill_root_pid_checked(pid) {
                return false;
            }
            if let Some(pidfile) = interactive_registry().lock().unwrap().remove(config) {
                let _ = std::fs::remove_file(&pidfile);
            }
            true
        }
        // Never authenticated — nothing root-owned to kill; drop the stale claim.
        Interactive::Pending => {
            interactive_registry().lock().unwrap().remove(config);
            true
        }
        Interactive::None => true,
    }
}

/// `pkexec kill -TERM` a root-owned pid, reporting whether it was delivered (vs. a
/// refused polkit prompt). The checked twin of [`kill_root_pid`].
#[cfg(target_os = "linux")]
fn kill_root_pid_checked(pid: i32) -> bool {
    Command::new("pkexec")
        .arg("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Like [`disconnect`], but reports whether the tunnel actually went down.
///
/// The app-close path needs this. `disconnect` is best-effort — it drops the
/// registry entry and ignores whether the elevated `pkexec kill` succeeded — which
/// is right for exit-time cleanup but wrong for a quit that must be *cancelled* when
/// the user dismisses the polkit prompt: the tunnel (and the machine-wide routing it
/// installed) is still up, and silently forgetting it would strand that routing with
/// nothing left to undo it. On failure the registry entry is preserved so the tunnel
/// stays visible (`active_configs`) and killable.
#[cfg(target_os = "linux")]
pub fn disconnect_checked(config: &str) -> Result<(), String> {
    // Interactive tunnel (terminal-started) first — its own elevated kill.
    if !disconnect_interactive_checked(config) {
        return Err("openvpn teardown was not authorized".into());
    }
    // Headless tunnel: peek the pidfile without removing, so a refused kill leaves
    // the entry in place.
    let pidfile = registry()
        .lock()
        .unwrap()
        .get(config)
        .map(|p| p.pidfile.clone());
    let Some(pidfile) = pidfile else {
        return Ok(());
    };
    if !kill_pidfile(&pidfile) {
        return Err("openvpn teardown was not authorized".into());
    }
    // TERM delivered — now reap our child and forget it.
    if let Some(mut proc) = registry().lock().unwrap().remove(config) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        let _ = std::fs::remove_file(&proc.pidfile);
    }
    Ok(())
}

/// Non-Linux: no polkit prompt to cancel (Windows brings tunnels up through the
/// unelevated interactive service; macOS raises an `osascript` admin prompt whose
/// cancellation is a smaller, separate gap), so the app-close path falls back to the
/// best-effort teardown.
#[cfg(not(target_os = "linux"))]
pub fn disconnect_checked(config: &str) -> Result<(), String> {
    disconnect(config)
}

/// `pkexec kill` the pid recorded in `pidfile` (the root OpenVPN process). Returns
/// whether the tunnel can be considered down afterwards: `true` if the TERM was
/// delivered (or there was no pid to kill), `false` if the elevated kill was refused
/// — a cancelled polkit prompt, which leaves the tunnel (and the machine's routing)
/// up. Best-effort callers ignore the bool; the app-close path (`disconnect_checked`)
/// reads it to decide whether the quit can proceed.
#[cfg(target_os = "linux")]
fn kill_pidfile(pidfile: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(pidfile) else {
        return true;
    };
    let pid = contents.trim();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    Command::new("pkexec")
        .arg("kill")
        .arg("-TERM")
        .arg(pid)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Tear down every live tunnel. Used at app exit; errors are swallowed so
/// shutdown never blocks. Shared by Linux/Windows (each dispatches to its own
/// platform [`disconnect`]).
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn disconnect_all() {
    // Interactive tunnels included: they are the ones that used to survive the app
    // and leave the machine's routing rewritten with nothing left to undo it.
    let keys: Vec<String> = {
        let reg = registry().lock().unwrap();
        let interactive = interactive_registry().lock().unwrap();
        #[cfg(target_os = "windows")]
        let svc = svc_registry().lock().unwrap();
        let keys = reg.keys().chain(interactive.keys());
        #[cfg(target_os = "windows")]
        let keys = keys.chain(svc.keys());
        keys.cloned().collect()
    };
    for k in keys {
        let _ = disconnect(&k);
    }
}

/// The **checked twin of [`disconnect_all`]** used on the app-close path. It tears
/// down the *same* set of registered tunnels — every key `disconnect_all` would touch,
/// unfiltered by liveness — so that after it succeeds there is nothing left for the
/// exit-time `disconnect_all` to kill (and therefore no polkit prompt raised after the
/// window is already gone). But it stops at the first refused teardown and reports it,
/// so a dismissed prompt aborts the quit instead of quitting with the machine's routing
/// still rewritten. Enumerating the registries directly — rather than the frontend
/// filtering `active_configs` — is the point: `active_configs` hides a tunnel whose
/// liveness probe reads false, which is exactly a tunnel `disconnect_all` would still
/// prompt to kill.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn disconnect_all_checked() -> Result<(), String> {
    let keys: Vec<String> = {
        let reg = registry().lock().unwrap();
        let interactive = interactive_registry().lock().unwrap();
        #[cfg(target_os = "windows")]
        let svc = svc_registry().lock().unwrap();
        let keys = reg.keys().chain(interactive.keys());
        #[cfg(target_os = "windows")]
        let keys = keys.chain(svc.keys());
        keys.cloned().collect()
    };
    for k in keys {
        disconnect_checked(&k)?;
    }
    Ok(())
}

// --- Windows: interactive-service-first tunnel management --------------------
//
// Windows has no `pkexec`/polkit, but it has something better suited: the
// **OpenVPN Interactive Service** (`OpenVPNServiceInteractive`, installed and
// auto-started by the community installer), which exists precisely so an
// UNELEVATED client can bring a tunnel up. The client sends one startup
// message over `\\.\pipe\openvpn\service` — three NUL-terminated UTF-16LE
// strings: working directory, openvpn command line, stdin data — and the
// SYSTEM service spawns `openvpn.exe` with the *client's* token, appending a
// `--msg-channel` through which the privileged work (TUN adapter open, routes,
// DNS) is done by the service itself. It replies `0x%08x\n%ls\n%ls`: code 0 +
// the spawned pid on success, an error code + text otherwise. The service also
// ties the tunnel to the client: when the pipe drops or the process exits, it
// reverts the routes/DNS it applied (its undo lists) — a service-started
// tunnel can never outlive Eldrun with the machine's routing still changed.
//
// `connect_streaming` therefore tries the service FIRST. The service owns the
// spawned process's stdio, so the handshake is followed by tailing a `--log`
// file (`wait_for_ready_logfile`, shared with macOS). Authorization caveat: a
// user who is neither elevated nor a member of the "OpenVPN Administrators"
// local group may only use configs inside the machine config directory —
// Eldrun's stored configs live under %APPDATA%, so [`explain_service_refusal`]
// turns that refusal into the one-time `net localgroup` fix.
//
// Only when the service pipe does not exist (service not installed / not
// running) does the old path run: spawn `openvpn.exe` directly with the same
// `--askpass`-file credential flow as Linux, parsing stdout for the ready
// marker — which only works when Eldrun itself is elevated (creating the
// TAP/Wintun adapter needs Administrator rights), and the error messages say so.

/// Quote one argument for a Windows command line so `CommandLineToArgvW` —
/// which the interactive service uses to parse the options string — reads it
/// back as a single argv item. MSVCRT rules: backslashes are literal except in
/// front of a `"`, where each doubles and the quote itself is escaped; trailing
/// backslashes double so they can't eat the closing quote. Compiled cfg-free
/// for Linux-run unit tests.
pub fn win_cmdline_quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '"')) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(backslashes));
                out.push(ch);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

/// Join an argv into the single options string the service startup message
/// carries (the service re-parses it with `CommandLineToArgvW`).
pub fn svc_options_string(args: &[String]) -> String {
    args.iter()
        .map(|a| win_cmdline_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Encode the interactive service's startup message: three NUL-terminated
/// UTF-16LE strings back to back — working directory, openvpn command line
/// (WITHOUT the program name; the service prepends its registered exe), and
/// stdin data (empty here: credentials travel in files, as on every other
/// platform). Compiled cfg-free for Linux-run unit tests.
pub fn svc_startup_message(workdir: &str, options: &str, stdin_data: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity((workdir.len() + options.len() + stdin_data.len() + 3) * 2);
    for s in [workdir, options, stdin_data] {
        for unit in s.encode_utf16().chain(std::iter::once(0)) {
            msg.extend_from_slice(&unit.to_le_bytes());
        }
    }
    msg
}

/// A decoded reply from the interactive service: `0x%08x\n%ls\n%ls` in
/// UTF-16LE. `code` 0 is success, with `detail` carrying the spawned
/// `openvpn.exe` pid (also `0x%08x`); otherwise `detail`/`message` are the
/// failing function and its error text.
pub struct SvcResponse {
    pub code: u32,
    pub detail: String,
    pub message: String,
}

/// Parse a service reply. `None` when the bytes aren't the expected shape —
/// the caller reports an unrecognized reply rather than inventing a verdict.
pub fn svc_parse_response(bytes: &[u8]) -> Option<SvcResponse> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    let text = text.trim_end_matches('\0');
    let mut lines = text.splitn(3, '\n');
    let code = lines.next()?.trim();
    let code = u32::from_str_radix(code.trim_start_matches("0x"), 16).ok()?;
    Some(SvcResponse {
        code,
        detail: lines.next().unwrap_or("").trim().to_string(),
        message: lines.next().unwrap_or("").trim().to_string(),
    })
}

/// The pid the service reports on success (`code` 0, pid in `detail`).
pub fn svc_response_pid(resp: &SvcResponse) -> Option<u32> {
    if resp.code != 0 {
        return None;
    }
    u32::from_str_radix(resp.detail.trim_start_matches("0x"), 16).ok()
}

/// Turn a service refusal into an actionable message. The refusal a non-admin
/// actually hits is the authorization check (Eldrun's stored configs are not
/// inside the machine config directory), and the fix is the one-time group
/// membership the official OpenVPN GUI also sets up — so say exactly that,
/// keeping the raw service text for everything else. The group's member list
/// is re-read per connect, so no re-logon is needed after adding.
pub fn explain_service_refusal(resp: &SvcResponse) -> String {
    let raw = match (resp.message.is_empty(), resp.detail.is_empty()) {
        (false, false) => format!("{} ({})", resp.message, resp.detail),
        (false, true) => resp.message.clone(),
        (true, false) => resp.detail.clone(),
        (true, true) => format!("error 0x{:08x}", resp.code),
    };
    format!(
        "the OpenVPN Interactive Service refused to start the tunnel: {raw} — if this is \
         an authorization error, add your account to the \"OpenVPN Administrators\" group \
         once (from an elevated prompt: net localgroup \"OpenVPN Administrators\" \
         \"%USERNAME%\" /add) and reconnect"
    )
}

/// The interactive service's control pipe (default instance name).
#[cfg(target_os = "windows")]
const SVC_PIPE: &str = r"\\.\pipe\openvpn\service";

/// How long the service gets to answer the startup message. It only has to
/// validate and `CreateProcess` — the handshake itself is tailed separately.
#[cfg(target_os = "windows")]
const SVC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

/// A tunnel brought up through the interactive service: the control pipe
/// (dropping it is the teardown signal — see [`disconnect`]), the spawned
/// `openvpn.exe` pid, and the runtime files to reap.
#[cfg(target_os = "windows")]
struct SvcVpn {
    pipe: std::fs::File,
    pid: u32,
    pidfile: PathBuf,
    logfile: PathBuf,
}

/// Registry of service-started tunnels, keyed by config path (the Windows
/// third registry, alongside [`registry`] and [`interactive_registry`]).
#[cfg(target_os = "windows")]
fn svc_registry() -> &'static Mutex<HashMap<String, SvcVpn>> {
    static REG: OnceLock<Mutex<HashMap<String, SvcVpn>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open the service control pipe. `None` = no interactive service on this
/// machine (pipe absent) — the caller falls back to the direct spawn. A busy
/// pipe (another client connecting this instant) is retried briefly: the
/// service re-creates its listening instance right after each accept.
#[cfg(target_os = "windows")]
fn svc_open_pipe() -> Option<std::fs::File> {
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..5 {
        match std::fs::OpenOptions::new().read(true).write(true).open(SVC_PIPE) {
            Ok(pipe) => return Some(pipe),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(_) => return None,
        }
    }
    None
}

/// Bytes waiting on `pipe`, or `None` when the service end is closed. The
/// service closes the pipe when the `openvpn.exe` it spawned for us exits, so
/// `None` doubles as "tunnel over".
#[cfg(target_os = "windows")]
fn pipe_avail(pipe: &std::fs::File) -> Option<usize> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::PeekNamedPipe;
    let mut avail = 0u32;
    unsafe {
        PeekNamedPipe(
            HANDLE(pipe.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut avail),
            None,
        )
    }
    .ok()
    .map(|()| avail as usize)
}

/// Liveness probe for a service tunnel, draining (and discarding) any pending
/// service chatter so the pipe buffer can never fill up and stall the service.
#[cfg(target_os = "windows")]
fn pipe_alive(pipe: &std::fs::File) -> bool {
    use std::io::Read;
    match pipe_avail(pipe) {
        None => false,
        Some(0) => true,
        Some(n) => {
            let mut scratch = vec![0u8; n];
            let mut reader: &std::fs::File = pipe;
            let _ = reader.read(&mut scratch);
            true
        }
    }
}

/// Read the service's reply to the startup message: poll for bytes (a named
/// pipe read would block indefinitely), then take everything available —
/// message-read mode was set at connect, so that is exactly one reply. `None`
/// on timeout or a broken pipe.
#[cfg(target_os = "windows")]
fn svc_read_response(pipe: &mut std::fs::File, timeout: Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    let start = Instant::now();
    loop {
        let avail = pipe_avail(pipe)?;
        if avail > 0 {
            let mut buf = vec![0u8; avail];
            let n = pipe.read(&mut buf).ok()?;
            buf.truncate(n);
            return Some(buf);
        }
        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Outcome of a service-first connect: `Done` is authoritative — the service
/// was there, and its verdict (up, or why not) is the connect's. Only
/// `Unavailable` (no pipe: service not installed / not running) falls back to
/// the direct spawn.
#[cfg(target_os = "windows")]
enum SvcAttempt {
    Done(Result<(), String>),
    Unavailable,
}

/// Ask the interactive service to bring the tunnel up (see the section comment
/// for the protocol). `args` is the argv [`openvpn_args`] built; the caller
/// still owns the credential files' lifetime.
#[cfg(target_os = "windows")]
fn svc_connect_streaming(
    config: &str,
    stem: &str,
    args: &[String],
    pidfile: &Path,
    on_line: &impl Fn(&str),
) -> SvcAttempt {
    let Some(mut pipe) = svc_open_pipe() else {
        return SvcAttempt::Unavailable;
    };
    // Message-read mode, so each service reply comes out of `read` whole.
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_READMODE_MESSAGE};
        let mode = PIPE_READMODE_MESSAGE;
        let _ = unsafe {
            SetNamedPipeHandleState(HANDLE(pipe.as_raw_handle()), Some(&mode), None, None)
        };
    }

    // The service owns the spawned process's stdio, so the handshake is tailed
    // from a logfile instead (the macOS pattern). Start clean: a stale logfile
    // would satisfy the tail spuriously.
    let logfile = runtime_dir().join(format!("{stem}.svc.log"));
    let _ = std::fs::remove_file(&logfile);
    let mut svc_args = args.to_vec();
    svc_args.push("--log".to_string());
    svc_args.push(logfile.to_string_lossy().into_owned());

    // Working dir = the config's directory, so relative paths inside the config
    // (ca/cert/key) resolve the same as for a direct spawn.
    let workdir = Path::new(config)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let msg = svc_startup_message(&workdir, &svc_options_string(&svc_args), "");
    if pipe.write_all(&msg).is_err() {
        return SvcAttempt::Done(Err(
            "could not send the connect request to the OpenVPN Interactive Service".to_string(),
        ));
    }

    let resp = match svc_read_response(&mut pipe, SVC_RESPONSE_TIMEOUT) {
        Some(bytes) => match svc_parse_response(&bytes) {
            Some(resp) => resp,
            None => {
                return SvcAttempt::Done(Err(
                    "unrecognized reply from the OpenVPN Interactive Service".to_string(),
                ));
            }
        },
        None => {
            return SvcAttempt::Done(Err(
                "the OpenVPN Interactive Service did not answer the connect request".to_string(),
            ));
        }
    };
    let Some(pid) = svc_response_pid(&resp) else {
        return SvcAttempt::Done(Err(explain_service_refusal(&resp)));
    };
    on_line(&format!(
        "OpenVPN Interactive Service started openvpn.exe (pid {pid})"
    ));

    let ready = wait_for_ready_logfile(
        &logfile,
        CONNECT_TIMEOUT,
        Duration::from_millis(300),
        || pipe_alive(&pipe),
        |line| on_line(line),
    );
    match ready {
        Ok(()) => {
            svc_registry().lock().unwrap().insert(
                config.to_string(),
                SvcVpn {
                    pipe,
                    pid,
                    pidfile: pidfile.to_path_buf(),
                    logfile,
                },
            );
            SvcAttempt::Done(Ok(()))
        }
        Err(msg) => {
            // Kill the half-up tunnel; the service sees the exit, reverts any
            // routes/DNS it applied (its undo lists), and closes the pipe.
            kill_root_pid(pid as i32);
            let _ = std::fs::remove_file(&logfile);
            SvcAttempt::Done(Err(explain_openvpn_error(&msg).unwrap_or(msg)))
        }
    }
}

/// Whether the service-started tunnel for `config` is still up; a dead entry
/// (service closed the pipe: its openvpn exited) is reaped with its files.
#[cfg(target_os = "windows")]
fn svc_connected(config: &str) -> bool {
    let mut reg = svc_registry().lock().unwrap();
    match reg.get(config) {
        Some(svc) if pipe_alive(&svc.pipe) => true,
        Some(_) => {
            if let Some(dead) = reg.remove(config) {
                let _ = std::fs::remove_file(&dead.pidfile);
                let _ = std::fs::remove_file(&dead.logfile);
            }
            false
        }
        None => false,
    }
}

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
/// tunnel comes up, so the caller can stream the live handshake into a read-only
/// log. Interactive-service-first (see the section comment); the direct spawn
/// below is only the fallback for a machine without the service.
#[cfg(target_os = "windows")]
pub fn connect_streaming(
    config: &str,
    username: Option<&str>,
    password: &str,
    key_passphrase: Option<&str>,
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

    let stem = safe_stem(config);
    // Feed the secrets through whichever channels the config actually reads —
    // both, when it has an `auth-user-pass` account *and* an encrypted key.
    let (userpass_file, askpass_file) =
        write_credfiles(config, &stem, username, password, key_passphrase)?;
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let args = openvpn_args(
        config,
        userpass_file.as_deref(),
        askpass_file.as_deref(),
        &pidfile,
    )?;
    let remove_credfiles = || {
        for f in [userpass_file.as_deref(), askpass_file.as_deref()].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
    };

    // Service first: its verdict is final. Only a missing service (no pipe)
    // falls through to the direct spawn, which needs an elevated Eldrun.
    match svc_connect_streaming(config, &stem, &args, &pidfile, &on_line) {
        SvcAttempt::Done(result) => {
            remove_credfiles();
            return result;
        }
        SvcAttempt::Unavailable => {}
    }

    let Some(exe) = resolve_openvpn() else {
        remove_credfiles();
        return Err(OPENVPN_MISSING.to_string());
    };

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
            remove_credfiles();
            return Err(format!(
                "failed to launch openvpn.exe: {e} — the OpenVPN Interactive Service is not \
                 running, and a direct spawn needs Eldrun itself to run as Administrator"
            ));
        }
    };

    // Stream stdout/stderr until the ready marker, EOF, or timeout.
    let ready = wait_for_ready(&mut child, &on_line);
    remove_credfiles();

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
            // A recognized credential error stands on its own — appending the
            // adapter/Administrator hint to "wrong password" would just mislead.
            Err(explain_openvpn_error(&msg).unwrap_or_else(|| {
                format!(
                    "{msg} — if this is a permissions/adapter error, start the OpenVPN \
                     Interactive Service (OpenVPNServiceInteractive) so Eldrun can connect \
                     unelevated, run Eldrun as Administrator, or (re)install the OpenVPN \
                     TAP/Wintun driver"
                )
            }))
        }
    }
}

/// Tear down the tunnel for `config` if it is up. Best-effort, three flavours:
/// an interactive tunnel (typed into a terminal tab) by the pid it wrote; a
/// service-started tunnel by user-level `taskkill` (its `openvpn.exe` runs with
/// THIS user's token) plus dropping the control pipe — the service sees the
/// exit, reverts the routes/DNS it applied, and closes its end; a direct-spawn
/// child via `taskkill /T` on its handle. A missing/already-dead tunnel is
/// treated as success.
#[cfg(target_os = "windows")]
pub fn disconnect(config: &str) -> Result<(), String> {
    // An interactive tunnel has no child of ours — kill it by the pid it wrote
    // (this was missing on Windows; Linux/macOS have always done it).
    disconnect_interactive(config);
    let svc = svc_registry().lock().unwrap().remove(config);
    if let Some(svc) = svc {
        kill_root_pid(svc.pid as i32);
        drop(svc.pipe);
        let _ = std::fs::remove_file(&svc.pidfile);
        let _ = std::fs::remove_file(&svc.logfile);
    }
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
    key_passphrase: Option<&str>,
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
    // Feed the secrets through whichever channels the config actually reads —
    // both, when it has an `auth-user-pass` account *and* an encrypted key.
    let (userpass_file, askpass_file) =
        write_credfiles(config, &stem, username, password, key_passphrase)?;
    let remove_credfiles = || {
        for f in [userpass_file.as_deref(), askpass_file.as_deref()].into_iter().flatten() {
            let _ = std::fs::remove_file(f);
        }
    };
    let pidfile = runtime_dir().join(format!("{stem}.pid"));
    let logfile = runtime_dir().join(format!("{stem}.log"));
    // Stale files from a previous run would satisfy the tail/liveness checks
    // spuriously — start clean.
    let _ = std::fs::remove_file(&pidfile);
    let _ = std::fs::remove_file(&logfile);

    let mut args = openvpn_args(
        config,
        userpass_file.as_deref(),
        askpass_file.as_deref(),
        &pidfile,
    )?;
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
            remove_credfiles();
            return Err(format!("failed to run osascript: {e}"));
        }
    };
    if !output.status.success() {
        remove_credfiles();
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
    // The credentials have been read by now; remove them regardless of outcome.
    remove_credfiles();

    match ready {
        Ok(()) => {
            mac_registry()
                .lock()
                .unwrap()
                .insert(config.to_string(), MacVpn { pidfile, logfile });
            Ok(())
        }
        // Say which secret was wrong; fall back to the raw log tail.
        Err(msg) => Err(explain_openvpn_error(&msg).unwrap_or(msg)),
    }
}

/// Tear down the tunnel for `config` if it is up: an admin-prompted
/// `kill -TERM <pid>` (the daemon is root — a plain kill gets EPERM). The
/// second prompt per disconnect is accepted for v1. A missing/already-dead
/// tunnel is treated as success.
#[cfg(target_os = "macos")]
pub fn disconnect(config: &str) -> Result<(), String> {
    // An interactive tunnel has no entry in `mac_registry` — kill it by its pid.
    disconnect_interactive(config);
    let proc = mac_registry().lock().unwrap().remove(config);
    let Some(proc) = proc else {
        return Ok(());
    };
    if let Some(pid) = pidfile_pid(&proc.pidfile) {
        if pid_alive(pid) {
            kill_root_pid(pid);
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
    // Interactive tunnels included — see the Linux/Windows twin.
    let keys: Vec<String> = {
        let reg = mac_registry().lock().unwrap();
        let interactive = interactive_registry().lock().unwrap();
        reg.keys().chain(interactive.keys()).cloned().collect()
    };
    for k in keys {
        let _ = disconnect(&k);
    }
}

/// macOS twin of [`disconnect_all_checked`] (its tunnels live in [`mac_registry`]).
#[cfg(target_os = "macos")]
pub fn disconnect_all_checked() -> Result<(), String> {
    let keys: Vec<String> = {
        let reg = mac_registry().lock().unwrap();
        let interactive = interactive_registry().lock().unwrap();
        reg.keys().chain(interactive.keys()).cloned().collect()
    };
    for k in keys {
        disconnect_checked(&k)?;
    }
    Ok(())
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

    /// A config nobody connected is not reported as up. The header's VPN indicator
    /// is driven by this, and a false positive parks a "your machine is being
    /// rerouted" badge over a machine that isn't.
    ///
    /// Asserts about *this* config rather than global emptiness: the registries are
    /// process-global and the tests below register live entries in parallel.
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    #[test]
    fn unconnected_config_is_never_reported_up() {
        let cfg = "/store/never-connected.ovpn";
        assert!(!is_connected(cfg));
        assert!(!active_configs().contains(&cfg.to_string()));
    }

    /// Drop a config from both the interactive registry and the disk, without going
    /// through `disconnect_interactive` — which would try to `kill` the pid, and in
    /// these tests that pid is *our own process*.
    fn forget_interactive(config: &str) {
        if let Some(pidfile) = interactive_registry().lock().unwrap().remove(config) {
            let _ = std::fs::remove_file(pidfile);
        }
    }

    /// The interactive command must carry a `--writepid` Eldrun chose, and claim it.
    /// This is the whole fix for #83: without the pid, a root tunnel started in a
    /// terminal tab is invisible to `is_connected`/`active_configs` and unkillable by
    /// `disconnect`/`disconnect_all` — it outlives the app still owning the routing.
    #[cfg(target_os = "linux")]
    #[test]
    fn interactive_command_claims_a_pidfile() {
        let cfg = "/store/test-claims.ovpn";
        forget_interactive(cfg);

        let cmd = interactive_connect_command(cfg).unwrap();
        let pidfile = interactive_pidfile(cfg);

        assert!(cmd.contains("--writepid"));
        assert!(cmd.contains(&shell_quote(&pidfile.to_string_lossy())));
        // Claimed, but OpenVPN hasn't written a pid yet — the user is still at the
        // polkit prompt. Pending is NOT dead: reaping here would forget a tunnel in
        // the seconds before it comes up.
        assert_eq!(interactive_state(cfg), Interactive::Pending);
        assert!(!is_connected(cfg));

        forget_interactive(cfg);
    }

    /// Once the pid is on disk and alive, the tunnel is up — visible to everything
    /// the frontend asks (`openvpn_status`, `openvpn_active`).
    #[cfg(unix)]
    #[test]
    fn interactive_tunnel_with_a_live_pid_is_up() {
        let cfg = "/store/test-live.ovpn";
        forget_interactive(cfg);
        let _ = interactive_connect_command(cfg).unwrap();

        // Our own pid is, definitionally, alive.
        let me = std::process::id();
        std::fs::write(interactive_pidfile(cfg), format!("{me}\n")).unwrap();

        assert_eq!(interactive_state(cfg), Interactive::Alive(me as i32));
        assert!(is_connected(cfg));
        assert!(active_configs().contains(&cfg.to_string()));

        forget_interactive(cfg);
    }

    /// A tunnel whose process is gone (the user closed its terminal) is reaped, not
    /// reported as up — and its stale pidfile is cleaned up so the next connect
    /// can't mistake it for a live one.
    #[cfg(unix)]
    #[test]
    fn interactive_tunnel_with_a_dead_pid_is_reaped() {
        let cfg = "/store/test-dead.ovpn";
        forget_interactive(cfg);
        let _ = interactive_connect_command(cfg).unwrap();

        // A pid that is *certainly* dead: spawn a process and reap it.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let pidfile = interactive_pidfile(cfg);
        std::fs::write(&pidfile, format!("{dead}\n")).unwrap();

        assert_eq!(interactive_state(cfg), Interactive::None);
        assert!(!is_connected(cfg));
        // Reaped from both the registry and the disk.
        assert!(!interactive_registry().lock().unwrap().contains_key(cfg));
        assert!(!pidfile.exists());
    }

    /// Arming twice must not resurrect a stale pidfile: a leftover from a previous
    /// run would otherwise read as a live tunnel the moment the config is armed.
    #[cfg(unix)]
    #[test]
    fn arming_clears_a_stale_pidfile() {
        let cfg = "/store/test-stale.ovpn";
        forget_interactive(cfg);
        let pidfile = interactive_pidfile(cfg);
        let _ = std::fs::create_dir_all(runtime_dir());
        std::fs::write(&pidfile, format!("{}\n", std::process::id())).unwrap();

        let _ = interactive_connect_command(cfg).unwrap();

        assert!(!pidfile.exists());
        assert_eq!(interactive_state(cfg), Interactive::Pending);

        forget_interactive(cfg);
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
    fn win_cmdline_quote_shapes() {
        // No metacharacters → unquoted, byte for byte (backslashes are literal).
        assert_eq!(win_cmdline_quote("plain"), "plain");
        assert_eq!(win_cmdline_quote(r"C:\dir\file.ovpn"), r"C:\dir\file.ovpn");
        assert_eq!(win_cmdline_quote(r"end\"), r"end\");
        // Spaces / emptiness force quotes.
        assert_eq!(win_cmdline_quote("has space"), "\"has space\"");
        assert_eq!(win_cmdline_quote(""), "\"\"");
        // A quote inside: preceding backslashes double and the quote is escaped.
        assert_eq!(win_cmdline_quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(win_cmdline_quote(r#"a\"b"#), r#""a\\\"b""#);
        // Trailing backslashes double so they can't eat the closing quote.
        assert_eq!(win_cmdline_quote(r"e nd\"), "\"e nd\\\\\"");
        // The options string is the quoted args joined by single spaces.
        assert_eq!(
            svc_options_string(&["--config".to_string(), r"C:\a b\c.ovpn".to_string()]),
            r#"--config "C:\a b\c.ovpn""#
        );
    }

    #[test]
    fn svc_startup_message_is_three_nul_terminated_utf16_strings() {
        // Non-ASCII on purpose: the message is UTF-16LE, not the ANSI codepage.
        let msg = svc_startup_message("C:\\wä", "--config a.ovpn", "");
        assert_eq!(msg.len() % 2, 0);
        let units: Vec<u16> = msg
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // Exactly three NULs, one terminating each string (the last is empty).
        assert_eq!(units.iter().filter(|&&u| u == 0).count(), 3);
        assert_eq!(units.last(), Some(&0));
        let parts: Vec<String> = units
            .split(|&u| u == 0)
            .map(|p| String::from_utf16(p).unwrap())
            .collect();
        assert_eq!(parts, ["C:\\wä", "--config a.ovpn", "", ""]);
    }

    #[test]
    fn svc_parse_response_reads_pid_and_refusals() {
        let enc = |s: &str| -> Vec<u8> {
            s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
        };
        // Success: code 0, pid on line 2 (both `0x%08x`), description on line 3.
        let ok = svc_parse_response(&enc("0x00000000\n0x00001a2b\nProcess ID")).unwrap();
        assert_eq!(ok.code, 0);
        assert_eq!(svc_response_pid(&ok), Some(0x1a2b));
        // Refusal: nonzero code — never a pid, and the explanation must carry
        // both the service's own text and the actionable one-time fix.
        let err = svc_parse_response(&enc(
            "0x20000001\nValidateOptions\nconfig is not in the allowed location",
        ))
        .unwrap();
        assert_eq!(err.code, 0x2000_0001);
        assert_eq!(svc_response_pid(&err), None);
        let msg = explain_service_refusal(&err);
        assert!(msg.contains("config is not in the allowed location"), "{msg}");
        assert!(msg.contains("OpenVPN Administrators"), "{msg}");
        assert!(msg.contains("net localgroup"), "{msg}");
        // Garbage is None, not a fabricated verdict.
        assert!(svc_parse_response(&enc("not-a-code\nx\ny")).is_none());
        assert!(svc_parse_response(&[]).is_none());
    }

    #[test]
    fn openvpn_args_askpass_shape() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            None,
            Some(Path::new("/run/eldrun/openvpn/x.pass")),
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

    /// Readiness is detected by scanning OpenVPN's output for the
    /// "Initialization Sequence Completed" marker, so the argv must pin the
    /// logging knobs a config could otherwise sabotage it with: a `mute 16`
    /// (as shipped in real configs) suppresses the marker — it follows a burst
    /// of same-category route-addition lines — and Eldrun then reported
    /// "timed out" on, and killed, a tunnel that was actually up. `verb 0`
    /// hides the marker outright. Both are overridden because command-line
    /// options are applied after `--config`.
    #[test]
    fn openvpn_args_pin_logging_so_the_ready_marker_survives() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            None,
            Some(Path::new("/run/eldrun/openvpn/x.pass")),
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        let vi = args.iter().position(|a| a == "--verb").unwrap();
        assert_eq!(args[vi + 1], "3");
        let mi = args.iter().position(|a| a == "--mute").unwrap();
        assert_eq!(args[mi + 1], "0");
        // Overrides only win from *after* the config file's own directives.
        let ci = args.iter().position(|a| a == "--config").unwrap();
        assert!(vi > ci && mi > ci);
    }

    #[test]
    fn openvpn_args_userpass_uses_auth_user_pass() {
        let args = openvpn_args(
            "/home/u/work.ovpn",
            Some(Path::new("/run/eldrun/openvpn/x.auth")),
            None,
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        let ai = args.iter().position(|a| a == "--auth-user-pass").unwrap();
        assert_eq!(args[ai + 1], "/run/eldrun/openvpn/x.auth");
        assert!(!args.iter().any(|a| a == "--askpass"));
    }

    #[test]
    fn openvpn_args_carries_both_channels_at_once() {
        // The regression this whole change exists for: a config with an
        // `auth-user-pass` account AND an encrypted key needs BOTH flags. Feeding
        // only one leaves OpenVPN's other prompt unanswered and the handshake
        // hangs until it times out.
        let args = openvpn_args(
            "/home/u/work.ovpn",
            Some(Path::new("/run/eldrun/openvpn/x.auth")),
            Some(Path::new("/run/eldrun/openvpn/x.pass")),
            Path::new("/run/eldrun/openvpn/x.pid"),
        )
        .unwrap();
        let ui = args.iter().position(|a| a == "--auth-user-pass").unwrap();
        assert_eq!(args[ui + 1], "/run/eldrun/openvpn/x.auth");
        let ai = args.iter().position(|a| a == "--askpass").unwrap();
        assert_eq!(args[ai + 1], "/run/eldrun/openvpn/x.pass");
        // …and the tail options survive both being present.
        let pi = args.iter().position(|a| a == "--writepid").unwrap();
        assert_eq!(args[pi + 1], "/run/eldrun/openvpn/x.pid");
        assert!(args.iter().any(|a| a == "--auth-nocache"));
    }

    #[test]
    fn openvpn_args_rejects_leading_dash_config() {
        assert!(openvpn_args("-evil", None, Some(Path::new("/a")), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_control_chars() {
        assert!(openvpn_args("/a\nb.ovpn", None, Some(Path::new("/a")), Path::new("/b")).is_err());
    }

    #[test]
    fn openvpn_args_rejects_empty_config() {
        assert!(openvpn_args("   ", None, Some(Path::new("/a")), Path::new("/b")).is_err());
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
    fn explain_openvpn_error_names_which_secret_was_wrong() {
        // The whole point: a rejected account and a bad key passphrase are two
        // different fields, and OpenVPN reports them with two different lines.
        let auth = explain_openvpn_error(
            "AUTH: Received control message: AUTH_FAILED; SIGTERM[soft,auth-failure] received",
        )
        .unwrap();
        assert!(auth.contains("username and password"), "{auth}");

        let key = explain_openvpn_error(
            "Cryptographic API error; OpenSSL: error:0308010C:digital envelope routines; \
             Private Key Password verification failed",
        )
        .unwrap();
        assert!(key.contains("private-key passphrase"), "{key}");
        // …and they must never be confused for each other.
        assert!(!key.contains("username"), "{key}");
        assert!(!auth.contains("private-key"), "{auth}");

        // OpenSSL words a bad decrypt several ways; all mean the same field.
        for line in ["OpenSSL: error:0700006C:bad decrypt", "Decryption error"] {
            assert!(
                explain_openvpn_error(line).unwrap().contains("private-key passphrase"),
                "{line}"
            );
        }
    }

    #[test]
    fn explain_openvpn_error_separates_non_credential_failures() {
        // Things no retyped password can fix must not be reported as bad creds.
        let declined = explain_openvpn_error("administrator authorization was declined").unwrap();
        assert!(declined.contains("Elevation"), "{declined}");

        let dns = explain_openvpn_error("RESOLVE: Cannot resolve host address: vpn.x").unwrap();
        assert!(dns.contains("resolve"), "{dns}");

        let tls = explain_openvpn_error("TLS Error: TLS key negotiation failed to occur").unwrap();
        assert!(tls.contains("TLS handshake"), "{tls}");

        let tun = explain_openvpn_error("ERROR: Cannot open TUN/TAP dev /dev/net/tun").unwrap();
        assert!(tun.contains("tunnel device"), "{tun}");
    }

    #[test]
    fn explain_openvpn_error_passes_unknown_output_through() {
        // Unrecognized output must fall back to the raw tail — replacing a specific
        // error with a vague guess is worse than showing the real thing.
        assert_eq!(explain_openvpn_error("Initialization Sequence In Progress"), None);
        assert_eq!(explain_openvpn_error(""), None);
    }

    #[test]
    fn config_requires_key_passphrase_detects_encrypted_keys() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("eldrun-ovpn-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, body: &str| {
            let p = dir.join(name);
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(body.as_bytes()).unwrap();
            p
        };

        // Inline encrypted key (traditional PEM) → needs a passphrase.
        let inline = write(
            "inline.ovpn",
            "client\nauth-user-pass\n<key>\n-----BEGIN RSA PRIVATE KEY-----\n\
             Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,ABC\n\nbase64==\n\
             -----END RSA PRIVATE KEY-----\n</key>\n",
        );
        assert!(config_requires_key_passphrase(inline.to_str().unwrap()));
        // …and it is orthogonal to the account channel: this config needs both.
        assert!(config_requires_userpass(inline.to_str().unwrap()));

        // Inline PKCS#8 encrypted key → needs a passphrase.
        let pkcs8 = write(
            "pkcs8.ovpn",
            "client\n<key>\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nb64==\n\
             -----END ENCRYPTED PRIVATE KEY-----\n</key>\n",
        );
        assert!(config_requires_key_passphrase(pkcs8.to_str().unwrap()));

        // Inline *unencrypted* key → does not.
        let plain = write(
            "plain.ovpn",
            "client\n<key>\n-----BEGIN PRIVATE KEY-----\nb64==\n-----END PRIVATE KEY-----\n</key>\n",
        );
        assert!(!config_requires_key_passphrase(plain.to_str().unwrap()));

        // Out-of-line key, resolved relative to the config's own directory.
        write("enc.key", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nb64==\n");
        let extenc = write("extenc.ovpn", "client\ncert a.crt\nkey enc.key\n");
        assert!(config_requires_key_passphrase(extenc.to_str().unwrap()));

        write("plain.key", "-----BEGIN PRIVATE KEY-----\nb64==\n");
        let extplain = write("extplain.ovpn", "client\ncert a.crt\nkey plain.key\n");
        assert!(!config_requires_key_passphrase(extplain.to_str().unwrap()));

        // A key file we can't read → false (best-effort, like the userpass twin).
        let missingkey = write("missingkey.ovpn", "client\nkey nope.key\n");
        assert!(!config_requires_key_passphrase(missingkey.to_str().unwrap()));

        // `pkcs12` bundles are treated as passphrase-protected (DER — can't sniff).
        let p12 = write("p12.ovpn", "client\npkcs12 bundle.p12\n");
        assert!(config_requires_key_passphrase(p12.to_str().unwrap()));

        // A config that supplies its own `askpass <file>` needs nothing from us…
        let ownaskpass = write(
            "ownaskpass.ovpn",
            "client\naskpass /etc/openvpn/pass.txt\n<key>\n\
             -----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n</key>\n",
        );
        assert!(!config_requires_key_passphrase(ownaskpass.to_str().unwrap()));
        // …but a *bare* `askpass` means "prompt on the console" — we must answer it.
        let bareaskpass = write(
            "bareaskpass.ovpn",
            "client\naskpass\n<key>\n-----BEGIN RSA PRIVATE KEY-----\n\
             Proc-Type: 4,ENCRYPTED\n</key>\n",
        );
        assert!(config_requires_key_passphrase(bareaskpass.to_str().unwrap()));

        // Commented-out key directive / cert-only config → does not.
        let certonly = write("certonly.ovpn", "client\n# key enc.key\nauth-user-pass\n");
        assert!(!config_requires_key_passphrase(certonly.to_str().unwrap()));

        // Missing config → false.
        assert!(!config_requires_key_passphrase(
            dir.join("nope.ovpn").to_str().unwrap()
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_config_refuses_paths_outside_the_store() {
        // It deletes Eldrun's copy only — pointed at anything else (the user's
        // original .ovpn, or worse), it must refuse before touching the fs.
        let err = remove_config("/home/u/office.ovpn").unwrap_err();
        assert!(err.contains("not a stored"), "{err}");
        let err = remove_config("/etc/passwd").unwrap_err();
        assert!(err.contains("not a stored"), "{err}");
    }

    #[test]
    fn remove_config_of_missing_stored_file_is_ok() {
        // The goal state is "not stored": a file already gone is success, not an
        // error the UI has to explain.
        let path = configs_dir().join("nope__gone.ovpn");
        assert!(!path.exists());
        assert_eq!(remove_config(path.to_str().unwrap()), Ok(()));
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
