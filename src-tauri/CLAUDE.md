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
| `gpustat.rs` | Whole-**device** GPU memory (the header row, the monitor pane, the model menu's headroom line) — Ollama's `/api/ps` figure is now one line of its breakdown, not the reading. Reports a GPU's **two** pools separately because on an APU only one is real: the dedicated VRAM carve-out (~512 MB — the framebuffer, permanently ~full, so it alone says nothing) and the shared pool mapped out of system RAM (amdgpu's GTT, where a model actually lands); callers sum them, and on a discrete card the shared half is 0 so the sum collapses to plain VRAM. Sources: **DRM sysfs** (`mem_info_*` + `gpu_busy_percent` — no tool, no root) and **`nvidia-smi`** (the only portable NVIDIA read; a process spawn, so its *absence* is remembered rather than re-paid every poll). A card is only reported when it states a `vram_total` — Intel's `i915` exposes none, and a zero is not a measurement. One ~1 s cache serves all three surfaces. Each `GpuSample` also carries the card's **sensors** — temperature, power (draw + cap), core/mem clocks, fan %, PCIe link, driver version — read from the *same* cheap sysfs (a card's `hwmon` subdir + `pp_dpm_*`/`current_link_*`) / `nvidia-smi` pass, so every surface gets them free; each is `None` when the driver won't say (never a fake zero). **Per-process** GPU memory is deliberately separate (`process_snapshot` → `gpu_process_snapshot`, monitor pane only, *not* cached into the shared snapshot): a heavier read (a `/proc` `fdinfo` walk deduped by `drm-client-id` for amdgpu, an `nvidia-smi --query-compute-apps` spawn) the always-visible header must not pay for. A **remote** project samples its host's GPUs too: `sysstat::REMOTE_SNAPSHOT_SCRIPT` ships the host's DRM sysfs files (`AMD\t…` lines) and raw `nvidia-smi` CSV (`NVSMI`/`NVPROC`) over the one SSH round-trip, and `parse_remote_snapshot` runs them through these *same* `parse_drm_card`/`parse_nvidia_smi`/`parse_nvidia_apps` parsers — so a host GPU reads field-for-field like a local one. Remote per-process is NVIDIA-only (the AMD `fdinfo` walk is too heavy to run per remote poll). |

**Commands (`commands/`)** — Tauri command handlers exposed to the frontend.

| File | Purpose |
|------|---------|
| `projects.rs` | Project CRUD, scaffold/import, time-today (god module; #1). |
| `fs.rs` | File-I/O commands (read/write/mtime, extracted from `projects.rs`; #1 seam). |
| `fs_watch.rs` | Filesystem watch start/stop + change events. |
| `git.rs` | Git status/history/commit/push. |
| `git_publish.rs` | Publish a project's repo to GitHub (`gh`) or GitLab (`glab`). |
| `terminal.rs` | Terminal/PTY command surface (delegates to `terminal/mod.rs`). Also the **local** tmux-session commands (TODO #85): `local_tmux_{list,kill,rename}`, and the `pty_spawn` local-tmux wrap (`services::tmux_local`). |
| `apps.rs` | App launching, `run_script_detached`, `open_file`, external window tracking. |
| `default_apps.rs` | Per-file-type default-app mapping. |
| `downloads.rs` | Per-project download routing. |
| `ssh.rs` | SSH commands for remote projects (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`, `ssh_tooling_status`). Also the **active-disconnect** pair (explicit-click only, never on relaunch): `remote_kill_all_jobs` (`tmux kill-server` on a host — ends *every* running session/job, best-effort, rides a live master or authenticates ad-hoc like `global_machine_monitor_snapshot`) and `ssh_close_master` (`ssh -O exit` on the shared `cm-%C` socket, for a project-free global machine that pools nothing; a project host tears its pool down via `remote_disconnect` instead). |
| `remote.rs` | Pooled SSH/SFTP connection lifecycle (`remote_connect`/`remote_disconnect`) for the active remote project. Also `remote_upload_file` (HPC wizard "Load data" step, `docs/quirky-knitting-umbrella`): streams a local file to `<remote_path>/<dest_rel>` over the pooled SFTP (`upload_file_streaming_on`), primary host, dest_rel sanitized to stay inside the root. Also the tmux-session commands (TODO #85): `remote_tmux_list` (Sessions view, `tmux ls` → `Vec<TmuxSession>`; called per-host so the view aggregates every connected worker), `remote_tmux_kill` (explicit-close / per-row kill), and `remote_tmux_rename` (per-row rename), all over the pooled ControlMaster. |
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
| `slurm.rs` | **SLURM run/watch core for HPC projects** (`docs/quirky-knitting-umbrella` plan): `slurm_available`/`slurm_submit`/`slurm_queue`/`slurm_job_out`/`slurm_cancel`. Mirrors `python.rs`'s dispatch — resolves `project_dir` (+ optional `host_id`, primary default) to a remote target and runs a POSIX-`sh` script over the pooled ControlMaster (`run_remote_script`), or a local shell for a login node that itself has SLURM. **Security**: the script is embedded verbatim, so every path is `shell_quote`d (the shared `ssh_exec` helper) and a job id is validated numeric before it touches `scontrol`/`scancel`. `slurm_submit` chains `sbatch --parsable` → `scontrol show job` in ONE round trip (the id comes from sbatch, so nothing user-controlled is interpolated) and returns the SLURM-resolved absolute out/err/work paths. Pure parsers (`parse_submit_jobid`, `parse_scontrol_paths`, `parse_squeue`, `split_script_rel` — which preserves absolute paths so the frontend can pass a file's absolute path and skip any remote-vs-local rel computation) are unit-tested. |
| `python.rs` | Which Python the viewer's Run/Debug run (#87), and the **single** source of that precedence — the frontend asks, it never re-derives. A project's pinned `python_interpreter` always wins (and costs no probing); otherwise auto-detect ranks in-tree venv → poetry → active `VIRTUAL_ENV`/`CONDA_PREFIX` → pyenv → system. A **named conda env is offered but never auto-picked**: choosing one of N unrelated envs on the user's behalf is a guess, and a wrong one here is indistinguishable from a bug. Remote projects probe the **host** (one constant `sh` script over `run_remote_script`) — the interpreter that matters is the one on the machine the run tab runs on. |
| `pdf_clip.rs` | In-memory transfer slot for dragged/copied PDF *pages*. Two Eldrun windows are separate WebViews with separate JS heaps, so the bytes must cross the process boundary; events carry only the token. |
| `crash.rs` | Receives frontend renderer crash reports. |
| `debug.rs` | Debug-mode helpers. |

**Services (`services/`)** — `AppHandle`-free, unit-testable.

| File | Purpose |
|------|---------|
| `ssh_common.rs` | Shared SSH argv + validation helpers (`validate_arg`, `ssh_*_base_args`, `ssh_target`, `sshpass_available`). |
| `remote.rs` | Explicit remoteness resolver (`remote_target_for`/`_for_dir`) + pooled `Sftp`/ControlMaster registry (mount-free remote). **Multi-host**: the pool is keyed by a composite `(project, host)` [`conn_key`], so a project's primary and each extra worker connect independently; the primary path is the `PRIMARY_HOST` (`"primary"`) constant and every file/git/sync caller (which *is* the primary subsystem) keeps its old single-arg signature via thin wrappers. `remote_target_for_host` / `compute_hosts_for` resolve a worker's spec from `projects.json`'s `extra["compute_hosts"]`. |
| `sftp.rs` | Native SFTP session: list + read/write/create/delete/rename/mkdir/download (pooled `*_on` + one-shot). |
| `ssh_exec.rs` | Remote command execution over SSH (PTY tabs, git-over-ssh, remote `mkdir`; ControlMaster). **Persistent sessions (tmux, TODO #85):** when `PtyOptions.tmux_session`/`tmux_attach` is set, `wrap_pty_options` nests the final `exec …` inside `tmux new-session -A -D -s <name>` (`TmuxWrap::{Session,Attach}` → `tmux_wrap_exec`), preserving the `cd`/env/agent-prelude prefix verbatim — so the run is decoupled from the disposable ssh channel and reattaches on reconnect/relaunch. `-A` = start-or-resume, `-D` = evict a stale client, `-s <name>` = the **frontend-minted, persisted** per-tab session name (a uuid — stable across a relaunch, unlike the regenerated PTY id, which is what makes reattach work). tmux-absent falls back to today's plain `exec` + a notice; `set -g status off`/`mouse on` reclaim the status line. `tmux_kill_session_script` (explicit close only), `tmux_ls_script`+`parse_tmux_ls`+`TmuxSession` (Sessions view) ride `run_remote_script`. |
| `remote_agents.rs` | Remote agent bootstrap/resume for SSH projects. |
| `remote_sync.rs` | Selective byte-sync core for remote projects: mirror paths, manifest, host/mirror walks, divergence + push/pull primitives. |
| `sync_auto.rs` | Auto-sync engine on top of `remote_sync` (watcher + interval trigger, safe-direction policy). Skips the git-tracked set when lockstep owns it. |
| `git_peer.rs` | Git lockstep: keeps the local mirror and host repo in step **semantically** (commits/refs via `git bundle`, never `.git` bytes). **Lockstep owns the git-tracked tree; byte-sync owns everything else** — the invariant that keeps the two transports from racing for the same file (#28p). One consequence worth knowing: enabling lockstep converts a **tracked** file from a continuous byte mirror to commit-gated — a saved edit no longer reaches the peer until it's committed (`docs/git_lockstep_case_matrix.md` #5/#7). |
| `worker_sync.rs` | **Multi-host remote** (`docs/multi_host_remote_plan.md`): the push-only, code-only fan-out that keeps each extra "worker" host's tracked tree at the primary's HEAD. Reuses `git_peer`'s bundle primitives (`bundle_create_args`, `Peer`) but only the OUTBOUND half — source(mirror)→worker only, so it inherits none of lockstep's divergence/conflict/local-loss machinery. `git init`→`fetch bundle`→`reset --hard FETCH_HEAD`, **never `git clean`** (untracked experiment outputs survive by construction — the one load-bearing invariant, tested). Triggers: worker connect, a `.git` commit on the mirror (via `git_peer::poll_loop`'s watcher branch, which calls `fan_out`), and the manual `worker_sync_now`. `worker_sync.json` records each worker's `last_head` for incremental bundles. **Output pull-back** (`preview_outputs`/`pull_outputs`) is the ONE worker→local byte path — user-initiated, size-confirmed, `git ls-files --others` → per-file SFTP download into `outputs/<label>/`. **Shared-filesystem workers** (`ComputeHost.shared_fs`, the **default** for a newly added machine) get NONE of this: they see the primary's folder over a shared FS, so no copy/bundle/git ever touches them — the fan-out gate `wants_code_fanout` (`!shared_fs && sync_code`) and a defensive early skip in `sync_worker` keep git off what is the primary's real working tree (a tab just `cd`s into `spec.remote_path`). |
| `local_loss.rs` | The record of what lockstep/sync **destroyed in the local mirror** (#28q): a per-project append-only log, written by the destructive sites in `git_peer` (`audit_local_head_move`) and `commands::sync`, raised by `LocalLossDialog`. A file, not an event — the services are `AppHandle`-free and a background pass can delete with no window listening. |
| `openvpn.rs` | OpenVPN process lifecycle (askpass file, teardown). Two registries, both keyed by config path: headless tunnels Eldrun spawned, and *interactive* ones typed into a terminal tab — the latter armed with a `--writepid` Eldrun owns, so they are visible (`is_connected`/`active_configs`) and killable (`disconnect`/`disconnect_all`) rather than outliving the app with the machine's routing changed. Windows adds a third registry: headless connects go through the **OpenVPN Interactive Service** (named-pipe IPC, `\\.\pipe\openvpn\service`) so Eldrun stays unelevated; the direct `openvpn.exe` spawn (needs elevated Eldrun) is only the no-service fallback. |
| `tmux_local.rs` | Persistent **local** (tmux) sessions (TODO #85): wraps a LOCAL shell/script tab's `PtyOptions.{cmd,args}` into a `tmux new-session -A -D` argv so a run survives an Eldrun **crash** (the tmux server is a daemon the PTY-held client is separate from) and reattaches on restart. **Unix only** — `tmux_available()` is `false` on Windows, making every entry point a no-op. Pure argv builders (`local_tmux_{args,kill_args,rename_args,ls_args}`); the wrap runs in `commands::terminal::pty_spawn` only when ssh/docker wrapping did NOT fire. |
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
| `mod.rs` | PTY lifecycle. (Agent-session resolution happens in `commands::terminal::pty_spawn`, before ssh/docker wrapping.) **Closing a tab (`kill`) — or the app (`kill_all`, wired into `RunEvent::Exit`) — reaps the child's whole process *subtree*, not just the shell leader**: `portable_pty::Child::kill()` signals only the leader, so a long-running descendant (dev server, build, training run) would otherwise be orphaned. The subtree is walked (`sysstat::descendant_pids`) *before* the leader dies (its children reparent to init once it's gone), then signalled — SIGTERM→SIGKILL-after-grace on tab close, immediate SIGKILL at exit (a delayed escalation thread would die with the process). |
