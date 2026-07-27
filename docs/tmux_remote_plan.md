# Persistent Remote Sessions (tmux) — Implementation Plan (TODO #85)

Status: **implemented** (Phases 0–4; live-QA on a real host still pending — Done ≠ Tested).

**What shipped vs. this plan.** Two deliberate changes from the design below:

1. **Default ON**, not opt-in behind the experimental flag (per the user).
   `RemoteSpec.persist_sessions` means "default on unless explicitly `false`", the
   pill's "Persistent sessions (tmux)" item is the opt-**out**, and the per-spawn
   decision is `PtyOptions.tmux_session` (set only for remote `shell` tabs — Python
   runs open a shell tab — never agents).

2. **The session name is a frontend-minted uuid persisted on the tab**
   (`TabEntry.tmuxSession`, `newTmuxSessionName`), *not* derived from the tab id
   (§Data model option 1). The reason: `loadFromLayout` regenerates a tab's key on
   every restart, so a name derived from the PTY id (`<scope>:<tab-key>`) would
   change on relaunch and **fork a second session instead of reattaching** — the
   opposite of the goal. `ELDRUN_TAB_UID` (the plan's suggested source) only exists
   for agent tabs anyway. Minting once and persisting it makes the name stable
   across a relaunch, which is what makes restart-reattach work.

Key symbols: backend `ssh_exec::{TmuxWrap, tmux_wrap_exec,
tmux_kill_session_script, tmux_rename_session_script, tmux_ls_script,
parse_tmux_ls, TmuxSession, valid_tmux_session_name}` + `services::tmux_local` +
`PtyOptions.{tmux_session,tmux_attach}`, commands
`remote_tmux_{list,kill,rename}`/`local_tmux_{list,kill,rename}`/`set_project_persist_sessions`;
frontend `lib/tmuxSession.ts` (mint + gate), `lib/closeRemoteTab.ts`, the persisted
`TabEntry.tmuxSession`/`tmuxAttach`, and the Sessions view in `ProjectFilesView.tsx`.

### Post-v1 additions (this pass)

- **Local persistence (Unix)** — the plan below scoped tmux to *remote* tabs, calling
  local "impossible on Windows and low-value elsewhere." Shipped anyway (per the
  user): a **local** project's shell/script tab is wrapped in a tmux session on the
  machine so a run survives an **Eldrun crash** and reattaches on restart. Works
  because the tmux server is a daemon the PTY-held client is separate from; **Unix
  only** (no tmux on Windows → `services::tmux_local` no-ops), **default ON** via
  `settings.persist_local_sessions`. The wrap is an argv rewrite in `pty_spawn`
  (not a `$SHELL -c` string like the remote path), applied only when ssh/docker
  wrapping did **not** fire.
- **Worker-host sessions** — the Sessions view now aggregates across the primary
  **and every connected worker** (`docs/multi_host_remote_plan.md`), each row
  host-tagged; attach/kill/rename act on the row's host. The wrap itself was already
  host-agnostic (it runs per-host via `remote_host_id`), so only the view changed.
- **Rename** — per-row Rename in the Sessions view (`remote_tmux_rename` /
  `local_tmux_rename`, gated on `valid_tmux_session_name`) also updates the owning
  tab's persisted `tmuxSession`/`tmuxAttach` so it reattaches to the new name after a
  restart (the live client stays attached — tmux rename never drops it).
- **Resumable command tabs** — largely already satisfied: a script/command runs in a
  persistent shell tab (the `lib/pythonRun.ts` pattern — a login shell that outlives
  the command), so it restores and reattaches to the *completed* run rather than
  re-running. For a directly-`cmd`'d local command tab, `local_tmux_args` keeps a
  login shell **after** the command for the same guarantee.

## The problem, in one sentence

A remote shell or script is a child of the `ssh -tt` channel, so it dies —
silently, with `SIGHUP` — the instant that channel breaks: a network blip, a
laptop sleep, a VPN drop, or Eldrun quitting. For a long Python training run
that is the worst possible outcome, and it is exactly the case Eldrun cannot
survive today.

The fix is to run the remote shell/script **inside a tmux server on the host**,
decoupled from the SSH channel. The SSH client becomes a disposable viewer; the
work lives on the server. Reconnect — or relaunch Eldrun — and the same command
reattaches to the still-running session, output and all.

## Why this is server-side, and what that means for Windows/macOS

tmux runs on the **remote host** (a Linux box — essentially always, for a
compute/experiment host). The local machine only ever runs the `ssh` client. So
a Windows or macOS Eldrun connecting to that host gets **identical**
persistence: the feature is entirely server-side and is *not* obsolete on those
platforms — it is the whole point that the run is decoupled from your laptop's
OS, network, and Eldrun process. The only local-OS wrinkle is cosmetic and
already handled elsewhere (Windows skips ControlMaster, `ssh_exec.rs:187`); the
tmux path is untouched by it.

**Scope is therefore remote projects only.** Local (non-remote) tabs are a
weaker, harder story — the process is Eldrun's own child, not decoupled by SSH,
so surviving an Eldrun restart would need tmux/dtach *locally* too, which is
impossible on Windows and low-value elsewhere. Out of scope for this item.

## The one seam

Every remote tab's command is built by **`remote_command`** (`ssh_exec.rs:117`),
called from **`wrap_pty_options`** (`ssh_exec.rs:500`). Today it emits:

```
cd <remote_path> && export K=<v> … && exec "${SHELL:-/bin/bash}" -l          # shell tab
cd <remote_path> && export K=<v> … && exec "${SHELL:-/bin/bash}" -lc '<cmd>' # command/agent tab
```

The tmux wrap replaces only the final `exec …` with a tmux launch. Everything
before it — the `cd`, the sorted env exports, the `remote_agents` bootstrap
prelude (`ssh_exec.rs:159`) — is preserved verbatim, nested *inside* tmux:

```
cd <remote_path> && export … && exec tmux new-session -A -D -s eldrun-<name> -- \
    "${SHELL:-/bin/bash}" -l                          # shell tab
cd <remote_path> && export … && exec tmux new-session -A -D -s eldrun-<name> -- \
    "${SHELL:-/bin/bash}" -lc '<cmd>'                 # command/agent tab
```

Flags, each load-bearing:

- **`-A`** — attach if the session exists, create it if not. This single command
  is *both* "start" and "resume": on first spawn it creates and runs the target;
  on a reconnect/relaunch it reattaches and the target arg is ignored (the
  process is already running). This is what makes restart-resume free.
- **`-D`** — on attach, detach any *other* client first. Stops a stale ssh
  client (ControlPersist can outlive a reload) or a second Eldrun window from
  mirror-sharing the pane and fighting over its size.
- **`-s eldrun-<name>`** — a **stable per-tab session name**. The one piece of
  new persisted state (see Data model). If it is not stable across restarts,
  reattach silently creates a *second* session instead of resuming.

`ssh_pty_args` (`ssh_exec.rs:176`) is unchanged: it still forces `-tt`, and it
deliberately omits `BatchMode`, so a first-run interactive prompt (host key,
passphrase) still works through the terminal even with tmux in the middle.

## Data model — one field, no migration

A per-tab boolean plus a derived session name. Two options:

1. **Reuse the existing tab identity.** The frontend already mints
   `ELDRUN_TAB_UID` (persisted, and already exported to the host). Derive
   `eldrun-<uid>` in `wrap_pty_options` — no schema change at all, and the name
   is automatically stable across restarts because the uid is.
2. **Explicit `tmuxSession` on the tab**, mirrored like `sessionId`
   (`tabs.ts:372`), if we ever want a human-named session decoupled from the
   tab. Not needed for v1.

A tab that **attaches** to an arbitrary named session (from the Sessions view,
below) carries that name explicitly — `tmuxAttach: Option<String>` on the tab —
so `wrap_pty_options` builds an attach rather than a fresh spawn, and the tab
restores/reattaches to *that* session across a restart. This is the one case
where the session name is not derived from the tab uid (the session predates the
tab), so it must be persisted on the tab.

Go with (1) for tabs Eldrun starts. The opt-in is a per-project toggle
(`RemoteSpec` gains
`persist_sessions: Option<bool>`, mirrored into `projects.json` `extra` and the
`types/index.ts` mirror, defaulting to unset ⇒ off) so it upgrades every
existing remote project in place with no migration — same pattern as the sandbox
toggle. Gate the whole thing behind the experimental flag
(`lib/experimental.ts`) until live-QA'd.

## Restart-resume — most of the machinery already exists

The reattach path is already there; tmux just makes it *mean something* for
remote work.

- A remote **shell** tab is *already* restorable — `isRestorableKind`
  (`tabs.ts:3416`) is true for shell/files kinds, so on relaunch Eldrun already
  respawns its ssh command. Today that respawn gets a *fresh* shell (the prior
  run is gone). With tmux, the respawned command is
  `tmux new-session -A -s eldrun-<uid>` → it **reattaches** to the session that
  kept running. No new restore code for shells — the wrap alone delivers it.
- **Scripts** run *inside* a shell/command tab (this is already true —
  `lib/pythonRun.ts` opens a terminal tab and types the command, precisely so it
  inherits tab locality). So a persistent shell tab carries a running Python
  process through a restart for free. A dedicated resumable *command* tab (like
  `RESUMABLE_AGENTS`, `tabs.ts:3452`) is a possible follow-up but not required
  for v1.

## Kill vs. detach — the one genuinely new decision

Today closing a tab reaps the whole remote subtree (backend `CLAUDE.md`,
`terminal/mod.rs` `kill`). With tmux, closing the ssh client must **not** kill
the session — that would defeat the entire feature. Split the intent:

- **Close tab** (an explicit user action) → kill the session:
  `tmux kill-session -t eldrun-<uid>`, fired as a one-shot over the pooled
  ControlMaster via **`run_remote_script`** (`ssh_exec.rs:300`) — the transport
  already exists, no new plumbing. The local ssh child is reaped as today.
- **Eldrun quit / connection drop** → leave the session alive on the host. An
  explicit machine disconnect ends that host's tmux sessions before closing SSH.

The seam: the tab-close path (`kill`) needs to know whether the tab was a
persistent remote tab, and if so run the kill-session one-shot *before* reaping
the ssh child. App-exit (`kill_all`) and remote-disconnect must **not**.

## tmux presence & fallback

Detect and degrade gracefully, reusing the `remote_agents.rs::bootstrap_prelude`
pattern (`command -v tmux >/dev/null || …`):

- **Present** → wrap as above.
- **Absent** → run the plain `exec` (today's behavior) and surface a one-line
  notice that persistence is off because tmux is missing. Note tmux is *usually*
  preinstalled on compute/HPC hosts, but userspace-installing it (no sudo) is
  harder than an npm-installable agent CLI, so the realistic fallback is
  "run without persistence + tell the user," **not** auto-install.

## UX cost — the honest trade

tmux intercepts scrollback (its own copy-mode) and draws a status bar, which can
make an xterm.js pane feel less native. Mitigations, shipped as session options:

- `set -g status off` — reclaim the status line; Eldrun already provides tabs and
  layout, so tmux's status bar is redundant chrome.
- `set -g mouse on` — wheel scrolls tmux history so scrollback still feels normal.

**Alternative worth weighing: `dtach`/`abduco`.** These give pure detach/attach
with *no* status bar, no windows, and no scrollback interception — a strictly
more transparent fit for Eldrun's model, since we already own tabs and layout.
The trade is availability: tmux is far more likely to be preinstalled on a
random compute host. Recommendation: **build on tmux** (what the user asked for,
and the common denominator), but keep the wrap behind a tiny "session backend"
indirection so a `dtach` backend can be added later without touching the seam.

## Composition with the other axes

- **Docker containers** are mutually exclusive with ssh wrapping
  (`terminal.rs:116`) — a container project is local. No interaction.
- **Worker hosts** (multi-host) each get their own pool entry and could each run
  their own tmux session (`eldrun-<uid>` is already unique per tab, and tab
  locality is `host:<id>`); the wrap is host-agnostic. v1 can apply it to the
  primary only and extend to workers trivially later.
- **Agent tabs** — the `remote_agents` bootstrap prelude nests *inside* the tmux
  target command untouched. A remote Claude/Codex tab could run inside tmux too,
  but agent *conversation* resume is already handled by `RESUMABLE_AGENTS`; the
  tmux value there is narrower (surviving a mid-response disconnect). v1 can
  scope tmux to shell/command tabs and leave agent tabs as-is.

## Surfacing "your run is still alive" — the Sessions view

Because a persistent session outlives the tab that started it, the host can hold
sessions no open tab points at: a run from a crashed/relaunched Eldrun, a
different machine, or one the user started by hand in a plain ssh terminal. Those
must be **discoverable and reattachable**, or the persistence is a trap. This is
the primary UI surface for the feature.

**A "Sessions" view in the file viewer**, alongside Files / Git / Search / Apps /
Orange (`ProjectFilesView.tsx:33,607`). It is the exact analog of the **Orange
(diverged)** view (`ProjectFilesView.tsx:619-632`): a toolbar toggle gated on
`project?.remote && projectId`, badged with a live count, that swaps the tree for
a backend-fed list. Because `ProjectFilesView` renders *twice* (RightPanel and
the Files (Project) tab), the view — and its click-to-open — appears in **both**
the right-side files panel and the Files tab with no extra wiring, exactly as the
Orange view does.

- **Toolbar button:** `☰ N` (session count), remote-only, next to the `±` orange
  toggle. Toggles `view === "sessions"`.
- **List rows:** one per host tmux session. Each row shows the session **name**,
  window/pane count, created/idle time, and an **attached** dot (another client
  is on it right now). Rows Eldrun created (`eldrun-<uid>` prefix) are labelled
  with the originating project/tab when known; foreign sessions show their raw
  name — both are first-class.
- **Click a row → open the running session.** Opens a shell tab whose remote
  command is an **attach**, not a fresh shell: `tmux new-session -A -D -s <name>`
  with no target command (idempotent: attaches the existing session; `-D`
  detaches any other client so keystrokes aren't mirrored). The tab carries the
  session name so it restores and reattaches like any persistent tab. This is why
  attach must accept an **arbitrary** name, not just `eldrun-<uid>` — a
  hand-started `train` session opens the same way.
- **Per-row actions:** **Kill** (`tmux kill-session -t <name>`, confirmed) and,
  for an already-open session, "reveal the tab that owns it". Both ride the same
  one-shot transport.

**Backend:** one new pure-ish command `remote_tmux_list(project_id, host_id)` →
`tmux ls -F '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}'`
over `run_remote_script` (`ssh_exec.rs:300`), parsed into a `Vec<TmuxSession>`
(empty, not an error, when tmux is absent or no server is running — `tmux ls`
exits non-zero with "no server running", which the parser treats as zero
sessions). Polled on the same cadence as the orange/status poll, so the count
badge stays live. The attach path reuses the existing `wrap_pty_options` seam —
the tab just declares "attach to session `<name>`" instead of "run `<cmd>`".

**Close confirm.** On **close** of a persistent remote tab, confirm ("This will
terminate the remote session `eldrun-<uid>` and any process running in it") — the
mirror of the container toggle's non-resumable-conversation confirm, and in the
spirit of `LocalLossDialog`: the tab is a window onto a live process, and closing
it (vs. detaching) is destructive.

## Phases

- **Phase 0 — wrap + flag.** `remote_command` grows a `persist: bool` param;
  `wrap_pty_options` passes the project's `persist_sessions` (gated on the
  experimental flag). Pure, unit-testable: assert the exact tmux argv for
  shell/command tabs, and that env/`cd`/bootstrap-prelude nesting is unchanged
  when off. **No runtime behavior change until the flag/toggle is on.**
- **Phase 1 — kill semantics.** Thread "is a persistent remote tab" into the
  `kill` path; fire `tmux kill-session` via `run_remote_script` on explicit
  close only. App-exit leaves sessions alive; machine disconnect ends its host's
  sessions. Unit-test the
  branch selection (kill-session fired vs. not) without a real host.
- **Phase 2 — presence + transparency.** tmux-detect fallback prelude; ship the
  `status off` / `mouse on` options; the missing-tmux notice.
- **Phase 3 — UI: the toggle + close-confirm.** The per-project persistence
  toggle in the remote menu; the close-confirm on a persistent tab.
- **Phase 4 — the Sessions view.** `remote_tmux_list` command + `TmuxSession`
  type; the `☰ N` toolbar toggle and list view in `ProjectFilesView` (mirrors
  the Orange view); click-to-attach opening a shell tab via the attach seam;
  per-row kill/reveal. This is the item's headline surface, not a stretch goal.
- **Phase 5 (deferred).** `dtach` backend behind the session-backend
  indirection; worker-host sessions; resumable remote *command* tabs.

## Tests

- **Automated (mine):** argv builders in `ssh_exec.rs` (tmux wrap on/off, both
  tab kinds, nesting preserved, session name stable from uid; **attach** argv for
  an arbitrary session name); `tmux ls` output parsing (normal list, "no server
  running" → zero, tmux-absent → zero); kill-path branch selection; frontend
  toggle/persistence (tsc + a `tabs` restore test proving both a persistent
  remote shell tab and an *attach* tab restore to the same session name).
- **Manual (the user's — Done ≠ Tested; I can't launch Eldrun or reach a host):**
  1. Remote project, toggle on, start `python -u long_run.py` in a shell tab;
     kill the network / sleep the laptop → reconnect → same output continues.
  2. Quit Eldrun mid-run → relaunch → the shell tab reattaches, run still going.
  3. **Explicitly close** the tab → confirm the session is gone on the host
     (`tmux ls` shows no `eldrun-<uid>`).
  4. Host without tmux → tab still works, notice shown, no persistence.
  5. Two Eldrun windows / a stale client → `-D` detaches the other, no mirror.
  6. **Sessions view:** start a `tmux` session by hand on the host in a plain
     terminal → it appears in the `☰` list → click it → a tab attaches and shows
     the live process → per-row Kill removes it and it drops from the list.
