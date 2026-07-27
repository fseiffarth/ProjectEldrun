# Agent session persistence

Referenced from `CLAUDE.md`.

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
session, following a `/clear`. For Claude the key is its launch id
(`--session-id`); Codex mints its own id so the key is a separate per-tab uuid
and the backend injects `codex resume <live-id>`. **Codex caveat:** user-level
Codex hooks need a one-time trust (`/hooks` in Codex) before they run. Gemini
and Vibe are still dropped (TODO 39d).
