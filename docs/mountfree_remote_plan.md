# Mount-Free Remote Projects — Implementation Plan

Status: **implemented** (Phases 0–5 / #28e–#28j landed). Supersedes the
sshfs-based remote model from `docs/ssh_projects_plan.md` (Group G #28). sshfs is
**removed entirely** — there is no coexistence mode. Remote projects are now
SSH/SFTP-native: agent tabs over `ssh -tt`, file browse/I-O over SFTP, git on the
host over SSH, all riding one pooled ControlMaster + `Sftp` session per active
remote project. See the per-phase notes below; runtime QA against a live key-auth
host is still hand-checked (agents can't launch Eldrun).

## Goal

Run a remote (SSH) project — agent tabs, file browsing, file create/edit/
download, and git — **without** a local FUSE mount. Remote projects become
SSH/SFTP-native:

- **Agent/terminal tabs** run on the host over `ssh -tt` (already the mechanism).
- **File browsing** lists directories over SFTP.
- **File I/O** (read/create/edit/delete/download) goes over SFTP.
- **Git** runs on the host over SSH (`ssh host 'cd <path> && git …'`).

Motivation: drop the FUSE dependency (`sshfs` on Linux, macFUSE on macOS,
SSHFS-Win on Windows) — install friction, kernel-extension approval (macOS), and
stale/hung-mount lifecycle bugs all disappear.

Decisions (locked):
- **Fully replace sshfs** — no mount, no coexistence.
- **Git runs over SSH** for remote projects (keep the status/history/commit/push
  UI; re-route its execution to the host).

## The keystone: explicit remoteness

Today "is this project remote?" is inferred from the filesystem: a cwd under
`ssh_mount::mounts_root()` ⇒ remote (`services/ssh_exec.rs:297` `project_id_from_cwd`,
`wrap_pty_options:262`). Every remote behavior hangs off that mount path. With no
mount, that signal is gone, so the **first and load-bearing change** is to make
remoteness explicit and carry it through every file/git/terminal command.

New backend resolver (single source of truth):

```rust
// e.g. services/remote.rs
pub struct RemoteTarget { pub spec: RemoteSpec, pub project_id: String }

/// Some(target) iff the project has a `remote` spec; None for local projects.
pub fn remote_target_for(project_id: &str) -> Option<RemoteTarget>;
```

Command surface shift: file/git/terminal commands stop receiving a raw
`project_dir` *local path* and instead receive a **`project_id` + `rel_path`**
(path relative to the project root). Each command resolves:

- local project → `directory` + `rel_path` on the local fs (unchanged);
- remote project → `spec.remote_path` + `rel_path` over SFTP/SSH.

`RemoteSpec` is unchanged structurally (`user?`, `host`, `port?`, `remote_path`,
`openvpn?`). What changes is the **meaning of `Project.directory`** for remote
projects: it is no longer a real local mountpoint. It becomes a non-fs display
value (e.g. `ssh://user@host/remote_path`) that the fs layer never touches.
Update the doc-comment on `schema/project.rs:71-73` accordingly.

## Connection model (Phase 0 — do this first)

A live file tree and viewers make many small calls; `services/sftp.rs` currently
spawns a fresh `ssh -s sftp` child **per call** (`open_session`, fine for the
one-shot dialog, far too slow for interactive use). And without a single shared
SSH connection the user would re-authenticate for SFTP, agent tabs, and git
separately.

Design: **one ControlMaster per active remote project, reused by everything.**

- On project activation, open a persistent SSH ControlMaster socket (the
  `control_dir()` machinery already exists in `ssh_exec.rs`). Auth happens
  **once** here: key/agent under `BatchMode=yes`, or — per the no-stored-password
  rule — a one-time password prompt fed to the master via `SSHPASS`
  (`sshpass -e`), never persisted, never on argv.
- Hold a **persistent `Sftp` session** per active remote project (one
  `ssh -s sftp` riding the same ControlMaster), pooled in app state and reused
  across `list_dir`/read/write calls. Open on activate, close on deactivate.
- Agent tabs (`ssh -tt`) and git-over-ssh both reuse the same ControlMaster
  socket → no extra auth, fast channel setup.

This phase is the linchpin for *both* performance and single-sign-on; everything
else builds on it.

## Phases

Ordered so each is independently shippable and testable. Phase 1 alone delivers
the stated main goal (remote agent tabs).

### Phase 0 — Explicit remoteness + pooled connection
- Add `services/remote.rs`: `remote_target_for(project_id)` + a pooled
  `Sftp`/ControlMaster registry in Tauri-managed state.
- Define how `project_id` + `rel_path` flow from the frontend into commands
  (new param shape; keep local path resolution identical for local projects).
- Auth-once on activation; teardown on deactivation/exit.
- **No user-visible behavior change yet** beyond the connection being held open.

### Phase 1 — Remote agent tabs *(main goal; smallest lift)*
- `services/ssh_exec.rs`: replace `project_id_from_cwd`-based detection in
  `wrap_pty_options` with the explicit `RemoteTarget`. Pass the project id (and
  resolved remote spec) through `PtyOptions` from `commands/terminal.rs` →
  `terminal/mod.rs` rather than sniffing the cwd.
- Remote cwd becomes `spec.remote_path` (+ optional subdir from the tab), not a
  mountpoint. `remote_command` already `cd`s into the target.
- Verify agent-resume (`services/remote_agents.rs`, `services/agent_session.rs`)
  makes no mountpoint assumptions; the `ELDRUN_TAB_UID` keying is unaffected.
- **Exit criteria:** open a remote project with no mount → Claude/Codex agent
  tab connects over `ssh -tt`, runs on the host, resizes/exits correctly.

### Phase 2 — Live remote file browsing
- Make directory listing project-aware: remote → pooled `sftp::list_dir`,
  local → `fs::read_dir` (today `commands/fs.rs:48 list_dir`).
- `src/components/files/FileTree.tsx` (`invoke("list_dir", …)` at ~326) and
  `FileBrowser.tsx`: pass `projectId` + `relPath`; render SFTP entries (which
  already carry real file-type metadata).
- fs-watch: inotify can't see the remote tree. Drop live-watch for remote
  projects; add an explicit refresh control (optional: periodic SFTP re-list as a
  later enhancement). `commands/fs_watch.rs` no-ops for remote projects.
- **Exit criteria:** the live file tree of a remote project lists/expands remote
  dirs with no mount.

### Phase 3 — Remote file I/O (create / edit / download / delete)
- Extend `services/sftp.rs` with the write half (the `openssh-sftp-client` crate
  already supports these; only reads are wired today): `read_file`,
  `write_file`, `create_file`, `mkdir`, `remove_file`, `remove_dir`, `rename`,
  and `metadata`/mtime. Add `download(rel_path, dest_local)` (SFTP get into the
  per-project downloads dir) and optionally `upload`.
- Route `commands/fs.rs` ops to the remote path for remote projects:
  `create_file` (179), `write_project_file_bytes` (213), `delete_file` (150),
  reads, and mtime. Either dispatch inside the existing commands via
  `remote_target_for`, or add remote-specific commands the frontend selects.
- In-app viewers need bytes: `embed/FileViewerPane.tsx` / `stores/linkRouting.ts`
  fetch file contents over SFTP for remote projects (PDF/image/markdown/code).
  Large files over a slow link will be noticeably slower — acceptable.
- `commands/downloads.rs`: define remote-project download routing (SFTP get →
  local downloads dir, or write into the remote dir).
- **Exit criteria:** create, edit+save, view, delete, and download a remote file
  with no mount.

### Phase 4 — Git over SSH
- Factor `commands/git.rs` so every invocation goes through one helper:
  `run_git(target, args)` where `target` is local or remote.
  - local → `command_no_window("git").current_dir(dir)` (unchanged; keeps the
    Windows no-console behavior noted at `git.rs:4-9`).
  - remote → `ssh_exec::remote_command("cd <remote_path> && git <args>")` over the
    shared ControlMaster. Output parsing is byte-for-byte identical (text is
    text), so `git_status`, history, diff, commit, push reuse their parsers.
- Push uses the **remote host's** git credentials/SSH keys, not the local box.
  Note interaction with `commands/git_publish.rs` (gh/glab) — that's the push
  axis and may need a remote variant or be deferred.
- **Exit criteria:** git status/history/commit/push in the right panel work on a
  remote project, executed on the host.

### Phase 5 — Remove sshfs
- Delete `services/ssh_mount.rs` and everything mount-specific:
  `ensure_project_mounted` (`commands/ssh.rs`), `ensure_remote_mounted`
  (`services/project_runtime.rs`), `mounts_root`/`mountpoint_for`/`unmount_all`,
  the `mounts/` path in `paths.rs`, and the `RunEvent::Exit` unmount hook in
  `lib.rs`.
- Frontend: remove the `ensure_project_mounted` startup/switch calls in
  `src/stores/projects.ts`.
- `services/sftp.rs` currently imports `validate_arg`/`ssh_base_args`/
  `ssh_password_base_args`/`sshpass_available` from `ssh_mount`; relocate those
  shared helpers (e.g. into `services/ssh_exec.rs` or a small `ssh_common.rs`)
  before deleting `ssh_mount.rs`.
- Migration for existing remote projects: their persisted `directory` is a stale
  mountpoint. On load, ignore it for fs purposes and drive everything from the
  `remote` spec; best-effort clean up any leftover `mounts/<id>` on first run.
- Docs/build: strip `sshfs`/FUSE from `CLAUDE.md` (Persistence section), the
  packaging/runtime notes, and any install hints. Update
  `docs/ssh_projects_plan.md` to point here.

## Cross-cutting concerns

- **Single authentication.** SFTP + agent tabs + git-over-ssh MUST share one
  ControlMaster per project or the user is prompted up to 3×. Phase 0 owns this.
  Password mode prompts once and feeds the master via `SSHPASS`; channels reuse
  it. No password is ever stored (existing rule).
- **No page cache.** Every read is a network round-trip. Mitigations: the pooled
  SFTP session, lazy tree expansion, and only fetching file bytes on open. A
  small in-memory LRU for recently-read files is a possible later enhancement.
- **Latency / offline.** An unreachable host must fail fast (ConnectTimeout) and
  never wedge the UI — same posture as today's startup mount. The file tree
  should surface a clear "disconnected" state rather than hang.
- **OpenVPN.** Unchanged: bring the tunnel up before opening the ControlMaster
  (`RemoteSpec.openvpn`); password prompted at activation, never stored.
- **Security.** SFTP path components are protocol fields, not shell tokens (the
  injection-safety property `sftp.rs` already documents). Git-over-ssh embeds the
  remote path in a remote `$SHELL -c` string, so it MUST go through the existing
  `shell_quote`/`validate_arg` defenses in `ssh_exec.rs`.

## Testing

- Per-phase `cargo test --manifest-path src-tauri/Cargo.toml` + `npx tsc --noEmit`.
- New unit tests: SFTP write/path-join helpers (pure parts, no live host);
  `run_git` local-vs-remote argv construction; `remote_target_for` resolution.
- Runtime QA is hand-checked against a real key-auth host (agents can't launch
  Eldrun). Adapt the existing Group G Phase 1–8 manual checklist, dropping all
  mount/`/proc/mounts` steps and adding: file tree lists over SFTP; create/edit/
  download a remote file; git status/commit/push runs on the host; single auth
  prompt across tab+browse+git.

## Proposed TODO tracking

New Group G sub-items under #28 (work-axis theme):

- **#28e — Mount-free remote: explicit remoteness + pooled SSH/SFTP** (Phase 0).
- **#28f — Mount-free remote agent tabs** (Phase 1).
- **#28g — Live remote file browsing over SFTP** (Phase 2).
- **#28h — Remote file I/O (create/edit/download/delete) over SFTP** (Phase 3).
- **#28i — Git over SSH for remote projects** (Phase 4).
- **#28j — Remove sshfs** (Phase 5).

## Out of scope (for now)

- Periodic/push-based remote fs change notification (manual refresh only at
  first).
- `git_publish` (gh/glab) remote-host variant.
- Read-cache/LRU for remote file bytes.
- Windows/macOS-specific remote tuning beyond what the shared SSH path gives.
