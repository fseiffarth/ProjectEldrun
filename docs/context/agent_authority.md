# Agent authority axes

Referenced from `AGENTS.md`.

**Agent authority has four axes**, and they compose: the project container
`sandbox` (OS containment), the tab's `location` (where the process runs), the
default-on local-agent filesystem `fence`, and — behind the
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

## The local-agent filesystem fence

`services::agent_fence` is the fourth axis. On Linux, a locally-running agent
that is not already in a project container is launched under an outer
`bubblewrap` boundary. The host root remains visible read-only so compilers and
system tools still work, while `$HOME`, `/tmp`, and `/run` are replaced with
private filesystems. That hides SSH keys, unrelated hosting/cloud credentials,
the keyring
and D-Bus sockets, the Docker socket, and other projects. The owning project is
then mounted read-write. If it belongs to project boxes, every box folder and
member root is added read-write; membership in several boxes produces the union.
A `box:<id>` tab receives that box's roots directly. Claude/Codex also receive
`--add-dir` and Gemini receives `--include-directories`, so their own working-dir
checks agree with the OS boundary.

The fence is on by default globally. A project can inherit, force it off, or
force it on; changing either setting affects a tab only when that tab respawns.
Box scopes have no override and inherit the global setting. Missing or unusable
`bubblewrap` fails closed: the agent does not start, and the UI offers the
interactive `sudo apt install bubblewrap` command in a terminal tab. The user can
instead turn the project override off explicitly. The configured
`agent_fence_paths` allowlist restores selected toolchain/config paths read-only
inside the empty home; credentials are deliberately absent from its defaults.
Independently of that list, the fence also follows the agent binary's own
symlink chain on the host and binds every directory hop under `$HOME`
read-only (`command_bind_paths`): the native Claude installer leaves
`~/.local/bin/claude` pointing into `~/.local/share/claude/versions/`, and with
only `~/.local/bin` restored the link dangles inside the sandbox and bubblewrap
fails with `execvp claude: No such file or directory`. Allowlisting the binary's
home is therefore never required, only a way to expose more of an install dir.

Composition is explicit:

- A project container is already the stronger boundary, so the fence is skipped.
- An agent running over SSH is outside the local kernel's reach, so the fence is
  not enforced and the UI says “remote host”. A local-only tab of a remote project
  runs in and is fenced to its local mirror.
- macOS and Windows have no v1 enforcement backend; the status says so rather
  than presenting a false guarantee.
- Shell/script tabs are the user's terminals and are never fenced.

The boundary is filesystem-only: network access is shared. A nested bubblewrap
cannot run under the outer boundary on Linux systems with the
`bwrap-userns-restrict` AppArmor profile, so Claude Code's own bubblewrap sandbox
falls back to unsandboxed execution *inside* Eldrun's outer fence. Docker commands
also cannot work there because `/run` is private and the Docker socket is hidden.
The agent-state mounts deliberately reuse `services::sandbox`: narrowed auth and
resume state, immutable hook scripts, writable staged copies of hook-registration
config, and per-root Claude transcript permissions. That keeps the hook-repointing
and cross-project transcript protections identical across the two containment
mechanisms.

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
