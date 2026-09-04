//! Persistent **local** (tmux) sessions (TODO #85 extension).
//!
//! The remote half of persistent sessions runs tmux on the SSH host; this runs it
//! on the **local machine** so a local project's shell/script tab (a Python run, a
//! long build) keeps going if Eldrun **crashes** — and reattaches on restart —
//! instead of dying with the PTY. It works because the tmux **server** is a
//! daemon: the PTY only holds a tmux *client*, so when Eldrun (and the client)
//! goes away the session and its processes live on under the server, and a
//! respawn's `tmux new-session -A` reattaches them.
//!
//! **Unix only.** There is no tmux on Windows, so every entry point here no-ops
//! there (guarded by [`tmux_available`], which is `false` on Windows), leaving the
//! tab to spawn exactly as before.
//!
//! Unlike the remote wrap (which emits a `$SHELL -c` *string* for ssh), the local
//! wrap rewrites `PtyOptions.{cmd,args}` into a direct `tmux` **argv** — the PTY
//! spawns `tmux` itself, and the `cwd` set on the client is inherited by a
//! freshly-created session. Its `env` is **not**: tmux gives a new session the
//! *server's* global environment, so per-tab variables have to be handed to
//! `new-session` explicitly ([`local_tmux_args`]).

use std::collections::HashMap;

use crate::services::ssh_exec::{is_valid_env_key, TMUX_HISTORY_LINES};
use crate::terminal::PtyOptions;

/// Prefix reserved for tmux sessions Eldrun creates on the local machine.
///
/// It is deliberately broad enough to include sessions created by a previous
/// Eldrun run and whose tabs have not been opened in this run yet. A clean app
/// quit reaps these sessions ([`kill_eldrun_sessions`]), while a crash leaves
/// them available for restore.
pub const ELDRUN_LOCAL_TMUX_PREFIX: &str = "eldrun-";

/// What the tmux **client** can hand its server in one message. The argv is
/// sent as a single imsg and refused with `command too long` (the tab then
/// shows nothing but `[process exited]`) once every item plus its NUL
/// terminator exceeds `MAX_IMSGSIZE` (16384 in every tmux release). A fenced
/// agent tab hit this: the bubblewrap wrap emits one `--bind`/`--ro-bind`
/// item pair per `~/.claude`/`~/.codex` entry and per transcript dir, so a
/// well-used machine's fence alone runs to tens of kilobytes — and a
/// Mobile-reachable agent tab nests all of it inside the tmux command line.
pub const TMUX_ARGV_LIMIT: usize = 16384;

/// Above this the command line moves into a [`launcher_script`] instead of
/// riding the tmux argv. Well under [`TMUX_ARGV_LIMIT`]: the message also
/// carries a header and the client's own cwd/environment bookkeeping, and the
/// limit is an unrecoverable launch failure rather than a slowdown.
const TMUX_ARGV_BUDGET: usize = 12 * 1024;

/// The bytes a tmux client sends for `args` — each item and its terminator —
/// which is exactly what it measures against [`TMUX_ARGV_LIMIT`].
pub fn argv_bytes(args: &[String]) -> usize {
    args.iter().map(|a| a.len() + 1).sum()
}

/// Which of a `tmux ls` listing's sessions a clean quit ends: every session
/// Eldrun minted, and nothing else. Pure, so the ownership rule is tested
/// without a tmux server.
///
/// There used to be one exemption — the Trash workspace's sessions, kept so a
/// phone attached through the Mobile sidecar could keep working after the
/// desktop quit. That only made sense while the sidecar outlived the app; it
/// no longer does (`commands::mobile_control::stop_host_for_exit`), so a Trash
/// session left behind is an agent nobody can reach, i.e. exactly the leftover
/// the quit path exists to remove.
pub fn sessions_to_reap<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| is_eldrun_local_tmux_session(name))
        .map(str::to_string)
        .collect()
}

/// Whether a `tmux kill-session` failure means the session was already gone —
/// which is the desired end state, not an error. A session can exit between
/// `ls` and `kill-session`, and the server itself goes away with its last one.
pub fn kill_failure_is_already_gone(stderr: &str) -> bool {
    stderr.contains("can't find session")
        || stderr.contains("no server running")
        || stderr.contains("failed to connect to server")
}

/// End every tmux session Eldrun created on the local machine — the clean-quit
/// reap (TODO #85). Blocking; callers off the main thread wrap it in
/// `spawn_blocking`, the exit path runs it inline.
///
/// This deliberately lists the daemon rather than only the tabs currently
/// hydrated in the frontend: a session recovered from an earlier crash may
/// belong to an inactive project and therefore have no mounted tab in this run
/// yet. The `eldrun-` prefix is reserved for sessions Eldrun mints, so
/// user-managed sessions are never affected.
///
/// Reached from two places on purpose: the frontend's close handler (the
/// window's ×) and the backend's `RunEvent::Exit` net, which also catches the
/// exits that never run frontend code — a SIGTERM/SIGINT from the dev launcher,
/// an `app.exit()`. A renderer or process crash reaches neither, leaving the
/// sessions alive for restore.
pub fn kill_eldrun_sessions() -> Result<(), String> {
    if !tmux_available() {
        return Ok(());
    }
    let listed = crate::paths::command_no_window("tmux")
        .args(local_tmux_ls_args())
        .output()
        .map_err(|e| format!("could not list tmux sessions: {e}"))?;
    // `tmux ls` returns non-zero when no server is running, which is already
    // the desired end state for the quit path.
    if !listed.status.success() {
        return Ok(());
    }
    let sessions = crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&listed.stdout));
    let mut failures = Vec::new();
    for name in sessions_to_reap(sessions.iter().map(|s| s.name.as_str())) {
        let output = crate::paths::command_no_window("tmux")
            .args(local_tmux_kill_args(&name))
            .output()
            .map_err(|e| format!("could not run tmux: {e}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !kill_failure_is_already_gone(&detail) {
                failures.push(if detail.is_empty() {
                    name
                } else {
                    format!("{name}: {detail}")
                });
            }
        }
    }
    // Every Eldrun session is ending here, so every launcher is stale too.
    let _ = std::fs::remove_dir_all(crate::storage::state_dir().join("tmux-launch"));
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "could not stop every Eldrun local tmux session: {}",
            failures.join("; ")
        ))
    }
}

/// Whether a local tmux session is owned by Eldrun.
///
/// Session names are minted by the frontend as `eldrun-<scope>--…`; keeping the
/// ownership rule here means the quit path never touches a user-created session
/// such as `train` or `work`.
pub fn is_eldrun_local_tmux_session(session: &str) -> bool {
    session.starts_with(ELDRUN_LOCAL_TMUX_PREFIX)
}

/// Single-quote `s` for a POSIX shell (mirrors `ssh_exec::shell_quote`). Used only
/// to fold a command tab's `cmd`+`args` into the single command string tmux hands
/// to `sh -c`.
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

/// The tab variables worth putting in a session's environment, sorted so the
/// argv is deterministic (and testable).
///
/// `is_valid_env_key` keeps a key with shell metacharacters out of the `export`
/// fallback, where it would sit unquoted left of `=`. `TERM`/`COLORTERM` are
/// tmux's own to set per pane — feeding it the outer terminal's `TERM` is how a
/// pane ends up disagreeing with the terminal it is drawn in.
fn session_env_pairs(env: &HashMap<String, String>) -> Vec<(&str, &str)> {
    let mut pairs: Vec<(&str, &str)> = env
        .iter()
        .filter(|(k, _)| {
            is_valid_env_key(k) && k.as_str() != "TERM" && k.as_str() != "COLORTERM"
        })
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
}

/// Whether this machine's tmux understands `new-session -e` (added in 3.2).
/// Cached like [`tmux_available`]; the answer cannot change within a run.
#[cfg(unix)]
fn tmux_supports_session_env() -> bool {
    use std::sync::OnceLock;
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        crate::paths::command_no_window("tmux")
            .arg("-V")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| version_supports_session_env(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(false)
    })
}

#[cfg(not(unix))]
fn tmux_supports_session_env() -> bool {
    false
}

/// Parse `tmux -V` output for the `new-session -e` floor (3.2). Unrecognized
/// output is treated as *not* supporting it: emitting an unknown flag would make
/// every persistent tab fail to start, while the `export` fallback keeps the
/// case that matters (an agent tab) working.
fn version_supports_session_env(v_output: &str) -> bool {
    let rest = v_output.trim();
    let rest = rest.strip_prefix("tmux").unwrap_or(rest).trim();
    // Development builds ("master", "next-3.6") are past 3.2 by construction.
    let rest = match rest.strip_prefix("next-") {
        Some(r) => r,
        None if rest.starts_with("master") => return true,
        None => rest,
    };
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor) >= (3, 2)
}

/// Whether a usable `tmux` is on `PATH`. Cached after the first probe (the answer
/// cannot change within a run). Always `false` on Windows, which is what makes
/// every wrap here a no-op there.
#[cfg(unix)]
pub fn tmux_available() -> bool {
    use std::sync::OnceLock;
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        crate::paths::command_no_window("tmux")
            .arg("-V")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(not(unix))]
pub fn tmux_available() -> bool {
    false
}

/// Build the `tmux` argv (the value of `PtyOptions.args`, with `cmd` = `"tmux"`)
/// that spawns-or-attaches the session named `session`. Pure + unit-testable.
///
/// `target_cmd` empty ⇒ a bare `new-session` whose command is tmux's default
/// (the login shell) — the shell-tab / typed-command case (e.g. a Python run typed
/// into the shell), where the shell **outlives** the command so the session
/// survives its completion. `target_cmd` set (a command tab) ⇒ tmux runs
/// `<cmd> <args>; exec "$SHELL" -l`, i.e. the command, then a login shell, so the
/// session likewise persists after the command exits (reattach shows the result
/// rather than re-running it — the resumable-command-tab guarantee).
///
/// `-A` = attach if it exists / create otherwise (one command that is both start
/// and resume). Attach is deliberately non-evicting so desktop and phone clients
/// coexist. `status off` / `mouse on` / `window-size largest` are session-scoped
/// after a literal `;` argv item (tmux splits its argv on a standalone `;`).
/// `history-limit` alone comes **before** `new-session` and is `-g`: a pane
/// copies the limit at creation, so a `-t`-scoped set after the fact would leave
/// the session's one pane at tmux's default 2000 — see
/// [`ssh_exec::TMUX_HISTORY_LINES`](crate::services::ssh_exec::TMUX_HISTORY_LINES),
/// which also sizes the phone replay.
/// `env` is the tab's own environment, which a pane does **not** otherwise get:
/// tmux builds a new session's environment from the *server's* global one (fixed
/// when the server started), not from the client that creates the session, so
/// every tab after the first inherited the founding tab's variables. That is what
/// silently broke agent resume — Claude's `SessionStart` hook keys by
/// `$ELDRUN_TAB_UID`, saw the wrong value or none, wrote no
/// `live_sessions/<uid>` record, and `agent_session::resolve_*` then had nothing
/// to resume but the tab's original launch id (i.e. the conversation as it was
/// when the tab was first opened). See [`local_tmux_args_with`] for how the
/// variables are carried.
pub fn local_tmux_args(
    session: &str,
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
) -> Vec<String> {
    local_tmux_args_with(
        session,
        target_cmd,
        target_args,
        env,
        tmux_supports_session_env(),
    )
}

/// Testable core of [`local_tmux_args`]. `session_env` = the local tmux accepts
/// `new-session -e` (3.2+), which is the mechanism that carries `env` for **both**
/// tab kinds. Without it a command tab still gets its variables — they are
/// `export`ed at the head of the command line tmux runs — while a bare shell tab
/// keeps the pre-fix behavior, since there is no command line to prefix and
/// overriding tmux's `default-command` to synthesize one would take the user's
/// own `~/.tmux.conf` out of the loop.
///
/// Only a freshly *created* session is reached either way: `-A` on an existing
/// one attaches, and its pane keeps the process (and environment) it was started
/// with. That is the intended resume behavior, not a gap in this.
fn local_tmux_args_with(
    session: &str,
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> Vec<String> {
    let line = command_line(target_cmd, target_args, env, session_env);
    local_tmux_args_for(session, line.as_deref(), env, session_env)
}

/// The inline `<cmd> <args>` half of a command tab's tmux target, with the
/// `export`s ahead of it when the tmux has no `new-session -e`. `None` for a
/// shell tab (no command). Everything is [`shell_quote`]d, so it is the same
/// text whether it lands on the tmux argv or in a [`launcher_script`].
fn command_line(
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> Option<String> {
    if target_cmd.is_empty() {
        return None;
    }
    let mut line = String::new();
    if !session_env {
        for (k, v) in session_env_pairs(env) {
            line.push_str(&format!("export {}={}; ", k, shell_quote(v)));
        }
    }
    line.push_str(&shell_quote(target_cmd));
    for a in target_args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    Some(line)
}

/// A `#!/bin/sh` script that `exec`s the command tab's command — the carrier
/// for a command line too long for the tmux argv (see [`TMUX_ARGV_LIMIT`]).
/// tmux then runs `'<script>'; exec "$SHELL" -l`, which is the inline shape
/// with the long part moved out; the script `exec`s so the command replaces
/// the script's shell exactly as it replaced nothing before. Pure: the caller
/// writes it (see [`wrap_pty_options_local`]).
pub(crate) fn launcher_script(
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> String {
    let mut script = String::from("#!/bin/sh\n");
    if !session_env {
        for (k, v) in session_env_pairs(env) {
            script.push_str(&format!("export {k}={}\n", shell_quote(v)));
        }
    }
    // Exports are lines of their own above, so the command line itself is
    // rendered without them (`session_env = true`) and `exec`'d as one.
    let line = command_line(target_cmd, target_args, env, true).unwrap_or_default();
    script.push_str(&format!("exec {line}\n"));
    script
}

/// [`local_tmux_args_with`] with the command half already rendered: `line` is
/// what tmux runs before the trailing login shell, or `None` for a shell tab.
fn local_tmux_args_for(
    session: &str,
    line: Option<&str>,
    env: &HashMap<String, String>,
    session_env: bool,
) -> Vec<String> {
    let pairs = session_env_pairs(env);
    let mut args: Vec<String> = vec![
        "set-option".into(),
        "-g".into(),
        "history-limit".into(),
        TMUX_HISTORY_LINES.to_string(),
        ";".into(),
        "new-session".into(),
        "-A".into(),
    ];
    if session_env {
        for (k, v) in &pairs {
            args.push("-e".into());
            // One argv item, so no quoting: a value with spaces, quotes or `;`
            // reaches tmux exactly as written.
            args.push(format!("{k}={v}"));
        }
    }
    args.push("-s".into());
    args.push(session.to_string());
    if let Some(line) = line {
        // One positional arg = the command line tmux runs via `sh -c`. Keeping a
        // login shell after it is what makes a finished run reattachable.
        args.push(format!("{line}; exec \"${{SHELL:-/bin/bash}}\" -l"));
    }
    // Session options as trailing tmux commands (standalone ';' tokens split argv).
    for tok in [
        ";",
        "set-option",
        "-t",
        session,
        "status",
        "off",
        ";",
        "set-option",
        "-t",
        session,
        "mouse",
        "on",
        ";",
        "set-window-option",
        "-t",
        session,
        "window-size",
        "largest",
    ] {
        args.push(tok.to_string());
    }
    args
}

/// `tmux kill-session -t <session>` argv, for the explicit-close / Sessions-view
/// kill of a local persistent tab. `|| true` is unnecessary here (a missing
/// session just exits non-zero, which the fire-and-forget caller ignores).
pub fn local_tmux_kill_args(session: &str) -> Vec<String> {
    vec!["kill-session".into(), "-t".into(), session.to_string()]
}

/// `tmux rename-session -t <old> <new>` argv.
pub fn local_tmux_rename_args(old: &str, new: &str) -> Vec<String> {
    vec![
        "rename-session".into(),
        "-t".into(),
        old.to_string(),
        new.to_string(),
    ]
}

/// `tmux ls -F …` argv for listing local sessions (same format the remote path
/// parses via `ssh_exec::parse_tmux_ls`).
pub fn local_tmux_ls_args() -> Vec<String> {
    vec![
        "ls".into(),
        "-F".into(),
        "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}".into(),
    ]
}

/// Rewrite `opts` to spawn the tab inside a **local** tmux session when it carries
/// a `tmux_session` name and tmux is available. No-op otherwise (no name, or no
/// tmux — including all of Windows), leaving the tab to spawn exactly as before.
///
/// Only the resolved local command is rewritten. `cwd` is left for
/// `build_command` to apply to the `tmux` client, which a freshly-created session
/// does take its start directory from; `env` is **also** written into the session
/// explicitly, because that half is *not* inherited from the client (see
/// [`local_tmux_args`]). Callers must ensure this runs only for a **local** spawn
/// (not an `ssh`/`docker`-wrapped one) — see `commands::terminal::pty_spawn`, which
/// runs it last, after the session/fence rewrites have put their variables in
/// `opts.env`.
pub fn wrap_pty_options_local(opts: &mut PtyOptions) {
    if !tmux_available() {
        return;
    }
    let Some(session) = opts.tmux_session.clone() else {
        return;
    };
    let session_env = tmux_supports_session_env();
    let mut args = local_tmux_args_with(&session, &opts.cmd, &opts.args, &opts.env, session_env);
    if !opts.cmd.is_empty() && argv_bytes(&args) > TMUX_ARGV_BUDGET {
        // Past the client's message limit, tmux would exit with `command too
        // long` and the tab with `[process exited]`. Move the command into a
        // script and hand tmux its path instead.
        let script = launcher_script(&opts.cmd, &opts.args, &opts.env, session_env);
        match write_launcher(&session, &script) {
            Ok(path) => {
                let line = shell_quote(&path.to_string_lossy());
                args = local_tmux_args_for(&session, Some(&line), &opts.env, session_env);
            }
            Err(e) => {
                // Leave the long argv in place: tmux's own error is the honest
                // report, and the tab shows it.
                eprintln!("tmux_local: could not write launcher for '{session}': {e}");
            }
        }
    }
    opts.cmd = "tmux".to_string();
    opts.args = args;
}

/// Where a session's [`launcher_script`] lives:
/// `<state_dir>/tmux-launch/<session>.sh`. Keyed by the session name so a
/// respawn of the same tab overwrites its own script, and sanitized like the
/// other state-dir keys so a session name never becomes a path.
fn launcher_path(session: &str) -> std::path::PathBuf {
    crate::storage::state_dir()
        .join("tmux-launch")
        .join(format!("{}.sh", crate::storage::project_key(session)))
}

/// Write `script` as the session's launcher, executable by its owner only.
fn write_launcher(session: &str, script: &str) -> std::io::Result<std::path::PathBuf> {
    let path = launcher_path(session);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

/// Drop a session's launcher once the session is gone. The script only
/// matters while `new-session -A` might still *create* the session; a
/// respawn writes a fresh one, so nothing is lost by removing it early.
pub fn remove_launcher(session: &str) {
    let _ = std::fs::remove_file(launcher_path(session));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn shell_tab_uses_default_login_shell_and_options() {
        // No target command → bare new-session (tmux's default login shell) so the
        // shell survives a typed command's completion; options chained after `;`.
        let args = local_tmux_args_with("eldrun-abc", "", &[], &HashMap::new(), false);
        assert_eq!(
            args,
            vec![
                // history-limit precedes new-session: a pane copies it at
                // creation, so the trailing `-t`-scoped sets are too late.
                "set-option",
                "-g",
                "history-limit",
                "10000",
                ";",
                "new-session",
                "-A",
                "-s",
                "eldrun-abc",
                ";",
                "set-option",
                "-t",
                "eldrun-abc",
                "status",
                "off",
                ";",
                "set-option",
                "-t",
                "eldrun-abc",
                "mouse",
                "on",
                ";",
                "set-window-option",
                "-t",
                "eldrun-abc",
                "window-size",
                "largest",
            ]
        );
    }

    #[test]
    fn command_tab_runs_command_then_keeps_a_shell() {
        // A command tab keeps a login shell AFTER the command so the finished run
        // reattaches (resumable-command-tab guarantee) instead of re-running.
        let args =
            local_tmux_args_with("eldrun-x", "python", &["train.py".into()], &HashMap::new(), true);
        assert_eq!(args[5], "new-session");
        assert!(args.iter().any(|a| a == "eldrun-x"));
        let target = &args[9];
        assert_eq!(
            target,
            "'python' 'train.py'; exec \"${SHELL:-/bin/bash}\" -l"
        );
        // Options still trail.
        assert!(args
            .windows(2)
            .any(|w| w == [";".to_string(), "set-option".to_string()]));
    }

    #[test]
    fn tab_env_reaches_the_session_as_new_session_flags() {
        // The pane does not inherit the client's environment (tmux copies the
        // SERVER's), so the tab's own variables ride on `new-session -e` — sorted,
        // one argv item each, before `-s`.
        let env = env_of(&[
            ("ELDRUN_TAB_UID", "tab-uid-1"),
            // "sk-test" rather than a bare letter: `scripts/privacy-check.sh`
            // clears an api_key whose value is built out of placeholder words, and
            // reports every other one — a fixture must not need the override.
            ("ANTHROPIC_API_KEY", "sk-test"),
            // tmux owns TERM per pane; a bad key would land unquoted in `export`.
            ("TERM", "xterm-256color"),
            ("not a key", "x"),
        ]);
        let args = local_tmux_args_with("eldrun-x", "claude", &[], &env, true);
        let e: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "-e")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(e, vec!["ANTHROPIC_API_KEY=sk-test", "ELDRUN_TAB_UID=tab-uid-1"]);
        // …and the flags precede the session name, as tmux requires.
        let dash_s = args.iter().position(|a| a == "-s").unwrap();
        assert!(args.iter().position(|a| a == "-e").unwrap() < dash_s);
        assert_eq!(args[dash_s + 1], "eldrun-x");
    }

    #[test]
    fn without_session_env_support_a_command_tab_exports_inline() {
        // tmux < 3.2 has no `-e`; an agent tab still gets its key by exporting it
        // at the head of the command line tmux runs.
        let env = env_of(&[("ELDRUN_TAB_UID", "tab-uid-1"), ("Q", "a'b c")]);
        let args = local_tmux_args_with("eldrun-x", "claude", &[], &env, false);
        assert!(!args.iter().any(|a| a == "-e"));
        assert_eq!(
            args[9],
            "export ELDRUN_TAB_UID='tab-uid-1'; export Q='a'\\''b c'; \
             'claude'; exec \"${SHELL:-/bin/bash}\" -l"
        );
    }

    #[test]
    fn launcher_script_execs_the_same_quoted_line() {
        // The script carries exactly the text the inline form would have put on
        // the tmux argv — exports first when the tmux lacks `-e`, then the
        // quoted command — behind `exec`, so the command replaces the script's
        // shell the way it replaced nothing inline.
        let env = env_of(&[("ELDRUN_TAB_UID", "tab-uid-1")]);
        let args = vec!["--bind".to_string(), "/a b".to_string(), "it's".to_string()];
        assert_eq!(
            launcher_script("bwrap", &args, &env, true),
            "#!/bin/sh\nexec 'bwrap' '--bind' '/a b' 'it'\\''s'\n"
        );
        assert_eq!(
            launcher_script("bwrap", &args, &env, false),
            "#!/bin/sh\nexport ELDRUN_TAB_UID='tab-uid-1'\nexec 'bwrap' '--bind' '/a b' 'it'\\''s'\n"
        );
    }

    #[test]
    fn a_fence_sized_argv_is_over_budget_and_the_launcher_form_is_not() {
        // A fenced agent on a well-used machine: one `--ro-bind src dst` per
        // transcript dir, and 120 of those already pass tmux's message
        // limit — which is `command too long` and a dead tab. The launcher
        // form of the same tab is a few hundred bytes regardless.
        let mut fence: Vec<String> = Vec::new();
        for i in 0..120 {
            let p = format!("/home/user/.claude/projects/-home-user-eldrun-projects-project-{i:03}");
            fence.extend(["--ro-bind".to_string(), p.clone(), p]);
        }
        fence.extend(["--".to_string(), "claude".to_string()]);
        let env = env_of(&[("ELDRUN_TAB_UID", "tab-uid-1")]);
        let inline = local_tmux_args_with("eldrun-x", "bwrap", &fence, &env, true);
        assert!(argv_bytes(&inline) > TMUX_ARGV_LIMIT, "{}", argv_bytes(&inline));

        let line = shell_quote("/state/tmux-launch/eldrun-x.sh");
        let launched = local_tmux_args_for("eldrun-x", Some(&line), &env, true);
        assert!(argv_bytes(&launched) < TMUX_ARGV_BUDGET);
        let dash_s = launched.iter().position(|a| a == "-s").unwrap();
        assert_eq!(
            launched[dash_s + 2],
            "'/state/tmux-launch/eldrun-x.sh'; exec \"${SHELL:-/bin/bash}\" -l"
        );
        // The env still rides `-e`; only the command moved.
        assert!(launched.iter().any(|a| a == "ELDRUN_TAB_UID=tab-uid-1"));
        // A shell tab has no command line to move, launcher or not.
        assert!(command_line("", &[], &env, true).is_none());
    }

    #[test]
    fn launcher_path_cannot_leave_the_launch_dir() {
        let path = launcher_path("../../etc/x y");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_x_y.sh");
        assert!(path.parent().unwrap().ends_with("tmux-launch"));
    }

    #[test]
    fn session_env_floor_is_tmux_3_2() {
        assert!(version_supports_session_env("tmux 3.2\n"));
        assert!(version_supports_session_env("tmux 3.2a\n"));
        assert!(version_supports_session_env("tmux 3.6\n"));
        assert!(version_supports_session_env("tmux 4.0\n"));
        assert!(version_supports_session_env("tmux next-3.4\n"));
        assert!(version_supports_session_env("tmux master\n"));
        assert!(!version_supports_session_env("tmux 3.1c\n"));
        assert!(!version_supports_session_env("tmux 2.7\n"));
        // Unparseable → no flag: an unknown `-e` would kill every persistent tab.
        assert!(!version_supports_session_env(""));
        assert!(!version_supports_session_env("something else"));
    }

    #[test]
    fn kill_and_rename_argv() {
        assert_eq!(local_tmux_kill_args("s"), vec!["kill-session", "-t", "s"]);
        assert_eq!(
            local_tmux_rename_args("old", "new"),
            vec!["rename-session", "-t", "old", "new"]
        );
    }

    #[test]
    fn identifies_only_eldrun_owned_sessions() {
        assert!(is_eldrun_local_tmux_session("eldrun-project--shell-123"));
        assert!(!is_eldrun_local_tmux_session("train"));
        assert!(!is_eldrun_local_tmux_session("my-eldrun-run"));
    }

    #[test]
    fn quit_reaps_every_eldrun_session_including_trash_and_no_foreign_one() {
        // A user's own `train`/`work` sessions are never touched; every Eldrun-
        // minted one goes, the Trash workspace's included — the sidecar that
        // once justified keeping those stops with the app now.
        let trash = format!("eldrun-{}--agent-abc", crate::paths::TRASH_PROJECT_ID);
        let listed = [
            "train",
            "eldrun-p1--shell-1",
            trash.as_str(),
            "work",
            "my-eldrun-run",
        ];
        assert_eq!(
            sessions_to_reap(listed),
            vec!["eldrun-p1--shell-1".to_string(), trash.clone()]
        );
        assert!(sessions_to_reap(["train"]).is_empty());
    }

    #[test]
    fn already_gone_failures_are_not_errors() {
        assert!(kill_failure_is_already_gone("can't find session: eldrun-x"));
        assert!(kill_failure_is_already_gone("no server running on /tmp/tmux-1000/default"));
        assert!(kill_failure_is_already_gone("error connecting to /tmp/tmux-1000/default (failed to connect to server)"));
        assert!(!kill_failure_is_already_gone("permission denied"));
        assert!(!kill_failure_is_already_gone(""));
    }

    #[test]
    fn wrap_no_session_is_noop() {
        let mut opts = PtyOptions {
            id: "t".into(),
            cmd: "bash".into(),
            args: vec![],
            env: Default::default(),
            cwd: "/p".into(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        };
        wrap_pty_options_local(&mut opts);
        assert_eq!(opts.cmd, "bash");
    }
}
