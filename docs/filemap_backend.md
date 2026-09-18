# ProjectEldrun — Backend File Map (`src-tauri/src/`)

See the root `AGENTS.md` for project rules; `docs/filemap_frontend.md` is the
frontend file map.

Deliberately **not** a `CLAUDE.md` (agents auto-load those). Grep it for the
file you touch. **One line per row**: what the file is for, plus an invariant
only when breaking it does damage. The *why* goes in code comments or
`docs/context/`, never here. Pre-2026-09-18 long-form rows: `docs/filemap_rationale/backend.md`.

**Top level**

| File | Purpose |
|------|---------|
| `main.rs` | Tauri app entry point, plugin registration. |
| `lib.rs` | Command registration (`generate_handler!`), app setup, hook/restore install; crash logger (panic hook + async-signal-safe fatal-signal handler that restores `SIG_DFL` and re-raises; `scripts/crash-symbolize.sh`); per-window renderer reload budget; macOS menu bar (`macos_menu_plan`). |
| `storage.rs` | JSON persistence helpers: unique-temp atomic replacement and serialized, corruption-preserving read-modify-write transactions. |
| `paths.rs` | Canonical Eldrun directory paths. |
| `sysstat.rs` | Per-process CPU via `/proc` (`descendant_pids`), whole-system `SystemSnapshot`, and `machine_load()` — aggregate-only, no process table (cheap enough to poll). Unsupported target answers `supported: false`, never zeros. |
| `gpustat.rs` | Whole-device GPU memory as two pools (dedicated VRAM + shared/GTT; callers sum) plus sensors, from DRM sysfs or `nvidia-smi`; ~1 s cache. Missing readings are `None`, never 0. Per-process GPU is separate (monitor only). Remote hosts parsed by the same parsers. |

**Commands (`commands/`)** — Tauri command handlers exposed to the frontend.

| File | Purpose |
|------|---------|
| `projects.rs` | Project CRUD, scaffold/import, time-today (god module, #1). `find_project_conflict` is the one duplicate gate (#152), comparing a `ProjectSite` (local dir canonicalized; remote = SSH target + path). `plan_project_dir_rename`/`rename_project_dir`: guarded rename of a closed local project's folder (no-replace move, then path prefixes re-pointed in registry, `project.json`, saved layout). |
| `fs.rs` | File-I/O commands (read/write/mtime, extracted from `projects.rs`; #1 seam). |
| `fs_watch.rs` | Filesystem watch start/stop + change events. |
| `git.rs` | Git status/history/commit/push + worktrees (#23, `docs/worktree_improvement_plan.md`). `WorktreeSite` makes where it runs explicit (a remote project's `project_dir` is the mirror). |
| `git_publish.rs` | Publish a repo to GitHub (`gh`) / GitLab (`glab`); shared `Provider`. `PublishSite`: remote projects publish from the local lockstep mirror by default (`publish_from = "local"`). |
| `git_fork.rs` | Import-dialog fork source: fork via the provider CLI's raw `api` (response names the fork; existing fork looked up), then clone it with the original as `upstream`. |
| `terminal.rs` | Terminal/PTY command surface (delegates to `terminal/mod.rs`). Also the **local** tmux-session commands (TODO #85): `local_tmux_{list,kill,rename}`, and the `pty_spawn` local-tmux wrap (`services::tmux_local`). |
| `app_update.rs` | Settings → Updates commands (thin over `services::app_update`). No command takes a URL or path; download re-asks GitHub, install uses what download staged. |
| `apps.rs` | App launching, `run_script_detached`, `open_file`, external window tracking. |
| `default_apps.rs` | Per-file-type default-app mapping. |
| `ssh.rs` | SSH commands for remote projects (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`, `ssh_tooling_status`) + explicit-click disconnects: `remote_kill_all_jobs` (`tmux kill-server`) and `ssh_close_master`. |
| `remote.rs` | Pooled SSH/SFTP lifecycle (`remote_connect`/`remote_disconnect`), `remote_upload_file` (sanitized dest), and remote tmux commands (`remote_tmux_{list,kill,rename}`, per host) (#85). |
| `openvpn.rs` | OpenVPN tunnel connect/store-config commands. |
| `ollama.rs` | Ollama model list/pull/delete + cancellable streaming autocomplete; capability-based FIM with prose chat, semantic stream stops and seeded candidates. Server address only via `resolve_ollama_addr` (read per call); `https://` is an error, never a downgrade. |
| `tex.rs` | TeX compile + SyncTeX (shell-escape defense). `compile_tex` is async (`spawn_blocking`); pdflatex full compiles use a cached-preamble `.fmt` keyed by preamble + local inputs. |
| `synctex.rs` | Native SyncTeX reverse search from `.synctex(.gz)` (the CLI picks the wrong `.tex` file on margin clicks). |
| `boxes.rs` | Project-box CRUD + the `box:<id>` scope's allowed-roots (`box_allowed_roots`, fail-closed) + the box folder's agent-doc link blocks and per-member symlink farm (`.eldrun-box-links.json` ownership manifest — only Eldrun-created links are ever removed). Membership is N:M via `member_ids` only. |
| `browser.rs` | In-app browser (#61, `docs/browser_plan_{a,b,c}.md`): reader tab fetched + sanitized in Rust (ammonia, no JS runs) and a separate hardened live-page window. Path-free command surface. |
| `caldav.rs` | CalDAV account commands (`docs/context/caldav.md`), mirroring mail's. Sync = `caldav_fetch` (raw iCal) → frontend parses with `lib/calendar/ics.ts` → `caldav_apply` merges atomically. |
| `calendar.rs` | Calendar/event/task CRUD over `calendar.json` + guarded ICS read/write. `merge_caldav_calendar_at` merges CalDAV rows by `caldav_href` field by field (never re-mints ids). |
| `mail.rs` (priority marks) | `mail_priority_{set,page,counts,clear}`: Important/Urgent marks, local-only (`schema::mail::MailPriority`), no network. |
| `mail.rs` (deleting) | `mail_move` (delete = move to Trash) and `mail_purge` (`\Deleted` + `UID EXPUNGE`). Requires UIDPLUS or refuses (`NO_UIDPLUS`) — never plain `EXPUNGE`. |
| `mail.rs` (filters) | `mail_filters_{list,set,apply}`: local keyword rules; list saved wholesale (order = first match wins); one command for preview and apply (`dry_run`). |
| `printing.rs` | Native print manager: `print_system_snapshot` + cancel / set-default / pause / test page. CUPS (under `LC_ALL=C`) or Windows PowerShell, mapped to a closed state set (unknown ≠ healthy). |
| `subwindow.rs` | Detached subwindow lifecycle (#42). Wayland parks by minimize/activate (hide/show loses placement); `detached_window_is_parked` gates renderer work. `detached_query` writes `?detached=<scope>&group=<gid>`. |
| `presenter.rs` | Presentation windows (deck audience window, PDF present window, `present-` labels): second monitor, screen kept awake. Not a detached subwindow — never parked on project switch. |
| `timer.rs` | Time-tracking commands. |
| `vm.rs` | Project VMs (`docs/context/vm_projects.md`): thin `spawn_blocking` wrappers over `services::vm`/`vm_proxy`. Also "Download to…" SFTP exit; remote names validated (remote tree is attacker-controlled). |
| `usage_stats.rs` | Usage recap: batched counter writes (`usage_bump`), rollup reads, watcher attach, and git commits/lines derived on demand from `git log`. |
| `workspace.rs` | Workspace-backend commands (switch/show/hide, `workspace_info`, `desktop_owns_super_key`, `workspace_capabilities`) + connection-type and Wi-Fi SSID probes. |
| `settings.rs` | Settings read/update. `patch_settings` owns the cross-window read + shallow merge + write under the process-wide JSON mutation lock and returns the committed snapshot; webviews never race by replacing the file from their private caches. |
| `root_mcp.rs` | The root console's MCP listener: loopback `POST /mcp`, `Origin` refused, bearer checked, writes emitted as `root-mcp-changed` for the window's calendar store and CalDAV push. An `*_open` tool's overlay goes out as `root-mcp-open`. `root_mcp_status` carries neither port nor token, but does carry `WIRED_CLIS` for the CLI rows' read-only MCP chips. Design: `docs/context/root_console.md`. |
| `mobile_control.rs` | Tauri adapter for Eldrun Mobile: desktop bridge (Unix socket / Windows pipe + token), Tailscale Serve inspection, per-OS host service, pairing/devices. Sidecar = the Eldrun binary with `--mobile-host`. Host lifetime = app's. |
| `project_runtime.rs` | Project-switch runtime command wrapper (off-UI-thread). |
| `slurm.rs` | SLURM run/watch (`slurm_*`) over the pooled ControlMaster (`run_remote_script`). Every path `shell_quote`d; job ids validated numeric. |
| `hpc_ws.rs` | HPC workspaces (`hpc_ws_*` over `ws_allocate`/`ws_list`/…); the allocated path becomes the project's remote root. Nothing site-specific. |
| `python.rs` | The single source of Python interpreter precedence (#87): pinned `python_interpreter` → in-tree venv → poetry → `VIRTUAL_ENV`/`CONDA_PREFIX` → pyenv → system. Named conda envs offered, never auto-picked. Remote probes the host. |
| `pdf_clip.rs` | In-memory transfer slot for dragged/copied PDF *pages*. Two Eldrun windows are separate WebViews with separate JS heaps, so the bytes must cross the process boundary; events carry only the token. |
| `crash.rs` | Receives frontend renderer crash reports. |
| `debug.rs` | Debug helpers + renderer memory readings for `rendererWatchdog.ts`: `webview_renderer_rss` (every renderer, tagged by the window that claimed it via `webview_renderer_claim`; label from the calling window, never the payload). |
| `skills.rs` | Skills Library commands (`docs/skills_plan.md`), thin `spawn_blocking` wrappers over `services::skills`. Install takes a `SkillTarget`, never a path. |
| `spell.rs` | Spell-check commands (M#248), thin `spawn_blocking` over `services::spell`; issues reuse `commands::ollama::GrammarIssue`; no display prose from the backend (`no_dictionary` token). Also `spell_dictionaries`, install/remove. |

**Services (`services/`)** — `AppHandle`-free, unit-testable.

| File | Purpose |
|------|---------|
| `text_completion.rs` | AppHandle-free completion reservations/cancellation and bounded NDJSON transport; abort drops the HTTP socket, with Unicode/chunk/cancellation tests. |
| `ssh_common.rs` | Shared SSH argv + validation helpers (`validate_arg`, `ssh_*_base_args`, `ssh_target`, `sshpass_available`). |
| `mobile_control/` | AppHandle-free Eldrun Mobile sidecar core: loopback HTTP/PWA server, exact-origin device auth, bounded admin/desktop protocols, audit store, tmux PTY/WebSocket bridge. Raw project ids, paths, commands, tmux targets never cross the browser API; tab labels are the only tab state the phone writes (via `agent_tab_target`). |
| `git_init.rs` | Default branch `main` for every repo Eldrun creates: `init_repo` (local), `INIT_SHELL` (remote, with fallback for git < 2.28), `ensure_default_branch`. |
| `remote.rs` | Explicit remoteness resolver (`remote_target_for`/`_for_dir`) + pooled `Sftp`/ControlMaster registry keyed by `(project, host)` (`conn_key`; `PRIMARY_HOST`). Workers via `remote_target_for_host` / `compute_hosts_for`. |
| `sftp.rs` | Native SFTP session: list + read/write/create/delete/rename/mkdir/download (pooled `*_on` + one-shot). |
| `ssh_exec.rs` | Remote command execution over SSH (PTY tabs, git-over-ssh, ControlMaster). With `tmux_session`/`tmux_attach`, `wrap_pty_options` nests the exec in `tmux new-session -A -D -s <frontend-minted name>` (#85). |
| `remote_agents.rs` | Remote agent bootstrap/resume for SSH projects. |
| `remote_sync.rs` | Selective byte-sync core for remote projects: mirror paths, manifest, host/mirror walks, divergence + push/pull primitives. |
| `app_update.rs` | App update check against GitHub releases (not the Tauri updater: releases are unsigned). Asset URLs checked against this repo's release-download prefix; per-platform installer handoff. |
| `big_folders.rs` | Giant-folder census for the setup prompt: local walk + remote `du -ak -x` reduced to one `(rel, bytes)` shape; pure `tally_dirs` + `pick` report the shallowest over-threshold folder. |
| `caldav.rs` | CalDAV transport (RFC 4791/6578) on `reqwest` + `roxmltree`: fixed XML templates, multistatus parsing. Never parses iCalendar (opaque text to the frontend). |
| `dev_build.rs` | Reads `package-dev-auto.sh`'s state files + log tail for the header dev-build chip (step, estimate, failure, behind, relaunch). `None` unless compiled with `ELDRUN_DEV_SOURCE_ROOT`. |
| `desktop_images.rs` | Desktop images the phone composer may attach (#31u): newest screenshots/pictures by opaque id; `resolve` re-scans, so no path crosses the API; copies via `mobile_control::inbox::store`. |
| `browser_engine.rs` | Browser engine work: reader fetch (rustls, no cookies/Referer, fixed UA, 15 s / 5 MB / 3-hop caps), live-window registry, download quarantine + sniffing. SSRF rule: only hop 0 (the user's URL) may be loopback/private. |
| `sync_auto.rs` | Auto-sync on top of `remote_sync` (watcher + interval, safe-direction policy). Skips lockstep-owned tracked files; ignores `.git`/`.eldrun` writes; HPC tag stops it. |
| `git_peer.rs` | Git lockstep (`docs/git_lockstep_case_matrix.md`): mirror and host repo kept in step via `git bundle`, never `.git` bytes. Lockstep owns tracked files, byte-sync the rest (#28p); tracked edits reach the peer only once committed. |
| `worker_sync.rs` | Multi-host worker fan-out (`docs/multi_host_remote_plan.md`): push-only, reuses `git_peer` bundle primitives outbound; `fetch bundle` → `reset --hard FETCH_HEAD`, **never `git clean`** (tested). |
| `local_loss.rs` | Append-only per-project record of what lockstep/sync destroyed in the local mirror (#28q), written by `git_peer` / `commands::sync`, shown by `LocalLossDialog`. A file, not an event. |
| `openvpn.rs` | OpenVPN lifecycle (askpass file, teardown). Registries keyed by config path: headless tunnels and interactive terminal tunnels (Eldrun-owned `--writepid`); Windows uses the Interactive Service pipe to stay unelevated. |
| `tmux_local.rs` | Local tmux wrapping (#85, Unix only): `local_tmux_*` argv builders; applied in `pty_spawn` only when ssh/docker wrapping didn't. `kill_eldrun_sessions` reaps local `eldrun-*` sessions on clean quit. |
| `agent_bin.rs` | Installs embedded `eldrun-send` scripts into `<state_dir>/bin`, on PATH and read-only mounted into fences and containers; project → phone file delivery through the outbox. |
| `agent_turn.rs` | Agent turn state from the agents' own hooks (`<live_sessions>/<ELDRUN_TAB_UID>.turn`): watches the live-sessions tree, maps uid → PTY, emits `agent-turn` (working/decision/done/idle). |
| `agent_session.rs` | Agent session resolvers (`resolve_{claude,codex}_session`), hook installer (`HOOK_EVENTS`, `CODEX_HOOK_EVENTS` → `~/.codex/config.toml`), live-session records (`<uid>`, `.mode`, `.src`), Codex hook trust, `agent_session_model`. |
| `agent_transcript.rs` | Agent transcript tail (6 MiB) for the phone's Focus view, as prompt/answer entries; resolved via `agent_session::read_agent_transcript`. |
| `codex_store.rs` | Codex's SQLite thread store (`~/.codex/state_<n>.sqlite`), read-only best-effort: `thread_model`, `thread_exists` (Codex stopped writing rollout files). |
| `copilot/{rpc,policy,process,documents,session}.rs` | Group M #45a Copilot autocomplete: bounded framed JSON-RPC, directory-bound cloud consent, the narrow bwrap fence + pinned server install, incremental document sync/tickets, and the per-project session (handshake, completion behind opaque ids, feedback, device sign-in, restart budget, `sessions()` registry). Thin commands in `commands/copilot.rs`; `RunEvent::Exit` stops every server. |
| `agent_prompts.rs` | Project-scoped collected prompts (`agent_prompts.json`, #249), beside — never inside — `agent_tasks.json`. Shares `sanitize_message` + 16 KiB limit, 64 per project; pure `apply_*` core tested. Phone reaches it via `mobile_control`. |
| `agent_prompts.rs` prompt links (#262) | `AgentPromptsFile.links[project]` stores validated `related`/`after` edges additively without changing the file version. Endpoints name collected/history rows; deleting or clearing an endpoint prunes its edges, while archive preserves them as the same id moves into history. Link commands emit the existing prompt-change event. The service remains `AppHandle`-free; chain delivery is the frontend scheduler host's responsibility. |
| `prompt_blame.rs` | Prompt blame (#255): `head(project_id)` (HEAD + branch) and `files_touched(project_id, commit, since)` (dirty entries newer than `since` ∪ diff since commit). |
| `agent_usage.rs` | Reads one agent CLI's usage panel without a tab (`claude -p "/usage" --output-format json`, spends no quota). `RECIPES` holds only CLI-verified recipes. |
| `agent_versions.rs` | Installed agent CLI versions vs the ones Eldrun's flags/parsers were verified with (`VERIFIED`, one row per check; `VERSION_ARGV`). |
| `root_mcp.rs` | Root-console MCP tools (`docs/context/root_console.md`): per-run token handed only to a local root-scope agent; `projects_list`/`calendar_*`/`todo_*` over the calendar helpers. |
| `agent_fence.rs` | Default-on local agent fence: pure authority/root decisions, box union roots, fence-tool probe (bwrap / `sandbox-exec`), argv wrappers, working-root args. Remote/container/Windows report not-enforced. Fails closed. |
| `agent_creds.rs` | Claude credential mirror (`<state_dir>/agent-creds/claude/.credentials.json`), mounted into fence/container instead of the host file (a file bind mount pins a stale inode after Claude's atomic rotation). |
| `codex_bind.rs` | Hook-free Codex session binding: follows `~/.codex/sessions` rollouts so Codex tabs resume even when its hook is untrusted. |
| `sandbox.rs` | Project containers (#38): one session-lived capability-dropped container per project (`eldrun-<id>`), tabs `docker exec` in; identical-path mount. Idempotent `up`, `down`/`down_all`/`sweep_orphans`; tab close TERMs via pidfile wrapper. `CLAUDE_UNMOUNTED` is a denylist. |
| `vm.rs` | Project-VM lifecycle (`docs/vm_projects_plan.md`): QEMU/KVM guest reached only over SSH on a per-boot loopback port; no shared fs. Owns overlay, cloud-init seed, keypair, port allocation, per-VM known_hosts/identity. |
| `iso9660.rs` | Minimal ISO 9660 + Rock Ridge writer (`SP`/`NM`/`PX`) for the cloud-init NoCloud seed — two root files, `cidata` label — so macOS and Windows need no `genisoimage`. Pure; byte-level tests plus an `isoinfo` cross-check where installed. |
| `vm_proxy.rs` | VM egress proxy: allowlisting CONNECT-only HTTP proxy via slirp `guestfwd`; deny-by-default (agent APIs + per-project extras, GitHub opt-in); deny log = exfiltration tripwire. No plain HTTP. |
| `project_runtime.rs` | Worker-thread project switch + time flush (`flush_project_secs`); kicks the sandbox container down(prev)/up(next) thread on switch. |
| `restore_service.rs` | Tab/session restore on relaunch. |
| `terminal_service.rs` | Tab layout save/restore, keyed by project id at `<state_dir>/sessions/<key>/terminals.json` with `open_apps` (#142). Never read executable intent from inside the project tree. |
| `usage_stats.rs` | Recursive file-churn watcher on the active project (pure `classify_fs_event`/`is_ignored`/`Debouncer`) + periodic flush into `usage_stats.json`. Local filesystems only — inotify cannot see an SFTP tree. |
| `mail_authres.rs` | `Authentication-Results` (RFC 8601): trust only the topmost instance, and only if its `authserv-id` matches the account's configured one. |
| `mail_crypt.rs` | Local mail store encryption at rest (`docs/context/mail_encryption.md`): `ELMC` envelope (XChaCha20-Poly1305, random nonce), HKDF subkeys (`k_field`/`k_blob`/`k_addr`/`k_name`/`k_wrap`), key file wrapped by keychain KEK or Argon2id passphrase. |
| `mail_crypto.rs` | Format-agnostic end-to-end mail seam: detects what a message claims (`CryptoKind`) by structure, not validity; armor only at line start; MIME wrapper outranks inline armor. |
| `mail_filters.rs` | Pure keyword matcher for mail filters. Empty rule matches nothing; comparison `to_lowercase`d. |
| `mail_engine.rs` | Mail protocol layer (MIME, IMAP, SMTP, TLS), AppHandle- and path-free; module header owns transport invariants (implicit TLS only, no cert escape hatch, all bounds). Every IMAP op leases from the session pool (#167). |
| `mail_pgp.rs` | OpenPGP keyring + sign/verify/encrypt/decrypt on rPGP, sealed under `k_wrap`. Key generation is Curve25519 only (no algorithm choice). |
| `web_safety.rs` | Shared web-safety primitives for mail and browser: `sanitize_attachment_name`, host/scheme helpers, and the navigation gate (takes a parsed `Url`, never `&str`; three outcomes). |
| `webkit_a11y.rs` | WebKitGTK AT-SPI opt-out: WebKit 2.48's a11y Text bridge `CRASH()`es the renderer on stale offsets, so Eldrun redirects `WEBKIT_A11Y_BUS_ADDRESS`. |
| `window_service.rs` | Window-state helpers, incl. `all_detached_labels` — every live popout regardless of owning project, which is the set the #240 monitor watcher re-fits (an unplugged display has nothing to do with which project is active). |
| `skills.rs` | Skills Library service (`docs/skills_plan.md`): git sources shallow-cloned into `skills_cache/<id>/` via `commands::git`'s hardened clone; catalog parsed fresh from `**/SKILL.md` frontmatter; nothing persisted but sources. |
| `spell.rs` | Dictionary spell check (M#248) on `spellbook` (pure-Rust Hunspell): system `.aff`/`.dic` + `<state_dir>/dictionaries/` (with `personal.dic`); Latin-1 fallback. |
| `state_gc.rs` | Bounds the state dir's otherwise-unbounded files (logs, WebKit cache, …) that no other subsystem sweeps. Trims keep the tail and happen in place. |

**Platform (`platform/`)** — `WorkspaceBackend` strategy.

| File | Purpose |
|------|---------|
| `x11.rs` | X11 workspace / window management via xcb. Also `session_is_wayland`, the one predicate behind every "don't bother under Wayland" branch: the `_NET_CLIENT_LIST` scans in `apps.rs`/`find_window_for_title` answer at once (XWayland's list never holds a native window; nothing consumes the id there), `subwindow.rs` treats positions as unreadable, `screenshot.rs` prefers the portal. |
| `wayland_kde.rs` | KDE Plasma Wayland backend: workspace info over D-Bus only; no parking (`can_park` false), no sticky. |
| `windows.rs` | Windows backend: SW_HIDE "parking", position_window, occlusion probe (Win32 FFI). |
| `windows_park.rs` | Pure Windows parking logic (un-gated; Linux-run safety tests). |
| `macos.rs` | macOS backend: app-granularity hide/unhide parking (CGWindowList + NSRunningApplication FFI). |
| `macos_park.rs` | Pure macOS parking + occlusion logic (un-gated; Linux-run safety tests). |
| `null.rs` | No-op fallback — every Linux desktop without a backend (GNOME, XFCE, sway, …) and any failed connect: parks nothing, `can_park` false. |

**Schema (`schema/`)** — Serde structs mirroring the JSON state files.

`schema/calendar.rs` also owns `TaskFileLink`, the one-way project-file remark
back-reference on a board card; CalDAV merges preserve it beside mail/event.

| File | Purpose |
|------|---------|
| `projects.rs` / `project.rs` | `projects.json` entries + per-project `project.json`. |
| `settings.rs` | `settings.json`. |
| `default_apps.rs` | `default_apps.json`. |
| `time_log.rs` | `time_log.json` (unbounded `Vec`; Efficiency #2/#12). |
| `usage_stats.rs` | `usage_stats.json`: rolling hour+day usage counters behind the daily recap. Same bucket/prune shape as `net_usage`, but an **open** metric-key → count map (`metric` module) so a new stat needs no migration. |
| `boxes.rs` | Project boxes. |
| `browser.rs` | In-app browser wire contract (`UrlVerdict`, `ReaderPage`, `SecurityState`, …); nothing persisted, no type carries a path. `allowed && reason.is_some()` = reachable but ask first. |
| `caldav.rs` | CalDAV accounts (`caldav/accounts.json`, no secrets — keychain keyed by server target) + protocol wire shapes; `CalDavCalendarRef.read_only` from the server's privilege set. |
| `calendar.rs` | `calendar.json`: calendars, events, tasks (tasks are also the to-do board's cards). `normalize` keeps `percent`/`completed` authoritative and reconciles `column`. |
| `mail.rs` | Mail wire contract. `MailPriority` is a mark, not a move; `messages.priority` written only by `MailStore::set_priority` (never by `upsert_header`); its index created after the additive `ALTER`. |
| `session.rs` | Live/restorable session state. |
| `skills.rs` | Skills Library wire shapes (`SkillSource`, `SkillCatalogEntry`, `InstalledSkill`, `SkillDetail`, `SkillTarget`) — not a state file beyond `skills_sources.json`; the catalog and installed lists are re-derived from disk on every call. `SkillTarget`'s two variants are deliberately asymmetric: `Project { dir }` carries a path, `Personal` carries nothing, which is the whole boundary — see `services::skills`. |

**Terminal (`terminal/`)**

| File | Purpose |
|------|---------|
| `mod.rs` | PTY lifecycle. Visible-only streaming: hidden panes emit no `terminal-output`; output buffers in Rust (`ROUTE_PENDING_CAP`) with throttled `terminal-activity` digests; show drains as one `terminal-replay`. Kill reaps the subtree. |
