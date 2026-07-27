# Sandbox hardening plan — the audit follow-ups

Plan for TODO Group O #142–#150, the items an adversarial review of the agent-tab
sandbox found and that were **deliberately not** fixed in the audit pass because
each one is a product decision, needs a UI, or takes on an external dependency.

The fixes that *were* applied are not repeated here; see the Group O entries and
the code comments at `services::sandbox::resolve_spawn_authority`,
`services::terminal_service::sanitize_tab_layout` and
`services::restore_service::is_allowed_restore_exec`.

## The one sentence that explains every item below

**Eldrun's own control files live inside the container's writable project mount,
and the host reads them back as executable intent.** The container itself is
sound — no docker socket, `--cap-drop ALL`, `--security-opt no-new-privileges`,
non-root `--user <uid>:<gid>`, `--pids-limit`, `--init` — but a boundary whose
writable area contains the control plane of the thing enforcing it is not a
boundary. Two files were read as executable intent (`project.json`'s `open_apps`,
and the persisted tab layout's `cmd`/`args`/`env`/`location`), and both are now
guarded by validators. Phase 1 replaces those validators with a structural
property, because a validator list can never be shown to be complete.

## What the perimeter is now

Worth stating, because it changes the priority of everything else: the review
tried to reach the privileged renderer from every hostile-content surface Eldrun
renders and **could not**. The CSP (`script-src 'self' blob:`, no
`unsafe-inline`, `withGlobalTauri` off) blocks the `dangerouslySetInnerHTML`
sinks in the markdown/notebook/compare/ODT viewers, and the mail body and
HTML/SVG previews are additionally in `<iframe sandbox="">`.

The one confirmed exception was dev-mode Vite HMR executing repo-authored
`src/**` in the main webview — which required an agent with write access to the
*Eldrun checkout itself*. That is no longer how Eldrun is developed, so there is
no confirmed renderer-execution path at all.

Consequence: **the CSP is load-bearing** (pinned by
`src/__tests__/CspTripwire.test.ts`, added because nothing else in the tree fails
when it is loosened), and #144 is defence-in-depth against a *future* renderer
bug rather than a live hole. Phase 1 is the only remaining confirmed escape
class.

---

## Phase 1 — #142: move executable-intent state out of the project tree

**Why this one first.** It is the only item that makes the codebase *simpler*.
Today every future feature that reads a field out of `project.json` has to
independently remember that the file is attacker-writable; that unwritten rule is
what was forgotten twice. Afterwards the rule is structural and testable.

### Current layout (all inside the project tree, i.e. inside the rw mount)

| What | Where | Read by |
|------|-------|---------|
| tab layout (`cmd`/`env`/`cwd`/`location`/`resumeArgs`/`agentMode`) | `<project>/.eldrun/sessions/terminals.json`, falling back to `project.json`'s `tab_layout`/`tab_groups`/`open_tab_sessions` | `terminal_service::load_terminal_session`, `commands::projects::load_project` |
| `open_apps` (host auto-exec on activation) | `<project>/project.json` | `terminal_service::load_open_apps` → `project_runtime::switch` → `restore_service::restore_project_apps` |

The sandbox spec is already read only from `projects.json` in the state dir (that
fallback was deleted in the audit pass) — so it is the model to copy.

### Target

`<state_dir>/sessions/<sanitized project id>/terminals.json`, holding the layout
*and* `open_apps`. Nothing under a project directory is ever read as executable
intent again.

### The actual work, and where the difficulty is

The whole `terminal_service` API is keyed by `local_file` (the path to
`project.json`), not by project id — that is the refactor, not the file move.

- **Phase 1a — key by project id.** Thread `project_id` through
  `save_tab_layout` / `load_terminal_session` / `write_terminal_session` /
  `load_open_apps` and their callers (`commands::terminal`,
  `commands::projects::load_project`, `services::project_runtime::switch`,
  `services::restore_service`). Reuse `sanitize_project_key` — the same
  path-component reduction `agent_session` already uses for
  `live_sessions/<project>/`; move it somewhere shared rather than adding a
  third copy.
- **Phase 1b — dual-write.** Write both locations, read the state-dir copy first
  and fall back to the project tree. Nothing breaks, and a rollback is one
  constant.
- **Phase 1c — migrate and stop.** On first read with no state-dir copy present,
  adopt the project-tree copy (through `sanitize_loaded_layout`, since the file
  being migrated is exactly the untrusted one), write it to the state dir, and
  stop writing the project tree. Stop reading `project.json`'s `tab_layout` /
  `tab_groups` / `open_tab_sessions` / `open_apps` at all.
- **Phase 1d — the invariant, as a test.** A tripwire asserting that no
  executable-intent field is read from a project-tree path: walk the backend
  source for reads of `Project::{open_apps, tab_layout, tab_groups,
  open_tab_sessions}` and fail if any survive outside the migration shim. This is
  the deliverable that makes Phase 1 worth more than the validators it replaces —
  `BrowserTripwire.test.ts` and `MailTripwire.test.ts` are the pattern.

### Costs — accept these explicitly before starting

- **The layout stops travelling with the folder.** Small in practice:
  `project.json` is already gitignored for Eldrun-created projects, so this only
  affects copying or moving a directory by hand.
- **It does affect byte-sync / multi-host.** A project folder synced between
  machines currently carries its tab layout; afterwards it does not. This is the
  real loss, and it lands on the remote/mirrored workflows the app is built
  around.
- **Single point of failure.** Losing `<state_dir>` currently loses global state;
  afterwards it loses every project's layout too.
- **Migration risk.** A buggy one-time read silently drops tabs. Hence the
  dual-write phase, and hence 1c should log what it migrated.

### Keep after Phase 1

`sanitize_tab_layout` and `is_allowed_restore_exec` stay. They cost nothing, they
guard the migration shim, and they are the second layer if a future feature
reintroduces a project-tree read.

---

## Phase 2 — #150: the host-bound local-model marker

The residual half of the persisted-layout escape, and the one item here that is
small.

`sandbox::is_host_bound_local_agent` grants a tab the right to skip the container
when its `cmd` is in `HOST_BOUND_LOCAL_AGENT_CMDS` **and** its env carries
`ELDRUN_LOCAL_MODEL`. Both came from the persisted layout, and
`ELDRUN_LOCAL_MODEL` was never an authority marker — `TabBar.tsx` sets it so the
usage recap can break local-agent tabs down by model. An authority decision was
keyed on a telemetry label.

The **arbitrary-argv half is now closed**: a persisted `resumeArgs` is no longer
trusted (`terminal_service::rebuild_resume_args` re-derives a built-in's flag from
the frontend's `RESUMABLE_AGENTS` table and a custom agent's from its
`settings.json` spec), so the worst a planted entry gets is the agent CLI with its
*own* resume flag.

What remains is a **containment bypass, not code execution**: such a tab runs on
the host instead of in the container.

**Fix.** Record host-bound-ness where the container cannot write it — a marker
file under `<state_dir>/sessions/<project>/host_bound/<tab uid>`, written when the
tab is genuinely created by `TabBar`/`NewTabMenu`, and required by
`is_host_bound_local_agent` in addition to the cmd allowlist. `ELDRUN_LOCAL_MODEL`
goes back to being only a usage label. The tab uid is already stable across
relaunch (unlike the PTY id), so a legitimate restored Ollama tab keeps working.

Do this **with or after Phase 1a**, which is where per-project state-dir keying
gets built.

*Rejected:* stripping `env` on restore. It closes the same hole but breaks a
restored local-model tab's reach to the host ollama daemon, and vibe's
`VIBE_HOME`.

---

## Phase 3 — #145: narrow `~/.claude/projects`

**Think twice before doing this one.** It is a confidentiality fix that takes on
a maintenance dependency for a payoff that is real but bounded.

The container's `~/.claude` mount is now per-entry with an exclusion list
(`CLAUDE_UNMOUNTED`), which closed the host-RCE routes (`shell-snapshots/`,
`plugins/`, `agents/`). But `projects/` is mounted whole, so a contained agent can
read and write **every** project's conversation history — a confidentiality breach
on its own, and the enabler for the `live_sessions` lateral-movement trick that
the per-project mount only half-closes.

Claude keys transcripts by **encoded cwd**, not by Eldrun project: this repo's
transcripts live in `~/.claude/projects/-home-florian-eldrun-projects-projecteldrun/`,
i.e. `/` → `-` with a leading `-`.

**The cost is the point:** that encoding is undocumented and belongs to another
product. If it changes, resume breaks, and it breaks *silently* — the worst
failure class in this codebase.

If it is done anyway:

1. `claude_project_dir_name(cwd)` in `services::sandbox`, unit-tested against the
   observed encoding, plus the cases the observation does not cover (a path with
   a `.`, a `_`, a trailing slash, a non-ASCII segment).
2. Mount only that subdirectory, creating it first if absent so the mount cannot
   fail.
3. **Drift detection, or don't bother shipping it:** at container-up, compare the
   computed name against the actual entries under `~/.claude/projects`. A
   mismatch must log loudly, and should fall back to the current whole-`projects/`
   mount — a silently-wrong narrow mount trades a confidentiality bug for a
   resume bug, which is a worse deal.
4. Live QA per agent, and re-verification on Claude Code updates. That recurring
   cost is the real reason this is Phase 3 and not Phase 1.

---

## Phase 4 — #143: confirm a repo-supplied `Dockerfile`

`sandbox::detect_spec_sources` auto-adopts a root `Dockerfile` on first container
enable, and `docker build` runs its `RUN` steps as **root** with default
capabilities and full network — a strictly larger blast radius than the session
container it is building. The traversal hole is closed
(`resolve_spec_dockerfile`) and `--network host` is refused (`validate_network`),
but the *adoption* is still silent.

- Split detection from adoption: `detect_spec_sources` reports, a new command
  answers "what does this repo declare?", and `set_project_sandbox` records an
  explicit decision (`spec_source`) in `projects.json`.
- Dialog names what it costs: *this repo declares its own container image —
  building it runs the repo's own commands as root*. Design is the user's.
- Re-ask when the `Dockerfile` changes (hash it into the recorded decision),
  otherwise the confirmation is a one-time formality that a later commit walks
  straight through.

**Honest caveat:** a confirmation the user sees on every devcontainer repo decays
to a reflex click, and it breaks the "devcontainers just work" property. Worth
doing because *root* is the differentiator here, not because dialogs are good.

---

## Phase 5 — #144: per-window capability split

Lowest priority, and only defence-in-depth now that no renderer-execution path is
confirmed.

`capabilities/default.json` applies to `["main", "detached-*", "present-*"]`, so
the deck presenter's audience window reaches the same ~300 commands the main
window does.

**Verify the mechanism before designing around it.** Tauri v2's ACL is documented
for *plugin* commands; whether it gates commands defined in the app's own
`generate_handler!` needs confirming against the installed Tauri version — the
plan changes completely depending on the answer:

- **If the ACL gates app commands:** add `capabilities/presenter.json` scoped to
  `present-*` with an explicit small allowlist, and drop `present-*` from
  `default.json`. Enumerate the real set from `DeckAudienceApp.tsx`'s `invoke`
  calls first.
- **If it does not:** the equivalent is a runtime guard. An app command can take
  `webview: tauri::Webview` and read `webview.label()`, so a small
  `refuse_from_presenter(&webview)?` helper on the high-value commands
  (`pty_spawn`, `run_script_detached`, `credential_paste_to_pty`,
  `open_file`/`launch_app`, the fs writers) buys most of the benefit with none of
  the allowlist-drift risk.

**Do `present-*` only.** Detached subwindows legitimately use a wide surface, and
an under-specified allowlist fails *only in that window* — a bug class this
codebase already knows to avoid.

---

## Not planned, and why

- **#146 (repo-planted `.venv` auto-select)** — low severity, and contained
  anyway when the project's container toggle is on. The fix (ask once instead of
  auto-selecting) is a UX change; leave it in the TODO.
- **#147 (pill shows the container toggle on for a remote project)** — the spawn
  path no longer does this silently; what is left is a UI state. Cheap, but it is
  a display fix, not containment.
- **#149 (`pty_spawn` cwd confinement)** — needs the set of legitimate roots
  enumerated first (git worktrees created anywhere, run tabs on absolute paths).
  The exploit path that made it urgent is closed.
- **#148 turned out to be a non-issue.** `commands::git_publish` derives
  `repo_name` from `commands::projects::sanitize_name`, which maps every
  non-`[A-Za-z0-9_-]` character to `-` and then drops empty `-`-separated parts —
  so a leading `-` cannot survive and the provider CLI never sees an option-shaped
  positional. Verified, no code change.
- **Refusing the spawn for a container-toggled remote project** — rejected: it
  would break exactly the projects that were extended from a container-toggled
  local one.

## Test strategy

Every phase lands pure logic next to the existing `#[cfg(test)]` modules
(`sandbox`, `terminal_service`, `restore_service`, `agent_session`), matching how
the audit pass was tested. Two tripwires carry the load, because both guard
properties that fail *silently*: `CspTripwire.test.ts` (already in), and Phase
1d's project-tree-read tripwire.

Baseline to preserve: the Rust suite was green at 1269 immediately after the
audit pass, and the frontend at 2108 with `tsc --noEmit` clean.
