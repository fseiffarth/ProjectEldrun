# Agent authority axes

Referenced from `AGENTS.md`.

**Agent authority has three axes Eldrun owns**, and they compose: the project
container `sandbox` (OS containment), the tab's `location` (where the process
runs), and the default-on local-agent filesystem `fence`. All three are
properties of the *process* — where it runs and what it can reach — which is
what makes them Eldrun's to decide.

## The permission mode is not one of them

An agent's permission mode — Claude's plan / accept-edits / bypass, Codex's
sandbox and approval policy, Gemini's approval mode — belongs to the agent, and
is set inside the agent's own CLI. Eldrun launches the plain command and passes
no mode flag.

There was a fourth axis here: an experimental per-tab **Plan/Auto** toggle
(`agent_mode_toggle`, `components/tabs/agentModes.ts`, `TabEntry.agentMode`),
which folded `--permission-mode`/`--approval-mode` into the tab's `args`. It is
gone, and the two reasons it went are worth keeping written down, because they
are what a reimplementation would run into again:

- **A mode was a launch flag, so every flip respawned the PTY.** Changing a
  running session's mode meant killing it and relaunching it on `--resume`,
  which is survivable for the conversation and not for the terminal scrollback
  or a turn in flight. The agent's own in-TUI switch (Claude's shift+tab) costs
  none of that, because it never restarts anything.
- **It made the tab layout a second authority record.** A user who set a mode
  inside the CLI and a `TabEntry.agentMode` saying otherwise are two answers to
  one question, and the layout's answer is the one that got re-applied on
  restart — so Eldrun could quietly put a resumed session into a mode nobody
  had asked for.

The mode a user sets in-session still survives a relaunch, but through the
agent rather than through the layout: `services::agent_session` re-applies the
mode Claude's own Stop hook recorded onto the `--resume` respawn (a shift+tab
cycle fires no hook event, which is why the record exists at all). An explicit
`--permission-mode` on a custom agent's argv outranks it, and anything outside
the known mode set is discarded.

Eldrun Mobile is unaffected: the phone's mode sheet
(`mobile-web/src/terminal/agentModes.ts`) never used launch flags. It presses
Shift+Tab and verifies each step against the mode the TUI itself prints — which
is the same thing a person does, through the CLI. The desktop bridge's
`modes` list is now always empty, so a phone can no longer request a *launch*
mode; changing a running session's mode is untouched.

## The local-agent filesystem fence

`services::agent_fence` is the third axis. On Linux, a locally-running agent
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
Login state gets the same treatment: `~/.claude.json` (oauthAccount +
onboarding) is staged as a per-project **copy** with its cross-project
`projects` map filtered to the box's own roots — without it every fenced tab
demanded a fresh login, and mounting the host original writable would hand a
boxed agent every project's history plus a place to write `allowedTools` for
uncontained sessions. The same staged mount goes into project containers.

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

**A layout written before the toggle was removed still carries its `agentMode`,
and `loadFromLayout` ignores it.** No migration strips the field: the frontend
no longer projects it, so the next layout save overwrites the entry without it.
Nothing reads it in the meantime, so a stale `"agentMode":"auto"` in an old
`terminals.json` cannot put a restored tab into a mode — which is the property
the removal was for.
