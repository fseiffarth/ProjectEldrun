# Agent authority axes

Referenced from `AGENTS.md`.

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

**Unset is a third mode, and it restores as itself.** The badge reads `◇`/`⏸`/`⚡`,
and `◇` is not a missing value: it is a tab launched with no mode flag at all, i.e.
the agent's own default, which is what every agent tab nobody clicked the badge on
is running in. `loadFromLayout` used to fail *closed* into Plan for a mode-capable
tab with no persisted `agentMode`, which meant a resumed Claude session changed
mode on every relaunch. Both halves of that rationale have since stopped holding:
the layout is read from `<state_dir>/sessions/<id>/terminals.json` and no longer
from the project tree (`sandbox_hardening_plan` Phase 1 / #142), and against a
layout that genuinely is attacker-written the default was never the gate anyway —
`sanitize_tab_layout` keeps `agentMode` for a known `cmd`, so such a file writes
`"agentMode":"auto"` outright and never takes the absent branch.
