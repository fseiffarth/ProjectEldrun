//! Remote (SSH) command execution for terminal/agent tabs.
//!
//! Remote projects are SSH/SFTP-native (no local FUSE mount): the user's scripts
//! and agents run **on the remote host**. This module rewrites a tab's
//! `PtyOptions` so that instead of spawning the requested command directly, the
//! PTY spawns the local `ssh` client with a forced TTY (`-tt`). The ssh client
//! allocates a remote PTY, so resize/kill/exit keep working through the local PTY
//! unchanged.
//!
//! Remoteness is **explicit**: the frontend tags a project-scope spawn with the
//! owning `project_id` in `PtyOptions`, and `wrap_pty_options` resolves its
//! `RemoteSpec` via `services::remote::remote_target_for` (a `RemoteTarget`).
//! The remote working dir is the project root (`spec.remote_path`). Local
//! projects (and tabs flagged `local_only`, e.g. local Ollama agents, and
//! untagged root/connection terminals) are left untouched.
//!
//! As elsewhere, `host`/`user`/`remote_path` are validated (no leading `-`, no
//! control characters) and passed to `ssh` as separate argv items. The one
//! unavoidable shell string is the *remote* command — ssh always concatenates
//! its trailing argv and hands it to the remote `$SHELL -c` — so each token is
//! single-quoted via `shell_quote` before it is embedded.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::schema::project::RemoteSpec;
use crate::services::remote_agents;
use crate::services::ssh_common::{ssh_base_args, ssh_target, validate_arg};
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
/// `<state_dir>/ssh-control` (e.g. `~/.local/share/eldrun/ssh-control`). The
/// single shared `cm-%C` master socket here is reused by every remote path —
/// agent tabs, the pooled SFTP session (`services::remote`/`services::sftp`),
/// git-over-ssh, and an interactive login — so authentication happens once.
pub(crate) fn control_dir() -> PathBuf {
    storage::state_dir().join("ssh-control")
}

/// Single-quote `s` for a POSIX shell, escaping embedded single quotes as
/// `'\''`. The result parses back to exactly `s` regardless of spaces, `$`,
/// quotes, or other metacharacters. `pub(crate)` so command modules that build
/// their own host scripts (e.g. `commands::slurm`) share this one implementation
/// rather than reinventing shell quoting.
pub(crate) fn shell_quote(s: &str) -> String {
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

/// A POSIX-portable environment variable name (`[A-Za-z_][A-Za-z0-9_]*`). Used to
/// gate which keys may be `export`ed into the remote `$SHELL -c` string: the
/// value is `shell_quote`d, but the key is not (it sits left of `=`), so a key
/// containing shell metacharacters (e.g. `A; rm -rf ~ #`) would break out of the
/// assignment and run as a separate statement. Every key Eldrun sets today is a
/// valid identifier; this enforces that property rather than trusting it.
fn is_valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// How a remote tab is wrapped in a **tmux** session on the host (TODO #85), so
/// the work is decoupled from the disposable ssh channel and survives a drop /
/// laptop sleep / Eldrun relaunch.
#[derive(Debug, Clone)]
pub enum TmuxWrap {
    /// Start-or-attach a per-tab session (`tmux new-session -A`) that runs this
    /// tab's target command. On first spawn it creates and runs the command; on a
    /// reconnect/relaunch it reattaches and the target is ignored (the process is
    /// already running) — one command that is both "start" and "resume".
    Session(String),
    /// Attach to an **arbitrary named** session that already exists on the host
    /// (opened from the Sessions view, or a hand-started `tmux` session). No
    /// target command — `new-session -A` attaches the running session, or creates
    /// a bare login shell if the name is somehow gone.
    Attach(String),
}

/// Wrap a resolved `exec …` line in a tmux launch (see [`TmuxWrap`]). Emitted as
/// a POSIX-sh `if command -v tmux …` so a host **without** tmux degrades to the
/// plain exec (today's behavior) plus a one-line notice, instead of failing —
/// tmux is usually preinstalled on a compute/HPC host but cannot be assumed. The
/// session gets `status off` (Eldrun already draws tabs/layout, so tmux's status
/// bar is redundant chrome) and `mouse on` (wheel scrolls tmux history, so
/// scrollback still feels native), chained as extra tmux commands after a literal
/// `;` argv separator.
fn tmux_wrap_exec(exec_line: &str, wrap: &TmuxWrap) -> String {
    // `status off`/`mouse on` are passed as separate tmux commands: a standalone
    // `;` token (quoted so the remote shell hands it to tmux literally, not as a
    // shell separator) splits tmux's argv into successive commands.
    let opts = "';' set -g status off ';' set -g mouse on";
    match wrap {
        TmuxWrap::Session(name) => {
            let q = shell_quote(name);
            // tmux runs its command argument via `sh -c`, so the (quoted) exec
            // line — `exec "${SHELL:-/bin/bash}" -l…` — is executed exactly as it
            // would be directly, only now inside the persistent session.
            let target = shell_quote(exec_line);
            format!(
                "if command -v tmux >/dev/null 2>&1; then \
                 exec tmux new-session -A -D -s {q} {target} {opts}; \
                 else printf 'eldrun: tmux not found on the remote host; session persistence is OFF (install tmux to enable it)\\n' >&2; {exec_line}; fi"
            )
        }
        TmuxWrap::Attach(name) => {
            let q = shell_quote(name);
            format!(
                "if command -v tmux >/dev/null 2>&1; then \
                 exec tmux new-session -A -D -s {q} {opts}; \
                 else printf 'eldrun: tmux not found on the remote host; cannot attach session %s\\n' {q} >&2; exec \"${{SHELL:-/bin/bash}}\" -l; fi"
            )
        }
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
///
/// `tmux`, when `Some`, wraps the final `exec …` in a persistent tmux session
/// (TODO #85). Everything before it — the `cd`, the sorted env exports, the
/// agent bootstrap prelude — is preserved verbatim and nested *inside* the
/// session, so the wrap changes only where the target runs, not what it is. A
/// [`TmuxWrap::Attach`] ignores `local_cmd`/`local_args` (it attaches an existing
/// session, running no fresh target).
pub fn remote_command(
    local_cmd: &str,
    local_args: &[String],
    env: &HashMap<String, String>,
    remote_dir: &str,
    tmux: Option<&TmuxWrap>,
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
            // is_valid_env_key gates injection via a metacharacter-bearing key.
            is_valid_env_key(k) && k != "TERM" && k != "COLORTERM" && !AGENT_AUTH_ENV.contains(&k)
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

    // The tmux wrap replaces only the final `exec …`; the `cd`/exports prefix is
    // untouched, so the session opens in the project dir with the same env.
    let exec = match tmux {
        Some(wrap) => tmux_wrap_exec(&exec, wrap),
        None => exec,
    };

    format!("{} && {}", parts.join(" && "), exec)
}

/// The tmux **kill-session** one-shot script fired on an *explicit* tab close of
/// a persistent remote tab (TODO #85). Closing the tab is the destructive intent
/// that ends the run; an app-exit / respawn leaves the session alive. A machine
/// disconnect ends every session on that host. Run over the pooled
/// ControlMaster via [`run_remote_script`]. The session name is `shell_quote`d
/// (it may be an arbitrary name from the Sessions view). `|| true` keeps the
/// exit status clean when the session is already gone.
pub fn tmux_kill_session_script(session: &str) -> String {
    format!("tmux kill-session -t {} 2>/dev/null || true", shell_quote(session))
}

/// Kill every tmux session owned by the connected SSH user. Used when Eldrun
/// deliberately disconnects a remote machine, so its persistent runs do not
/// continue without their machine connection.
pub fn tmux_kill_server_script() -> &'static str {
    "tmux kill-server 2>/dev/null || true"
}

/// Whether `name` is a safe tmux session name to rename **to** (TODO #85): tmux
/// treats `:` and `.` specially, and a name with whitespace/control chars is a
/// footgun, so a rename target must be a non-empty run of `[A-Za-z0-9_-]`. (The
/// *source* name is not validated this way — a foreign/hand-started session may be
/// anything — only quoted.)
pub fn valid_tmux_session_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The tmux **rename-session** one-shot (TODO #85): `tmux rename-session -t <old>
/// <new>`. Both names are `shell_quote`d (the `old` may be an arbitrary foreign
/// name); the caller MUST have checked `new` with [`valid_tmux_session_name`].
pub fn tmux_rename_session_script(old: &str, new: &str) -> String {
    format!(
        "tmux rename-session -t {} {}",
        shell_quote(old),
        shell_quote(new)
    )
}

/// The `tmux ls` one-shot that backs the Sessions view (TODO #85): one tab-
/// separated row per session — name, window count, created epoch, attached flag.
/// `2>/dev/null || true` makes an absent tmux or a not-running server (`tmux ls`
/// exits non-zero with "no server running") a clean **empty** list rather than an
/// error (see [`parse_tmux_ls`]).
pub fn tmux_ls_script() -> &'static str {
    "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}' 2>/dev/null || true"
}

/// One host tmux session, as surfaced by the Sessions view (TODO #85).
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct TmuxSession {
    /// Session name (`eldrun-<uid>` for one Eldrun started, else a foreign name).
    pub name: String,
    /// Number of windows in the session.
    pub windows: u32,
    /// Creation time, seconds since the Unix epoch (host clock).
    pub created: u64,
    /// Whether another client is currently attached to it.
    pub attached: bool,
}

/// Parse the tab-separated output of [`tmux_ls_script`] into [`TmuxSession`]s.
/// Empty/`no server running` output → an empty list (never an error). A row that
/// does not have the four expected fields is skipped rather than failing the whole
/// parse (forward-compatible with an unexpected `tmux ls` build).
pub fn parse_tmux_ls(output: &str) -> Vec<TmuxSession> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                return None;
            }
            let mut f = line.split('\t');
            let name = f.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let windows = f.next()?.trim().parse().ok()?;
            let created = f.next()?.trim().parse().ok()?;
            // tmux prints `session_attached` as a count of attached clients; any
            // positive count means at least one client is on it.
            let attached = f.next()?.trim().parse::<u32>().ok()? > 0;
            Some(TmuxSession {
                name,
                windows,
                created,
                attached,
            })
        })
        .collect()
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

/// Build `ssh -S <shared-control-path> -O check <target>` for resolving the
/// actual ControlMaster PID without opening a network connection. The `%C`
/// token is expanded by OpenSSH from the same user/host/port tuple used by every
/// remote-project channel.
pub fn ssh_control_check_args(remote: &RemoteSpec) -> Result<Vec<String>, String> {
    let target = ssh_target(&remote.user, &remote.host)?;
    let control_path = control_dir().join("cm-%C");
    let mut args = vec![
        "-S".to_string(),
        control_path.to_string_lossy().into_owned(),
        "-O".to_string(),
        "check".to_string(),
    ];
    if let Some(port) = remote.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    Ok(args)
}

/// Build the remote command string `cd <remote_path> && git <args…>` for a
/// git-over-ssh invocation. This is the one unavoidable shell string: ssh
/// concatenates its trailing argv and hands it to the remote `$SHELL -c`, so
/// every token — `remote_path` and each git arg — is single-quoted via
/// [`shell_quote`] before it is embedded (the injection-safety requirement from
/// the mount-free plan's Security bullet). Pure + unit-testable.
pub fn remote_git_command(remote_path: &str, git_args: &[String]) -> String {
    let mut s = format!("cd {} && git", shell_quote(remote_path));
    for a in git_args {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// Build the full `ssh` argv for running `git <git_args>` on `spec`'s host. The
/// shared-master base args (`ssh_base_args`: `BatchMode=yes`, `ConnectTimeout`,
/// and — on Unix — opportunistic reuse of the `cm-%C` ControlMaster the Phase-0
/// pooled connection / agent tabs establish) are followed by the single remote
/// `$SHELL -c` string from [`remote_git_command`]. `remote_path`/`host`/`user`
/// are validated (no leading `-`, no control chars) via `validate_arg`/
/// `ssh_target` inside `ssh_base_args` and here. Returned as `Vec<String>` so it
/// is unit-testable without connecting.
pub fn git_ssh_args(spec: &RemoteSpec, git_args: &[String]) -> Result<Vec<String>, String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(remote_git_command(&spec.remote_path, git_args));
    Ok(args)
}

/// Run `git <git_args>` on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. Because git's output is plain text,
/// the caller parses it byte-for-byte identically to a local `git` invocation —
/// that is what lets `commands::git` reuse every existing parser unchanged for
/// remote projects. The remote `git`'s credentials/SSH keys are the host's own
/// (the process runs there), so e.g. `push` authenticates with the host login.
pub fn run_git_remote(
    spec: &RemoteSpec,
    git_args: &[String],
) -> Result<std::process::Output, String> {
    let args = git_ssh_args(spec, git_args)?;
    crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git over ssh: {e}"))
}

/// Run a single shell command on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. The command string is handed to the
/// remote `$SHELL -c`, so the caller MUST `shell_quote` any path/argument it
/// embeds. Used for cheap host capability probes (e.g. `command -v rsync`).
pub fn run_remote_shell(spec: &RemoteSpec, command: &str) -> Result<std::process::Output, String> {
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(command.to_string());
    crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run command over ssh: {e}"))
}

/// Run a POSIX-`sh` script inside the project's remote directory (`cd <path> && <script>`),
/// riding the shared ControlMaster. This is how `services::git_peer` collapses a probe
/// that cost six SSH round trips into one (#28p D5).
///
/// **`script` is embedded verbatim** — it is the shell program, so it cannot be quoted.
/// Callers must therefore pass a *constant* script, or one built only from values they
/// have proven inert (`git_peer::ancestry_script` interpolates hex object names and
/// nothing else). Never interpolate a path, branch name, or any other user-controlled
/// string into it; `remote_path` is the sole variable here and it is `shell_quote`d.
pub fn run_remote_script(spec: &RemoteSpec, script: &str) -> Result<std::process::Output, String> {
    validate_arg("remote path", &spec.remote_path)?;
    // The newline before `}` terminates the group's last command, so a script may end in
    // either `fi` or a trailing `;` without a syntax error either way.
    let cmd = format!("cd {} && {{ {script}\n}}", shell_quote(&spec.remote_path));
    run_remote_shell(spec, &cmd)
}

/// Best-effort recursive byte size of a directory on the host, over SSH.
///
/// Reports **apparent** size — the sum of each file's `st_size` — to match every
/// other size figure in the app: the local walk ([`crate::commands::fs`]'s
/// `walk_dir_size`) and the per-file SFTP listing sizes both use `st_size`. Plain
/// `du` instead reports **disk-block allocation** (each file rounded up to a 4 KB
/// block), which made an identical folder read *larger* over SSH than its local
/// mirror — e.g. 452 KB vs 377 KB for 31 small files, purely from block rounding.
///
/// `du -sb` gives exact apparent bytes on GNU coreutils (the usual Linux dev
/// host). BSD/macOS `du` has no `-b`, so when it produces nothing we fall back to
/// `du -sk` (1024-byte *block* units) × 1024 — approximate there, but no worse
/// than the previous behavior. The shell always emits **bytes**, so the parse
/// below never rescales. The path is validated + single-quoted; a `du` error
/// (e.g. unreadable dir) yields 0 rather than failing the whole listing.
pub fn remote_dir_size(spec: &RemoteSpec, remote_dir: &str) -> Result<u64, String> {
    validate_arg("remote path", remote_dir)?;
    let q = shell_quote(remote_dir);
    let cmd = format!(
        "s=$(du -sb {q} 2>/dev/null | cut -f1); \
         if [ -n \"$s\" ]; then echo \"$s\"; \
         else du -sk {q} 2>/dev/null | cut -f1 | awk '{{print $1*1024}}'; fi"
    );
    let out = run_remote_shell(spec, &cmd)?;
    let bytes: u64 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .parse()
        .unwrap_or(0);
    Ok(bytes)
}

/// Full recursive size tree of a directory on the host, for the Disk Usage
/// Analyzer pane.
///
/// One `du -ak` round-trip (riding the shared ControlMaster) rather than an
/// N-call SFTP walk: `-a` reports files as well as directories, `-k` fixes the
/// unit at 1024-byte blocks (portable across GNU and BSD/macOS `du`, unlike
/// GNU-only `-b`), and `-x` keeps the scan on one filesystem so a network mount
/// or `/proc` under the root cannot make it run forever. `du` dedups hard links
/// itself. Parsing lives in [`crate::duscan::parse_du_output`], which is where the
/// output shape is documented and tested. The path is validated + single-quoted.
pub fn remote_du_tree(spec: &RemoteSpec, remote_dir: &str) -> Result<crate::duscan::DuScan, String> {
    validate_arg("remote path", remote_dir)?;
    let cmd = format!("du -ak -x {} 2>/dev/null", shell_quote(remote_dir));
    let out = run_remote_shell(spec, &cmd)?;
    // `du` exits non-zero when *any* entry was unreadable, having still printed
    // everything it could reach — so the status is ignored and stdout is parsed
    // regardless. An empty stdout (a genuinely dead connection) fails in the parser.
    crate::duscan::parse_du_output(remote_dir, &String::from_utf8_lossy(&out.stdout))
}

/// Raw `du -ak -x` capture of a host directory, riding the shared ControlMaster.
///
/// The same command `remote_du_tree` runs, but handed back as **text** rather than
/// pruned into a `DuScan`: the giant-folder census (`services::big_folders`) needs
/// every line — the emit caps that make a size *tree* renderable would silently
/// drop the folders it exists to find. One round trip; `-x` stays on this
/// filesystem, so a network mount under the project root isn't measured as project
/// data. `du` exits non-zero on any unreadable entry having printed the rest, so
/// stdout is returned regardless of status.
pub fn remote_du_raw(spec: &RemoteSpec, remote_dir: &str) -> Result<String, String> {
    validate_arg("remote path", remote_dir)?;
    let cmd = format!("du -ak -x {} 2>/dev/null", shell_quote(remote_dir));
    let out = run_remote_shell(spec, &cmd)?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        return Err("du returned nothing (is the host reachable?)".to_string());
    }
    Ok(text)
}

/// Best-effort create `spec.remote_path` (and parents) on the host over SSH,
/// riding the shared ControlMaster. Used when a new remote project is created so
/// agent tabs / git can `cd` into the project root. `mkdir -p <path>` is handed
/// to the remote `$SHELL -c`, so the path is single-quoted via `shell_quote` and
/// validated (no leading `-`, no control chars). Returns the trimmed stderr on
/// failure; callers treat it as best-effort.
pub fn remote_mkdir_p(spec: &RemoteSpec) -> Result<(), String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(format!("mkdir -p {}", shell_quote(&spec.remote_path)));
    let out = crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run mkdir over ssh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Best-effort `git init` on the host inside `spec.remote_path`, but only when
/// that dir is not already a git work tree. Used when a remote project is
/// imported **with git support** (`git_type != "none"`) onto a host tree that
/// carries no repo: it gives git lockstep a repo on the (authoritative) host to
/// pair the local mirror from, matching how a fresh remote *create* leaves the
/// mirror as the repo. Idempotent — a path that is already a repo is left
/// untouched. The command is handed to the remote `$SHELL -c`, so the path is
/// single-quoted via `shell_quote` and validated; rides the shared ControlMaster.
pub fn remote_git_init(spec: &RemoteSpec) -> Result<(), String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    let path = shell_quote(&spec.remote_path);
    args.push(format!(
        "cd {path} && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init"
    ));
    let out = crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git init over ssh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Build a ready-to-run shell command string that opens an **interactive** ssh
/// login to `[user@]host[:port]`, sharing the same multiplexing master socket
/// (`ControlPath`) the terminal/agent tabs use.
///
/// Typed into a root-scope shell tab (see the frontend `openConnectionInRoot`)
/// when the user has turned **off** headless connections: the password is entered
/// directly in the visible terminal — Eldrun never handles it — and because the
/// login shares `cm-%C` with [`ssh_pty_args`], the pooled SFTP session, file
/// browse, and git-over-ssh all ride the authenticated master without a second
/// prompt. On Unix this enables `ControlMaster=auto`; on Windows
/// multiplexing is unavailable so the login simply opens its own connection. The
/// control-socket dir is created here so ssh can bind the master. Each argv item
/// is shell-quoted before being joined, so spaces/metacharacters stay inert.
pub fn interactive_login_command(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<String, String> {
    let target = ssh_target(user, host)?;
    let mut args: Vec<String> = vec!["ssh".to_string()];

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::fs::create_dir_all(control_dir());
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
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);

    Ok(args
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" "))
}

/// If `opts` belongs to a remote project, rewrite it in place to run the
/// requested command on the remote host via `ssh -tt`. No-op for local projects.
///
/// Remoteness is detected from `opts.project_id` (the explicit signal the
/// frontend sets for project-scope tabs): `remote_target_for` resolves it to a
/// `RemoteTarget`, or returns `None` for a local project. A spawn with no
/// `project_id` (root/connection terminals, `local_only` tabs) is always local.
/// The remote working dir is the project root (`spec.remote_path`).
///
/// On success, `opts.cmd` becomes `"ssh"`, `opts.args` the ssh argv, and
/// `opts.cwd` a stable local directory (the ssh client's local cwd is
/// irrelevant). Validation/connection failures surface as `Err`.
pub fn wrap_pty_options(opts: &mut PtyOptions) -> Result<(), String> {
    let host_id = opts
        .remote_host_id
        .as_deref()
        .unwrap_or(crate::services::remote::PRIMARY_HOST);
    use crate::services::remote::{remote_target_for, remote_target_for_host, PRIMARY_HOST};
    let target = match &opts.project_id {
        Some(id) => match remote_target_for_host(id, host_id) {
            Some(t) => t,
            // A worker id that no longer resolves (the machine was removed while a
            // tab still pointed at it) falls back to the PRIMARY on a remote project
            // rather than silently running local in the remote cwd (plan §8). A
            // genuinely local project still resolves to nothing → left as-is.
            None => match remote_target_for(id).filter(|_| host_id != PRIMARY_HOST) {
                Some(t) => t,
                None => return Ok(()),
            },
        },
        None => return Ok(()), // untagged spawn (root/connection/local_only) → local
    };

    // Remote working dir is the project root on the host. There is no local
    // mountpoint to strip a subdir against (mount-free remote model).
    let remote_dir = target.spec.remote_path.trim_end_matches('/').to_string();
    validate_arg("remote dir", &remote_dir)?;

    // Ensure the control-socket directory exists before ssh tries to bind it.
    let _ = std::fs::create_dir_all(control_dir());

    // Persistent-session (tmux) wrap, TODO #85. An explicit attach (Sessions view /
    // restored attach tab) wins; otherwise a per-tab `tmux_session` name — minted
    // and persisted by the frontend for shell/script tabs of a persist-enabled
    // remote project (so it is stable across a relaunch, unlike the PTY id) — spawns
    // or reattaches that session. Absent (agent tabs, persistence off, local) →
    // today's plain exec.
    let tmux = match (&opts.tmux_attach, &opts.tmux_session) {
        (Some(name), _) => Some(TmuxWrap::Attach(name.clone())),
        (None, Some(name)) => Some(TmuxWrap::Session(name.clone())),
        (None, None) => None,
    };

    let cmd_string = remote_command(&opts.cmd, &opts.args, &opts.env, &remote_dir, tmux.as_ref());
    let args = ssh_pty_args(&target.spec, &cmd_string)?;

    opts.cmd = "ssh".to_string();
    opts.args = args;
    // env is now embedded in the remote command; the local ssh client keeps only
    // TERM/COLORTERM, which build_command sets. Clear the rest to avoid leaking
    // local env into the ssh client process.
    opts.env.retain(|k, _| k == "TERM" || k == "COLORTERM");
    opts.cwd = storage::root_work_dir().to_string_lossy().into_owned();
    Ok(())
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
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            label: None,
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

    // ── remote_command ─────────────────────────────────────────────────────

    #[test]
    fn remote_command_shell_uses_login_shell() {
        let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", None);
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
            None,
        );
        assert_eq!(
            cmd,
            "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc \
             'exec '\\''mytool'\\'' '\\''--foo'\\'' '\\''bar baz'\\'''"
        );
    }

    #[test]
    fn remote_command_agent_bootstraps_known_cli() {
        let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", None);
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
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
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
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
        // Auth vars (and their values) are never exported to the remote …
        assert!(!cmd.contains("ANTHROPIC_API_KEY"));
        assert!(!cmd.contains("OPENAI_API_KEY"));
        assert!(!cmd.contains("sk-local"));
        assert!(!cmd.contains("sk-oai"));
        // … but ordinary env still is.
        assert!(cmd.contains("export KEEP_ME='1'"));
    }

    #[test]
    fn remote_command_drops_env_key_with_shell_metachars() {
        // A key carrying shell metacharacters can't be made safe by quoting the
        // value (the key sits left of `=`), so it must be dropped entirely rather
        // than emitted as `export <metachars>=…`.
        let mut env = HashMap::new();
        env.insert("A; touch /tmp/pwned #".to_string(), "v".to_string());
        env.insert("GOOD_VAR".to_string(), "1".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
        assert!(!cmd.contains("touch /tmp/pwned"));
        assert!(!cmd.contains("export A;"));
        assert!(cmd.contains("export GOOD_VAR='1'"));
    }

    // ── tmux wrap (TODO #85) ───────────────────────────────────────────────

    #[test]
    fn remote_command_off_is_unchanged() {
        // With no tmux wrap the output is byte-for-byte the pre-#85 command: the
        // cd/exports/exec nesting is untouched.
        let mut env = HashMap::new();
        env.insert("K".to_string(), "v".to_string());
        assert_eq!(
            remote_command("", &[], &env, "/srv/p", None),
            "cd '/srv/p' && export K='v' && exec \"${SHELL:-/bin/bash}\" -l"
        );
    }

    #[test]
    fn remote_command_tmux_wraps_shell_tab() {
        let wrap = TmuxWrap::Session("eldrun-p1_shell-1".to_string());
        let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", Some(&wrap));
        // cd prefix is preserved verbatim…
        assert!(cmd.starts_with("cd '/srv/p' && "));
        // …and the exec is a new-session -A -D on the derived name, with the login
        // shell exec nested as tmux's (quoted) command argument.
        assert!(cmd.contains("command -v tmux >/dev/null 2>&1"));
        assert!(cmd.contains("exec tmux new-session -A -D -s 'eldrun-p1_shell-1' "));
        assert!(cmd.contains("'exec \"${SHELL:-/bin/bash}\" -l'"));
        // status/mouse options are chained as separate tmux commands.
        assert!(cmd.contains("';' set -g status off ';' set -g mouse on"));
        // Fallback: a host without tmux still runs the plain exec.
        assert!(cmd.contains("session persistence is OFF"));
        assert!(cmd.contains("; exec \"${SHELL:-/bin/bash}\" -l; fi"));
    }

    #[test]
    fn remote_command_tmux_wraps_command_tab_preserving_prelude() {
        let wrap = TmuxWrap::Session("eldrun-p1_a1".to_string());
        let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", Some(&wrap));
        // The agent bootstrap prelude is nested INSIDE the tmux target unchanged…
        assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
        assert!(cmd.contains("npm install -g @anthropic-ai/claude-code"));
        // …and the whole `$SHELL -lc '<prelude; exec claude>'` line is tmux's
        // (quoted) command argument on the persistent session.
        assert!(cmd.contains("exec tmux new-session -A -D -s 'eldrun-p1_a1' "));
    }

    #[test]
    fn remote_command_tmux_attach_ignores_target() {
        let wrap = TmuxWrap::Attach("train".to_string());
        // Even with a target command, an attach ignores it and just reattaches the
        // named (possibly hand-started) session.
        let cmd = remote_command("python", &["run.py".to_string()], &HashMap::new(), "/srv/p", Some(&wrap));
        assert!(cmd.contains("exec tmux new-session -A -D -s 'train' "));
        // No fresh target is exec'd inside the attach (the session already runs).
        assert!(!cmd.contains("run.py"));
    }

    #[test]
    fn tmux_kill_session_script_quotes_name() {
        assert_eq!(
            tmux_kill_session_script("eldrun-p1_shell-1"),
            "tmux kill-session -t 'eldrun-p1_shell-1' 2>/dev/null || true"
        );
        // An arbitrary/foreign name is single-quoted so it can't break out.
        assert!(tmux_kill_session_script("a'b").contains("'a'\\''b'"));
    }

    #[test]
    fn tmux_kill_server_script_is_best_effort() {
        assert_eq!(tmux_kill_server_script(), "tmux kill-server 2>/dev/null || true");
    }

    #[test]
    fn parse_tmux_ls_reads_rows_and_tolerates_empty() {
        let out = "eldrun-p1_shell-1\t2\t1700000000\t1\ntrain\t1\t1700000500\t0\n";
        let v = parse_tmux_ls(out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], TmuxSession { name: "eldrun-p1_shell-1".into(), windows: 2, created: 1_700_000_000, attached: true });
        assert_eq!(v[1], TmuxSession { name: "train".into(), windows: 1, created: 1_700_000_500, attached: false });
        // "no server running" / absent tmux → empty output → zero sessions.
        assert!(parse_tmux_ls("").is_empty());
        assert!(parse_tmux_ls("\n").is_empty());
        // A malformed row is skipped, not fatal.
        assert!(parse_tmux_ls("onlyname\n").is_empty());
    }

    #[test]
    fn tmux_ls_script_tolerates_no_server() {
        let s = tmux_ls_script();
        assert!(s.contains("tmux ls -F"));
        // "no server running" (non-zero exit) and absent tmux both collapse to
        // empty output rather than an error.
        assert!(s.contains("2>/dev/null || true"));
    }

    #[test]
    fn is_valid_env_key_matches_posix_identifiers() {
        assert!(is_valid_env_key("ELDRUN_TAB_UID"));
        assert!(is_valid_env_key("_x9"));
        assert!(!is_valid_env_key("9leading"));
        assert!(!is_valid_env_key("has space"));
        assert!(!is_valid_env_key("a;b"));
        assert!(!is_valid_env_key(""));
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

    #[test]
    fn ssh_control_check_uses_shared_path_and_target() {
        let args = ssh_control_check_args(&spec(Some("alice"), "host.example", Some(2200), "/p"))
            .unwrap();
        assert_eq!(args[0], "-S");
        assert!(args[1].contains("cm-%C"));
        assert!(args.windows(2).any(|w| w == ["-O", "check"]));
        assert!(args.windows(2).any(|w| w == ["-p", "2200"]));
        assert_eq!(args.last().unwrap(), "alice@host.example");
    }

    // ── interactive_login_command ──────────────────────────────────────────

    #[test]
    fn interactive_login_command_shape() {
        let cmd =
            interactive_login_command(&Some("alice".to_string()), "host.example", None).unwrap();
        // Starts with a (quoted) ssh and ends with the (quoted) target.
        assert!(cmd.starts_with("'ssh' "));
        assert!(cmd.contains("'alice@host.example'"));
        // Multiplexing master is SHARED with ssh_pty_args (same cm-%C socket), so a
        // root-terminal login's auth is reused by the headless mount/check.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(cmd.contains("ControlMaster=auto"));
            assert!(cmd.contains("cm-%C"));
            assert!(cmd.contains("ControlPersist="));
        }
        #[cfg(target_os = "windows")]
        assert!(!cmd.contains("ControlMaster=auto"));
    }

    #[test]
    fn interactive_login_command_includes_port() {
        let cmd = interactive_login_command(&None, "h", Some(2222)).unwrap();
        assert!(cmd.contains("'-p' '2222'"));
        assert!(cmd.trim_end().ends_with("'h'"));
    }

    #[test]
    fn interactive_login_command_rejects_bad_target() {
        assert!(interactive_login_command(&None, "-evil", None).is_err());
        assert!(interactive_login_command(&Some("-evil".to_string()), "h", None).is_err());
    }

    // ── wrap_pty_options detection ─────────────────────────────────────────

    fn local_opts(cwd: &str, project_id: Option<&str>) -> PtyOptions {
        PtyOptions {
            id: "t".to_string(),
            cmd: "bash".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: cwd.to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            project_id: project_id.map(str::to_string),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
        }
    }

    #[test]
    fn wrap_pty_options_none_id_is_local_noop() {
        // No explicit project_id (root/connection/local_only spawn) → always
        // local, so the spawn is left untouched (mount-free: there is no cwd
        // mountpoint to sniff).
        let mut opts = local_opts("/home/user/proj", None);
        wrap_pty_options(&mut opts).unwrap();
        assert_eq!(opts.cmd, "bash");
        assert!(opts.args.is_empty());
    }

    // ── git over ssh ───────────────────────────────────────────────────────

    #[test]
    fn remote_git_command_quotes_path_and_each_arg() {
        let cmd = remote_git_command(
            "/srv/my project",
            &["status".to_string(), "--porcelain".to_string()],
        );
        assert_eq!(cmd, "cd '/srv/my project' && git 'status' '--porcelain'");
    }

    #[test]
    fn remote_git_command_no_args_is_bare_git() {
        assert_eq!(remote_git_command("/srv/p", &[]), "cd '/srv/p' && git");
    }

    #[test]
    fn git_ssh_args_shape_target_then_remote_command_last() {
        let s = spec(Some("alice"), "host.example", None, "/srv/p");
        let args = git_ssh_args(&s, &["status".to_string(), "--porcelain".to_string()]).unwrap();
        // BatchMode (rides/falls-back to key auth), target present as one item.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "alice@host.example"));
        // The remote $SHELL -c string is the final argv item.
        assert_eq!(
            args.last().unwrap(),
            "cd '/srv/p' && git 'status' '--porcelain'"
        );
        // Opportunistic ControlMaster reuse on Unix (shared cm-%C socket).
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=no"));
            assert!(args.iter().any(|a| a.contains("cm-%C")));
        }
    }

    #[test]
    fn git_ssh_args_includes_port() {
        let s = spec(None, "h", Some(2222), "/p");
        let args = git_ssh_args(&s, &["log".to_string()]).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn git_ssh_args_rejects_bad_remote_path_and_host() {
        // A remote path that could be read as an option is rejected before any
        // ssh runs (it would otherwise be embedded in the remote shell string).
        assert!(git_ssh_args(&spec(None, "h", None, "-rf"), &["status".to_string()]).is_err());
        assert!(git_ssh_args(&spec(None, "-evil", None, "/p"), &["status".to_string()]).is_err());
    }
}
