# SSH / Remote Projects — Implementation Plan (TODO Group M, #28)

Status: **implemented** (code complete; runtime QA pending — agents cannot
launch Eldrun). Built by a 4-agent sequential team.

## Implemented

Final files / commands as shipped:

- `src-tauri/src/schema/project.rs` — `RemoteSpec` struct + `Project.remote`.
- `src-tauri/src/commands/ssh.rs` — `ssh_connect`, `ssh_default_dir`,
  `ssh_list_dir`, `ensure_project_mounted` (+ `RemoteEntry`, `parse_ls_output`).
- `src-tauri/src/services/ssh_mount.rs` — `mountpoint_for`, `is_mounted`,
  `mount`, `unmount`, `unmount_all`, `sshfs_available`, and the shared
  `validate_arg` / `ssh_base_args` / `sshfs_args` helpers.
- `src-tauri/src/commands/projects.rs` — `CreateProjectRequest` /
  `ImportProjectRequest` gain optional `remote`; remote projects mount under a
  generated id, scaffold over the mount, and persist `remote` in `project.json`
  and the `projects.json` entry `extra`. (Remote import is `keep`-only.)
- `src-tauri/src/services/project_runtime.rs` — `switch` best-effort mounts the
  next project if it is remote (non-panicking).
- `src-tauri/src/lib.rs` — registers the four SSH commands; switches to
  `.build(...).run(closure)` so `RunEvent::Exit` calls `unmount_all()`.
- `src/types/index.ts` — `RemoteSpec` / `RemoteEntry` types, `ProjectEntry.remote`.
- `src/components/layout/BottomBar.tsx` — SSH-address field + Connect + in-app
  remote folder browser; builds the `remote` spec for create/import.
- `src/stores/projects.ts` — `load()` best-effort calls `ensure_project_mounted`
  for the initially-active remote project (startup mount; non-blocking).
- `src/styles/themes.css` — remote-browser dialog styling.

Deviations from the plan: none structural. The validation/argv helpers live in
`services/ssh_mount.rs` and are re-used by `commands/ssh.rs` (single source of
truth). Startup mount is frontend-driven (the lowest-risk option) rather than a
backend setup-time mount, so an offline host at boot never blocks app start.

Follow-ups / out of scope:

- **Project-removal unmount** — no project-delete command exists today; when one
  is added it should call `ssh_mount::unmount(&mountpoint_for(id))`. Until then,
  stale mounts are torn down on the next app exit (`unmount_all`). See the NOTE
  in `services/ssh_mount.rs`.
- **Password / interactive auth** — out of scope for v1 (`BatchMode=yes`).
- **Runtime QA** — connect → browse → create/import → terminal/file-tree must be
  validated live by the user.

---


## Goal (from user)

When adding **or** importing a project, expose an **optional SSH address field**.
The flow is:

1. User enters an SSH address (`user@host`, optional `:port`).
2. App **connects** over SSH to verify reachability.
3. On success, the user can **browse the remote filesystem** to the desired
   location (same UX as the local folder picker, but remote).
4. The picked remote directory becomes the project. From then on the project
   behaves **exactly like a local project** — file tree, terminal cwd, git —
   except its bytes live on the remote host.

## Decided architecture

- **Remote access = sshfs mount.** On project activation we `sshfs`-mount the
  chosen remote dir to a local mountpoint; the project's `directory` field
  points at that mountpoint. All existing local code (`list_dir`, PTY `cwd`,
  `git_*`) keeps working **unchanged** against the mountpoint. Requires `sshfs`
  + FUSE on the local machine.
- **Remote browse = in-app browser.** A new `ssh_list_dir` command runs `ls`
  over SSH; the dialog renders a clickable remote folder browser.
- **Auth = user's existing SSH setup.** We shell out to the system `ssh`/`sshfs`
  with `BatchMode=yes` (no interactive password prompts in-app). Keys / agent /
  `~/.ssh/config` are the source of truth. A failed connect surfaces ssh's
  stderr to the user. (Password/interactive auth is explicitly out of scope for
  v1.)
- **Team model = sequential phased.** Four agents run one after another on a
  clean working tree; no parallel edits to the shared files
  (`commands/projects.rs`, `BottomBar.tsx`, schema).

## Data model

Add optional remote metadata. A project is "remote" iff `remote` is present.

`schema/project.rs` — new struct + field on `Project`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSpec {
    /// SSH user, e.g. "alice"
    pub user: Option<String>,
    /// SSH host, e.g. "build.example.com"
    pub host: String,
    /// SSH port; None = default 22
    pub port: Option<u16>,
    /// Absolute path on the remote host that is the project root
    pub remote_path: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
```

`Project` gains `#[serde(skip_serializing_if = "Option::is_none")] pub remote: Option<RemoteSpec>`.

`schema/projects.rs` `ProjectEntry` carries `remote` inside the existing
`extra` map (mirrors how `directory`/`git_type` are stored), so the pill list
and `resolveProjectDirectory` need no structural change.

`directory` for a remote project = the **local mountpoint**
`~/.local/share/eldrun/mounts/<project-id>`. `resolveProjectDirectory` already
returns `directory`, so the frontend is unchanged for the mounted case.

`types/index.ts` — mirror `RemoteSpec` and add `remote?` to `ProjectEntry`.

## Mountpoint + lifecycle

- Mount root: `~/.local/share/eldrun/mounts/<project-id>/`.
- Mount command:
  `sshfs [user@]host:remote_path mountpoint -p <port> -o BatchMode=yes,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`
- A remote project's mount is established **on activation** (first switch to it,
  and at startup if it is the active project) and torn down (`fusermount -u` /
  `umount`) on app exit and on project removal. Idempotent: re-mount is a no-op
  if already mounted (check `/proc/mounts` / `mountpoint -q`).
- Guard: if `sshfs` is not installed, fail with a clear, actionable error
  ("sshfs not found — install sshfs/FUSE to use remote projects").

## Command surface (new)

- `ssh_connect(user, host, port) -> Result<(), String>` — runs
  `ssh -o BatchMode=yes -o ConnectTimeout=10 [-p port] [user@]host true`,
  maps failure to ssh stderr.
- `ssh_list_dir(user, host, port, path) -> Result<Vec<RemoteEntry>, String>` —
  runs a safe listing over ssh (`ls -1Ap` style, or `find -maxdepth 1`), parses
  into `{ name, is_dir }`. Empty `path` ⇒ remote home (`pwd`).
- `ssh_default_dir(user, host, port) -> Result<String, String>` — remote `$HOME`
  for the browser's start location.
- `ensure_project_mounted(project_id) -> Result<String, String>` — mount if
  needed, return the mountpoint (called before terminal spawn / file-tree use
  for remote projects).
- Extend `CreateProjectRequest` / `ImportProjectRequest` with optional `remote`.

All new commands registered in `lib.rs`.

## Frontend (dialog)

`BottomBar.tsx` project dialog (`kind: "new" | "import"`):

- New optional **"SSH address"** input + **Connect** button (both new/import).
- States: `idle → connecting → connected | error`.
- While `connected`, replace/augment the local folder picker with a **remote
  browser**: breadcrumb + clickable folder list driven by `ssh_list_dir`,
  starting at `ssh_default_dir`. A "Use this folder" action sets the chosen
  remote path.
- New project + remote: browse to a parent, enter a name → backend `mkdir`s the
  remote subdir (over the mount) and scaffolds there.
- Import + remote: pick an existing remote dir (mode is implicitly "keep"; copy/
  move are disabled for remote in v1).
- Submit passes `remote: { user, host, port, remotePath }` to
  `create_project` / `import_project`.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml` — parsing of `ssh_list_dir`
  output, mountpoint derivation, schema round-trip (remote present/absent),
  request deserialization.
- `npx tsc --noEmit` — frontend.
- Runtime: **do not** launch Eldrun from an agent. Ask the user to restart their
  instance and test connect → browse → create/import → terminal/file tree.

## 4-Agent sequential breakdown

Each agent runs on a clean tree built from the prior agent's committed work, type-checks/tests its slice, and hands off.

**Agent 1 — Backend foundation (schema + SSH commands).**
- `schema/project.rs`: `RemoteSpec` + `Project.remote`.
- New `commands/ssh.rs`: `ssh_connect`, `ssh_list_dir`, `ssh_default_dir`
  (+ `RemoteEntry`). Shell out to system `ssh`, `BatchMode`, robust parsing,
  host/path validation (reject shell-meta in args; pass via argv, never a shell
  string).
- Register commands in `lib.rs` + `commands/mod.rs`.
- Unit tests for listing parse + arg construction. `cargo test` green.

**Agent 2 — Mount lifecycle + create/import backend.**
- `services/ssh_mount.rs` (new): mountpoint derivation, `is_mounted`,
  `mount`, `unmount`, sshfs-availability check.
- Wire mount/unmount into `services/project_runtime.rs` switch + app-exit; add
  `ensure_project_mounted` command.
- Extend `CreateProjectRequest`/`ImportProjectRequest` with `remote`; for remote
  projects: establish mount, set `directory = mountpoint`, scaffold over the
  mount (respecting the no-scaffold path), persist `remote` in `project.json`
  and the `projects.json` entry's `extra`.
- Tests: mountpoint derivation, request round-trip. `cargo test` green.

**Agent 3 — Frontend dialog + remote browser.**
- `types/index.ts`: `RemoteSpec`/`RemoteEntry`, `ProjectEntry.remote`.
- `BottomBar.tsx`: SSH field, Connect, remote browser component, wire to the
  final create/import request shape; disable copy/move for remote.
- `npx tsc --noEmit` green; keep styling consistent with the existing dialog.

**Agent 4 — Integration, hardening, docs.**
- End-to-end review of the three slices; error states (sshfs missing, connect
  fail, mount fail, stale mount on restart); unmount-on-exit correctness.
- Full `cargo test` + `tsc`.
- Docs: mark TODO Group M / #28 in progress with what shipped; update CLAUDE.md
  Persistence section (mounts dir, remote project fields); note the sshfs/FUSE
  dependency in README if appropriate.
</content>
</invoke>
