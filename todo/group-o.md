## Group O — Project Security & Permissions (new feature)
*Files: `src-tauri/src/commands/projects.rs` (create/import), `schema/project.rs`
+ `schema/settings.rs` (new security/permission fields), `ProjectSwitcher.tsx`
(import/add dialog) + a project-settings "Security" area, download-routing in
`services/project_runtime.rs`/`commands/`. Distinct from the SSH "no in-app
passwords" stance — this is per-project policy. Ties into Group G (remote/agent
auth) and the local/remote git push axis (#21).*

58. **Security stages for project import/add.** Offer graded security modes when
    adding/importing a project, stored in project settings:
    - **Highest** — only local models allowed; no git push (optionally no git,
      no scaffolds).
    - **Restricted** — a checkable allow-list of models; no git push (optionally
      no git, no scaffolds).
    - **Lowest** — everything allowed.
    Surface as a "Security" area in project settings and enforce it where agents
    are spawned and where pushes happen.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

59. **Per-project remote-control toggle (default off).** A per-project switch to
    enable/disable agent remote control (Claude, …), defaulting to **off**.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

87. **Per-tab Plan/Auto agent mode. (DONE ✅ · 🧪 Untested)** A third authority axis
    beside the Docker sandbox (OS containment) and tab locality (where it runs):
    how much authority the *agent* has. An agent tab carries an optional
    `agentMode` — **Plan** (`--permission-mode plan`: reads and proposes, never
    edits) or **Auto** (`acceptEdits`: edits apply, shell/network still ask) —
    surfaced as a clickable badge in the tab strip, so one tab plans while another
    does the work and each comes back in its mode after a restart. Absent = the
    agent's own ask-each-time default, which is every pre-existing tab.
    - Behind the experimental global setting `agent_mode_toggle` (default **off**).
    - **Claude only**, by construction: the mode is a launch flag, so switching one
      respawns the agent, and that is only non-destructive for an agent that
      resumes its conversation on respawn (`resolve_claude_session_impl` rewrites
      `--session-id` → `--resume`). Gemini has `--approval-mode` but no resume — a
      toggle there would silently destroy the chat. Codex resumes but has no plan
      mode, only a read-only sandbox that approximates one. The capability table in
      `components/tabs/agentModes.ts` is the single gate for adding more.
    - Known cost: the respawn loses xterm scrollback (the conversation is resumed,
      the terminal's raw history is not). A busy tab confirms before restarting.
    - Follow-ups: an `agent_default_mode` setting so new tabs *start* in Plan or
      Auto (would make the badge purely two-state); Codex once `--sandbox
      read-only`/`--full-auto` are verified to be accepted on `codex resume`.
    - [x] 🤖 Automated test (`src/__tests__/AgentMode.test.ts`)
    - [ ] 🖐️ Manual test

60. **Never manipulate the browser download path. (DONE — removed.)** Eldrun must
    not touch any browser's download directory. The `commands/downloads.rs` module
    that edited Firefox `prefs.js` / Chromium `Preferences` was removed entirely
    (file, `mod` decl, and handler registration). Routing a download into a project
    is a security risk if the file is then pushed with the project's git, and even
    the "reset to `~/Downloads`" path still wrote into browser config — so we leave
    browser download settings fully alone.

86. **Docker sandbox on Windows (currently refused).** The sandbox is Unix-only:
    `services::sandbox` is `#[cfg(unix)]` and `pty_spawn` returns a clear error on
    Windows rather than silently spawning an agent unsandboxed that the user asked
    to sandbox. It was never actually functional there — `staged_config_mounts` and
    `rw_mounts` bind host paths straight into a **Linux** container, so on Windows
    the container-side destination came out as a Windows host path
    (`C:\Users\…\.claude\settings.json`), which means nothing inside the container
    and whose drive colon also makes the `src:dst` mount string ambiguous;
    `host_uid_gid()` is equally meaningless there. CI only surfaced this by
    accident, through a test assertion rather than the feature itself. To support
    it: translate host paths to Docker Desktop's container view (`C:\x` → `/c/x`,
    or a WSL2 path), decide what `--user` should be on Windows (likely: omit it),
    and re-enable the module plus its `staged_config_mounts` test for Windows.
    Needs a real Docker Desktop box to verify — it cannot be validated from CI or
    from a Linux dev host. Ties into Group H (Windows parity).
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

### Sandbox-audit follow-ups (2026-07-26)

An adversarial review of the agent-tab container found ten issues (S-1 … S-10).
Eight were fixed in place; the root cause was that Eldrun's own control files
(`project.json`, `.eldrun/sessions/terminals.json`) live **inside** the
container's writable project mount while the host reads them back as executable
intent. What is left is listed here.

142. **Move `.eldrun/sessions/` out of the project tree.** The persisted tab
    layout is now *sanitized* on load (`services::terminal_service::
    sanitize_tab_layout` neutralizes any entry whose `cmd` is not a known tab
    command) and `pty_spawn` no longer trusts the renderer's `sandbox`/
    `local_only` flags (`services::sandbox::enforce_spawn_authority`). But the
    file itself still sits in the container's rw mount and in any cloned repo,
    so a planted layout is still *read* — the sanitizer is what makes it
    harmless. The cleaner fix is `<state_dir>/sessions/<project-id>/
    terminals.json`, which also removes the hostile-repo variant entirely.
    Deliberately **not** done in the audit pass: it drops the "layout travels
    with the folder" property (and with it the byte-sync/multi-host case, where a
    synced project folder currently carries its tab layout) and needs a one-time
    migration read of the old location, both of which are product decisions.
    The layout's *argv* is no longer attacker-controlled either — a persisted
    `resumeArgs` is re-derived from the frontend's `RESUMABLE_AGENTS` table or the
    custom agent's `settings.json` spec (`terminal_service::rebuild_resume_args`)
    — so what is left is the file still being *read* from the mount at all.
    Phased plan (incl. the project-tree-read tripwire that makes the invariant
    checkable rather than remembered):
    [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 1.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

143. **Confirm before adopting a repo's own `Dockerfile` / devcontainer image.**
    `services::sandbox::detect_spec_sources` still auto-adopts a root
    `Dockerfile` on the first container enable, and `docker build` runs its
    `RUN` steps as **root** with default capabilities and full network — a
    strictly larger blast radius than the session container. The traversal hole
    is closed (`resolve_spec_dockerfile` refuses absolute/`..` and confines the
    canonicalized path) and `--network host` is refused, but the *adoption* is
    still silent. Wants a dialog ("this repo declares its own container image —
    build it? [uses the repo's Dockerfile as root]"), which is a UI the user
    should design. Plan (incl. re-asking when the `Dockerfile` changes, so the
    confirmation is not a one-time formality a later commit walks through):
    [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 4.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

144. **Per-window capability split for `present-*` / `detached-*`.**
    `capabilities/default.json` is the only capability file and applies to
    `windows: ["main", "detached-*", "present-*"]`, so every one of the ~300
    application commands is reachable from the deck presenter's audience window
    as well as the main one. Tauri v2 supports per-window command permissions.
    Deliberately deferred: detached subwindows legitimately use a wide command
    surface, and an under-specified allowlist breaks them in ways only live QA
    finds. Do the `present-*` window first — it needs almost nothing. **Verify
    first** whether Tauri v2's ACL gates app-defined (`generate_handler!`)
    commands at all, or only plugin ones — the approach changes completely, and a
    `webview.label()` runtime guard is the fallback. Plan:
    [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 5.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

145. **Narrow `~/.claude/projects` to this project's own transcript dir.** The
    container's `~/.claude` mount is now per-entry with an exclusion list
    (`CLAUDE_UNMOUNTED`: `shell-snapshots/`, `plugins/`, `agents/`, `backups/`,
    `file-history/`, `telemetry/`, `history.jsonl`, `sessions/`, `session-env/`,
    `stats-cache.json`, `daemon.*`), which closes the host-RCE routes. But
    `projects/` is still mounted whole, and Claude keys transcripts by encoded
    cwd rather than by Eldrun project — so a contained agent can still read and
    write **every** project's conversation history. Narrowing it means
    replicating Claude's cwd encoding on the Rust side and accepting that a
    project whose encoding we get wrong loses resume — an undocumented format
    belonging to another product, whose drift fails *silently*. Weigh that
    recurring cost before starting; needs the drift-detection fallback described
    in [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md)
    Phase 3.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

146. **Don't silently auto-select a repo-planted `.venv` (S-10).**
    `commands::python::find_venvs` offers any directory under the project root
    that holds a `pyvenv.cfg`, shallowest-first, so a repo-committed `.venv`
    "wins auto-select" and its interpreter becomes what Run/Debug executes.
    Arguably the expected semantics of "run this project's Python" — the
    *silence* is the problem. Fix: require the candidate to be an executable
    regular file whose `pyvenv.cfg` names a real base interpreter, and ask once
    on a project's first open instead of picking. (`python.rs:177` also runs
    `poetry env info -p` with the untrusted project as cwd.) Low severity: when
    the project's container toggle is on, the run tab is contained anyway.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

147. **Surface "container not applied" for a remote project.** A local project
    that had the container enabled and was later extended to remote keeps its
    `sandbox.enabled` spec while every tab runs unsandboxed on the remote host —
    possibly an HPC login node. The spawn path no longer does this silently
    (`wrap_pty_options_docker` logs it, and `enforce_spawn_authority` clears the
    flag), but the **pill still shows the toggle as on**. Wants a pill state /
    warning; refusing the spawn was rejected because it would break exactly the
    projects that were extended from a container-toggled local one.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

148. **Guard the provider CLI's positional arguments. (NOT A PROBLEM ✅)**
    `commands::git_publish::local_publish` passes `repo_name` to `gh repo create`
    / `glab repo create` as a bare positional, which would be option injection
    for a project named `-something`. It cannot be: `repo_name` is
    `commands::projects::sanitize_name(&project.name)`, which maps every
    non-`[A-Za-z0-9_-]` character to `-` and then joins the non-empty
    `-`-separated parts — so a leading `-` is dropped by construction and the CLI
    never sees an option-shaped positional. Verified by reading the only call
    site (`git_publish.rs:363`); no code change. Kept as a record so the next
    audit does not re-raise it.

150. **Stop keying host-bound authority on a usage-stats env var.**
    `services::sandbox::is_host_bound_local_agent` lets a tab skip the container
    when its `cmd` is in `HOST_BOUND_LOCAL_AGENT_CMDS` **and** its env carries
    `ELDRUN_LOCAL_MODEL` — and both came from the persisted layout, i.e. from
    inside the container's own writable mount. `ELDRUN_LOCAL_MODEL` was never an
    authority marker: `TabBar.tsx`/`NewTabMenu.tsx` set it so the usage recap can
    break local-agent tabs down by model, so an authority decision was keyed on a
    telemetry label. The **arbitrary-argv half is fixed** (`resumeArgs` is now
    re-derived from `RESUMABLE_AGENTS` / the `settings.json` custom-agent spec by
    `terminal_service::rebuild_resume_args`, so a planted entry gets the agent's
    own resume flag and nothing else) — what remains is a *containment* bypass:
    such a tab runs on the host rather than in the container. Fix: record
    host-bound-ness in `<state_dir>/sessions/<project>/host_bound/<tab uid>` at
    genuine tab creation and require it alongside the cmd allowlist; the tab uid
    is already stable across relaunch, so a legitimate restored Ollama tab is
    unaffected. Do it with #142's Phase 1a, which builds the per-project
    state-dir keying. Plan: [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 2.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

149. **Confine `pty_spawn`'s `cwd` to the owning project.** The audit suggested
    rejecting a spawn whose `project_id` is `Some` and whose `cwd` is not under
    that project's directory or mirror. Not done: a legitimate tab can sit
    outside the tree (a git worktree created anywhere, a run tab on an absolute
    path), so the rule needs the full set of legitimate roots enumerated before
    it can fail closed without breaking real tabs. The layout sanitizer plus
    backend-resolved authority already remove the exploit path that made this
    urgent.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---
