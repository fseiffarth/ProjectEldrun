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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

59. **Per-project remote-control toggle. (DONE ✅ · 🧪 Untested)** **Shipped
    2026-07-28.** `Project.remote_control: Option<bool>` (`schema/project.rs`)
    overrides the global `agent_remote_control` per project: `Some(true/false)`
    forces `claude` tabs of that project on/off, `None` (untouched — every
    existing project) inherits the global setting. `commands::terminal`'s
    `resolve_agent_remote_control` reads the override the same way
    `services::sandbox` reads a spec: from the `projects.json` entry's
    flattened `extra["remote_control"]` — the state-dir mirror, never
    `project.json` (inside the project tree / a container's rw mount). Written
    by `set_project_remote_control` (mirrors `set_project_python`'s
    write-both-stores shape). Surfaced in the pill's Runtime menu as a
    three-state cycle (inherit → off → on), i18n'd ×5.
    - **The "default off" / "flip the global default" half is deliberately NOT
      done.** Flipping the shipped global default would silently change
      existing users' Claude sessions from steerable to not, with no
      migration and no signal anyone asked for that — a bigger, more
      debatable UX call than "add a working per-project override," and one
      the original item explicitly left open ("a decision on whether the
      global default should flip"). What shipped is the unambiguous, safe
      part: a real per-project override that can force it off, with zero
      behavior change for anyone who never touches it. Revisit the global
      default separately if wanted.
    - [x] 🤖 Automated test — `commands::terminal::tests` (pure
      `agent_remote_control_effective`: no project id / unknown project /
      override-wins-both-directions / no-override-inherits-global) +
      `projects_commands.rs`'s `set_project_remote_control_writes_both_stores_and_clears`
      (both stores written; clearing removes the field rather than storing
      `null`).
    - [ ] 🖐️ Manual test — set a project's remote control to "off", spawn a
      Claude tab, confirm `--remote-control` is absent from its argv even
      with the global setting on; confirm "inherit" goes back to matching the
      global setting.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

87. **Per-tab Plan/Auto agent mode. (DONE ✅ · 🧪 Untested)** *(This is group-O's
    #87; group-M has a different #87.)* A third authority axis
    beside the Docker sandbox (OS containment) and tab locality (where it runs):
    how much authority the *agent* has. An agent tab carries an optional
    `agentMode` — **Plan** (`--permission-mode plan`: reads and proposes, never
    edits) or **Auto** (`acceptEdits`: edits apply, shell/network still ask) —
    surfaced as a clickable badge in the tab strip, so one tab plans while another
    does the work and each comes back in its mode after a restart. Absent = the
    agent's own ask-each-time default, which is every pre-existing tab.
    - Behind the experimental global setting `agent_mode_toggle` (default **off**).
    - **Claude *and Gemini*** — this bullet used to say "Claude only, by
      construction… a toggle on Gemini would silently destroy the chat", which
      the code has since overtaken. `components/tabs/agentModes.ts:46-56` ships
      Gemini via `--approval-mode` (deliberately `auto_edit`, **not** `yolo`),
      with the continue-last ambiguity accepted and documented in code.
      The mode is a launch flag, so switching one respawns the agent
      (`resolve_claude_session_impl` rewrites `--session-id` → `--resume`).
      **Codex remains the deliberate absence**: it resumes but has no plan mode,
      only a read-only sandbox that approximates one. That capability table is
      still the single gate for adding more.
    - Known cost: the respawn loses xterm scrollback (the conversation is resumed,
      the terminal's raw history is not). A busy tab confirms before restarting.
    - Follow-ups: an `agent_default_mode` setting so new tabs *start* in Plan or
      Auto (would make the badge purely two-state); Codex once `--sandbox
      read-only`/`--full-auto` are verified to be accepted on `codex resume`.
    - [x] 🤖 Automated test (`src/__tests__/AgentMode.test.ts`)
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

60. **Never manipulate the browser download path. (DONE — removed.)** Eldrun must
    not touch any browser's download directory. The `commands/downloads.rs` module
    that edited Firefox `prefs.js` / Chromium `Preferences` was removed entirely
    (file, `mod` decl, and handler registration). Routing a download into a project
    is a security risk if the file is then pushed with the project's git, and even
    the "reset to `~/Downloads`" path still wrote into browser config — so we leave
    browser download settings fully alone.

86. **Docker sandbox on Windows (currently refused).** *(This is group-O's #86;
    group-G has a different #86.)* **Two premises below are now stale:**
    `services::sandbox` is **no longer** `#[cfg(unix)]` — it compiles everywhere
    (`services/mod.rs:30-36`), and the refusal lives at the call site
    (`commands/terminal.rs:149-150`). Its `staged_config_mounts_copies_and_shadows_host_originals`
    test is **not** cfg-gated either (`sandbox.rs:1935`), so there is nothing to
    "re-enable". The remaining work is only: host-path→container-path
    translation, the `--user` decision, and a real Docker Desktop box.
    Original text follows. The sandbox was Unix-only:
    `services::sandbox` was `#[cfg(unix)]` and `pty_spawn` returns a clear error on
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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

### Sandbox-audit follow-ups (2026-07-26)

An adversarial review of the agent-tab container found ten issues (S-1 … S-10).
Eight were fixed in place; the root cause was that Eldrun's own control files
(`project.json`, `.eldrun/sessions/terminals.json`) live **inside** the
container's writable project mount while the host reads them back as executable
intent. What is left is listed here.

142. **DONE (2026-07-27) — Move `.eldrun/sessions/` out of the project tree.**
    The layout and `open_apps` now live at `<state_dir>/sessions/<project key>/
    terminals.json`, keyed by **project id** rather than by the path to a
    `project.json` (that re-keying was the actual work — the whole
    `terminal_service` API took a `local_file`). `load_project` no longer serves
    the layout at all; `CenterPanel` restores from the new `load_tab_session`.
    The project-tree copy is still **written** — so a byte-synced or hand-copied
    folder keeps carrying its tabs — but is never read without an explicit click
    ("Restore layout saved in the folder…" in the pill menu →
    `adopt_folder_tab_layout`, which sanitizes and refuses to adopt `open_apps`).
    Migration is **once per installation**, so a project imported afterwards is
    never adopted from. The invariant is a test now, not a memory:
    `src-tauri/tests/project_tree_intent.rs`. The migration has run against the
    real 27-project workspace: 26 migrated (the 27th had no saved layout at all),
    85 tabs carried, zero neutered by the sanitizer.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — migration verified on the real workspace. Still worth a
      look on the next relaunch: that restored tabs come back where expected, and
      that "Restore layout saved in the folder…" adopts a synced folder's layout.
      - [x] ✅ Works
      - [ ] ❌ Doesn't work

    <details><summary>Original entry</summary>

    The persisted tab
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

    </details>

143. **Confirm before adopting a repo's own `Dockerfile` / devcontainer image.
    (DONE ✅ · 🧪 Untested)** **Shipped 2026-07-28.** Detection and adoption are
    split: `services::sandbox::detect_spec_source` is now pure (reports a
    `DetectedSpecSource{kind,value,hash}`, mutates nothing), and
    `commands::projects::set_project_sandbox` takes an optional
    `source_decision` and returns a `SandboxToggleOutcome` — `Applied{spec}` or
    `NeedsConfirmation{source}`. Enabling a project whose repo currently
    declares a Dockerfile/devcontainer image and hasn't been decided about
    (`SandboxSpec.spec_source_hash` unset or stale) comes back
    `NeedsConfirmation` and writes nothing; the frontend (`ProjectPill.tsx`'s
    toggle, `ProjectDialog.tsx`'s create-time row) shows a `confirm()` dialog
    naming the root-as-build risk (`scaffold.ts`'s `describeDetectedSpecSource`,
    one wording shared by both call sites) and re-invokes with
    `{hash, adopt}`. A hash that doesn't match the live detection — a stale
    dialog, or the file changed between the two calls — is refused the same
    way rather than applied. **Re-asks when the Dockerfile changes**: the
    decision is keyed by a SHA-256 of the file's bytes (or the image string),
    so editing `RUN` steps after an adopt *or* a decline re-triggers the
    dialog; an unchanged decline never re-asks. A `dockerfile`/`image` set to
    something detection wouldn't produce (the knobs dialog, `set_project_sandbox_spec`)
    is always treated as a deliberate manual choice and never second-guessed.
    - [x] 🤖 Automated test — `sandbox::tests` (`detect_spec_sources_prefers_dockerfile_then_devcontainer_image`)
      + `projects_commands.rs` (`set_project_sandbox_preserves_spec_and_confirms_dockerfile`,
      `set_project_sandbox_decline_sticks_until_dockerfile_changes`): first enable
      with a repo Dockerfile comes back `NeedsConfirmation`; a mismatched hash is
      refused; a matching adopt/decline applies and persists; an unchanged
      decision never re-asks; a changed Dockerfile does.
    - [ ] 🖐️ Manual test — enable a project container on a repo with its own
      Dockerfile, confirm the dialog names the root/network risk, decline once
      and confirm no re-ask on an unchanged file, then edit the Dockerfile and
      confirm it re-asks.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

144. **Per-window capability split for `present-*` / `detached-*`.**
    **Stale premise:** `capabilities/browser.json` now exists and scopes
    `browser-*` to *zero* permissions — so the "verify first whether Tauri v2's
    ACL gates `generate_handler!` commands at all" question is already answered
    in the affirmative by that file plus `tests/capability_scope.rs`. Scoping is
    also by **webview**, not window (`capabilities/default.json:5`
    `"webviews": [...]`). The work is now just doing the `present-*` split.
    Original text: `capabilities/default.json` was the only capability file and applies to
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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

145. **Narrow `~/.claude/projects` to this project's own transcript dir.**
    **PARTIAL — the write half shipped in `b36e731` (2026-07-28) and was never
    recorded here.** `claude_transcript_mounts` (`services/sandbox.rs:1423-1459`)
    now mounts per-directory: this project's own transcript dir `rw`, **every
    other project's `ro`**. `:1340` stages the parent and `:1470`
    `harvest_claude_transcripts` brings new dirs back out after teardown.
    Crucially, `transcript_cwd` (`:1349`) reads the cwd **out of the transcript**
    instead of decoding Claude's lossy directory name, with
    `transcript_name_matches` only as a fallback — which removes the
    "replicate an undocumented encoding, drift fails silently" objection this
    entry was blocked on. **Still open: cross-project *read*.** Reassess the
    cost note below before doing more; it no longer describes the work.
    Original text: The
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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

146. **Don't silently auto-select a repo-planted `.venv` (S-10).**
    `commands::python::find_venvs` (`python.rs:132-158`) offers any directory
    under the project root that holds a `pyvenv.cfg` **and an existing
    `bin/python`** (`:116` — slightly narrower than this entry claims, and it
    predates the entry, so it is not partial credit), shallowest-first, so a
    repo-committed `.venv`
    "wins auto-select" and its interpreter becomes what Run/Debug executes.
    Arguably the expected semantics of "run this project's Python" — the
    *silence* is the problem. Fix: require the candidate to be an executable
    regular file whose `pyvenv.cfg` names a real base interpreter, and ask once
    on a project's first open instead of picking. (`python.rs:177` also runs
    `poetry env info -p` with the untrusted project as cwd.) Low severity: when
    the project's container toggle is on, the run tab is contained anyway.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

147. **Surface "container not applied" for a remote project.** A local project
    that had the container enabled and was later extended to remote keeps its
    `sandbox.enabled` spec while every tab runs unsandboxed on the remote host —
    possibly an HPC login node. The spawn path no longer does this silently
    (`wrap_pty_options_docker` logs it at `services/sandbox.rs:598-617`, and
    `enforce_spawn_authority` clears the flag). **Premise correction:** the pill
    does *not* show the toggle as on — `ProjectPill.tsx:1848` hides the whole
    container section for `project.remote`. A hidden control is precisely what
    makes the retained spec invisible, so restate the ask as a **positive
    warning** that a stale `sandbox.enabled` is being ignored, not as fixing a
    wrong toggle state. Refusing the spawn was rejected because it would break
    exactly the projects that were extended from a container-toggled local one.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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

150. **DONE (2026-07-27) — Stop keying host-bound authority on a usage-stats env
    var.** `is_host_bound_local_agent(cmd, marker)` now takes a *registered marker*
    instead of the tab's env: a local-model tab mints a uid at creation
    (`src/lib/hostBound.ts` → `register_host_bound_tab`), the backend writes
    `<state_dir>/sessions/<project>/host_bound/<uid>`, and the spawn path checks
    for that file. `ELDRUN_LOCAL_MODEL` is a usage label again. Markers are pruned
    on every layout save against the uids still in the layout.
    Two corrections to the plan, both worth knowing: the uid is **not** already
    stable across relaunch (`loadFromLayout` re-mints every key *and* the PTY id),
    so it is minted once and persisted as `hostBoundUid`; and with #142 done this
    is mostly a **decoupling** fix, not a containment one — it stops a
    display-only change to a telemetry var from silently granting container
    escapes. It does not defend against a compromised renderer, which can call the
    registration command as easily as it can spawn. That case is the CSP's.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — open an Ollama/vibe tab in a container-toggled project,
      confirm it still runs on the host, and that it still does after a relaunch.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

    <details><summary>Original entry</summary>

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

    </details>

149. **Confine `pty_spawn`'s `cwd` to the owning project. (DONE ✅ · 🖐️ Untested)**
    **Shipped 2026-07-29.** `commands::terminal::pty_spawn` now rejects a spawn
    whose `project_id` is `Some` and whose (already-resolved) `cwd` sits outside
    that project's sanctioned root, right after the existing `local_only`
    mirror-resolution step and before session/remote-control logic reads
    `project_id`. The root is `services::sandbox::project_dir_for(project_id)`
    for a local project (already the bind-mount root docker uses, so a git
    worktree at `<dir>/.eldrun/worktrees/<name>` passes as a subdir — no second
    enumeration needed) or `services::remote_sync::mirror_dir(project_id)` for a
    `local_only` tab of a remote project (exactly what that branch had just set
    `cwd` to, so this only ever catches a caller that supplied its own instead).
    A **truly-remote** tab (`is_remote && !local_only`) is exempt outright: its
    `cwd` names a path on the far host, which this process cannot check, and the
    ssh-wrapped command does the `cd` over there. The "run tab on an absolute
    path" case flagged below turned out not to be a counterexample:
    `lib/pythonRun.ts`'s `runCwd` only falls back to the file's own directory
    when the viewer has **no** project (root-scope tab, `project_id: None`),
    which the gate already exempts. Comparison is component-wise
    (`Path::starts_with`), mirroring `services::sandbox::cwd_is_within`'s shape
    but kept as a separate function (`cwd_within`) since that one only
    classifies a docker mount rw/ro and this one refuses the spawn outright.
    - [x] 🤖 Automated test — `cwd_within_accepts_project_dir_and_subdirs` /
      `_rejects_sibling_and_unrelated_paths` (`commands/terminal.rs`), plus the
      full `cargo test`/`cargo clippy -D warnings` suite stays green.
    - [ ] 🖐️ Manual test — open a shell tab normally (still works), then try
      to reproduce the original exploit shape (a `project_id` paired with an
      unrelated `cwd`) and confirm `pty_spawn` refuses it with the new error.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

151. **A repo's own `.git/config` is executable intent too. (MITIGATED ⚠️ · not
    fully closed)** The same sentence as #142, with git as the executor instead
    of Eldrun: `services::sandbox` bind-mounts the project directory whole —
    `.git` included — into the container's rw mount, and every host-side git
    call runs in that directory with the repo's config honoured. So a
    contained agent writing `.git/config` gets code execution **on the host**.
    The sharpest is `core.fsmonitor`, whose hook form git runs on a plain
    `git status` — and `git_file_statuses`/`git_status` are polled continuously
    for the file tree, so the chain needs no user action at all. `diff.external`
    and `diff.<driver>.textconv` are the same class via the diff viewer and the
    file-status poll. All three verified to execute against a live repo.
    - **Shipped (exact keys)**: every invocation in `commands::git::run_git`
      (local *and* the SSH path) goes through `hardened_git_args` — `-c
      core.fsmonitor=false`, `-c protocol.ext.allow=never`, plus
      `--no-ext-diff --no-textconv` on the subcommands that accept them. The
      two unattended spawns that build their own `Command`
      (`commands::usage_stats`'s recap `log`, `commands::fs`'s
      `ignored_paths_under` status) use the shared `hardened_git_command_in`.
      Tested in both directions (`a_repos_own_config_cannot_run_a_program_on_the_host`).
    - **Shipped 2026-07-28 (attacker-named keys)** — the structural fix, done
      as the narrower of the two shapes #142 named (not "stop exposing `.git`
      rw", which breaks in-container commits): before every **local** git
      call, `commands::git::sanitize_repo_git_config` reads the project's
      `.git/config` as a plain file (never as a repo — this itself cannot
      trigger a filter/hook) via `git config --file … --list --no-includes`,
      and strips any key matching `CONFIG_DENYLIST` — `filter.*.clean`/
      `.smudge`/`.process`, `diff.*.textconv`/`.command`, and `include.path`/
      `includeif.*.path` (closing the include-laundering bypass a filter/diff
      -only list would otherwise have). Unlike a `-c` override this matches by
      key *shape*, so the attacker's choice of driver name doesn't matter —
      closing the `filter.<driver>.clean` residual this item is named for.
      Wired through the same `hardened_git_command_in` chokepoint as the
      exact-key hardening, so `run_git`'s local branch and both standalone
      spawns get it for free. **Known cost, stated in code**: a repo that
      legitimately uses a content filter (Git LFS is the common case) loses it
      for every local git call this codebase makes — there is no way to keep
      "some filters, but not attacker-chosen ones" here, since the command
      name *is* the filter's entire configuration surface.
    - **Still residual, deliberately**: `.git/hooks/*` and `core.sshCommand`/
      `credential.helper` fire only on **user-initiated** writes (Commit,
      Push, Checkout) — a repo's own hooks are a feature there, and a config
      denylist can't reach a hook anyway (a file in a well-known directory,
      not a config key). Blocking `credential.helper`/`core.sshCommand` by key
      would also break a legitimate use (a helper or SSH wrapper set from
      inside a container, meant to carry to the host's later push) the same
      way blocking `filter.*` breaks LFS — closing them without that cost
      needs value-level judgment (an allowlist of known-safe values), not
      attempted here. `services::git_peer`/`worker_sync`/`git_publish` remain
      unhardened and out of scope (a *remote* project's mirror, never
      container-mounted), and neither is `sanitize_repo_git_config` run for
      **remote** git calls (a project container is local-only, so the
      container→host escalation this closes has no remote counterpart there).
    - [x] 🤖 Automated test — `sanitize_stops_a_repo_local_filter_clean_driver`
      (the named residual, closed), `sanitize_closes_the_include_laundering_bypass`
      (the bypass a naive filter/diff-only list would have, closed, plus an
      assertion the strip leaves unrelated config — `user.email` — alone),
      `config_denylist_matches_the_named_shapes_and_nothing_else` (the pure
      matcher, both directions).
    - [ ] 🖐️ Manual test — toggle a project's container on, have an agent
      inside it write `filter.evil.clean`/`.gitattributes`, confirm the host
      file tree's git status doesn't run it; confirm a real Git LFS repo's
      filter is (expectedly) inert for host-side status/diff/add while a
      container is active.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

152. **One gate for "this is already a project". (DONE ✅ · 🧪 Untested)** Importing
    or creating a project on a site another project already owns used to be
    refused in exactly one case — a local `keep` import of the same directory
    string — and `create_project` had no check at all. Three consequences, all
    data-shaped rather than cosmetic:
    - A **remote** project's registered `directory` is a per-id state dir, so the
      comparison could never match: the same `host:/path` could be imported any
      number of times, each copy with its own mirror and its own lockstep +
      byte-sync state driving one host tree, none aware of the others.
    - The check ran **after** the mode dispatch had already moved the files, so
      re-importing a registered folder under a different name in `move` mode moved
      the tree out from under the original entry and left it pointing at a path
      that no longer existed.
    - It compared raw strings, so `/a/foo`, `/a/foo/` and a symlink into it read as
      three different projects.
    - **Shipped**: `find_project_conflict` in `commands::projects` is now the one
      resolver, over a `ProjectSite` that is a local directory *or* an SSH
      target + host path (`ssh_target_key` mirrors the frontend's
      `machineSync.sameTarget` — host case-insensitive, default port 22, a
      different login is a different site). `create_project`, `import_project`,
      `finish_import` and `extend_project_to_remote` all route through it;
      `import_project` runs it **before** the move/copy touches the disk. A remote
      project's **mirror** counts as an owned tree, and `remote_mirror_in` now
      avoids a path another project has registered as well as one that exists.
      `copy` mode stays exempt on purpose — it duplicates into a new directory and
      leaves the source registered and intact, which is a real thing to want.
    - The dialog pre-checks via `check_project_site` and names the colliding
      project with an **Open it** button, so a clone/fork no longer downloads a
      whole repository into a destination the backend is about to refuse.
    - Known limit: a host path is compared as typed, so `~/work` and
      `/home/alice/work` are two sites. Only the host can expand `~`, and browsing
      to a folder always yields an absolute path, so this is reachable only by
      hand-typing the path.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---

153. **Harden Eldrun Mobile's local unlock into a cryptographic gate (PROPOSED
     — needs sign-off).** From the 2026-08-28 mobile security re-review. Today
     the phone's app lock (`mobile-web/src/localLock.ts`) is a UI gate: the
     device signing key is a non-exportable `CryptoKey` in IndexedDB usable by
     any script in the Serve origin, and the PIN is a PBKDF2 verifier that
     wraps nothing — so an unlocked, running phone plus origin script (remote
     debugging, or setting the `sessionStorage` unlock flag) bypasses the lock.
     Not a bug: the UI states this posture honestly ("protects against casual
     access to an unlocked phone"). The proposed enhancement uses the WebAuthn
     **PRF extension** to derive a wrapping key from a platform-authenticator
     assertion and store the device key **encrypted at rest**, so no usable key
     exists without a biometric/device-lock assertion where PRF is supported;
     PIN-only and PRF-incapable phones keep today's behavior (no lockout).
     Full spec — enrollment/unlock/migration, the extractable-key tradeoff, and
     the residual it does *not* close (unlocked-and-running) — in
     [`docs/eldrun_mobile_future_plan.md`](../docs/eldrun_mobile_future_plan.md)
     §G. Needs the user's sign-off on the extractable-key tradeoff before any
     implementation.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---
