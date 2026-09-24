# Agent authority axes

Referenced from `AGENTS.md`.

**Agent authority has three axes Eldrun owns**, and they compose: the project
container `sandbox` (OS containment), the tab's `location` (where the process
runs), and the default-on local-agent filesystem `fence`. All three are
properties of the *process* — where it runs and what it can reach — which is
what makes them Eldrun's to decide.

A fourth thing looks like an axis and is narrower: the **root MCP caller
class** (`root_mcp::Caller`, `docs/context/root_console.md` §Mail). It is fixed
at spawn with the token and decides which of Eldrun's *own* tools exist for an
agent — a root tab writes mail drafts and never reads mail; only a `Reader`, an
agent in a `mail_reader` VM whose egress is the default allowlisting proxy,
reads. It composes with the axes above rather than replacing them: the class is
only handed out where `location` is that VM.

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
A `box:<id>` tab receives that box's roots directly. Claude also receives
`--add-dir` and Gemini receives `--include-directories`, so their own working-dir
checks agree with the OS boundary. Codex receives no automatic `--add-dir`:
that flag requests extra writable roots, and Codex warns and ignores it when
its own effective permissions are read-only or managed. Codex's permission
mode remains its own; the outer fence still exposes the box roots.
A root-console agent's fence is `~/eldrun/root` read-write and, only with
`root_fence_projects_readable` on (default off), every project, box folder and
remote mirror read-only through the allowlist's channel — a widening, since one
poisoned project can then reach the others through an agent with open network.

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
The one part of that chain handed back **read-write** is the agent's own
native-installer layout (`updatable_install_dirs`): a launcher link in
`~/.local/bin` pointing at a payload under `~/.local/share/<tool>/` — so
`claude update`, and Claude's background auto-update, work from a fenced tab
instead of failing on a read-only `versions/` every session (user,
2026-09-13). The updater writes the new binary into `versions/` and swaps the
link by rename, so exactly `~/.local/bin` and `~/.local/share/<tool>` open up;
an npm/nvm or package-managed install stays read-only, because a Node prefix's
`bin/` holds every global tool. This is a deliberate widening: an agent that
can update its CLI can replace it, and that binary is the one the user runs
everywhere. Login state gets the same treatment: `~/.claude.json` (oauthAccount +
onboarding) is staged as a per-project **copy** with its cross-project
`projects` map filtered to the box's own roots — without it every fenced tab
demanded a fresh login, and mounting the host original writable would hand a
boxed agent every project's history plus a place to write `allowedTools` for
uncontained sessions. The same staged mount goes into project containers.

Inside the fence those staged copies are **symlinked** into place rather than
mounted over their real paths. `rename(2)` onto a mount point fails with
`EBUSY`, and every one of these agents rewrites its config by writing a sibling
temp file and renaming it over the original — with `~/.codex/config.toml`
bind-mounted, Codex failed with `failed to persist config` the first time it
tried to record a newly trusted project, and the same applies to Claude's
`settings.json`. So the scope's staging dir is bound once at
`/run/eldrun-agent-config` and each shadowed path is a link into it: an
in-place rewrite still lands in the throwaway copy, and a rename simply
replaces the link with a plain file in the home tmpfs. Neither reaches the host
original, which is the whole point of the shadow. Project containers still bind
the copies file by file and keep that limitation.

Composition is explicit:

- A project container is already the stronger boundary, so the fence is skipped.
- An agent running over SSH is outside the local kernel's reach, so the fence is
  not enforced and the UI says “remote host”. A local-only tab of a remote project
  runs in and is fenced to its local mirror.
- macOS enforces through a `sandbox-exec` Seatbelt profile built from the same
  mount planners as the Linux fence: writes are denied outside the roots and
  the agent's own state, the rest of `$HOME` is hidden. Seatbelt can deny but
  not redirect, so the agents' hook-registration files are read-only there
  (an agent rewriting its own `settings.json` gets `EPERM`) instead of shadowed
  by a throwaway copy, and `~/.claude.json` is exposed unfiltered rather than
  as the per-project filtered copy Linux stages. Device writes are denied too,
  except `/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/dtracehelper` and
  `/dev/fd`; other terminals' `/dev/ttys*` stay denied, so a fenced agent cannot
  write into another tab's terminal.
- The macOS fence is a filesystem fence only. The profile starts from
  `(allow default)`, so mach services stay reachable — `securityd` among them.
  A fenced agent can therefore ask the keychain for any item whose access list
  trusts the requesting tool (`/usr/bin/security` included), which is how the
  agents sign in at all. The Linux fence hides the keyring; the macOS one cannot
  without breaking agent authentication, so treat login-keychain items as
  reachable from a fenced Mac agent. The keychain *file* itself stays unreadable
  (it sits under the hidden `$HOME`).
- Windows has no unprivileged filesystem sandbox to build a fence on; the
  status says so rather than presenting a false guarantee.
- Shell/script tabs are the user's terminals and are never fenced.
- A persistent (tmux) agent tab keeps an **unfenced** login shell after the
  agent exits, on the same terminal. Where the kernel still honours `TIOCSTI`
  (Linux before 6.2 or with `dev.tty.legacy_tiocsti=1`, macOS), a fenced agent
  could queue keystrokes on its own terminal and exit, and that shell would run
  them. So the pane drains the input queue between the two
  (`tmux_local::FENCE_INPUT_DRAIN`). bubblewrap's `--new-session` would block
  `TIOCSTI` at the source, but it detaches the agent from its controlling
  terminal, so it never gets `SIGWINCH` and a TUI stops reflowing on resize.

Fenced Linux Codex gets no sandbox-backend override. Its own bubblewrap
cannot nest under the fence on Ubuntu: the outer bwrap runs under the stacked
`bwrap//&unpriv_bwrap` AppArmor profile, which denies the uid-map write of a
second user namespace (`unshare -Ur` fails inside the fence, so does a nested
`bwrap`). Eldrun briefly forced Codex's Landlock backend instead
(`-c features.use_legacy_landlock=true`, 2026-09-14), but Codex 0.154.0
prints a deprecation warning for that key on every start and its legacy
backend refuses workspace-write outright ("permission profiles requiring
direct runtime enforcement are incompatible with --use-legacy-landlock")
unless `sandbox_workspace_write.exclude_slash_tmp` is also set — a policy
narrowing Eldrun must not choose for the agent. So the flag was dropped
(2026-09-15): inside the fence Codex's sandbox fails to spawn, Codex reports
that and asks to run the command outside its sandbox — which is still inside
Eldrun's fence — and the user answers per command or once per session. A user
who prefers Landlock for now can opt in through their own `~/.codex/config.toml`
(`[features] use_legacy_landlock = true` plus
`[sandbox_workspace_write] exclude_slash_tmp = true`) and live with the
warning until upstream removes the backend.

The fence-tool probe caches success, but retries failure on the next request.
Installing bubblewrap therefore allows the next tab to start without restarting
Eldrun. The project menu reports the policy for **new spawns**, not an inspection
of already-running tabs; existing tabs retain their original mounts/profile.

Cargo toolchains remain readable, but `credentials` and `credentials.toml` under
`~/.cargo` and an inherited or tab-specific `CARGO_HOME` are hidden by default.
Linux masks existing files after all root/toolchain mounts; macOS adds final
read/write denials, including canonical aliases. The global
`agent_fence_cargo_credentials` opt-in restores the prior visibility through
allowed paths when publishing needs registry tokens. It does not filter
inherited environment variables or touch agent login credentials.

Codex's `skills`, `plugins`, and `shell_snapshots` no longer expose writable host
content to fenced tabs. Linux seeds fresh **per-tab writable copies** of skills
and plugins, relocating internal links and copying external targets independently, and starts shell snapshots empty so Codex can regenerate them normally.
These copies are temporary: changes are private to that tab. Shared `auth.json`,
session rollouts, the durable per-scope databases, credential refresh, and native
CLI self-updates retain their existing paths. macOS cannot redirect these
folders and instead denies writes to the shared executable content; skill/plugin
updates there need live verification. This does not turn the fence into project
confidentiality: other Claude transcripts remain readable, Codex's rollout store
remains shared, and readable host trees outside the hidden directories can still
be visible.

The boundary is filesystem-only: network access is shared. A nested bubblewrap
cannot run under the outer boundary on Linux systems with the
`bwrap-userns-restrict` AppArmor profile, so Claude Code's own bubblewrap sandbox
falls back to unsandboxed execution *inside* Eldrun's outer fence. Docker commands
also cannot work there because `/run` is private and the Docker socket is hidden.
The agent-state mounts deliberately reuse `services::sandbox`: narrowed auth and
resume state, immutable hook scripts and `<state_dir>/bin` commands (including
`eldrun-send`, prepended to PATH inside containers too), writable staged copies of hook-registration
config, and per-root Claude transcript permissions. That keeps the hook-repointing
and cross-project transcript protections identical across the two containment
mechanisms.

**A layout written before the toggle was removed still carries its `agentMode`,
and `loadFromLayout` ignores it.** No migration strips the field: the frontend
no longer projects it, so the next layout save overwrites the entry without it.
Nothing reads it in the meantime, so a stale `"agentMode":"auto"` in an old
`terminals.json` cannot put a restored tab into a mode — which is the property
the removal was for.
