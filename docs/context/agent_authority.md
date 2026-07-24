# Agent authority axes

Referenced from `CLAUDE.md`.

**Agent authority has three axes**, and they compose: the project container
`sandbox` (OS containment), the tab's `location` (where the process runs), and — behind the
experimental `agent_mode_toggle` setting, default off — its `agentMode`: **Plan**
vs **Auto** (Claude `--permission-mode plan`/`acceptEdits`; Gemini
`--approval-mode plan`/`auto_edit`). The mode is a *launch flag*, so flipping it
rewrites the tab's `args`, which respawns the PTY (`TerminalView`'s spawn effect
keys on them) — non-destructive only because the tab resumes its conversation on
respawn. That is exactly why `components/tabs/agentModes.ts` is a **capability
table, not a universal field**: an agent belongs in it only if it has both an
absolute mode flag *and* a working resume. Claude (resume-by-id) and Gemini
(continue-last) both qualify; Codex resumes but has no plan mode. Gemini's
continue-last resume carries one accepted caveat — with two Gemini tabs in a
project a respawn reattaches to the project's latest session, not necessarily
this tab's (the same ambiguity their ordinary restore already has). The mode
is persisted per tab, and re-applied onto the rebuilt args in `loadFromLayout` —
args are NOT persisted, so without that the split would silently die on restart.
