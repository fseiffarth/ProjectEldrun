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
| `workspace.rs` | KDE/X11 workspace switch commands. |
| `settings.rs` | Settings read/update. |
| `project_runtime.rs` | Project-switch runtime command wrapper (off-UI-thread). |
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
| `openvpn.rs` | OpenVPN process lifecycle (askpass file, teardown). |
| `agent_session.rs` | SessionStart hook installer + live-session recording for agent resume. |
| `project_runtime.rs` | Worker-thread project switch + time flush (`flush_project_secs`). |
| `restore_service.rs` | Tab/session restore on relaunch. |
| `terminal_service.rs` | Tab layout save/restore for terminals. |
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
| `boxes.rs` | Project boxes. |
| `calendar.rs` | `calendar.json`: calendars, events (start/end, rrule, alarms), tasks; migrates the legacy v1 array. |
| `session.rs` | Live/restorable session state. |
| `active_session.rs` | Defined but **not yet wired** (TODO Group F #24). |

**Terminal (`terminal/`)**

| File | Purpose |
|------|---------|
| `mod.rs` | PTY lifecycle + agent-session resolvers (`resolve_{claude,codex}_session`). |
