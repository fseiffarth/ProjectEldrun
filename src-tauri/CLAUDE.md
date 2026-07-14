# ProjectEldrun — Backend File Map (`src-tauri/src/`)

See the root `CLAUDE.md` for project-wide context (running, persistence, dev
workflow); see `src/CLAUDE.md` for the frontend file map.

**Top level**

| File | Purpose |
|------|---------|
| `main.rs` | Tauri app entry point, plugin registration. |
| `lib.rs` | Command registration (`generate_handler!`), app setup, hook/restore install. |
| `storage.rs` | JSON persistence helpers (read/write state files). |
| `paths.rs` | Canonical Eldrun directory paths. |
| `sysstat.rs` | Per-process CPU sampling via `/proc` (`descendant_pids`). |

**Commands (`commands/`)** — Tauri command handlers exposed to the frontend.

| File | Purpose |
|------|---------|
| `projects.rs` | Project CRUD, scaffold/import, time-today (god module; #1). |
| `fs.rs` | File-I/O commands (read/write/mtime, extracted from `projects.rs`; #1 seam). |
| `fs_watch.rs` | Filesystem watch start/stop + change events. |
| `git.rs` | Git status/history/commit/push. |
| `git_publish.rs` | Publish a project's repo to GitHub (`gh`) or GitLab (`glab`). |
| `terminal.rs` | Terminal/PTY command surface (delegates to `terminal/mod.rs`). |
| `apps.rs` | App launching, `run_script_detached`, `open_file`, external window tracking. |
| `default_apps.rs` | Per-file-type default-app mapping. |
| `downloads.rs` | Per-project download routing. |
| `ssh.rs` | SSH commands for remote projects (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`, `ssh_tooling_status`). |
| `remote.rs` | Pooled SSH/SFTP connection lifecycle (`remote_connect`/`remote_disconnect`) for the active remote project. |
| `openvpn.rs` | OpenVPN tunnel connect/store-config commands. |
| `ollama.rs` | Ollama model list/pull/delete + local autocomplete. |
| `tex.rs` | TeX compile + SyncTeX (shell-escape defense). |
| `boxes.rs` | Project-box CRUD. |
| `calendar.rs` | Calendar/event/task CRUD over `calendar.json` + guarded ICS file read/write. |
| `subwindow.rs` | Detached/popped-out subwindow lifecycle (#42). |
| `timer.rs` | Time-tracking commands. |
| `usage_stats.rs` | Usage recap: batched counter writes (`usage_bump`), rollup reads, watcher attach, and git commits/lines derived on demand from `git log`. |
| `workspace.rs` | KDE/X11 workspace switch commands. |
| `settings.rs` | Settings read/update. |
| `project_runtime.rs` | Project-switch runtime command wrapper (off-UI-thread). |
| `python.rs` | Which Python the viewer's Run/Debug run (#87), and the **single** source of that precedence — the frontend asks, it never re-derives. A project's pinned `python_interpreter` always wins (and costs no probing); otherwise auto-detect ranks in-tree venv → poetry → active `VIRTUAL_ENV`/`CONDA_PREFIX` → pyenv → system. A **named conda env is offered but never auto-picked**: choosing one of N unrelated envs on the user's behalf is a guess, and a wrong one here is indistinguishable from a bug. Remote projects probe the **host** (one constant `sh` script over `run_remote_script`) — the interpreter that matters is the one on the machine the run tab runs on. |
| `pdf_clip.rs` | In-memory transfer slot for dragged/copied PDF *pages*. Two Eldrun windows are separate WebViews with separate JS heaps, so the bytes must cross the process boundary; events carry only the token. |
| `crash.rs` | Receives frontend renderer crash reports. |
| `debug.rs` | Debug-mode helpers. |

**Services (`services/`)** — `AppHandle`-free, unit-testable.

| File | Purpose |
|------|---------|
| `ssh_common.rs` | Shared SSH argv + validation helpers (`validate_arg`, `ssh_*_base_args`, `ssh_target`, `sshpass_available`). |
| `remote.rs` | Explicit remoteness resolver (`remote_target_for`/`_for_dir`) + pooled `Sftp`/ControlMaster registry (mount-free remote). |
| `sftp.rs` | Native SFTP session: list + read/write/create/delete/rename/mkdir/download (pooled `*_on` + one-shot). |
| `ssh_exec.rs` | Remote command execution over SSH (PTY tabs, git-over-ssh, remote `mkdir`; ControlMaster). |
| `remote_agents.rs` | Remote agent bootstrap/resume for SSH projects. |
| `remote_sync.rs` | Selective byte-sync core for remote projects: mirror paths, manifest, host/mirror walks, divergence + push/pull primitives. |
| `sync_auto.rs` | Auto-sync engine on top of `remote_sync` (watcher + interval trigger, safe-direction policy). Skips the git-tracked set when lockstep owns it. |
| `git_peer.rs` | Git lockstep: keeps the local mirror and host repo in step **semantically** (commits/refs via `git bundle`, never `.git` bytes). **Lockstep owns the git-tracked tree; byte-sync owns everything else** — the invariant that keeps the two transports from racing for the same file (#28p). One consequence worth knowing: enabling lockstep converts a **tracked** file from a continuous byte mirror to commit-gated — a saved edit no longer reaches the peer until it's committed (`docs/git_lockstep_case_matrix.md` #5/#7). |
| `local_loss.rs` | The record of what lockstep/sync **destroyed in the local mirror** (#28q): a per-project append-only log, written by the destructive sites in `git_peer` (`audit_local_head_move`) and `commands::sync`, raised by `LocalLossDialog`. A file, not an event — the services are `AppHandle`-free and a background pass can delete with no window listening. |
| `openvpn.rs` | OpenVPN process lifecycle (askpass file, teardown). Two registries, both keyed by config path: headless tunnels Eldrun spawned, and *interactive* ones typed into a terminal tab — the latter armed with a `--writepid` Eldrun owns, so they are visible (`is_connected`/`active_configs`) and killable (`disconnect`/`disconnect_all`) rather than outliving the app with the machine's routing changed. |
| `agent_session.rs` | Agent-session resolvers (`resolve_{claude,codex}_session`), SessionStart hook installer, live-session records, Codex hook-trust state. |
| `codex_bind.rs` | Hook-free Codex session binding: follows `~/.codex/sessions` rollouts so Codex tabs resume even when its hook is untrusted. |
| `sandbox.rs` | Project containers (#38): ONE session-lived, capability-dropped Docker container per toggled project (`eldrun-<id>`); every shell/agent tab `docker exec`s into it. Identical-path mount of the project dir (+ minimal agent auth/state mounts) keeps resume/git/viewers reading host bytes. Lifecycle: idempotent `up` (spec-fingerprint label detects staleness) / `down` on deactivate (skipped while tabs live) / `down_all` at exit / `sweep_orphans` at startup. Tab close TERMs the in-container process via a pidfile kill-wrapper — docker never kills an exec when its client dies. Local projects only; Windows refused at spawn. Plan: `docs/docker_projects_plan.md`. |
| `project_runtime.rs` | Worker-thread project switch + time flush (`flush_project_secs`); kicks the sandbox container down(prev)/up(next) thread on switch. |
| `restore_service.rs` | Tab/session restore on relaunch. |
| `terminal_service.rs` | Tab layout save/restore for terminals. |
| `usage_stats.rs` | Recursive file-churn watcher on the active project (pure `classify_fs_event`/`is_ignored`/`Debouncer`) + periodic flush into `usage_stats.json`. Local filesystems only — inotify cannot see an SFTP tree. |
| `window_service.rs` | Window-state helpers. |

**Platform (`platform/`)** — `WorkspaceBackend` strategy.

| File | Purpose |
|------|---------|
| `x11.rs` | X11 workspace / window management via xlib. |
| `wayland_kde.rs` | KDE Wayland backend via KWin scripting + DBus (show/hide stub, #18). |
| `windows.rs` | Windows backend: SW_HIDE "parking", position_window, occlusion probe (Win32 FFI). |
| `windows_park.rs` | Pure Windows parking logic (un-gated; Linux-run safety tests). |
| `macos.rs` | macOS backend: app-granularity hide/unhide parking (CGWindowList + NSRunningApplication FFI). |
| `macos_park.rs` | Pure macOS parking + occlusion logic (un-gated; Linux-run safety tests). |
| `null.rs` | No-op platform fallback. |

**Schema (`schema/`)** — Serde structs mirroring the JSON state files.

| File | Purpose |
|------|---------|
| `projects.rs` / `project.rs` | `projects.json` entries + per-project `project.json`. |
| `settings.rs` | `settings.json`. |
| `default_apps.rs` | `default_apps.json`. |
| `time_log.rs` | `time_log.json` (unbounded `Vec`; Efficiency #2/#12). |
| `usage_stats.rs` | `usage_stats.json`: rolling hour+day usage counters behind the daily recap. Same bucket/prune shape as `net_usage`, but an **open** metric-key → count map (`metric` module) so a new stat needs no migration. |
| `boxes.rs` | Project boxes. |
| `calendar.rs` | `calendar.json`: calendars, events (start/end, rrule, alarms), tasks; migrates the legacy v1 array. |
| `session.rs` | Live/restorable session state. |
| `active_session.rs` | Defined but **not yet wired** (TODO Group F #24). |

**Terminal (`terminal/`)**

| File | Purpose |
|------|---------|
| `mod.rs` | PTY lifecycle. (Agent-session resolution happens in `commands::terminal::pty_spawn`, before ssh/docker wrapping.) |
