# ProjectEldrun — Roadmap

Reviewed **2026-09-15** against **v0.1.68**. This file records direction and
sequencing; [STATUS.md](STATUS.md) describes the implementation and verification
limits. Concrete tasks live in [TODO.md](TODO.md) and [`todo/`](todo/).

## Implemented Foundation

The Rust/Tauri migration is complete. Project/box desktop contexts, tiling and
pop-out tabs, agent resume, remote SSH/SFTP with Git lockstep and byte-sync,
Docker/VM runtimes, mail/calendar/CalDAV, native viewers, and Eldrun Mobile are
implemented. Windows and macOS have native integration and CI packaging.

Recent work adds the per-project prompt chart, draft board, scheduling and
completion-gated chains, CLI-hook activity, model-aware prompt history, Mobile
Focus transcripts, file sharing to the phone, and print job previews. These are
part of the current baseline; their remaining work is verification and hardening.
The agent's permission mode stays under its own CLI's control.

## Next: Verify and Stabilize the Existing Workflows

1. **Project and session continuity.** Exercise switching projects and boxes,
   detached-window parking/redocking, resize/paste/exit, per-tab Claude/Codex
   resume, continue-latest limits for other CLIs, and remote tmux reconnects.
   Confirm files, app defaults, and time tracking follow the chosen scope.
2. **Prompt delivery.** Live-test draft creation and multi-select moves, schedule
   edits, prefix commands/model choices, closed tabs, missed occurrences, and
   after-links. Check that decisions and new turns postpone follow-ups and that
   hook-free agents' idle heuristic behaves predictably. Schedules currently
   depend on the desktop window being open.
3. **Connected features.** Validate CalDAV pull/push conflicts against a server,
   mail encryption and VPN-gated accounts, Mobile pairing/lock/revocation,
   reconnects after desktop updates, Focus fallback, outbox, and gated writes.
   Verify the opt-in browser live window's permission and IPC boundaries.
4. **Hardware-dependent features.** Run the Deck presenter with a second display,
   printer submission/queue tracking, a real VM boot, and HPC/SLURM workflows on
   a cluster. Test Windows/macOS integrations and KDE Wayland on real desktops.

Track results per item in the existing groups, and remove an `UntestedTag` only
after user confirmation. See [verification](todo/group-y-verification.md),
[sessions](todo/group-f-session.md), [remote/HPC](todo/group-g-remote.md),
[mail](todo/group-j-mail.md), [CalDAV](todo/group-x-caldav.md),
[presenter](todo/group-v-presenter.md), and
[Mobile acceptance work](docs/eldrun_mobile_agent_plan.md).

## Reliability and Maintenance

- **Runtime and security:** continue PTY/process cleanup, fence/credential
  boundary checks, durable session metadata, and explicit handling of stale
  packaged backends/PWA bundles. Keep Git lockstep and byte-sync ownership
  separate; retain file-backed local-loss notices for destructive background
  moves. See [runtime](todo/group-i-runtime.md) and
  [security](todo/group-o-security.md).
- **Measured responsiveness:** measure UI and remote-probe costs before widening
  polling or adding visual work. Preserve visible-only viewer/terminal work,
  panel snapshots, Fast mode, and Energy Saver; examine remaining background
  sync/lockstep costs. See [performance](todo/group-u-performance.md).
- **Maintainability:** split the largest viewer, tab-store, and project-command
  modules in focused changes behind the existing CI gates. Keep desktop and
  Mobile type-checks, tests, lint/clippy, and the privacy scan mandatory.
  Broad Rust formatting remains deliberately deferred.

## Product Follow-ups

- **Prompt Universe — planned, not built.** Add a global cross-project agent/job
  overlay using the existing project-cloud UI and prompt/activity stores. The
  current prompt chart remains scoped to one project or box. See the
  [Prompt Universe plan](docs/prompt_universe_plan.md).
- **Git hosting:** GitHub and GitLab publishing already ship. A generic remote
  URL flow and reducing the dependence on provider CLIs remain follow-ups.
  See [hosting](todo/group-p-hosting.md).
- **Local agents and models:** finish driver discoverability and restore
  behavior, and separate the local-runtime interface from Ollama assumptions.
  The smart/native shell is still research, not an implemented replacement for
  the PTY. See [local agents](todo/group-s-agents.md) and
  [smart shell](todo/group-t-shell.md).
- **Viewers and presenter:** continue the open editing, performance, and
  presentation work after acceptance checks. Remaining Office formats still
  open externally. See [viewers](todo/group-m-viewers.md) and
  [presenter](todo/group-v-presenter.md).

## Longer-Term Direction

- **Eldrun Server — plan only.** Shared calendar/board and project collaboration
  would use provisioned SSH, CalDAV, and bare Git repositories. Recheck the
  plan's older prerequisites against current storage/CalDAV code before starting;
  writable project sharing remains gated on the documented Git trust boundary.
  See [server tasks](todo/group-z-server.md) and the
  [server plan](docs/eldrun_server_plan.md).
- **Broader desktop integration.** Linux X11 remains the reference. Validate the
  implemented KDE Wayland, Windows, and macOS backends before claiming parity
  from real use. Other Wayland compositors still need their own backends; macOS
  app-level parking has platform limits. See [platform work](todo/group-h-crossplatform.md)
  and [workspace work](todo/group-c-workspace.md).
- **Complete project context.** Extend the existing terminal/file/app/machine
  context with richer notes, task metadata, and workflow state. Pluggable
  compositor backends and an eventual Eldrun-native compositor remain long-term
  direction, not current delivery commitments. See [VISION.md](docs/VISION.md).
