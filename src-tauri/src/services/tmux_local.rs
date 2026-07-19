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
//! spawns `tmux` itself, and `cwd`/`env` set on the client are inherited by a
//! freshly-created session.

use crate::terminal::PtyOptions;

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
/// and resume); `-D` = detach any other client (a stale one from before a
/// crash/reload); `status off` / `mouse on` are chained as separate tmux commands
/// after a literal `;` argv item (tmux splits its argv on a standalone `;`).
pub fn local_tmux_args(session: &str, target_cmd: &str, target_args: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "new-session".into(),
        "-A".into(),
        "-D".into(),
        "-s".into(),
        session.to_string(),
    ];
    if !target_cmd.is_empty() {
        // One positional arg = the command line tmux runs via `sh -c`. Keeping a
        // login shell after it is what makes a finished run reattachable.
        let mut line = shell_quote(target_cmd);
        for a in target_args {
            line.push(' ');
            line.push_str(&shell_quote(a));
        }
        line.push_str("; exec \"${SHELL:-/bin/bash}\" -l");
        args.push(line);
    }
    // Session options as trailing tmux commands (standalone ';' tokens split argv).
    for tok in [";", "set", "-g", "status", "off", ";", "set", "-g", "mouse", "on"] {
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
        "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}".into(),
    ]
}

/// Rewrite `opts` to spawn the tab inside a **local** tmux session when it carries
/// a `tmux_session` name and tmux is available. No-op otherwise (no name, or no
/// tmux — including all of Windows), leaving the tab to spawn exactly as before.
///
/// Only the resolved local command is rewritten; `cwd`/`env` are left for
/// `build_command` to apply to the `tmux` client, so a freshly-created session
/// inherits them. Callers must ensure this runs only for a **local** spawn (not an
/// `ssh`/`docker`-wrapped one) — see `commands::terminal::pty_spawn`.
pub fn wrap_pty_options_local(opts: &mut PtyOptions) {
    if !tmux_available() {
        return;
    }
    let Some(session) = opts.tmux_session.clone() else {
        return;
    };
    let args = local_tmux_args(&session, &opts.cmd, &opts.args);
    opts.cmd = "tmux".to_string();
    opts.args = args;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_tab_uses_default_login_shell_and_options() {
        // No target command → bare new-session (tmux's default login shell) so the
        // shell survives a typed command's completion; options chained after `;`.
        let args = local_tmux_args("eldrun-abc", "", &[]);
        assert_eq!(
            args,
            vec![
                "new-session", "-A", "-D", "-s", "eldrun-abc",
                ";", "set", "-g", "status", "off",
                ";", "set", "-g", "mouse", "on",
            ]
        );
    }

    #[test]
    fn command_tab_runs_command_then_keeps_a_shell() {
        // A command tab keeps a login shell AFTER the command so the finished run
        // reattaches (resumable-command-tab guarantee) instead of re-running.
        let args = local_tmux_args("eldrun-x", "python", &["train.py".into()]);
        assert_eq!(args[0], "new-session");
        assert!(args.iter().any(|a| a == "eldrun-x"));
        let target = &args[5];
        assert_eq!(target, "'python' 'train.py'; exec \"${SHELL:-/bin/bash}\" -l");
        // Options still trail.
        assert!(args.windows(2).any(|w| w == [";".to_string(), "set".to_string()]));
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
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
        };
        wrap_pty_options_local(&mut opts);
        assert_eq!(opts.cmd, "bash");
    }
}
