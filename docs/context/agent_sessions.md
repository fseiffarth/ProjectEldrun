# Agent session persistence

Referenced from `AGENTS.md`.

The per-project tab layout (`tab_layout`/`tab_groups`) lives in
`<state_dir>/sessions/<id>/terminals.json` (see "Persistence" in `AGENTS.md`;
the copy inside a project folder is export-only). Shell/files tabs are always
restored on relaunch; agent tabs are normally dropped, **except resumable agent
tabs** — Claude and Codex tabs that carry a `sessionId` are persisted (with
their `sessionId`) and restored, respawning the agent so the prior conversation
comes back (see `isRestorableTab`/`RESUMABLE_AGENTS` in `src/stores/tabs.ts`).

## Mechanism

`services/agent_session.rs`, installed at startup: Eldrun installs a
`SessionStart` hook — into `~/.claude/settings.json` (JSON) and
`~/.codex/config.toml` (TOML text-append) — that records each tab's live
`session_id` under `~/.local/share/eldrun/live_sessions/<key>`, keyed by the
`ELDRUN_TAB_UID` env var Eldrun sets on the agent. At spawn,
`resolve_{claude,codex}_session` reads that to resume the *current* session,
following a `/clear`. The same script is also registered as a Claude `Stop`
hook: `Stop` fires after every response and — unlike `SessionStart` — carries
`permission_mode` in its payload, which the script records to
`live_sessions/<key>.mode`. The resolver re-applies that record as
`--permission-mode` on the `--resume` respawn, because Claude restores a mode
given at launch but *not* one reached via shift+tab mid-session (no hook event
fires for the cycle; verified empirically on CLI 2.1.251). This record is the
**only** thing that carries a mode across a respawn — Eldrun has no mode toggle
of its own; a mode flag a custom agent's own spec puts on the args outranks it,
and values outside the known mode set are discarded (the record is hook-parsed
JSON becoming a CLI argument).

For Claude the key is its launch id (`--session-id`); Codex mints its own id so
the key is a separate per-tab uuid and the backend injects
`codex resume <live-id>`. **Codex caveat:** user-level Codex hooks need a
one-time trust (`/hooks` in Codex) before they run; until then
`services::codex_bind` follows Codex's own rollout logs and writes the same
record. Gemini and the other "continue last" agents restore on their CLI's
continue flag, not a captured id.

### Where Codex keeps a session, and why resume died

The resume arg is emitted only when Codex still *has* the recorded
conversation, and that question has two answers in the field:

- the **rollout log** at
  `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, which is what
  every release up to 0.153.4 wrote;
- the **thread store** `~/.codex/state_<n>.sqlite`, which is where 0.153.4 puts
  it instead. Rows there still *name* a `rollout_path`, but no such file is
  created any more — `~/.codex/sessions/` does not exist on a fresh install.

Asking only the first is how Codex resume failed silently: the hook kept
recording live thread ids, the walk kept finding no file for any of them, and
every Codex tab relaunched as a **brand-new session** — which is also why the
folder-trust question came back on every Eldrun restart, since a fresh Codex
start in an untrusted cwd is exactly what asks it. `codex_session_exists` now
takes either answer, and `services::codex_store` reads the store (read-only,
best-effort: a renamed file, table or column yields "no", never an error). The
store's files are ordinary `~/.codex` entries, so the fence and the container
mount them by the same per-entry rule the rollout dir got — see
`CODEX_UNMOUNTED`.

The *other* half of the repeated question is the fence's config shadow.
`~/.codex/config.toml` is staged as a per-project throwaway copy so an agent
cannot repoint the host's SessionStart hook, and re-copying the host original at
every spawn threw away the `[projects."<path>"] trust_level` Codex had just
recorded there. `staged_config_mounts` now carries those tables — and only
those — across a restage, so the answer the user gave inside the fence sticks
while the rest of the file stays the host's, and nothing is ever written back to
the host.

## Only the tab's own session may move the record

Every process under the tab inherits `ELDRUN_TAB_UID`, so a nested CLI fires
the hook too — the tab's Claude running `claude -p …` through its own shell
tool does (verified live: a one-shot headless run overwrote both the id and the
mode record, so the next relaunch would have resumed a dead session in the
wrong mode). The script therefore applies a continuity rule, keyed by a second
env var the resolver sets, `ELDRUN_TAB_AGENT`:

- **Claude** (`claude`, and the default when the marker is missing): a Claude
  tab's session id *is* its launch key, stays that id until `/clear` or
  `/resume` rolls it, and `Stop` never introduces an id. So a session id that is
  neither the key nor the current record is accepted only from a `SessionStart`
  whose `source` is `clear` or `resume`; a nested `-p` run's `startup` and its
  `Stop` are refused, and the mode is written only alongside an accepted id.
- **Codex** (`codex`): Codex mints its ids, so its record is free-form — except
  that a Claude fired inside a Codex tab is refused outright (`CLAUDECODE` is
  set by Claude for its children, never by Codex). The rollout binder also
  adopts a hook-written id only when Codex actually has a rollout for it.

Both scripts (POSIX `sh`, PowerShell) implement the same rule; the POSIX one is
run for real by a unit test.

## Where the agent runs on restore

`loadFromLayout` resets an agent tab's cwd to the scope root — a saved cwd is
stale after a project move — except for cwds the scope *derives*: a linked
worktree under the root (`<root>/.eldrun/worktrees/<name>`) and, for a box
scope, a member project's root (or a worktree under one), which is where the
"+" menu's per-member Claude tab is deliberately started. `restoredAgentCwd`
in `src/lib/agentWorktrees.ts` is the rule; the box restore passes its member
roots as `agentRoots`. (On the current Claude CLI `--resume <id>` finds a
session from any cwd — verified live — so the cwd decides where the agent
*works*, not whether the conversation comes back.)

## Reusing a session id is fatal

`claude --session-id <id>` for an id that already has a transcript exits with
"Session ID … is already in use" (verified live). The resolver only downgrades a
`--resume` to `--session-id <launch>` when it can find no log for the id, so
every place a log can be has to be probed:

- `~/.claude/projects/*/<id>.jsonl` — the ordinary case;
- the project's **sandbox stage** (`<state_dir>/sandbox-stage/<project>/
  claude-projects/`), where a fenced or contained agent writes a transcript for
  a cwd that had no host dir yet. It is harvested into `~/.claude/projects`
  when the tab goes away — and, for a crashed run, by
  `sandbox::harvest_and_clear_stage` at startup, which runs **synchronously
  before the window can restore anything** (it used to share the off-thread
  container sweep, racing the restored tabs);
- a **remote** tab's Claude runs on the far host, where no hook is installed
  and the local probe sees nothing. The remote command therefore decides on the
  host (`ssh_exec::host_side_resume`): a transcript named after the id under
  any project dir there means `--resume`, else the fresh `--session-id`. A
  `/clear` on the host is not followed (the launch id is what comes back), no
  mode is re-applied, and a remote Codex tab has no resume path at all beyond
  its surviving tmux session.
