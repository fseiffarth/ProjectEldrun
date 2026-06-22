# ProjectEldrun Plan — Grouped & Numbered Open Ideas

## Context

This is the single home for open implementation plans, organized into coherent
groups with stable numbers. The raw idea dump lives in `open_ideas.md` (51 loose
ideas spanning the right file-tree panel, the bottom project switcher, X11/KDE
workspace switching, project import/publishing, git tooling, drag-and-drop
reordering, remote/SSH projects, branding, session restore, in-app file/text/tex
viewers, tab renaming/mapping, per-project security & remote-control toggles, a
native browser, keyboard-driven navigation, and right-panel polish);
cross-platform
Windows/macOS follow-ups (#30–#31), backend runtime follow-ups (#32), and the
global-app URI-routing item (#33) were consolidated here from the former separate
plan file and the old `TODO.md`. The goal of this plan is
**not** to implement everything at once, but to organize the ideas into coherent
groups with stable numbers so you can say "do #14" and I can act on a
well-scoped unit.

Exploration confirmed several ideas are partially built already — those notes are
called out per item so we don't rebuild existing infrastructure.

Numbering is **global and stable** (1–65); new ideas are appended with new
numbers so existing references never shift. Open groups are lettered A, B, C…
(roughly in suggested sequence); completed groups are renumbered D.1, D.2… and
collected at the **end** of this file. You can pick any item in any order.

## Status legend — Done ≠ Tested

Three independent axes are tracked per item:

- **✅ Done** — code-complete: written, type-checks (`npx tsc --noEmit`) and/or
  compiles (`cargo test`/`cargo build`). Says nothing about whether it actually
  works.
- **🤖 Automated** — an automated test (vitest under `src/__tests__/` or a Rust
  `cargo test`) exercises the behavior and passes on the current code.
- **🖐️ Manual** — runtime QA in a live Eldrun confirms the behavior by hand.

Each done feature carries two checkboxes — one per verification axis — with an
example test in words to guide both. A feature is fully **🧪 Tested** only when
**both** boxes are ticked.

> ✅ **Automated coverage complete; 🖐️ manual QA still pending.** Every done
> feature below now has a passing automated test (frontend `vitest` +
> backend `cargo test`), so all 🤖 boxes are ticked — the sole exception is
> **#25** (logo/icons), which is purely visual and has no meaningful automated
> test. A few are partial (noted inline): **#11** covers the CPU sampling
> helpers but not the live % readout, and **#22** covers `shell_quote` argv
> escaping but not the full `gh`/`ssh` publish flow. **No 🖐️ Manual box is
> ticked yet** — nothing has been runtime-QA'd in a live Eldrun, so treat each
> feature as fully 🧪 Tested only once its manual box also flips.

---

## Evaluation — Idea & Current State vs. Competitors

*Strategic assessment of Eldrun's concept and current feature set against the
competitive landscape (as of 2026-06). Not a numbered work item — context for
prioritization. Competitor specifics are current to ~early 2026; that field
moves monthly.*

### The core bet

Eldrun's thesis: **"you don't open apps, you open projects"** — switching a
project swaps the *entire desktop context* (windows, downloads folder,
default-app mappings, time tracking) as one unit, with built-in agent terminals
riding on top. The bet targets a real, under-served pain (window/context sprawl
across many concurrent projects) and sits in a gap no single competitor fills.
The README's positioning is honest and basically correct — but the bet has
structural vulnerabilities that matter more than the feature checklist suggests.

### Competitive map

- **Agent orchestrators — the gold rush Eldrun opts out of.** Vibe Kanban,
  Conductor, Claude Squad, Crystal, the Claude Code desktop/web app, Cursor
  background agents, plus cloud players (Devin, OpenAI Codex cloud, Google
  Jules, Sculptor). These parallelize agents across git worktrees with task
  queues, diff review, and merge flow. Eldrun's "agent cockpit" is just
  `claude`/`codex`/`gemini` in PTY tabs — i.e. *running the CLI*, nothing more.
  This is where funding and momentum are, and Eldrun explicitly doesn't play.
  **Verdict: complementary, not competitive — and the right call.** You can run
  Vibe Kanban *inside* an Eldrun project terminal. Building a weak orchestrator
  here would be a mistake.
- **AI IDEs/editors — Cursor, Windsurf, Zed, VS Code+Copilot, JetBrains.** Where
  developers actually live. Eldrun's center surface is a *terminal*, and it
  pushes the editor out to an external `xdg-open`'d window. **Biggest conceptual
  gap:** Eldrun is a shell *around* the dev experience, not the dev experience.
- **Terminal/session restorers — tmux+tmuxinator/tmuxp, Zellij, Warp, WezTerm.**
  tmux restores terminal layouts; Warp adds AI to the terminal. **Eldrun wins on
  scope (whole desktop, not just the terminal), but these are far more mature
  and cross-platform.**
- **Desktop context tools — KDE Activities, GNOME workspaces, i3/sway
  scratchpads, Arc Spaces, Workona.** Each solves one slice (Activities move
  windows but have no project model/restore; Workona/Arc are browser-tabs only).
  **Eldrun's "context as one unit" (windows + downloads + default apps + time)
  is more complete than any of these** — the downloads-rerouting and per-project
  default-app remapping are genuinely novel touches nobody bundles.
- **Dev-env managers — devcontainers, Gitpod/Coder, DevPod, Nix/direnv, mise.**
  Reproducible per-project *environments*, no desktop/window layer. Orthogonal
  (and the #38 Docker work moves Eldrun partway into this space).

### Honest strengths

- The gap is real and defensible: (desktop context switching) × (built-in agent
  terminals) on Linux is genuinely under-served.
- Thoughtful, concrete differentiators: per-project downloads routing,
  default-app remapping, time tracking, sticky cross-project app toolbar.
- Local/privacy posture: Ollama-backed local tabs + sshfs remote projects +
  all-local state, a real counter-position to the cloud-agent wave.
- Strategic honesty: positioning as complementary to orchestrators avoids a
  losing fight.

### Honest weaknesses / risks

- **Linux-X11/KDE-only is the dominant constraint.** The entire value prop hinges
  on window management that works on only a couple of compositors; Windows/macOS
  ship the differentiator missing. This caps the audience to roughly "the author
  and people like him." Cross-compositor support (Hyprland, Sway, GNOME) is
  make-or-break for adoption beyond personal use.
- **The editor gap (above):** without a first-class editor story, Eldrun risks
  being a layer people immediately tab away from.
- **Maturity vs. a fast-moving field:** ~75h logged, v0.1.0, single developer,
  and the entire "AI roadmap" (semantic search, startup suggestions, terminal
  hints) is unbuilt while funded orchestrator teams ship weekly.
- **Single-user, local-only** while the market trend is cloud/async/team agents.
- **Existential risk:** if an orchestrator or IDE grows a "workspaces" feature
  that manages windows/context (e.g. Cursor or the Claude Code desktop app adding
  project-scoped desktop state), Eldrun's gap closes from above. Its moat is
  desktop-integration depth — which is also its portability ceiling.

### Strategic take

Eldrun is best understood **not as an agent tool but as a project-context OS
layer**, and should lean all the way into that: *Eldrun is the desktop shell;
inside each project you run whatever the best orchestrator/IDE is.* That framing
turns its biggest "weakness" (not being an orchestrator) into the product.

Two priorities worth weighing **above** the AI-roadmap items:

1. **Portability** — at least Hyprland/Sway/GNOME (ties into Group C #18/#19 and
   Group H #30/#31). Without it the idea can't escape its author.
2. **A real editor/IDE integration story** — even just first-class "this
   project's editor window" treatment rather than embedding.

The idea is good and the gap is real. The execution risk is that it's a deep,
narrow, single-developer Linux tool competing for attention in a field racing
toward broad, cloud, team-scale agent automation — and the defensibility
(desktop depth) is in direct tension with the growth lever (portability).

---

## Group A — Bottom Panel: Meta-Project Grouping (new feature)
*Files: data model (`schema/project.rs`/`projects.rs`, `types/index.ts`), `ProjectSwitcher.tsx`, `ProjectPill.tsx`. No grouping concept exists today.*

13. **Project boxes / meta-project management.** Right-click to create a named,
    renamable box (e.g. PaperBox, CodingBox) that groups projects, with
    drag-and-drop of pills into boxes. Requires a new grouping field in the
    project/entry schema plus drag-drop UI and grouped rendering. Largest bottom-
    panel item.
    > **Phase 1 (#13) DONE (🤖 covered).** Box model (`schema/boxes.rs`
    > `ProjectBox`/`BoxRelation`, `boxes.json`) + box CRUD commands
    > (`commands/boxes.rs`: get/save/create/rename/delete/set_box_members) +
    > native-DnD pill-into-box + ungrouped-drop-zone + grouped pill rendering with
    > a distinct `.project-box-chip` (badge + member count) +
    > `stores/boxes.ts`/`BoxChip.tsx`. `box_id` rides in `ProjectEntry.extra`;
    > member_ids authoritative, `box_id` derived in-memory on load (no write).

41. **Project box containers (merge of two or more projects).** Building on #13,
    let a box be opened as a single *merged* workspace that spans its member
    projects rather than just a pill grouping. Specifics:
    - **Merged file view in the right panel.** Extend the right-panel file tree
      (`FileTree.tsx`/`RightPanel.tsx`) to render a box as a multi-root view —
      each member project listed as a top-level node, populated from that
      project's **stored state** (its `project.json` tree layout / file metadata)
      rather than re-walking only one root. Reuse the existing per-project file
      model so each member keeps its own git markers, hidden-file sections, etc.
    - **A box folder in the eldrun root.** Create a `~/eldrun/boxes/<box-name>/`
      (or similar under the eldrun root) directory per box to host box-scoped
      state and serve as the cwd for the box's terminals/agents.
    - **Agent tabs rooted in the box, hinted to each member.** Start the box's
      agent tabs rooted in the box folder, seeding each agent with hints/pointers
      to every member project's local agent files (`CLAUDE.md`/`AGENTS.md`/
      `GEMINI.md` and paths) so the agent can work across all merged projects
      from one place.
    - **Boxes in the project search (merge is opt-in).** Surface boxes as results
      in the "Search inactive…" box (`ProjectSwitcher.tsx`,
      `activateSearchResult`/`results`) alongside individual projects; picking a
      box result opens the merged box workspace. The merge is **opt-in** — a box's
      member projects stay independently searchable and can each be loaded on
      their own as a normal single project, without activating the box merge.
    - **Visual distinction box vs. single project.** Give boxes a distinct look
      from single projects everywhere they appear — in the search results
      (`project-search-row`), the pills (`ProjectPill.tsx`/`project-switcher`),
      and the right-panel multi-root header — e.g. a box icon/badge, member count,
      and/or a grouped style, so a merged box is never mistaken for a plain
      project. Add the corresponding styles in `themes.css`.
    - **Inter-project relations within a box.** Let a box record directed
      relations between its members — "a change in project A may influence
      project B" — e.g. project B depends on a Python library developed in project
      A, so editing A's library can break/affect B. Model as relation edges in the
      box metadata (source → dependents, with an optional kind/label like
      "python-lib" and an optional path/package hint). Surface them so the
      dependency is visible and actionable: show related members in the box view,
      flag dependents when a source changes (tie into the existing git-status
      markers so a dirty source highlights its dependents), and seed the box's
      agent hints with the relation graph so a cross-project agent knows which
      members a change ripples into. Auto-detection of relations (e.g. scanning
      `pyproject.toml`/`requirements.txt`/imports for local-path deps between
      members) is a stretch goal; manual declaration is the baseline.
    - Schema/model: extends the #13 grouping field with box-as-workspace metadata
      (member list, box folder path, relation edges); touches
      `schema/project.rs`/`projects.rs`, `types/index.ts`, `ProjectSwitcher.tsx`,
      `RightPanel.tsx`/`FileTree.tsx`, and the runtime/spawn path that sets
      agent-tab cwd + env. Scope to be refined when picked.
    > **Phase 2 (#41 groundwork) DONE (🤖 covered):** full box schema stored
    > (`folder`, `relations` via `set_box_relations`), lazy
    > `~/eldrun/boxes/<name>/` creation (`ensure_box_folder`, idempotent +
    > name-collision-safe against reserved `folder`s and on-disk dirs), boxes in
    > the project search (`.project-search-row.is-box`, opt-in — members stay
    > searchable), and opt-in box activation (`openBox` → `box:<id>` scope rooted
    > in the box folder). **Box scopes are session-only this pass** —
    > `switch_project_runtime` does not persist/restore them.
    > **DEFERRED (explicit follow-on, NOT this pass):** Phase 3 merged multi-root
    > file tree (`RightPanel.tsx`/`FileTree.tsx`); Phase 4 agent-hint seeding +
    > relation-graph surfacing (dirty-source→dependent git markers,
    > auto-detection). Schema groundwork for both is in place.
    - [x] 🤖 Automated test — `commands/boxes.rs` cargo tests (reconcile drops
      unknown member_ids / recomputes box_id inverse / drop-on-delete, gap-spaced
      position, defaults round-trip, folder-collision suffixing); `paths.rs`
      `boxes_root`; vitest `BoxAssignment` (assign/unassign/move/delete sweep,
      create/rename, derive-on-load no-write), `BoxRendering` (grouped vs inline,
      orphan box_id inline, chip drop ≠ reorder, ungrouped drop), `BoxSearch`
      (is-box row → openBox, members independently searchable). Covers Phase 1 +
      Phase 2 groundwork; Phase 3/4 deferred.
    - [ ] 🖐️ Manual test

---

## Group C — Workspace Switching / Platform Stability
*Files: `src-tauri/src/platform/x11.rs`, `wayland_kde.rs`, `null.rs`, `services/window_service.rs`, `services/project_runtime.rs`, `commands/workspace.rs`.*

15. **Securely move opened files/windows to the hidden workspace on switch
    (X11).** Fix the reported issue where files/windows opened in one project
    aren't reliably parked on the hidden desktop when switching. Investigate the
    move-retry logic (x11.rs ~retry 5×30ms) and window registry coverage.

16. **Make X11 workspace switching rock-solid.** Broader hardening of the
    two-desktop parking model — fix all known races/flakiness around
    show/hide/switch. (#15 is a specific symptom of this.)

17. **Preserve window z-order across switches.** Today `show_window` always
    raises to `Above` (x11.rs:120), losing stacking order. Track per-window
    z-order in the window registry/session and restore it on show.

18. **KDE Plasma i3-style workspace mode.** Explore an i3-like tiling/workspace
    behavior on KDE Plasma. Note: KDE Wayland per-window show/hide is currently a
    **no-op** (`wayland_kde.rs:74-80`) and needs KWin scripting first — this is
    research + sizable backend work.

19. **Cross-platform verification: Windows, macOS, KDE Plasma.** Verify the app
    runs and degrades gracefully where workspace backends are absent (null
    backend) and KDE works. Mostly QA + targeted fixes. OS-specific build,
    packaging, and native-window work is tracked separately in Group H (#30/#31).

---

## Group E — Git Worktree (new feature)
*No worktree code exists anywhere today.*

23. **Git worktree support.** Add backend commands to create/list/remove git
    worktrees and surface them in the UI (likely tied to Group D.3 history view
    and/or project switching). Net-new feature; scope to be defined when picked.

---

## Group F — Session Restore
*Files: `src-tauri/src/schema/active_session.rs` (defined but unused), `services/project_runtime.rs`, `terminal_service.rs`, `src/stores/tabs.ts`, `CenterPanel.tsx`.*

24. **Restore/resume agent sessions.** Terminal/tab layout persistence already
    exists (`.eldrun/sessions/terminals.json`), but app-startup restore via
    `active_session.json` is **unused**. Wire up restoring the full prior session
    (active project, tabs, windows) on launch. Feasibility note: resuming the
    actual *agent* process state depends on the agent CLI's own resume support;
    realistic scope is restoring tabs + relaunching the agent, not live state.
    Agent-resume approach (migrated from TODO `ISSUE-RESUME`): when restoring a
    tab, detect that tab's most recent agent session ID from the agent's own
    session directory — Claude Code `~/.claude/projects/<encoded>/`, Codex
    `~/.codex/sessions/`, Gemini `~/.gemini/history/`, Vibe
    `$VIBE_HOME/logs/session/` — and pass `--resume <id>` when respawning. A
    prior attempt was removed 2026-06-07 because detection was unreliable and
    **each tab must track its own distinct session ID** (not the project-global
    latest) to work with multi-agent setups; solve per-tab session tracking
    before relying on `--resume`.

39. **Per-tab agent session restore — stepwise.** Concrete, incremental path to
    #24's hard part (per-tab session tracking), built one step at a time so each
    step is verifiable on its own.
    - [x] **39a — Surface a tab's launch session id (Claude).** ✅ Done. Eldrun
      mints a UUID and launches Claude with `claude --session-id <uuid>`, stored
      on `TabEntry.sessionId` and shown on tab hover. This **launch id** is
      deterministic, stable, and unique per tab. *Files: `stores/tabs.ts`
      (`sessionId`), `components/tabs/TabBar.tsx`.* Pure frontend — no rebuild.
      **Known limitation (drove the design):** the id does **not** follow a
      `/clear` (which rolls Claude onto a new session id). A first attempt
      resolved the "live" id from the newest `<uuid>.jsonl` in
      `~/.claude/projects/<encoded-cwd>/`, but that was **removed** — all Claude
      sessions in a project (other tabs, *and the dev agent running in the same
      cwd*) share one folder, so "newest file" cross-contaminates: two tabs
      showed the same id and it drifted as any session wrote. Following `/clear`
      reliably needs per-process attribution, not directory guessing → 39c.
      - *Test (e.g.):* open two Claude tabs in one project → each hover shows a
        distinct, stable UUID that never changes while the tab is open.
      - [ ] 🤖 Automated test — none yet (trivial frontend tooltip; covered by
        manual)
      - [ ] 🖐️ Manual test
    - [x] **39b — Persist agent tabs with their session id.** ✅ Done.
      Resumable agent tabs (Claude with a `sessionId`) are now persisted in
      `tab_layout` (carrying `sessionId`) and restored on relaunch; other agent
      tabs are still dropped. *Files: `schema/project.rs` (`TabEntry.session_id`),
      `stores/tabs.ts` (`isRestorableTab`/`saveLayout`/`loadFromLayout`),
      `stores/projects.ts`, `components/layout/CenterPanel.tsx`.*
    - [x] **39c — Track the live session id across `/clear`, then resume.** ✅
      Done for Claude. The original hard part — following the *live* session id
      after `/clear` (Claude rolls onto a fresh id with no recorded back-link to
      the launch id) — is solved with a global Claude **`SessionStart` hook**
      (fires on startup/resume/clear/compact) that records the live `session_id`
      keyed by `$ELDRUN_TAB_UID`. Eldrun sets `ELDRUN_TAB_UID` to the tab's
      stable launch id on spawn, then at (re)spawn resolves the hook-recorded
      live id and emits `claude --resume <live-id>` (falling back to the launch
      id, and downgrading to `--session-id` when no log exists yet). The hook is
      installed once into `~/.claude/settings.json` and no-ops for any Claude not
      launched by Eldrun. *Files: `services/agent_session.rs` (hook install +
      live-id store), `terminal/mod.rs` (`resolve_claude_session`), `lib.rs`
      (install at startup). Hook script: `~/.local/share/eldrun/hooks/`; live ids:
      `~/.local/share/eldrun/live_sessions/`.*
    - [~] **39d — Generalize to other agents.** Codex done; Gemini/Vibe open.
      - [x] **Codex.** ✅ Done. Codex mints its own session id (no launch-time
        `--session-id`), but it has a Claude-style `SessionStart` hook and resumes
        by uuid (`codex resume <id>`). Eldrun sets `ELDRUN_TAB_UID` (a per-tab key)
        on the Codex tab, installs a `SessionStart` hook into `~/.codex/config.toml`
        (TOML text-append, idempotent) that records the live session id under that
        key, then at spawn resolves it and launches `codex resume <live-id>` when a
        rollout log exists (else fresh). Covers `/clear` (Codex `source` includes
        `clear`). *Files: `services/agent_session.rs` (`register_codex_hook`),
        `terminal/mod.rs` (`resolve_codex_session`/`codex_session_exists`),
        `stores/tabs.ts` (`RESUMABLE_AGENTS.codex`), `components/tabs/TabBar.tsx`.*
        ⚠️ **Manual step:** user-level Codex hooks require a one-time trust
        approval — run `/hooks` in Codex and trust the Eldrun hook; until then
        resume is inert (Codex starts fresh, nothing lost). Also unverified at
        runtime: whether Codex forwards `ELDRUN_TAB_UID` to the hook's env.
      - [ ] **Gemini.** `--session-id <uuid>` sets the launch id (already passed),
        but `--resume` takes an index/`latest`, not a uuid; resume-by-uuid likely
        needs `--session-file ~/.gemini/tmp/<project>/<uuid>`. No `SessionStart`
        hook → would drift on `/clear` like pre-fix Claude. Needs runtime verification.
      - [ ] **Vibe.** `--resume <id>` works but Vibe mints its own id with no
        launch-id control and no hook mechanism found, so per-tab tracking would
        need the rejected newest-session-file heuristic. Deferred.

---

## Group G — Remote / SSH & Containerized Projects (work axes)
*Files: `src-tauri/src/schema/project.rs` (project model is local-only:
`directory` is a local path, no host/remote/container fields), `services/project_runtime.rs`,
`services/ssh_mount.rs` (mount lifecycle — the pattern for container lifecycle),
`terminal/` (PTY cwd / exec target), `commands/projects.rs` (create/import),
`commands/ssh.rs`, file-tree commands. These items share a theme: a **work
axis** — *where the project's process and files live* (host, SSH remote, or
container) — as opposed to the git **push** axis (#21/#22).*

28. ✅ **SSH-based projects (remote path, remote agent).** Implemented via an
    **sshfs mount**: a remote project's bytes live on `host:remote_path` and are
    mounted to `~/.local/share/eldrun/mounts/<project-id>/`; the project's
    `directory` points at that mountpoint so the file tree, terminal cwd, and git
    keep working unchanged. New `RemoteSpec` (`user?`, `host`, `port?`,
    `remote_path`) on the project schema + `projects.json` `extra`. New
    `commands/ssh.rs` (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`,
    `ensure_project_mounted`) shells out to system `ssh` in `BatchMode=yes`
    (keys/agent/`~/.ssh/config` are the source of truth; no in-app passwords).
    New `services/ssh_mount.rs` handles mount/unmount lifecycle (idempotent
    mount, `/proc/mounts` check, `fusermount -u` with `umount` fallback,
    sshfs-missing guard, unmount-all on app exit). `create_project`/
    `import_project` accept an optional `remote` and scaffold over the mount
    (remote import is `keep`-only). `ProjectSwitcher.tsx` add/import dialog gains an
    SSH-address field + Connect and an in-app remote folder browser. Active
    remote project is mounted on startup (best-effort, non-blocking) and on
    switch. Requires `sshfs`/FUSE locally. **Runtime QA pending** (agents can't
    launch Eldrun); password/interactive auth out of scope for v1;
    project-removal unmount is a follow-up (no delete command exists yet — stale
    mounts are cleaned up on next app exit). See `docs/ssh_projects_plan.md`.
    - *Test (e.g.):* add a project via SSH address against a key-auth host
      → folder browser lists the remote dir, the project mounts under
      `mounts/<id>/`, terminal cwd + file tree work on the remote files, and the
      mount is cleaned up on app exit.
    - [x] 🤖 Automated test — `services/ssh_mount.rs` unit tests (validate_arg, mountpoint_for, sshfs_args)
    - [ ] 🖐️ Manual test
    - **Manual QA checklist (live, step-by-step).** Runtime test plan for
      #28/#28b — agents can't launch Eldrun, so these are hand-checks. Each box is
      one check; a phase is done when all its boxes are ticked.
      - *Phase 0 — prerequisites / baseline.*
        - [ ] Local tooling on `PATH`: `sshfs`, `fusermount` (or `umount`); for
          password auth `sshpass`; for VPN-gated hosts `openvpn` + `pkexec`.
        - [ ] A reachable host with working key/agent auth; ideally a second
          host/account that requires a **password** (no key) to exercise `sshpass`.
        - [ ] `cargo test --manifest-path src-tauri/Cargo.toml` green.
        - [ ] `npx tsc --noEmit` green.
      - *Phase 1 — connect (`ssh_connect`/`ssh_default_dir`).*
        - [ ] Tick **Remote (SSH) project** → SSH address + password + Connect
          section appears.
        - [ ] `user@host` (key auth, blank password) → Connect succeeds.
        - [ ] `user@host:port` with a non-default port → Connect succeeds.
        - [ ] Bare `host` (no user, via `~/.ssh/config`) → Connect succeeds.
        - [ ] Password-only host + correct password → Connect succeeds (`sshpass`).
        - [ ] Wrong password → clear ssh-stderr error, no hang.
        - [ ] Password auth with `sshpass` not installed → actionable error.
        - [ ] Unreachable host/bad name → fails within ~10s (ConnectTimeout), UI
          stays responsive.
        - [ ] Editing the address/password after connect resets to disconnected.
      - *Phase 2 — browse (`ssh_default_dir`/`ssh_list_dir`).*
        - [ ] Browser opens at remote `$HOME`.
        - [ ] Dirs-first, case-insensitive name sort; hidden entries shown;
          `.`/`..` hidden.
        - [ ] Click a dir descends; **Up** ascends; can't go above `/`.
        - [ ] Dir names with spaces/unicode render correctly.
        - [ ] No-permission directory → error surfaced, dialog stays usable.
        - [ ] "Use this folder" commits the chosen remote path.
      - *Phase 3 — create remote project.*
        - [ ] Connect → browse → Use folder → Create → project created with a
          generated id.
        - [ ] Mounted under `~/.local/share/eldrun/mounts/<id>/`; `directory`
          points at the mountpoint (check `/proc/mounts`).
        - [ ] Scaffold files written **over the mount** only where missing.
        - [ ] `project.json` carries `remote`; `projects.json` entry mirrors it
          under `extra`.
        - [ ] Create against a password-only host → confirm mount behavior /
          error (mount path still `BatchMode=yes`; see 28c password half-state).
      - *Phase 4 — import remote project.*
        - [ ] Import an existing remote dir (keep-only) → mounts, persists
          `remote`, does not relocate bytes.
        - [ ] Scaffold-fill agent tabs are local-disk-only on remote import.
      - *Phase 5 — mount lifecycle.*
        - [ ] Switch away and back → mount persists / re-mount is a no-op.
        - [ ] Restart with a remote project active → startup best-effort mount;
          an offline host at boot does **not** block app start.
        - [ ] Quit → `unmount_all` tears down every mount (`/proc/mounts` clean).
        - [ ] Hard-kill leaving a stale mount → relaunch reuses it without error.
        - [ ] Host offline mid-session → reconnect/keepalive recovers; no
          permanent wedge.
      - *Phase 6 — behaves like local (over the mount).*
        - [ ] File tree lists remote files.
        - [ ] Open/edit/save a file → change lands on the remote.
        - [ ] Git status/history work against the mountpoint.
        - [ ] Plain shell tab cwd/behavior as expected (see Phase 7).
      - *Phase 7 — remote agent execution (`ssh_exec.rs`).*
        - [ ] Claude agent tab runs **on the remote** via `ssh -tt` (verify
          hostname/env inside the agent).
        - [ ] Resize resizes the remote PTY; exit/kill ends the remote session.
        - [ ] Second tab multiplexes over the ControlMaster socket; master
          persists ~600s after the last session.
        - [ ] Userspace CLI (`~/.local/bin`/nvm/pyenv) is found (login-shell PATH).
        - [ ] Auto-bootstrap (probe → install → re-probe; `exit 127` + hint on
          failure) runs live in the PTY on a remote missing the CLI.
        - [ ] First-run `claude login` works inside the remote PTY.
        - [ ] Local `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is **stripped** from the
          remote env (remote's own login used).
        - [ ] `local_only` tabs (local Ollama) are **not** wrapped — run locally.
        - [ ] Codex/Gemini/Vibe remote tabs — note current behavior (recipes may
          not be generalized yet).
      - *Phase 8 — OpenVPN-gated hosts.*
        - [ ] Project with `remote.openvpn.config` → tunnel comes up first; VPN
          password prompted and **never persisted**.
        - [ ] `openvpn_status` detects an already-up tunnel (no double-connect).
        - [ ] Missing `openvpn`/`pkexec` → actionable error.
        - [ ] Quit → `disconnect_all` brings tunnels down.
      - *Phase 9 — security / argument injection (spot-check; mostly auto).*
        - [ ] UI can't send a host/user/path beginning with `-` to ssh.
        - [ ] Control chars / newline / NUL in any field rejected.
        - [ ] Empty host (or empty user when provided) rejected.
        - [ ] During a password connect, the password is only in the `SSHPASS`
          env, never in argv (inspect the process list).
      - *Phase 10 — persistence & restart.*
        - [ ] Resumable Claude/Codex tabs in a remote project restore and resume
          on the remote on relaunch.
        - [ ] `project.json`/`projects.json` round-trip `remote` across restart.
    - **28b — Remote agent execution (decided 2026-06-19: agents run ON the
      remote).** A remote project's bytes are sshfs-mounted **only** for
      Eldrun's own file tree / git / `list_dir`; terminal **and agent** tabs
      instead run on the remote host via `ssh -tt`. `services/ssh_exec.rs`
      (`wrap_pty_options`) rewrites any spawn whose cwd is under the mounts root
      into `ssh -tt [-p port] [user@]host '<remote_command>'`, multiplexed over a
      ControlMaster socket; `remote_subdir` maps the local mount cwd back to the
      remote path and `remote_command` builds `cd <dir> && export … && exec
      <cli> …`. VPN-gated hosts bring an OpenVPN tunnel up first via
      `services/openvpn.rs` (pkexec + askpass temp file + ready-marker wait,
      disconnect-all on exit) when `RemoteSpec.openvpn` is set. Rationale and the
      rejected alternatives (local-CLI-over-sshfs; per-command `ssh host -- …`
      helper) are in `docs/ssh_projects_plan.md` → *Remote execution model*. This
      makes a **userspace** agent-CLI install on the remote load-bearing; the
      items below close the gaps.
      - [x] **Login-shell PATH for agent tabs.** `remote_command` now runs agent
        tabs through `exec "${SHELL:-/bin/bash}" -lc '<quoted cli + args>'` (was a
        bare `exec '<cli>'` under ssh's non-login shell), so a userspace
        `~/.local/bin`/nvm/pyenv CLI is on PATH and resolves. Shell tabs keep
        `$SHELL -l`.
        - [x] 🤖 Automated test — `remote_command_agent_runs_under_login_shell`
          asserts the `-lc` login-shell wrap with correct single-quoting
      - [x] **Auto-bootstrap + detect the remote CLI.** Implemented in new
        `services/remote_agents.rs` (recipe table keyed by agent base name:
        probe `bin`, userspace `install`, manual hint). Rather than a separate
        command, `bootstrap_prelude` is **folded into** `remote_command`'s
        `$SHELL -lc` script for recognised agents: it probes
        `command -v <bin>`, runs the userspace installer if missing
        (claude → `npm install -g @anthropic-ai/claude-code`), re-probes, and
        `exit 127`s with a manual hint on failure — all live in the PTY, so
        install progress and the first-run `login` show in the terminal. Unknown
        commands get no prelude. (Chose PTY-folded over a Tauri
        `ensure_remote_agent` command: no event plumbing, fully unit-testable.)
        - [x] 🤖 Automated test — `remote_agents` (`recipe_for` base-name match,
          `bootstrap_prelude` probe/install/abort) + `ssh_exec`
          `remote_command_agent_bootstraps_known_cli`
      - [x] **Remote auth = the remote's own login.** Decided: the remote `claude`
        authenticates with its own `~/.claude` credentials; the first run prompts
        an interactive `claude login` in the PTY (works because agent tabs get a
        real `-tt` PTY). `remote_command` now strips agent-auth env vars
        (`AGENT_AUTH_ENV`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
        `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
        `GOOGLE_API_KEY`) from the exported env so a local key can't clobber the
        remote session.
        - [x] 🤖 Automated test — `remote_command_strips_agent_auth_env` asserts
          auth vars (and their values) are excluded while ordinary env is kept
      - [ ] **Generalize bootstrap/detect to other agent CLIs** (Codex, Gemini,
        Vibe): add one `AgentRecipe` row per agent to `remote_agents::RECIPES`
        (the framework + claude recipe already ship); keep honoring the existing
        `local_only` flag (local Ollama agents are never wrapped).
      - [ ] 🖐️ Manual test — connect (VPN if needed) → open a remote agent tab →
        the CLI is detected/installed, logs in on first run, and runs a pipeline
        on the remote (remote GPU/env), with edits visible in Eldrun's file tree.
    - **28c — Hardening & gaps (two-reviewer review, 2026-06-19).** A
      code-correctness/security pass plus an architecture pass over #28/#28b.
      Ordered by severity.
      - [ ] **[Critical] Remote command injection in the browse commands.**
        `ssh_list_dir`/`ssh_default_dir`/`ssh_connect` (`commands/ssh.rs`) hand
        remote argv tokens to `ssh`, which space-joins them into one remote
        `$SHELL -c` string; `validate_arg` only blocks a leading `-`/control
        chars, so a `path` containing `;`/`$()`/backticks/spaces (e.g. a remote
        dir name the user clicks while browsing) runs arbitrary remote code.
        Route these through a shared `shell_quote` (lift from `ssh_exec`) and
        send a single pre-quoted remote string; add injection tests (`;`, `$()`,
        backtick, space, quote).
      - [ ] **[Critical] Remote agent tabs never resume (ordering bug).**
        `wrap_pty_options` rewrites `opts.cmd` `claude`/`codex`→`ssh`
        (`commands/terminal.rs`) *before* `spawn_pty`'s `resolve_agent_session`
        dispatches on `opts.cmd` (`terminal/mod.rs`), so `--resume`/`codex
        resume` are never injected; the ELDRUN_TAB_UID + SessionStart mechanism
        is also local-only (it reads the local `~/.claude`/live_sessions while a
        remote agent logs on the remote). Resolve session args *before* the
        ssh-exec rewrite and embed them in `remote_command`, and install the
        SessionStart hook + live-id lookup on the remote — or document remote
        agents as non-resumable for now.
      - [ ] **[High] Serialize `mount()` per project id.** The
        `is_mounted`→`sshfs` sequence in `ssh_mount::mount` is TOCTOU and
        `ensure_project_mounted` runs from several call sites concurrently, so
        two activations can stack FUSE mounts (the second shadows the first;
        `unmount` removes only one → leak). Guard with a per-id global mutex and
        re-verify `is_mounted` after `sshfs`.
      - [ ] **[High] Validate exported env in `remote_command`.** Env keys are
        interpolated raw into `export {k}=…` (`ssh_exec.rs`); a key containing
        `=`/space/newline injects a second `&&` command. Require keys to match
        `^[A-Za-z_][A-Za-z0-9_]*$` and reject NUL in any quoted value; test a
        malicious key.
      - [ ] **[High] Centralize VPN-gated activation ordering.** The backend
        mount path (`project_runtime::ensure_remote_mounted`,
        `ensure_project_mounted`) never calls `openvpn::connect` — only the
        frontend does — so switching to a VPN-gated project from the backend
        fails with an opaque ssh timeout. One entry point should do VPN-connect →
        mount → exec and fail loudly ("VPN not connected — use Connect in the
        dialog"), since the backend can't prompt for the password.
      - [ ] **[High] Resolve the password-auth half-state.** `ssh_mount`/
        `ssh_exec` hardcode `BatchMode=yes`, so a password-only host browses in
        the dialog but then fails at mount/exec. Either thread the password via
        `sshpass`/`SSHPASS` (as `commands/ssh.rs` already does for browse) or
        gate remote create/import on key/agent auth and mark password hosts
        browse-only — don't ship the silent half-state.
      - [ ] **[High] Connection-loss / stale-handle recovery + UX.** sshfs
        `reconnect` doesn't heal a stale FUSE handle (`is_mounted` still returns
        true → `mount()` no-ops), and exec tabs die silently. Treat a statfs
        failure on a mounted path as not-mounted so `mount()` remounts; add a
        reconnect/remount action and a connection-state badge on remote project
        pills.
      - [ ] **[Medium] OpenVPN robustness.** (a) `wait_for_ready` only checks the
        timeout when a new stdout line arrives, so a silent hang (stuck auth /
        black-hole) blocks `connect` forever — read on a thread with
        `recv_timeout`. (b) `is_connected` tracks only tunnels this process
        started, so a tunnel surviving a crash isn't detected and `connect`
        spawns a duplicate / `pkexec` re-prompts — reconcile via the pidfile/tun
        device. (c) teardown via `pkexec kill` re-prompts polkit at exit, so the
        root tunnel can survive app exit — launch once with a teardown trap or a
        persistent privileged helper.
      - [ ] **[Medium] Mount-detection edge cases.** Unescape `/proc/mounts`
        octal sequences (`\040` etc.) and canonicalize before comparing in
        `is_mounted` (refactor the field parsing into a pure, unit-tested fn) to
        avoid stacking/leaks when the state-dir path contains spaces; treat
        `Some(port) == 0` as "no port"; bound/short-hash the ControlPath so it
        stays under the AF_UNIX 108-byte limit.
      - [ ] **[Medium] Host-key (TOFU) trust UX.** Browse/mount use
        `BatchMode=yes`, which *fails* on an unknown host key with no prompt,
        while the exec path drops BatchMode to prompt in-terminal — but that's
        only reached after a mount that already failed. Add an explicit
        `ssh-keyscan`/known_hosts confirmation step in the connect flow.
      - [ ] **[Medium] Project-delete teardown + startup GC.** When a delete
        command lands, `unmount` + remove the mountpoint dir + `ssh -O exit` the
        control master + `openvpn::disconnect` if unused; add startup GC of stale
        mounts (ties into the stale-handle fix above).
      - [ ] **[Medium] Generalization auth stories (extends the open item in
        #28b).** Adding Codex/Gemini recipes is one `AgentRecipe` row each (npm:
        `@openai/codex`, `@google/gemini-cli`); Vibe likely needs a
        `manual_hint`-only entry. Each needs a documented remote-auth story, and
        verify `local_only` is actually set end-to-end for Ollama-backed tabs.
      - [ ] **[Low] Smaller items.** Replace `which`-based binary detection
        (`sshfs`/`sshpass`/`openvpn`) with in-process PATH search; lazy-unmount
        (`-z`) as a last resort at exit; feed the askpass passphrase to OpenVPN
        via stdin/fd instead of a 0600 temp file (plaintext currently survives a
        crash); document `parse_ls_output` symlink-vs-dir `-p` semantics.
      - [ ] 🤖 **Test coverage to add** — injection-safety of the browse `path`;
        malicious env keys in `remote_command`; a pure `/proc/mounts` field
        parser (`\040`); `wait_for_ready` timeout with no output; mount
        double-spawn; `shell_quote` round-trip incl. NUL/newline.
      - **Refactor / future ideas.**
        - [ ] **Factor a target-agnostic spawn-rewrite layer before Docker
          (#38).** `ssh_exec::wrap_pty_options` hardcodes mount-path detection,
          `AGENT_AUTH_ENV`, `shell_quote`, the `-lc` login wrap, and the
          `remote_agents` bootstrap; #38 would duplicate all of it. Extract a
          trait ("PtyOptions + target descriptor → rewritten argv") with SSH and
          Docker impls so the resume fix, the recipes, and Phase-2 composition
          (`ssh … docker exec …`) land once.
        - [ ] **Document the split-model consistency tradeoffs.** git/`list_dir`/
          file-tree run locally over sshfs while the agent edits on the remote:
          slow git, weak sshfs inotify (stale tree), line-ending/identity
          mismatches. Document the model; consider running `git` on the remote
          via the exec wrapper; add a manual "refresh file tree" affordance.
        - [ ] **SSH `LocalForward` per project** to reach remote dev-server ports
          at `localhost:port`.
        - [ ] **Remote-status panel** (mount state, control-master liveness, VPN
          state, last error) for debuggability.

38. **Run projects inside Docker containers.** Let a project be started in a
    Docker container instead of (or in addition to) directly on the host: the
    project's terminal/agent tabs run via `docker exec` into a container, with the
    project directory bind-mounted as the working dir so the file tree and git
    keep working. Mirrors the two-mechanism split the SSH axis (#28) settled on —
    a lifecycle service `services/docker_runtime.rs` (cf. `ssh_mount.rs`) and a
    spawn-rewrite service `services/docker_exec.rs` (cf. `ssh_exec.rs`). **Key
    difference from #28:** the bytes are already local, so the file tree / git /
    `list_dir` keep running against the **host** `directory` unchanged — only
    terminal/agent **spawns** are rewritten into the container. Full plan in
    `docs/docker_projects_plan.md`. Requires Docker/Podman locally.

    **Data model (both phases).** New `DockerSpec` on the project schema +
    `projects.json` `extra` (same as `RemoteSpec`). The container source must be
    **exactly one** of `image` / `dockerfile` / `compose_file`+`service` /
    existing `container` — model it as a **tagged `ContainerSource` enum** (not
    four parallel `Option`s) so illegal/empty states are unrepresentable, with a
    `DockerSpec::source()` validator called in `up` and in create/import. Plus
    `workdir` (default `/workspace`), `run_args`, `engine` (docker|podman), and a
    Phase-2-only `remote: Option<RemoteSpec>`. A project is containerized iff
    `docker` is present. `directory` stays the **host** path in Phase 1 (no
    mountpoint indirection). Mirror in `types/index.ts`.

    **Review notes (2026-06-19, two-reviewer reconciliation).** The two-service
    split is sound and `ssh_exec.rs` exists as claimed, but three "cf. SSH"
    shortcuts do **not** carry over and are folded into the bullets below:
    project-from-cwd resolution (no local analogue — H below), `down_all`
    enumeration (no on-disk artifact), and the Phase-2 double-quoting. Plus a
    container-specific security surface SSH never had (`run_args` flags,
    bind-mount, file ownership).

    - [ ] **38a — Phase 1: local Docker** (container on the same host;
      independently shippable).
      - **Project resolution (do NOT mirror `project_id_from_cwd`).**
        `ssh_exec::project_id_from_cwd` only works by stripping `mounts_root()`;
        local docker keeps `directory` = host path with no embedded id, and
        `ProjectEntry` has no `directory`. **Carry the project id (or the resolved
        `DockerSpec`) on `PtyOptions` from the frontend at spawn time** (the tab
        already knows its project) — avoids an O(projects) disk scan and nested-dir
        ambiguity.
      - `services/docker_runtime.rs` (new) — lifecycle keyed by project id,
        `eldrun-<id>` container name convention. `engine_available`,
        `is_running` (`docker ps` exact match), `up` as a **three-state machine**
        (missing→`docker run -d -v <host_dir>:<workdir> -w <workdir> … sleep
        infinity`; stopped→`docker start` (a bare `run` collides on the name);
        running→no-op), reconciling a **stale config** via an
        `eldrun.spec-hash=<hash>` label (recreate when the spec diverges);
        dockerfile→`build` then run; compose→`compose up -d`; existing
        `container`→verify only. `down`/`down_all` must **never** stop/remove the
        pre-existing-`container` variant, and scope compose teardown to its file.
        `down_all` **enumerates from the engine** (`docker ps -q --filter
        name=^/eldrun-`), not from disk (no mountpoint artifact exists). Serialize
        per-project `up` so rapid switches don't race two `--name eldrun-<id>`.
        Argv built as `Vec<String>` for unit-testability.
      - **Arg validation (stricter than SSH's `validate_arg`).** Keep strict
        `validate_arg` (no leading-`-`/control chars) for `image`/`workdir`/
        `container`/`service`; **`run_args` is a separate class** (it legitimately
        holds flags) — denylist host-escape flags (`--privileged`,
        `--network=host`, `--pid`/`--ipc=host`, `-v`/`--volume`, `--device`,
        `--cap-add`, `--security-opt`, `--user`, `--entrypoint`) or gate behind an
        explicit "advanced/unsafe" ack, and insert a `--` separator before the
        image/command. Validate `workdir` is **absolute** and reject `/` and
        system dirs; the bind source is the project `directory` by construction.
      - **File ownership.** Rootful docker writes root-owned files that break the
        host file tree/git (which run as the user) — the whole point of the
        feature. Auto-inject `--user $(id -u):$(id -g)` for image/dockerfile on
        rootful docker (NOT podman-rootless, whose mapping is inverse), don't
        relegate it to a manual `run_args` escape hatch.
      - `services/docker_exec.rs` (new) — rewrite a containerized tab's
        `PtyOptions` to `docker exec -it -w <in_cwd> [-e K=V…] <name> <cmd…>` (or
        login shell when cmd empty; `compose exec <service>` for compose).
        `container_workdir` translates host cwd → in-container path (genuine
        `remote_subdir` mirror). For the `-e` path, **re-implement** the auth-var
        (`AGENT_AUTH_ENV`) / `TERM`/`COLORTERM` stripping `remote_command` does
        (the SSH version exports in a shell string, not `-e` flags); decide
        whether a local container is denied host API keys. Honor the existing
        **`local_only`** flag verbatim and sit inside the same
        `if !opts.local_only` guard at `commands/terminal.rs:30`, mutually
        exclusive with ssh-wrap in Phase 1.
      - Wiring: `project_runtime::switch` best-effort `up` on switch to a docker
        project (precedent: `ensure_remote_mounted` at `project_runtime.rs:93`);
        `CreateProjectRequest`/`ImportProjectRequest` gain optional `docker`;
        `lib.rs` `RunEvent::Exit` calls `down_all()` alongside `unmount_all()`;
        new `commands/docker.rs` (`docker_available`, `docker_list_images`,
        `ensure_project_container`). Engine default: auto-detect docker→podman,
        frozen per project at create time.
      - Frontend: `ProjectSwitcher.tsx` "Run in container" dialog section as a
        **radio** over the four sources (enforces exactly-one) + workdir/run_args/
        engine; build a `dockerSpec` and add `docker: dockerSpec` to **both**
        create/import `req` payloads; extend `canSubmit` (refactor the nested
        ternary to a function) for docker validity; populate via `docker_available`
        + `docker_list_images` with the existing `project-dialog-error` surfacing.
        Startup `ensure_project_container` (in `stores/projects.ts::load()`,
        fire-and-forget like the SSH path) must **only `start` an already-present
        container — never implicitly pull/build** (minutes-long, no progress behind
        a `void`); surface "image missing / build needed" as an actionable error
        with an explicit Build/Pull action.
      - *Test (e.g.):* create an image-based project → opening a terminal runs
        inside `eldrun-<id>`, host edits show in the file tree, git works,
        container stops on app exit.
      - [ ] 🤖 Automated test — `docker_runtime`/`docker_exec` argv + workdir
        translation + `run_args` denylist + exactly-one `ContainerSource` +
        schema round-trip (no daemon needed)
      - [ ] 🖐️ Manual test
    - [ ] **38b — Phase 2: remote Docker** (container on an SSH host; composes
      #28 with 38a, activated when `DockerSpec.remote` is set).
      - Bytes: as #28 — sshfs-mount the remote dir locally (file tree/git
        unchanged). Bind-mount source is the **remote** `remote_path` (the remote
        daemon mounts the remote bytes directly). The in-container workdir is then
        a **triple** translation (host cwd → sshfs mountpoint → remote_path →
        container path) — needs its own test, not just argv shape.
      - Runtime: spawns run `ssh -tt <host> docker exec …`. **Composition caveat:**
        `ssh_pty_args(remote, remote_command: &str)` takes a single **string**, so
        the whole `docker exec …` argv must be collapsed and `shell_quote`d a
        **second** time on top of `docker_exec`'s own pass — two stacked quoting
        layers the current single-pass tests don't cover. Do NOT also wrap in
        `remote_command`'s `-lc '<inner>'`; build `docker exec … <name> $SHELL -lc
        '<inner>'` once, then quote for ssh. `docker_runtime` engine calls gain an
        `ssh_base_args` prefix when `remote` is set; `down_all` tears down known
        remote-docker containers by **iterating the project list** (no local
        inventory of remote containers exists).
      - Frontend: "Run in container" becomes available after an SSH connection is
        established (remote-browse flow from #28).
      - *Test (e.g.):* remote host with docker → terminal execs into the remote
        container; host file tree (over sshfs) reflects in-container edits.
      - [ ] 🤖 Automated test — argv builders produce `ssh … docker …` /
        `ssh -tt … exec docker exec …` when remote (assert the **double-quoting**
        round-trips, incl. env values with `$`/quotes); triple workdir
        translation; `DockerSpec.remote` round-trip
      - [ ] 🖐️ Manual test

---

## Group H — Cross-Platform: Windows & macOS Support (new feature)
*Files: `src-tauri/src/platform/*`, `services/`,
`terminal/` (PTY), `commands/` (downloads, crash logging), `src-tauri/tauri.conf.json`
(bundle targets), `.github/workflows/ci-cd.yml` (package jobs). Both OSes already
have cross-platform foundations — platform-aware state paths, default-shell
fallback, browser profile paths, network detection — so this is follow-up work,
not a from-scratch port. Builds on / supersedes the OS half of #19 (Group C).*

30. **Windows support follow-ups.** Windows is past the compile stage (state
    paths, shell fallback, browser profiles, network detection, app-icon
    helpers, NSIS packaging, and a Windows CI package job all exist). Remaining:
    validate a real build/runtime on Win 10 1903+ and Win 11 (incl. ConPTY
    behavior in xterm.js); decide whether to replace the command-based PID
    liveness check with a native Windows API; add native window tracking
    (`EnumWindows` + `GetWindowThreadProcessId`) if project-owned standalone
    windows need reliable show/hide; decide on a Windows unhandled-exception
    crash hook (current crash logging is Unix-oriented); document/improve
    download routing where directory symlinks need Developer Mode or elevation;
    and QA browser download-preference editing across Firefox/Chrome/Chromium/
    Chrome Beta profile layouts.

31. **macOS support follow-ups.** macOS has initial cross-platform code (state
    paths, default shell, browser profiles, network detection, Unix symlinks,
    null workspace-backend fallback). Remaining: add bundle support when
    distribution is needed (`dmg`/`app` target, `minimumSystemVersion`, CI
    artifact handling); add Hardened Runtime entitlements **only** if
    signing/notarization is pursued — do **not** enable App Sandbox (PTY needs
    unrestricted POSIX PTY access); validate a real build on Apple Silicon (and
    Intel if needed); add native app-icon resolution for `.app` bundles if the UI
    needs resolved macOS icons; add native window tracking (Accessibility APIs or
    `CGWindowList`) only if project-owned standalone windows need reliable
    show/hide; and keep the null workspace backend as the default unless a clear
    need justifies Accessibility permissions or private APIs.

---

## Group I — Backend Runtime Follow-Ups
*Files: `src-tauri/src/services/` (`project_runtime.rs`, `terminal_service.rs`,
`window_service.rs`), `commands/`, `.eldrun/sessions/` mirrors, `schema/`. The
first backend runtime boundary pass is implemented: project switching is
coordinated through `switch_project_runtime`, core services live under
`services/`, tab/file/layout/window metadata is mirrored into
`.eldrun/sessions/`, download routing is part of switching, and the old
`switch_project_windows` command is deprecated. Related to #24 (session restore),
but backend-owned.*

32. **Backend runtime follow-ups.** Remaining backend-side work on the runtime
    boundary, each independently pickable:
    - Backend-owned PTY resurrection after app restart, including dead-session
      detection and a clear frontend policy (respawn, mark dead, or manual
      restart).
    - Terminal/agent transcript storage if restart recovery needs readable
      historical output rather than metadata-only restoration.
    - Promote `.eldrun/` runtime files from optional mirrors to the primary
      source once compatibility reads from `project.json` are validated.
    - Durable project-window metadata under `.eldrun/sessions/windows.json`
      beyond registry IDs (window role/origin, restore command, optional file
      target, future geometry/focus fields).
    - Move file-navigation runtime state backend-side once switching is stable:
      center file tabs, right-panel folder, breadcrumbs, history.
    - Focused tests for backend runtime switching with mocked services
      (time flushing, old-project save, project-window hide/show, download
      routing, root runtime handling, no respawn of already-live tabs).

---

## Group J — Web & Mail Surfaces: Routing, In-App Mail & Browser
*Three related surfaces for web/mail content sharing where-it-lives (right-panel
view vs. center tab vs. global-app surface), security, and auth decisions. #33
routes links **out** to the user's configured external apps; #65 and #61 are the
**in-app** counterparts (read mail / browse the web without leaving the
workspace). Files: `src/components/layout/GlobalAppBar.tsx` (roles +
launch-or-raise), `src-tauri/src/commands/apps.rs` (`launch_app`, `open_file`),
terminal/file-tree link handling (the global-apps suite is already implemented —
#33 is its last remaining item); plus, for the in-app surfaces, a new
`commands/mail.rs` + `schema/mail.rs` + `src/components/mail/` (mail) and a Tauri
webview surface + `src/components/browser/` (browser), and `types/index.ts`. No
mail or browser code exists today.*

33. **URI scheme routing** (migrated from TODO `G6.7`). Intercept `http://`,
    `https://`, `mailto:`, and `webcal:` links opened from within terminals or
    the file tree and route them through the global-app launch-or-raise flow
    (`launch_app`, keyed by the `browser` / `mail` / `calendar` roles) instead of
    a bare `xdg-open` call, so links open in the user's configured global app.

65. **Include a mail viewer in Eldrun.** Add an in-app email reader so mail can be
    read without leaving the workspace. Scope to be defined when picked; open
    questions to settle first: protocol (IMAP vs JMAP vs a provider API like
    Gmail), auth model (app password vs OAuth, mirroring the SSH "no in-app
    passwords" stance where possible), read-only vs send/reply, and where it lives
    (right-panel view like Git/Files, a dedicated center tab, or a global-app
    surface). Pairs naturally with #33 (`mailto:` routing) once present.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

61. **Include a browser in Eldrun.** Add an in-app web browser so pages can be
    viewed without leaving the workspace. Weigh the security implications
    (sandboxing, per-project download routing per #60, credential isolation)
    before building. Scope and surface (center tab vs. right-panel vs. global-app)
    to be defined when picked. Pairs with #33 (link routing) and #53 (drag a tab
    into a browser upload field).
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

## Group L — Center Panel: Tabs, Subwindows & Navigation
*Builds on Group D.11 (tiling split subwindows). All items share the center-panel
files: `src/stores/tabs.ts` (per-scope layout tree `layoutByScope`,
`focusedGroupByScope`, active tab), `src/components/layout/CenterPanel.tsx`,
`src/components/tabs/Subwindow.tsx` / `src/components/tabs/TabBar.tsx`,
`src/stores/projects.ts`. #42 additionally needs a Tauri multi-window surface
(`src-tauri/src/lib.rs`, `tauri.conf.json`) + the platform show/hide path
(`platform/x11.rs`, `platform/wayland_kde.rs`, `services/window_service.rs`,
`services/project_runtime.rs`); #55–#57 touch `schema/project.rs`; #62 touches
`src/App.tsx` (global key handlers). #55 (mapping bug) and #62 (keyboard nav) are
correctness/UX work atop the same layout model #42 detaches.*

42. **Drag a subwindow out of the Eldrun main window.** ✅ Implemented · 🧪 Awaiting
    live multi-window QA. Let a tiling subwindow
    (a tab group from Group D.11/#36) be dragged out of the main window and become
    its own standalone OS window, while keeping it bound to its project. The
    detached window must follow the **same hide/show logic as on project switch**:
    when the user switches projects in the main window, a detached subwindow
    belonging to the now-inactive project is parked/hidden on the hidden workspace
    (and re-shown on switching back) exactly like other project-owned windows,
    rather than floating free across all projects.
    Settled decisions (v1): detach gesture = explicit **pop-out button** (drag-past-
    edge deferred — WebKitGTK risk); detached window is a **second Tauri
    `WebviewWindow`** loading the same bundle under `?detached=<scope>:<groupId>`
    rendering one group (inert to project switches); the group leaves `layoutByScope`
    and is tracked in `detachedGroupsByScope` while its tab payloads stay in the
    shared store (PTYs never unmount); detached `TerminalView` is **attach-only**
    (no `pty_spawn`/no kill-on-unmount — output is broadcast by id; blank until next
    output, no scrollback restore); restart re-docks (session-only) but a detached
    group's tabs stay in `project.json` mid-session; parking reuses the existing
    `project_runtime::switch` path via an `ORIGIN_DETACHED_SUBWINDOW` tracked window
    + a hardened X11 `set_parkable` override (main window structurally never
    parkable) **and** a backend-independent Tauri `hide()/show()` fallback so
    Wayland/KDE/null also hide an inactive project's detached window; re-attach via
    dock-back button + dock-on-close (`onCloseRequested`) **and Ctrl+drag-to-dock**:
    Ctrl+dragging the popout's tab bar streams the gesture (screen coords, via the
    `DETACHED_DRAG_*` events) to the main window, which maps them to client space,
    shows the normal drop preview, and docks the group on release over a subwindow
    (`attachGroup` with the resolved edge/center target) — released outside the main
    window or on Escape, the popout stays floating. A plain (non-Ctrl) tab-bar drag
    still hands off to the WM for a native window move.
    Plan/reviews: `docs/group_l_42_detach_plan.md`,
    `docs/group_l_42_detach_plan_review.md`, `docs/group_l_42_detach_review_code.md`.
    *Files: `src/stores/detached.ts`, `src/stores/tabs.ts`,
    `src/components/layout/DetachedApp.tsx` / `DetachedCenterPanel.tsx` /
    `AppShell.tsx`, `src/components/tabs/TabBar.tsx`,
    `src/components/terminal/TerminalView.tsx`, `src/App.tsx`;
    `src-tauri/src/commands/subwindow.rs`, `platform/x11.rs` / `platform/mod.rs`,
    `services/window_service.rs` / `services/project_runtime.rs`, `lib.rs`,
    `tauri.conf.json`, `capabilities/default.json`.*
    - [x] 🤖 Automated test — `SubwindowDetach`, `DetachedSync`, `DetachedHost`,
      `TerminalAttachOnly` (frontend) + `window_service` detached-labels selector
      (backend). tsc clean; 30 #42 frontend tests pass; cargo 373 pass.
    - [ ] 🖐️ Manual test — needs backend rebuild + live run (pop-out spawns &
      seeds, PTY attaches without respawn, X11 park + Tauri hide on switch,
      Wayland hide fallback, dock-back & dock-on-close, main window never parked).

55. **[Bug] Fix tab→project mapping leak.** A tab can show up under the wrong
    project — e.g. the ProjectEldrun main window showing a `TODO.md` tab that
    belongs to a different project. This must never happen. Audit tab persistence
    / restore and the per-scope layout keying (`layoutByScope`, `tab_layout`/
    `tab_groups`, scope ids) so tabs are strictly bound to their owning project.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

56. **Right-click a tab → start renaming.** A right-click on a tab should
    immediately enter inline rename mode (rather than going through a menu).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

57. **Open `README.md` by default for a project with no tab.** When a project is
    opened/activated and has no tabs to restore, show its `README.md` in an
    in-app viewer tab by default (uses the Group D.14 viewer).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

62. **Fast keyboard navigation across projects / subwindows / tabs.** Make the
    whole app steerable from the keyboard with no mouse required. Needs design
    choices, but the target set: a fast fullscreen mode for a tab/subwindow,
    keyboard switching between projects, between subwindows (e.g. `Shift`+arrows
    to focus subwindows), between tabs in a subwindow (e.g. `Shift`+`Tab`), and
    between projects (e.g. `Shift`+`Ctrl`+`Tab`), plus closing tabs/subwindows —
    all keyboard-driven.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

## Group M — In-App Viewers: Text / TeX / Image Enhancements (Phase 2+)
*Builds on Group D.14 (in-app file→tab viewers). Files: `src/components/embed/FileViewerPane.tsx`,
`src/components/files/markdown.ts`/`tex.ts`/`highlight.ts`, `fileUtils.ts`
(`internalViewerFor`), `src/stores/tabs.ts` (`"embed"` tab kind, `viewer`),
`src/components/embed/EmbedPane.tsx`, backend `commands/tex.rs`
(`tex_capability`/`compile_tex`), `commands/apps.rs` (`embed_capability`,
default-app resolution), `src/types/index.ts`, `README.md`.*

43. **Auto-reload the native text viewer from disk (diff-aware).** When a file
    open in the in-app text viewer changes on disk, reload it with a diff check so
    external edits (agents, git checkout, other tools) surface in the viewer.
    Don't clobber unsaved in-tab edits — detect divergence and reconcile (reload
    when clean; warn/merge-prompt when the buffer is dirty). Likely a file-watch
    or poll on the open file's mtime/hash.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

44. **TeX viewer: preview off by default.** Default the TeX viewer to the source
    editor rather than auto-rendering a preview; make preview an explicit toggle.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

45. **Auto-complete in native text viewers (pre-defined model).** Add code/text
    auto-completion across all native text viewers, driven by a pre-defined
    (ideally local) model. Settle the model source (local Ollama vs. configured
    global), trigger/UX, and the privacy posture (no remote calls for local-only
    projects) when picked.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

46. **Undo/redo in native text/TeX viewers.** Add an undo/redo history to the
    in-app text and TeX editors (keyboard `Ctrl+Z`/`Ctrl+Shift+Z` plus buttons).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

47. **Save icon instead of "save/saved" text (+ optional autosave).** Replace the
    textual save/saved status in the text/TeX viewer with a save icon that
    reflects dirty/clean state; consider periodic autosave (with the #43
    diff-aware reload as the counterpart for external changes).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

48. **Per-file-type native-viewer settings + document supported types.** A single
    settings surface to configure native-viewer behavior keyed by file type, and
    document the supported types (and the native text viewer) in `README.md`.
    Ties into #44 (per-type preview defaults) and #45 (per-type completion).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

49. **Make file links in text/TeX viewers visibly clickable.** Render links that
    point at files with a clear affordance (underline / dotted underline) so they
    read as clickable, in both the text and TeX viewers. (Companion to #50, which
    governs *where* a clicked link opens.)
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

50. **Link-open routing: same subwindow, or drag-to-set-default.** When a file
    link (#49) is clicked, open the target in the **same** subwindow by default;
    if the user drags the link to another subwindow, make that the default target
    **only for that file, from that linking file, for this session** — discard the
    mapping when the linking file's tab is closed (and optionally close the
    linked file(s) with it).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

51. **Native `.odt` / `.xlsx` viewer.** Add an in-app viewer for OpenDocument /
    spreadsheet files. First decide whether it's worth it / already feasible via
    an existing Tauri-side renderer before building one.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

52. **Image viewer: zoom/scroll to the cursor.** Improve image-viewer scrolling so
    zoom centers on the mouse cursor rather than the viewport origin.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

53. **Drag images (and their tabs) out as drop sources.** Make images in the image
    viewer — and image tabs — draggable as drop sources, e.g. drag an image/text
    tab and drop it into a browser file-upload field.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

54. **TeX compile output → PDF in a new tab + compiler options.** Open the
    compiled PDF as its own tab (it is a real file), and add compiler options to
    the TeX viewer (output folder, engine/flags, …). Extends the existing
    `compile_tex` affordance from Group D.14.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

55. **Adjustable text size in the text/TeX/Markdown editors.** Add an `A−`/`A+`
    control (and `Ctrl` +/−, `Ctrl`+0 to reset) that scales the editor font. In
    the code editors (text/TeX) the gutter and syntax/link/ghost overlay layers
    scale together via the `--code-font-size`/`--code-line-height` CSS variables;
    in Markdown it sizes the source textarea and, once set, the rendered preview
    base font. The size persists per file type in `viewer_prefs[type].font_size`
    (alongside #45's autocomplete).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

66. **SyncTeX PDF↔source navigation + subtex→main compile wiring.** Make the
    compiled PDF and its `.tex` source navigable both ways, and let a child file
    build its parent. Compiles now always emit `-synctex=1` (`commands/tex.rs`).
    *Reverse search:* clicking a point in a PDF (`PdfCanvas`) runs `synctex_edit`
    and jumps the source tab to that line (via the `editorJump` store +
    `CodeEditor` `gotoLine`). *Forward search:* after a compile, `synctex_view`
    maps the source caret to a PDF box that `PdfCanvas` scrolls to and flashes
    (via the `pdfSync` store). *Subtex wiring:* a successful compile records each
    `\input`/`\include` child→root in `~/.local/share/eldrun/tex_roots.json`, and
    `resolve_tex_root` (magic `% !TEX root` comment → stored map → self) redirects
    a child's Compile to its main document. Adds a compile run animation
    (`.is-compiling` button sheen + header progress strip, reduced-motion aware).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

67. **Find in the text/TeX viewers.** Add an in-editor search bar to the shared
    `CodeEditor` (so it covers both the text and TeX viewers). `Ctrl`/`Cmd`+`F`
    opens a floating find bar pinned to the editor's top-right — bound on the
    editor container so it opens whenever focus is anywhere in the tab, not only
    on the textarea. The bar has a query input (seeded from the selection), a live
    `n/total` count, `↑`/`↓` (and `Enter`/`Shift`+`Enter`) to cycle, a `Aa` match-
    case toggle, and `Esc` to close. Matches are painted by a transparent overlay
    `<pre>` layer (`decorateSearchRanges`) scroll-synced like the highlight/link
    layers, the current match brighter; navigation moves the textarea selection
    and scrolls the match into view. Pure helpers `findMatches`/`decorateSearchRanges`.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

68. **Image viewer: auto-reload on disk change.** Give the image viewer the same
    diff-aware reload as the editors/PDF (#43): `useBlobUrl` polls `file_mtime`
    and re-reads the bytes when the file changes on disk, swapping the blob URL
    only once the fresh bytes are ready (no flash) and revoking the old one. An
    image regenerated by an external tool updates in place; the user's zoom/pan is
    preserved when the new image has the same dimensions, and only re-fit when the
    dimensions change.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

69. **Persist viewer scroll/zoom across reopen + restart.** The in-app PDF, text,
    and image viewers remember the reader's position so reopening a file — or
    restarting Eldrun — restores it instead of jumping to the top/default zoom.
    A per-tab `ViewerState` (`scrollTop`/`scrollLeft`/`scale`/`offsetX`/`offsetY`,
    `src/stores/tabs.ts`) travels with the `embed` tab through
    `save_tab_layout`/`loadFromLayout` (round-tripped via the Rust `TabEntry`'s
    flattened `extra`, no backend change). The viewer panes
    (`FileViewerPane.tsx`, shared `useViewerState` hook) restore once on first
    load and persist (throttled) as the reader scrolls/zooms/pans; the PDF honours
    a saved zoom over fit-width on first load, and `CodeEditor` gained
    `initialScrollTop`/`onScrollPersist`. `setViewerState` merges + dedups so an
    unchanged write never churns the saveLayout debounce.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

70. **TeX viewer: `Ctrl`+`S` saves and recompiles.** In the LaTeX viewer (engine
    available), `Ctrl`+`S` runs `compile()` instead of a plain save — `compile()`
    persists pending edits first, so the PDF preview tracks the source. The
    no-engine fallback keeps `Ctrl`+`S` as a plain save.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

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

60. **Reset browser download path to `~/Downloads`.** Stop redirecting browser
    downloads into the active project for now — keep the standard browser download
    path at the user's `~/Downloads`. Routing a download into a project is a
    security risk if the file is then pushed with the project's git.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

## Group R — Right Panel: Polish & App-Window Tracking
*Files: `src/components/layout/RightPanel.tsx`, `src/styles/themes.css`,
`src/stores/windows.ts`, backend `commands/apps.rs` + window tracking in
`services/window_service.rs`/`platform/x11.rs`. The pin toggle itself is done
(Group D.13 / #37); these are follow-on polish + a tracking-display bug.*

63. **Pin needle black in dark fancy mode.** The right-panel pin (📌) needle isn't
    legible in the dark "fancy" theme — make it black (or otherwise contrast-fix)
    in that mode.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

64. **[Bug] Right-panel Apps list must drop closed app windows.** A project-opened
    external app appears in the right-panel "Apps" list but doesn't disappear when
    the app/window is closed. Fix the add/remove lifecycle so the list reflects
    live windows. Doubles as a window-tracking test surface: on hover, show the
    entry's window id, monitor id, and z-order.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

Sequencing is **group-wise** — tackle whole groups in this order, since items
within a group share files and context:

- **Quick wins next:** J (#33 URI routing — last remaining global-apps item; the
  in-app mail #65 / browser #61 in the same group are the larger net-new
  surfaces, weigh security first and pair with #60).
- **Then correctness/stability:** C (X11/KDE workspace switching) — the
  highest-risk area; do #15/#16/#17 together.
- **Then larger features:**
  A (project boxes, builds on the done drag-drop) → E (git worktree) →
  F (session restore) → G (remote/SSH projects, largest net-new backend).
- **Center panel:** L (#42 detach, #55–#57 tab UX, #62 keyboard nav) — builds on
  the done D.11 tiling work; start with the #55 mapping bug (correctness), pairs
  with C since detached windows reuse the per-project parking path.
- **In-app viewers (incremental):** M (#43–#54) — small, mostly-independent
  enhancements on the done D.14 viewer; the link pair #49/#50 and the autosave
  pair #43/#47 are best done together.
- **Project policy:** O (#58–#60) — per-project security/permission model;
  touches the create/import dialog and the agent-spawn + git-push paths.
- **Right-panel polish:** R (#63 needle contrast, #64 app-window tracking bug).
- **Cross-platform (parallel track):** H (Windows #30 / macOS #31 follow-ups) —
  validate builds & packaging per OS; can proceed alongside the above.
- **Backend runtime (ongoing):** I (#32) — backend-owned runtime hardening
  (PTY resurrection, `.eldrun/` promotion, durable window metadata, tests);
  pairs with F (session restore).

## Verification approach (per item, when implemented)

- Frontend changes: `npx tsc --noEmit`, plus existing/added tests under
  `src/__tests__/` (e.g. the session-restore test for Group F).
- Backend changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Runtime validation: **do not** launch Eldrun from the agent — ask you to
  restart your running instance to verify workspace/window/UI behavior.

---

# ✅ Done (code-complete) — 🤖 Automated ✅ · 🖐️ Manual pending

Code-complete groups, renumbered D.1, D.2… and kept at the end of the file. Item
numbers stay global and stable. **All groups below are ✅ Done with passing 🤖
automated tests** (except #25, visual-only); **🖐️ manual/runtime QA is still
pending** across the board — see the Status legend at the top. Each group's
`🧪 Tested:` line and each feature's two checkboxes track the two axes; a feature
is fully 🧪 Tested only once its 🖐️ Manual box is also ticked after live QA.

## Group D.1 — Right Panel: File Tree & Navigation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx`, `fileUtils.ts`, `RightPanel.tsx`, `src/styles/themes.css`. Backend create/delete commands already exist in `commands/projects.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

1. ✅ **Create file / folder from right-click.** Added "New File" + "New Folder"
   entries to the entry context menu, plus an empty-area context menu so files
   can be created in an empty folder. Both reuse the `window.prompt` pattern and
   call the existing `create_file` / `create_dir` commands, then reload.
   - *Test (e.g.):* right-click a folder → "New File", type a name → the
     file appears in the tree **and** on disk; repeat via the empty-area menu
     inside an empty folder to confirm creation there too.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

2. ✅ **Show long file/folder names in full.** Added a native `title={e.name}` to
   the `.file-name` span so the full name shows on hover (CSS ellipsis kept).
   - *Test (e.g.):* create a file with a very long name → the row shows a
     truncated name with ellipsis, and hovering it surfaces the full name in a
     native tooltip.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

3. ✅ **Show parent folders when inside a subfolder.** Replaced the single
   "↑ .." button with a breadcrumb trail (up arrow, project-root `⌂` crumb, and
   each path segment separated by `/`), each segment clickable to jump directly.
   - *Test (e.g.):* navigate two levels deep → breadcrumb shows
     `⌂ / sub / subsub`; click the middle `sub` crumb → tree jumps to that folder
     and the breadcrumb trims accordingly.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

---

## Group D.2 — Right Panel: Git Status Markers ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/git.rs` (`git_file_statuses`), `FileTree.tsx` (`STATUS_COLOR`, `GitMarker`), `fileUtils.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

4. ✅ **Fix incorrect git colors.** Rewrote the porcelain parsing so the
   working-tree column (Y) decides "modified" before the index column (X) decides
   "staged" — partly-staged files like `MM` now read as modified (red) rather
   than masquerading as fully-staged. Bubbling priority is now
   modified > untracked > staged > unpushed > ignored.
   - *Test (e.g.):* stage a file then edit it again (porcelain `MM`) →
     its tree marker is red (modified), not orange (staged), and the containing
     folder bubbles up to red.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test

5. ✅ **Richer marker scheme.** `git_file_statuses` now also marks
   committed-but-unpushed files via `git log @{u}..`. Markers: gitignored → gray
   ✕ glyph; unstaged/untracked → red bar; staged → orange bar; unpushed → green
   ↑ glyph; clean/pushed → no marker. (Ignored uses a gray ✕ rather than red to
   avoid flooding the tree with alarm-colored marks on `target/`, `node_modules/`
   etc.; trivially switchable in `STATUS_COLOR`.)
   - *Test (e.g.):* set up one file in each state (ignored, untracked,
     staged, committed-but-unpushed, clean) → each shows the right glyph/color:
     gray ✕, red bar, orange bar, green ↑, no marker respectively.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test

6. ✅ **Show `.gitignore` in the tree.** `visibleEntries` now keeps `.gitignore`
   visible by default while still honoring the `panel_hidden_*` filters.
   - *Test (e.g.):* in a project with a `.gitignore`, confirm it stays
     visible in the tree even with default hidden-file filtering on, while other
     `panel_hidden_*` matches remain hidden.
   - [x] 🤖 Automated test — `GitignoreVisible.test.ts`
   - [ ] 🖐️ Manual test

---

## Group D.3 — Right Panel: Git History & Commit UI ✅ Done · 🧪 Untested
*Files: `src/components/files/GitHistory.tsx` (new), `RightPanel.tsx` (new "Git"
view), backend commands `git_log` / `git_branches` / `git_checkout` /
`git_commit_message` / `git_reword_head` in `commands/git.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

7. ✅ **Git history view.** New "Git" tab in the right-panel header shows the
   current branch, clickable local/remote branch pills (checkout), and a commit
   list (short hash, subject, ref badges, relative date; HEAD marked). Backend
   `git_log`, `git_branches`, `git_checkout` added.
   - *Test (e.g.):* open the Git tab → current branch is shown, the commit
     list matches `git log`, HEAD is marked, and clicking another branch pill
     checks it out (tree/branch label update).
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test

8. ✅ **Click a commit → commit-message window.** Clicking a commit opens a modal
   showing its full message. For HEAD it is editable with a "Generate (agent)"
   action (reuses `git_generate_commit_message`) and "Save (amend)"
   (`git_reword_head`); older commits are read-only. A "Checkout" action checks
   out the commit (detached). Full message fetched via `git_commit_message`.
   - *Test (e.g.):* click HEAD → modal is editable, edit + "Save (amend)"
     rewrites the commit message; click an older commit → read-only; "Checkout"
     puts the repo in detached HEAD at that commit.
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test

---

## Group D.4 — Bottom Panel: Project Pill polish ✅ Done · 🧪 Untested
*Files: `src/components/projects/ProjectPill.tsx`, `src/stores/activity.ts` (new),
`src/components/layout/AppShell.tsx`, `ProjectSwitcher.tsx`, `src/stores/projects.ts`,
backend `commands/terminal.rs` (`project_cpu_percent`), `commands/projects.rs`
(`set_project_description`), `src-tauri/src/sysstat.rs` (new). Test:
`src/__tests__/PillRunningIndicator.test.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green; #11 CPU% core helpers only) · 🖐️ manual ❌ (runtime QA pending)

9. ✅ **Running-task indicator on pills.** New `activity` store derives a
   per-scope "busy" flag from live PTY output: a single global `terminal-output`
   listener in `AppShell` stamps each PTY's last-output time (covers backgrounded
   projects too), and a 300 ms tick recomputes `busyByScope`. Busy pills show the
   three-dot `OrbitSpinner` tinted green (`.pill-running-spinner`).
   - *Test (e.g.):* start a long-running command in a **backgrounded**
     project's terminal → that pill shows the green spinner within ~300 ms; when
     output stops, the spinner clears shortly after.
   - [x] 🤖 Automated test — `PillRunningIndicator.test.ts`
   - [ ] 🖐️ Manual test

10. ✅ **Right-click → change description.** Pill context menu gains "Edit
    description" opening a small textarea dialog. Saving calls the new
    `set_project_description` command, which writes both `projects.json` (the
    pill list) and the project's `project.json`, then mirrors the cleaned value
    into the store.
    - *Test (e.g.):* right-click a pill → "Edit description", save new
      text → both `projects.json` and that project's `project.json` are updated
      on disk and the hover popup shows the new description.
    - [x] 🤖 Automated test — `projects_commands.rs::set_project_description_writes_both_projects_json_and_project_json`
    - [ ] 🖐️ Manual test

11. ✅ **Hover → per-project CPU %.** Hover popup now shows live CPU%, polled
    every 1.5 s while open. New `project_cpu_percent` command (backed by the
    `sysstat` `/proc` module) resolves the project's PTY ids → child PIDs +
    descendants and samples jiffies over a 300 ms window. CPU-only by design;
    per-process GPU isn't reliably attributable on Linux, so the existing Ollama
    VRAM tracking stays as the GPU signal. No-op (returns 0) off Linux.
    - *Test (e.g.):* hover a pill whose project runs a CPU-busy process →
      popup shows a non-zero CPU% refreshing ~every 1.5 s; an idle project reads
      ~0%; on non-Linux it returns 0 without erroring.
    - [x] 🤖 Automated test — *partial:* `sysstat.rs` unit tests (clk_tck, descendant_pids self-inclusion/empty, sum_jiffies live+dead pid); live % readout is manual
    - [ ] 🖐️ Manual test

12. ✅ **Suppress default webview reload/inspect on right-click.** The
    `.project-switcher` container now `preventDefault`s `contextmenu`, so a right-click
    anywhere on the bar surfaces only our pill menu, never Reload/Inspect.
    - *Test (e.g.):* right-click empty space on the project switcher and on a
      pill → only the custom menu appears; the default webview Reload/Inspect
      context menu never shows.
    - [x] 🤖 Automated test — `ProjectSwitcherContextMenu.test.tsx`
    - [ ] 🖐️ Manual test

---

## Group D.5 — Branding ✅ Done · 🧪 Untested
*Files: `src/assets/logo.svg` (new), `src/components/layout/HeaderBar.tsx`, `src-tauri/icons/*`.*
🧪 Tested: 🤖 automated — N/A (purely visual) · 🖐️ manual ❌ (icons/header not visually verified in a live build)

25. ✅ **Redraw the Eldrun logo in SVG.** Recreated the logo as a clean,
    symmetric vector (`logo.svg`): green circuit "tree of life" ring, split
    trunk, mirrored branch traces with node terminals, and the gold spark — left
    half authored and mirrored across the centre line. Header now imports the SVG
    (`logo.png` removed). OS app icons (`32x32`, `128x128`, `128x128@2x`,
    `icon.ico`, `icon.icns`) regenerated from the vector via `tauri icon`, which
    also fixed the previously mis-sized (all 650×650) raster icons.
    - *Test (e.g.):* launch a packaged build → the header renders the new
      SVG logo crisply, and the OS app/taskbar icon shows at correct sizes (not a
      stretched 650×650 blob).
    - [ ] 🤖 Automated test — *N/A: purely visual; manual only*
    - [ ] 🖐️ Manual test

---

## Group D.6 — Drag & Drop Reordering ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (already has a `reorder(from, to)` action),
`src/components/layout/CenterPanel.tsx` (tab bar — no drag handlers yet);
`src/stores/projects.ts` (projects carry a `position` field and are sorted by
it, but there is no reorder/persist action), `ProjectSwitcher.tsx`/`ProjectPill.tsx`,
backend `save_projects`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

26. ✅ **Drag-and-drop tab reordering.** Tabs in `TabBar.tsx` are now `draggable`
    with HTML5 drag handlers that call `useTabsStore.reorder(from, to)` on drop.
    Persistence is automatic — `CenterPanel`'s debounced `saveLayout` effect runs
    whenever `tabs` changes. Drag feedback via `.tab.dragging` / `.tab.drag-over`.
    - *Test (e.g.):* drag a tab to a new slot → order updates with drag
      feedback; reopen the app → the new tab order persisted (saveLayout fired).
    - [x] 🤖 Automated test — `TabReorder.test.ts`
    - [ ] 🖐️ Manual test

27. ✅ **Drag-and-drop project ordering.** Pills in `ProjectPill.tsx` are now
    `draggable` (source id carried in `dataTransfer`); dropping on another pill
    calls the new `reorderProjects(fromId, toId)` action in `projects.ts`, which
    splices the active-pill order, renumbers every project's `position` with
    gap-spaced values (active pills first, inactive after), and persists via
    `save_projects`. Drag feedback via `.project-pill.drag-over`.
    - *Test (e.g.):* drag one pill onto another → pills reorder, `position`
      values are renumbered (active first, inactive after) and written via
      `save_projects`; restart → order survives.
    - [x] 🤖 Automated test — `ProjectReorder.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.7 — Right Panel: Hidden Files Section ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (the `separateScaffold` split at
~426-480 and the "scaffold" `file-tree-section-divider`), `fileUtils.ts`
(`visibleEntries`, `STANDARD_PROJECT_FILES`), `src/styles/themes.css`.*
🧪 Tested: 🤖 automated ✅ (`HiddenFilesSection.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

29. ✅ **Collapsible hidden-files section under scaffold.** Keep the existing
    show/hide filtering (`showHidden` toggle + `hiddenEndings`/`hiddenPaths` in
    `visibleEntries`) exactly as-is. **Additionally**, when a scaffold section is
    shown, render a third grouped section **below** the scaffold divider that
    gathers the hidden folders/files, collapsed (minimized) by default with a
    click-to-expand header. This is an addition to the existing
    `separateScaffold` rendering (a parallel `hidden` bucket + a collapsed
    `<details>`-style divider), not a replacement of the binary show/hide
    toggle — so hidden items stay discoverable without flooding the tree, and
    the toggle still works for users who want them inline or fully hidden.
    - *Test (e.g.):* in a project with hidden files, the scaffold view
      shows a collapsed "hidden" section below the divider; clicking its header
      expands it; the existing show/hide toggle still works independently.
    - [x] 🤖 Automated test — `HiddenFilesSection.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.8 — Right Panel: Persist Script-Run Animation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (`runningScripts` state + the
`script-finished` listener at ~136, `runShellScript`, `.file-run-spinner`),
`src/components/layout/RightPanel.tsx` (renders `<FileTree>` only `{open && …}`).
Related to the run-detached backend `run_script_detached` in `commands/apps.rs`.*
🧪 Tested: 🤖 automated ✅ (`ScriptRunState.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

34. ✅ **Keep the `.sh` run animation alive when the right panel hides.** Today
    `FileTree` is mounted only while the panel is open (RightPanel
    `{open && (<FileTree…>)}`), so hiding the panel unmounts the tree and drops
    both the local `runningScripts` set and the `script-finished` subscription —
    when reopened, a still-running script shows no spinner and a completed run is
    never reflected. Lift the running-scripts state and the `script-finished`
    listener out of `FileTree` into a persistent owner (a small store like
    `activity.ts`, or an `AppShell`-level listener) so the run animation/state
    survives panel hide/show and the button re-renders correctly on reopen.
    - *Test (e.g.):* run a long `.sh`, hide the right panel, reopen →
      spinner is still active; let it finish while hidden → on reopen the button
      shows the finished (non-spinning) state.
    - [x] 🤖 Automated test — `ScriptRunState.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.9 — Center Panel: Free Tab Arrangement / Grid View ✅ Done · ⛔ Superseded by D.11
*The per-scope auto-grid (`grid`/`gridByScope`/`toggleGrid`/`setGrid` + ▦ button)
was **removed** and replaced by the tiling split-subwindow model in Group D.11.
`TerminalView`'s `visible`/`focused` prop split survives and is reused there.
`GridView.test.ts` now only asserts the old grid API is gone.*
🧪 Tested: 🤖 automated ✅ (`GridView.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

35. ✅ ⛔ **Free arrangement of tabs / grid view — superseded.** The original
    per-scope auto-grid (columns = `ceil(sqrt(n))`) is gone; tab arrangement is
    now the directional tiling split model (Group D.11 / #36). The reusable
    `TerminalView` `visible`/`focused` prop split and the all-scopes-mounted pane
    approach carried over. `GridView.test.ts` was rewritten to assert the grid
    store API no longer exists.
    - [x] 🤖 Automated test — `GridView.test.ts` (asserts removal)
    - [ ] 🖐️ Manual test

---

## Group D.11 — Center Panel: Tiling Split Subwindows ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (layout-tree model: `SplitNode`/`GroupNode`,
`splitWithTab`/`moveTab`/`reorderInGroup`/`resizeSplit`/`removeTab` collapse,
`serializeTree`/`deserializeTree`, per-scope `layoutByScope`/`focusedGroupByScope`),
`src/components/layout/CenterPanel.tsx` (recursive split render + measured-rect
pane positioning + panel-wide drop tracking), `src/components/tabs/Subwindow.tsx`
(per-group frame + L/R/T/B/center drop zones), `src/components/tabs/TabBar.tsx`
(per-group bar, cross-group drag payload `{key, fromGroup}`),
`src/components/layout/HeaderBar.tsx` (global tab bar removed), `src/stores/projects.ts`
(threads `tabGroups` through project switch via shared `serializeTree`),
`src/styles/themes.css` (`.subwindow`, `.split`/`.split-divider`, `.drop-zone`).
Backend: `schema/project.rs` `tab_groups`, `commands/projects.rs::save_tab_layout`,
`services/terminal_service.rs`, `schema/session.rs`, `services/project_runtime.rs`.
Tests: `src/__tests__/SplitLayout.test.ts`.*
🧪 Tested: 🤖 automated ✅ (`SplitLayout.test.ts` green, 85 vitest + cargo) · 🖐️ manual ❌ (runtime QA pending)

36. ✅ **Tiling split subwindows (directional drag-drop splits).** Reworked the
    center panel from one header tab bar + auto-grid into a tiling layout of
    subwindows. Each subwindow (group) owns its tabs and renders its own tab bar;
    dragging a tab onto another subwindow's edge (L/R/T/B) splits that direction
    into a new subwindow, onto its center moves the tab in. Splits resize via
    draggable dividers (`resizeSplit`, clamped, divider-pair math). The layout is
    a per-scope tree (`layoutByScope`); flat tab payloads stay per-scope so PTYs
    never unmount. `removeTab`/`moveTab`/`splitWithTab` collapse emptied groups
    and lone splits and keep focus + `activeKey` on a surviving group. Persisted
    as `tab_groups` in `project.json` alongside the flat `tab_layout`, round-trips
    through project switch (`switch_project_runtime`); absent → single group
    (legacy projects). **Backend rebuild/restart required** for `tab_groups`
    persistence (per CLAUDE.md; agents can't launch Eldrun).
    - *Test (e.g.):* drag a tab onto a subwindow's right edge → a 2-way row split
      with the dragged tab in a new group sized 50/50; close its only tab → split
      collapses back to one group with focus on the survivor; reload restores the
      tree from `tab_groups`.
    - [x] 🤖 Automated test — `SplitLayout.test.ts` (splits/collapse/move/resize/load)
    - [ ] 🖐️ Manual test

---

## Group D.10 — Project Model, Import & Publishing ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/projects.rs` (`normalize_git_type`,
`ImportProjectRequest.skip_scaffold`, create/import defaults + read-time
migration), `src-tauri/src/commands/github.rs` (new `github_publish`),
`lib.rs`/`commands/mod.rs` (registration), `ProjectSwitcher.tsx` (push-target select +
skip-scaffold checkbox), `ProjectPill.tsx` (Publish window + menu),
`src/stores/projects.ts` (`publishProject`), `src/types/index.ts`,
`themes.css` (`.skip-scaffold-row`). Tests: `projects_commands.rs`
(`import_project_skip_scaffold_…`), unit tests for `normalize_git_type` and
`shell_quote`.*
🧪 Tested: 🤖 automated ✅ (suite green; #22 publish = shell_quote only) · 🖐️ manual ❌ (`github_publish` runtime QA pending)

20. ✅ **No-scaffold option for import.** `ImportProjectRequest` gained a
    `skip_scaffold` flag (default false); `finish_import` now gates the
    `scaffold_project` call (and its `git init`) on it, still writing
    `project.json` so the project registers. The import dialog shows a "Skip
    scaffolding (project already has its own files)" checkbox that also hides the
    scaffold-fill guidance and suppresses the scaffold-fill agent tabs.
    - *Test (e.g.):* import an existing repo with "Skip scaffolding"
      checked → no `AGENTS.md`/`CLAUDE.md`/etc. added and no `git init`, but
      `project.json` is written so it registers (cf. `import_project_skip_scaffold_…`).
    - [x] 🤖 Automated test — `projects_commands.rs::import_project_skip_scaffold_does_not_add_missing_scaffold_files`
    - [ ] 🖐️ Manual test

21. ✅ **Rename public/private → local/remote (push-target axis).** `git_type`
    now models the git **push** target — distinct from the SSH **work**-remote —
    with three values: `local`, `remote-private`, `remote-public`. New projects
    default to `local`. A `normalize_git_type` helper migrates legacy values
    (private → remote-private, public → remote-public) on read in `get_projects`
    / `load_project` and canonicalizes writes. The dialog's "Git push target"
    select offers the three options.
    - *Test (e.g.):* a legacy project with `git_type: "private"` loads as
      `remote-private` via `get_projects`; a brand-new project defaults to
      `local` (cf. the `normalize_git_type` unit test).
    - [x] 🤖 Automated test — `commands/projects.rs` normalize_git_type unit tests
    - [ ] 🖐️ Manual test

22. ✅ **"Make repo public" publish flow.** New `github_publish(project_id,
    visibility)` command shells out to `gh repo create <name> --public|--private
    --source=. --remote=origin --push`. For SSH work-remote projects it runs over
    `ssh` on the host where the bytes live (reusing `ssh_base_args`/`validate_arg`
    + single-quoted remote argv). On success it records `git_type =
    remote-<visibility>` in both `projects.json` and `project.json`. Surfaced via
    a "Publish to GitHub…" entry in the project-pill context menu opening a
    visibility-picker window; the store's `publishProject` mirrors the new push
    target into state. Requires `gh` installed + authenticated. **Runtime QA
    pending** (agents can't launch Eldrun).
    - *Test (e.g.):* on a local project, "Publish to GitHub…" → pick
      public → `gh repo create` runs and `git_type` flips to `remote-public` in
      both json files; for an SSH project the command runs over `ssh` on the host.
    - [x] 🤖 Automated test — *partial:* `commands/github.rs` shell_quote unit tests (argv escaping only; full gh/ssh publish flow is manual)
    - [ ] 🖐️ Manual test

---

## Group D.12 — Layout fix: project switcher in the top header ✅ Done · 🧪 Untested
*Files: `src/components/layout/HeaderBar.tsx` (`header-center`),
`src/components/layout/ProjectSwitcher.tsx` (renamed from the old `BottomBar`),
`src/components/layout/AppShell.tsx`, `RightPanel.tsx`, `themes.css`.*
🧪 Tested: 🤖 automated ✅ (`ProjectSwitcherContextMenu.test.tsx` green) · 🖐️ manual ❌ (runtime QA pending)

14. ✅ **Stop bottom/right panel intersection.** Resolved by moving the project
    switcher out of the bottom overlay into the top header (`HeaderBar`
    `header-center`); the old `BottomBar` component became `ProjectSwitcher.tsx`.
    With no bottom bar there is nothing left to overlap the right panel, and the
    pill menus now open downward.
    - *Test (e.g.):* the project pills render in the top header; revealing the
      right panel no longer collides with a bottom bar.
    - [x] 🤖 Automated test — `ProjectSwitcherContextMenu.test.tsx`
    - [ ] 🖐️ Manual test

---

## Group D.13 — Right Panel: Pin / Dock Option ✅ Done · 🧪 Untested
*Files: `src/components/layout/AppShell.tsx` (hover-reveal/auto-close timers
`handleBodyMouseMove`/`scheduleClose`, `rightPinned` state), `RightPanel.tsx`
(`right-panel-header` pin button), `src/stores/settings.ts`
(`right_panel_pinned`), `src/styles/themes.css` (`.right-panel`/`.app-body`).*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

37. ✅ **Pin the right panel open.** A 📌 toggle in the `right-panel-header`
    keeps the panel persistently open instead of auto-hiding on mouse-leave; when
    pinned the hover-reveal/auto-close timers are suppressed and the panel takes
    layout space (no overlap of the center terminal). The pinned flag persists in
    `settings.json` (`right_panel_pinned`) and is restored on launch.
    - *Test (e.g.):* click the pin → panel stays open after the cursor leaves;
      center reflows (no overlap); toggle off → reverts to hover-reveal; restart →
      pinned state restored.
    - [x] 🤖 Automated test — covered by the right-panel suite
    - [ ] 🖐️ Manual test

---

## Group D.14 — File → Tab: In-App Viewers & Embedded Tabs (Phase 1) ✅ Done · 🧪 Untested
*Files: drag source `src/components/files/FileTree.tsx`, drop targets
`src/components/tabs/TabBar.tsx`/`Subwindow.tsx` + `commitFileDrop.ts`,
`src/stores/tabs.ts` (`"embed"` tab kind, `viewer`/`embedExec`), in-app viewers
`src/components/embed/FileViewerPane.tsx` + `EmbedPane.tsx`,
`src/components/files/markdown.ts`, `fileUtils.ts` (`internalViewerFor`),
backend `commands/apps.rs` (`embed_capability`, default-app resolution),
`commands/tex.rs` (`tex_capability`/`compile_tex`). Tests:
`FileDropAddsEmbedTab`/`FileDropEmptyFirstTab`/`FileDropSplitsSubwindow`,
`EmbedCapabilityGate`, `InternalViewer`, `Markdown`, `embed_capability_tests.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

40. ✅ **Drag a file from the right panel into a (sub)window's tab bar to open it
    in a tab (Phase 1).** Dragging a file row onto a subwindow's tab bar opens a
    new `"embed"` tab **named after the file**. Two backends: files with a
    built-in viewer (`internalViewerFor` → PDF, image, markdown, or text) render
    **in-app** via `FileViewerPane` — a zoom/pan image view, a PDF iframe, a
    markdown Edit/Preview toggle, and an editable code editor (line-number gutter,
    Tab/Shift+Tab indent, Ctrl+S save). Other files open in their external default
    app via `EmbedPane`, gated on an `embed_capability` check. Only in-app
    `viewer` embeds persist/restore across restart. TeX files additionally get a
    compile affordance when a LaTeX engine is on `PATH` (`tex_capability` /
    `compile_tex`). **Phase 2 (live X11-reparented frameless embedding) deferred**
    — see `docs/group_k_plan.md`.
    - *Test (e.g.):* drag `notes.md` onto a subwindow's tab bar → a `notes.md`
      tab opens rendering the markdown in-app; drag a `.png` → zoomable image
      tab; on an unsupported OS/app a non-viewer file opens externally as before.
    - [x] 🤖 Automated test — `FileDrop*`/`InternalViewer`/`Markdown`/`EmbedCapabilityGate`
    - [ ] 🖐️ Manual test

*This is an organizational plan. Pick an item by its number and I'll produce a
focused implementation plan + changes for just that item.*
