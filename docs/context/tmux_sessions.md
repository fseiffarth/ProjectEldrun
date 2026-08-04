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
session's login shell, which outlives it → the run reattaches, not re-runs) and,
**since the remote-agent extension**, to **remote agent tabs** (Claude, Codex,
any SSH-hosted agent) — never the root scope, and never a **local** agent
(`local_agent`, host-bound Ollama). An agent tab now carries a persisted tmux name
**in addition to** its `--resume` restore, and the two **compose** through
`new-session -A`: when the host session is still alive (the laptop-shutdown case)
the wrap **reattaches** the still-running agent and the `--resume` target is ignored;
when it is gone (host rebooted, session killed) `-A` creates a fresh session that runs
`--resume`, so the conversation resumes exactly as it did before. The agent bootstrap
prelude is nested inside the tmux target unchanged, the same way a shell tab's login
shell is. The session name is a **`eldrun-<scope>--<kind>-<uuid>` the frontend mints
once per tab and persists** (`TabEntry.tmuxSession`, `lib/tmuxSession.ts`'s
`newTmuxSessionName`) — *not* derived from the PTY id, which `loadFromLayout`
regenerates on restore (a derived name would fork a second session on relaunch
instead of reattaching); `tmux_attach` overrides it for a Sessions-view attach.
The `<kind>` token (`agent`/`shell`) sits at the *front of the uuid half*, after
the `--`, so it never disturbs the `eldrun-<scope>--` prefix the project filter
matches on, and a uuid (hex) can never begin with `agent`/`shell` so an older
tokenless name reads back cleanly as neither. `sessionKindFromName` is the pure
inverse, and it is the whole basis of the Sessions view's **second** grouping:
rows are grouped **first by machine** (`tmux-machine-group`), then **by session
type** within each machine (Agents / Shells / Other sub-headings,
`tmux-kind-group`), an empty bucket dropped and `Other` — foreign/legacy/renamed
sessions — shown only when non-empty. The grouping is entirely a function of the
name; the backend `TmuxSession` carries no kind field and did not need one.
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
**An empty list must mean "we asked and there is nothing"**, and for a while it
did not. `tmux_ls_script` ends in `|| true` so an absent tmux or a stopped
server is a clean empty listing rather than an error — but `run_remote_script`
only errors when `ssh` fails to *spawn*, so a failed **login** (exit 255, empty
stdout) parsed to the same empty list, and the frontend poll's `.catch(() => [])`
did the same for a hard rejection. Both said "no persistent sessions on the
host" about a host full of them. It is not a rare path: this probe spawns its
**own** `ssh` riding the shared `cm-%C` socket rather than the pooled session,
so whenever that socket is missing or being replaced (`remote::connect_host`
reopens a master whose socket went away; a sibling teardown, an `ssh -O exit`)
it falls back to a fresh login with no credential to answer, fails for one 7 s
tick and succeeds on the next — a Sessions view that blanks and comes back.
`remote_tmux_list` now returns `Err` on a non-zero exit status, and
`stores/hostSessions`' poll carries a **failed host's previous rows forward**
rather than folding them into the reading; a host that answers with nothing
still empties, or a killed session would never leave the list. This is the same
rule `release` already kept the last reading for.
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
