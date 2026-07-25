# tmux session persistence

Referenced from `CLAUDE.md`.

**A shell/script tab runs inside a tmux session so a long run survives** (#85,
`docs/tmux_remote_plan.md`) — decoupled from the disposable channel, the tab
**reattaches** on relaunch. It covers **two axes**:

- **Remote** (on the SSH host): survives an SSH drop, a laptop sleep, a VPN drop,
  or Eldrun quitting. **Default ON** per remote project
  (`RemoteSpec.persist_sessions !== false`; opt out via the pill's "Persistent
  sessions (tmux)"). `ssh_exec::wrap_pty_options` nests the existing `exec …`
  inside `tmux new-session -A -D -s <name>`.
- **Local** (on this machine, Unix only — no tmux on Windows): survives an
  **Eldrun crash** (the tmux server is a daemon; the PTY only holds a client).
  **Default ON** via `settings.persist_local_sessions`. `services::tmux_local`
  rewrites the local spawn's `{cmd,args}` into a `tmux` argv in
  `commands::terminal::pty_spawn`, *after* the ssh/docker branch so only a
  genuinely local tab is wrapped.

Scoped to **shell tabs** (Python runs open one; a command runs inside the
session's login shell, which outlives it → the run reattaches, not re-runs) and
never the root scope — **agent tabs are excluded** (they resume via their own
session). The session name is a **`eldrun-<scope>--<uuid>` the frontend mints
once per shell tab and persists** (`TabEntry.tmuxSession`, `lib/tmuxSession.ts`'s
`newTmuxSessionName`) — *not* derived from the PTY id, which `loadFromLayout`
regenerates on restore (a derived name would fork a second session on relaunch
instead of reattaching); `tmux_attach` overrides it for a Sessions-view attach.
**Scoping the Sessions view to one project** (`remote_tmux_list` →
`ssh_exec::filter_sessions_for_project`) matters because the host is usually
shared — a cluster login node carries several Eldrun projects' runs and other
people's. It reads **two** signals, and the second is the load-bearing one:
the **name** settles a session outright when it carries a project id (this
project's prefix ⇒ shown, `eldrun-<other-project>--` ⇒ hidden), but that only
ever covers sessions minted *after* the name was scoped. Every session already
running on a host — the `eldrun-<uuid>` ones — and every hand-started session
carry no id at all, and on a cluster those outlive the change by weeks, so a
name-only rule leaves the view looking exactly as unscoped as before. Those are
attributed by **working directory** instead (`#{pane_current_path}` in
`tmux_ls_script`, `TmuxSession.current_path`): a session whose active pane sits
inside this host's `remote_path` is this project's, one running elsewhere is
not. A row whose host reported no path (older format) is shown rather than
silently dropped. Nothing is unreachable: the view's **"All host sessions"**
checkbox passes `include_all`, returning the host listing untouched, so an
orphaned run outside every project tree can still be attached to or killed.
**Kill vs. detach**: closing a tab **always detaches** —
`lib/closeRemoteTab.ts`'s `closeTabWithConfirm` just `removeTab`s, killing only the
ssh/PTY client, so the session lives on under its tmux daemon; an app-exit,
crash, or respawn likewise **leave the session alive**. Disconnecting a remote
machine is deliberately different: `remote_disconnect` and
`remote_disconnect_all_hosts` end *every* tmux session on each currently
connected host before tearing down its pool. A session's **×** remains the way to
terminate just that one session (`remote_tmux_kill`/`local_tmux_kill`). Global
machines also issue `remote_kill_all_jobs` before closing their master.
Because a session outlives its tab, a host
can hold runs no tab points at; the **Sessions view** (`☰` toggle in
`ProjectFilesView`, mirrors the Orange view) makes them discoverable —
**multi-host** (aggregated across the primary and every connected worker via
`remote_tmux_list`, each row host-tagged), click a row to attach, per-row **×**
(kill) and **Rename** (`remote_tmux_rename`, updates the owning tab's persisted
name). tmux-absent falls back to today's plain `exec` + a notice.
