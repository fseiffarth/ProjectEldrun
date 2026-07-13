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

---
