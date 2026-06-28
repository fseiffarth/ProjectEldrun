//! Remote (SSH) command execution for terminal/agent tabs.
//!
//! A remote project's bytes are sshfs-mounted locally (see `ssh_mount`), but the
//! user needs scripts and agents to run **on the remote host**, not locally
//! against the mounted bytes. This module rewrites a tab's `PtyOptions` so that
//! instead of spawning the requested command directly, the PTY spawns the local
//! `ssh` client with a forced TTY (`-tt`). The ssh client allocates a remote
//! PTY, so resize/kill/exit keep working through the local PTY unchanged.
//!
//! Detection is by the mountpoint-path convention: if a spawn's `cwd` lives
//! under `ssh_mount::mounts_root()`, the first path component after it is the
//! project id, from which we load the `RemoteSpec`. Local projects (and tabs
//! flagged `local_only`, e.g. local Ollama agents) are left untouched.
//!
//! As elsewhere, `host`/`user`/`remote_path` are validated (no leading `-`, no
//! control characters) and passed to `ssh` as separate argv items. The one
//! unavoidable shell string is the *remote* command — ssh always concatenates
//! its trailing argv and hands it to the remote `$SHELL -c` — so each token is
//! single-quoted via `shell_quote` before it is embedded.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::schema::project::RemoteSpec;
use crate::services::remote_agents;
use crate::services::ssh_mount::{self, ssh_target, validate_arg};
use crate::storage;
use crate::terminal::PtyOptions;

/// `sshfs`-style keepalive so a flaky link recovers instead of wedging. Unlike
/// the mount/check paths we deliberately do **not** set `BatchMode=yes`: the PTY
/// is interactive, so a first-connection passphrase or host-key prompt can be
/// answered by the user inside the terminal.
const SSH_KEEPALIVE: &[&str] = &[
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// How long the multiplexing master stays alive after the last session closes.
/// Multiplexing is Unix-only (see [`ssh_pty_args`]), so this is unused on Windows.
#[cfg(not(target_os = "windows"))]
const CONTROL_PERSIST_SECS: u32 = 600;

/// Agent-auth environment variables that must **not** be forwarded to the
/// remote. A remote agent authenticates with its own stored login (e.g.
/// `~/.claude`); a forwarded local key/token would silently clobber that
/// session (most CLIs prefer an env key over stored credentials). These are
/// dropped from the exported env alongside `TERM`/`COLORTERM`.
pub(crate) const AGENT_AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
];

/// Directory holding ssh ControlMaster sockets, created on demand.
/// `<state_dir>/ssh-control` (e.g. `~/.local/share/eldrun/ssh-control`).
fn control_dir() -> PathBuf {
    storage::state_dir().join("ssh-control")
}

/// Single-quote `s` for a POSIX shell, escaping embedded single quotes as
/// `'\''`. The result parses back to exactly `s` regardless of spaces, `$`,
/// quotes, or other metacharacters.
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

/// Translate a local cwd under the sshfs mount to the matching remote path.
/// Strips the `mountpoint` prefix from `local_cwd` and joins the remainder onto
/// `remote.remote_path`. Falls back to `remote.remote_path` when `local_cwd` is
/// the mount root itself or is not under the mountpoint.
pub fn remote_subdir(remote: &RemoteSpec, mountpoint: &Path, local_cwd: &str) -> String {
    let base = remote.remote_path.trim_end_matches('/');
    let cwd = Path::new(local_cwd);
    match cwd.strip_prefix(mountpoint) {
        Ok(rel) if !rel.as_os_str().is_empty() => {
            format!("{base}/{}", rel.to_string_lossy())
        }
        _ => remote.remote_path.clone(),
    }
}

/// Build the remote command string that `ssh` hands to the remote `$SHELL -c`.
///
/// Shape: `cd <dir> && export K=<v> … && exec <CMD>`. For a shell tab
/// (`local_cmd` empty) `<CMD>` is the remote login shell. For an agent/command
/// tab `<CMD>` is `"${SHELL:-/bin/bash}" -lc '<cli + args>'` — i.e. the command
/// is run through a **login** shell too, so the remote's PATH (e.g.
/// `~/.local/bin`, nvm, pyenv) is initialised and a userspace-installed CLI is
/// found. Without `-l`, ssh's non-login remote shell would miss those entries.
/// For a *recognised* agent CLI a detect-and-install prelude (see
/// `remote_agents`) is prepended inside the `-lc` script so the binary is
/// bootstrapped on the remote before it is exec'd.
/// `TERM`/`COLORTERM` are skipped — ssh forwards `TERM` to the remote PTY
/// already — as are agent-auth vars (`AGENT_AUTH_ENV`), so a local key cannot
/// clobber the remote agent's own stored login.
pub fn remote_command(
    local_cmd: &str,
    local_args: &[String],
    env: &HashMap<String, String>,
    remote_dir: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("cd {}", shell_quote(remote_dir)));

    // Deterministic env order so the command is testable. Skip TERM/COLORTERM
    // (ssh forwards them to the remote PTY) and agent-auth vars (the remote uses
    // its own stored login — see AGENT_AUTH_ENV).
    let mut keys: Vec<&String> = env
        .keys()
        .filter(|k| {
            let k = k.as_str();
            k != "TERM" && k != "COLORTERM" && !AGENT_AUTH_ENV.contains(&k)
        })
        .collect();
    keys.sort();
    for k in keys {
        let v = &env[k];
        parts.push(format!("export {}={}", k, shell_quote(v)));
    }

    let exec = if local_cmd.is_empty() {
        // Login shell — let the remote pick its own $SHELL.
        "exec \"${SHELL:-/bin/bash}\" -l".to_string()
    } else {
        // Agent/command tab: run the command through a *login* shell so the
        // remote's PATH (~/.local/bin, nvm, pyenv, …) is set up and a
        // userspace-installed CLI resolves. Build the inner command line with
        // each token single-quoted, then quote the whole line again as the lone
        // argument to `$SHELL -lc`.
        let mut exec_cli = format!("exec {}", shell_quote(local_cmd));
        for a in local_args {
            exec_cli.push(' ');
            exec_cli.push_str(&shell_quote(a));
        }
        // For a recognised agent, prepend a detect-and-install prelude so the
        // CLI is present on the remote before we exec it (see remote_agents).
        let inner = match remote_agents::recipe_for(local_cmd) {
            Some(recipe) => format!("{}; {}", remote_agents::bootstrap_prelude(recipe), exec_cli),
            None => exec_cli,
        };
        format!("exec \"${{SHELL:-/bin/bash}}\" -lc {}", shell_quote(&inner))
    };

    format!("{} && {}", parts.join(" && "), exec)
}

/// Build the full `ssh` argv for an interactive remote PTY session running
/// `remote_command`. Returned as `Vec<String>` so it is unit-testable without
/// actually connecting.
///
/// Shape: `ssh -tt -o ControlMaster=auto -o ControlPath=… -o ControlPersist=… \
///         -o ServerAliveInterval=… -o ServerAliveCountMax=… \
///         [-p <port>] <[user@]host> <remote_command>`.
pub fn ssh_pty_args(remote: &RemoteSpec, remote_command: &str) -> Result<Vec<String>, String> {
    let target = ssh_target(&remote.user, &remote.host)?;

    let mut args: Vec<String> = vec!["-tt".to_string()];

    // Connection multiplexing (ControlMaster/ControlPath/ControlPersist) is a
    // Unix-only OpenSSH feature: it relies on a Unix-domain control socket with
    // file-descriptor passing, which the Windows OpenSSH client does not
    // implement (it warns and the session can fail to bind the socket). Skip it
    // on Windows — each tab simply opens its own connection — while keeping the
    // reconnect/keepalive options below, which work on every platform.
    #[cfg(not(target_os = "windows"))]
    {
        let control_path = control_dir().join("cm-%C");
        args.push("-o".to_string());
        args.push("ControlMaster=auto".to_string());
        args.push("-o".to_string());
        args.push(format!("ControlPath={}", control_path.to_string_lossy()));
        args.push("-o".to_string());
        args.push(format!("ControlPersist={CONTROL_PERSIST_SECS}"));
    }

    for a in SSH_KEEPALIVE {
        args.push((*a).to_string());
    }
    if let Some(port) = remote.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    args.push(remote_command.to_string());
    Ok(args)
}

/// If `opts.cwd` lives under the sshfs mounts root and its project is remote,
/// rewrite `opts` in place to run the requested command on the remote host via
/// `ssh -tt`. No-op for local projects or cwds outside the mounts root.
///
/// On success, `opts.cmd` becomes `"ssh"`, `opts.args` the ssh argv, and
/// `opts.cwd` a stable local directory (the ssh client's local cwd is
/// irrelevant). Validation/connection failures surface as `Err`.
pub fn wrap_pty_options(opts: &mut PtyOptions) -> Result<(), String> {
    let project_id = match project_id_from_cwd(&opts.cwd) {
        Some(id) => id,
        None => return Ok(()), // not under the mounts root → local project
    };

    let project = crate::commands::ssh::load_project_by_id(&project_id)?;
    let remote = match project.remote.as_ref() {
        Some(r) => r,
        None => return Ok(()), // mounts-root path but no remote spec → leave as-is
    };

    let mountpoint = ssh_mount::mountpoint_for(&project_id);
    let remote_dir = remote_subdir(remote, &mountpoint, &opts.cwd);
    validate_arg("remote dir", &remote_dir)?;

    // Ensure the control-socket directory exists before ssh tries to bind it.
    let _ = std::fs::create_dir_all(control_dir());

    let cmd_string = remote_command(&opts.cmd, &opts.args, &opts.env, &remote_dir);
    let args = ssh_pty_args(remote, &cmd_string)?;

    opts.cmd = "ssh".to_string();
    opts.args = args;
    // env is now embedded in the remote command; the local ssh client keeps only
    // TERM/COLORTERM, which build_command sets. Clear the rest to avoid leaking
    // local env into the ssh client process.
    opts.env.retain(|k, _| k == "TERM" || k == "COLORTERM");
    opts.cwd = storage::root_work_dir().to_string_lossy().into_owned();
    Ok(())
}

/// Extract `<project-id>` from a cwd of the form
/// `<mounts_root>/<project-id>[/subdir…]`, or `None` if `cwd` is not under the
/// mounts root.
fn project_id_from_cwd(cwd: &str) -> Option<String> {
    let root = ssh_mount::mounts_root();
    let rel = Path::new(cwd).strip_prefix(&root).ok()?;
    let first = rel.components().next()?;
    Some(first.as_os_str().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(user: Option<&str>, host: &str, port: Option<u16>, remote_path: &str) -> RemoteSpec {
        RemoteSpec {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
            remote_path: remote_path.to_string(),
            openvpn: None,
            extra: HashMap::new(),
        }
    }

    // ── shell_quote ────────────────────────────────────────────────────────

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("abc"), "'abc'");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
        // embedded single quote → '\''
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    // ── remote_subdir ──────────────────────────────────────────────────────

    #[test]
    fn remote_subdir_root_is_remote_path() {
        let s = spec(None, "h", None, "/srv/project");
        let mp = Path::new("/mounts/p1");
        assert_eq!(remote_subdir(&s, mp, "/mounts/p1"), "/srv/project");
    }

    #[test]
    fn remote_subdir_nested_appends_relative() {
        let s = spec(None, "h", None, "/srv/project");
        let mp = Path::new("/mounts/p1");
        assert_eq!(
            remote_subdir(&s, mp, "/mounts/p1/sub/dir"),
            "/srv/project/sub/dir"
        );
    }

    #[test]
    fn remote_subdir_trailing_slash_remote_path() {
        let s = spec(None, "h", None, "/srv/project/");
        let mp = Path::new("/mounts/p1");
        assert_eq!(remote_subdir(&s, mp, "/mounts/p1/x"), "/srv/project/x");
    }

    #[test]
    fn remote_subdir_outside_mount_falls_back() {
        let s = spec(None, "h", None, "/srv/project");
        let mp = Path::new("/mounts/p1");
        assert_eq!(remote_subdir(&s, mp, "/somewhere/else"), "/srv/project");
    }

    // ── remote_command ─────────────────────────────────────────────────────

    #[test]
    fn remote_command_shell_uses_login_shell() {
        let cmd = remote_command("", &[], &HashMap::new(), "/srv/p");
        assert_eq!(cmd, "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -l");
    }

    #[test]
    fn remote_command_agent_runs_under_login_shell() {
        // `mytool` is not a recognised agent, so there is no install prelude —
        // this isolates the login-shell wrapping. Agent tabs go through
        // `$SHELL -lc '<inner>'` so the remote PATH is set up; the inner command
        // line is `exec 'mytool' '--foo' 'bar baz'`, single-quoted again as the
        // lone -lc argument.
        let cmd = remote_command(
            "mytool",
            &["--foo".to_string(), "bar baz".to_string()],
            &HashMap::new(),
            "/srv/p",
        );
        assert_eq!(
            cmd,
            "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc \
             'exec '\\''mytool'\\'' '\\''--foo'\\'' '\\''bar baz'\\'''"
        );
    }

    #[test]
    fn remote_command_agent_bootstraps_known_cli() {
        let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p");
        // Runs inside a login shell …
        assert!(cmd.starts_with("cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc "));
        // … with a detect-and-install prelude for the known CLI …
        assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
        assert!(cmd.contains("npm install -g @anthropic-ai/claude-code"));
        assert!(cmd.contains("exit 127"));
        // … finally exec'ing the agent (single quotes escaped by the outer wrap).
        assert!(cmd.contains("exec '\\''claude'\\''"));
    }

    #[test]
    fn remote_command_exports_env_sorted_and_skips_term() {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm".to_string());
        env.insert("COLORTERM".to_string(), "truecolor".to_string());
        env.insert("B_VAR".to_string(), "2".to_string());
        env.insert("A_VAR".to_string(), "x y".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p");
        assert_eq!(
            cmd,
            "cd '/srv/p' && export A_VAR='x y' && export B_VAR='2' && \
             exec \"${SHELL:-/bin/bash}\" -lc 'exec '\\''sh'\\'''"
        );
    }

    #[test]
    fn remote_command_strips_agent_auth_env() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-local".to_string());
        env.insert("OPENAI_API_KEY".to_string(), "sk-oai".to_string());
        env.insert("KEEP_ME".to_string(), "1".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p");
        // Auth vars (and their values) are never exported to the remote …
        assert!(!cmd.contains("ANTHROPIC_API_KEY"));
        assert!(!cmd.contains("OPENAI_API_KEY"));
        assert!(!cmd.contains("sk-local"));
        assert!(!cmd.contains("sk-oai"));
        // … but ordinary env still is.
        assert!(cmd.contains("export KEEP_ME='1'"));
    }

    // ── ssh_pty_args ───────────────────────────────────────────────────────

    #[test]
    fn ssh_pty_args_shape() {
        let s = spec(Some("alice"), "host.example", None, "/srv/p");
        let args = ssh_pty_args(&s, "cd '/srv/p' && exec sh").unwrap();

        assert_eq!(args[0], "-tt");
        // Multiplexing is Unix-only: present on Unix, omitted on Windows.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=auto"));
            assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
            assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
        }
        #[cfg(target_os = "windows")]
        assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
        assert!(args.iter().any(|a| a == "ServerAliveInterval=15"));
        // Interactive PTY: BatchMode must NOT be forced.
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
        // No port flag when port is None.
        assert!(!args.iter().any(|a| a == "-p"));
        // Target is a single argv item; remote command is the final item.
        assert!(args.iter().any(|a| a == "alice@host.example"));
        assert_eq!(args.last().unwrap(), "cd '/srv/p' && exec sh");
    }

    #[test]
    fn ssh_pty_args_includes_port() {
        let s = spec(None, "h", Some(2222), "/p");
        let args = ssh_pty_args(&s, "exec sh").unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn ssh_pty_args_rejects_bad_host() {
        let s = spec(None, "-evil", None, "/p");
        assert!(ssh_pty_args(&s, "exec sh").is_err());
    }

    // ── project_id_from_cwd ────────────────────────────────────────────────

    #[test]
    fn project_id_from_cwd_outside_mounts_is_none() {
        assert_eq!(project_id_from_cwd("/home/user/proj"), None);
    }

    #[test]
    fn project_id_from_cwd_extracts_id() {
        let root = ssh_mount::mounts_root();
        let cwd = root.join("abc-123").join("sub");
        assert_eq!(
            project_id_from_cwd(&cwd.to_string_lossy()),
            Some("abc-123".to_string())
        );
    }
}
