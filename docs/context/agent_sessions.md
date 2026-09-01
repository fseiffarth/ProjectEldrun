# Agent session persistence

Referenced from `AGENTS.md`.

Project-local state lives in each project's `project.json`. This includes the
per-project tab layout (`tab_layout`/`tab_groups`). Shell/files tabs are always
restored on relaunch; agent tabs are normally dropped, **except resumable agent
tabs** — Claude and Codex tabs that carry a `sessionId` are persisted (with
their `sessionId`) and restored, respawning the agent so the prior conversation
comes back (see `isRestorableTab`/`RESUMABLE_AGENTS` in `src/stores/tabs.ts`).
Mechanism (`services/agent_session.rs`, installed at startup): Eldrun installs a
`SessionStart` hook — into `~/.claude/settings.json` (JSON) and
`~/.codex/config.toml` (TOML text-append) — that records each tab's live
`session_id` under `~/.local/share/eldrun/live_sessions/<key>`, keyed by the
`ELDRUN_TAB_UID` env var Eldrun sets on the agent. At spawn,
`terminal::resolve_{claude,codex}_session` reads that to resume the *current*
session, following a `/clear`. The same script is also registered as a Claude
`Stop` hook: `Stop` fires after every response and — unlike `SessionStart` —
carries `permission_mode` in its payload, which the script records to
`live_sessions/<key>.mode`. The resolver re-applies that record as
`--permission-mode` on the `--resume` respawn, because Claude restores a mode
given at launch but *not* one reached via shift+tab mid-session (no hook event
fires for the cycle; verified empirically on CLI 2.1.251). An explicit mode
flag already on the tab's args (the Plan/Auto toggle) outranks the record, and
values outside the known mode set are discarded. For Claude the key is its launch id
(`--session-id`); Codex mints its own id so the key is a separate per-tab uuid
and the backend injects `codex resume <live-id>`. **Codex caveat:** user-level
Codex hooks need a one-time trust (`/hooks` in Codex) before they run. Gemini
and Vibe are still dropped (TODO 39d).
