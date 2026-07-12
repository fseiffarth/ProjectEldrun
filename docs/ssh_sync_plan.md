# SSH Remote Projects — Local Sync & Tab Locality Plan

Implementation plan for the feature sketched in `docs/SSH_CHANGES.md`: every
remote (SSH) project automatically has a **local paired version inside Eldrun** —
a structural twin that starts empty and is populated by **explicit, user-chosen,
bidirectional sync** (remote→local and local→remote) — plus a **per-tab
local/remote locality** axis. Stays mount-free (no sshfs/FUSE). Builds on the
mount-free remote model (`docs/mountfree_remote_plan.md`).

This plan was produced by a two-architect design debate + an independent review
pass against the real code, then settled by the product owner's decisions
(recorded below).

## Product decisions (settled)

1. **Agents default LOCAL.** A new agent tab on a remote project runs locally,
   cwd = the local project root (the mirror root). Remote agents remain possible
   via the per-tab toggle. (This is the literal reading of `SSH_CHANGES.md`,
   chosen over the reviewers' "default remote" recommendation.)
2. **Sync is manual, selective, and bidirectional — the user chooses what syncs,
   in each direction.** The user marks files/folders to sync remote→local and/or
   local→remote in the file viewer; nothing syncs automatically and the whole tree
   is never pulled implicitly. An optional one-click "sync whole project" exists
   for when the full tree is wanted.
3. **Transport = hybrid: rsync fast-path over an SFTP floor.** Use `rsync` for
   bulk/folder/whole-project syncs when it is present on **both** ends (delta
   transfer, single connection, rides the existing ControlMaster); fall back to
   SFTP-native recursive everywhere it is missing (Windows by default, minimal
   hosts). Single-file syncs just use SFTP.
4. **Every remote project automatically has a local paired version in Eldrun** —
   a structural twin (the mirror), present by default but **empty until populated**.
   *No content is duplicated until the user explicitly syncs it*, so the act of
   selecting what to sync **is** the consent: no separate opt-in toggle, and no
   bytes land on the local disk unprompted. Deleting the project removes the
   mirror.
5. **Up-sync blocks on a stale base** (no silent clobber); **no `filetime` dep**
   (manifest stores the host base; on-host `sha256sum` only breaks size/mtime
   ties); **live sync stays out** of the default scope (optional later layer,
   push-on-open-buffers only).

### Known, accepted trade-off

Decisions 1 + 2 together mean a **local agent may operate on a partial tree** —
it can miss an unsynced import, config, or dependency, and the mirror is not a
valid git checkout. **This is accepted as-is** (product decision): the user
curates the synced set; no warning or gate is added when launching a local agent
on a partially-synced project. The optional one-click "sync whole project" action
remains available for when the full tree is wanted. Git operations stay routed to
the host (see below), never run against the mirror.

## Source-of-truth model

- **Every remote project has a local paired version** — the mirror — present by
  default but empty until the user syncs content into it. "No content duplicated"
  means the local twin exists structurally; bytes appear only on explicit sync.
- **The remote host is the source of truth for conflict resolution.** Sync is
  user-directed in both directions, but when both ends changed since the last
  sync, the host wins by default (up-sync blocks on a stale base — see below).
- **Mirror location:** `<state_dir>/remote-projects/<id>/mirror/`, a sibling of
  the existing per-project `project.json`. The state dir is minted by
  `remote_project_state_dir(id)` (`commands/projects.rs:20`); the `mirror/`
  subdir is net-new (created with the project, populated only by sync).
- **Manifest:** `<state_dir>/remote-projects/<id>/sync.json`, a map
  `relPath -> { selected, host_mtime, host_size, local_mtime, local_size,
  last_pull_ts, last_push_ts }`. All divergence is judged **host-vs-manifest**
  and **local-vs-manifest** — never host-mtime directly vs local-mtime (clock
  skew). The manifest is the single source of the green/amber UI state and the
  3-way (base/host/local) conflict base. It must be a single-writer structure
  (Tauri-managed `Mutex`, see Phase 1 / gap G7).
- **Git stays on the host** via the existing `ssh_exec` git path
  (`remote_git_command`); never run against the (possibly partial) mirror.

## UI state

- **green** — file is in the mirror and its manifest base still matches the host.
- **amber** — host moved since the last fetch. Only observable *after* an explicit
  re-stat/refresh (no watcher), so amber is a post-refresh state, not a live
  divergence indicator.
- **none** — not synced (default for everything until the user selects it).
- **spinner row** — a transfer is in flight (`sync-progress` event, mirroring the
  `fs-change` wiring in `commands/fs_watch.rs`).

The right panel's `files` view gains a **local/remote source toggle** (net-new
state *inside* the `files` view — NOT a new entry in the `View` union in
`RightPanel.tsx:44`, which is the left-rail selector). Remote source = today's
SFTP-on-demand listing; local source = `list_dir` against the mirror dir with the
overlay above. Both reuse `FileTree`.

## Tab locality

Add an optional field `location: "local" | "remote"` to **both** `TabEntry` and
`SavedTabEntry` in `src/stores/tabs.ts` (there is no `extra` map — it is an
explicit field, threaded through `loadFromLayout` and the save mapping). Defaults:

| Kind | Default `location` | Notes |
|------|--------------------|-------|
| agent | **local** | cwd = mirror root. Toggle to remote = today's `ssh -tt` path. |
| shell (terminal) | **remote** | remote for running remote scripts; local option = shell in the mirror dir. |
| local_agent (Ollama) | local (fixed) | unchanged; already forced local. |
| files / embed / projects3d | n/a | locality not meaningful. |

**Backend spawn is unchanged.** `commands/terminal.rs:71-75` already gates
`ssh_exec::wrap_pty_options` behind `!opts.local_only`, and a `local_only` spawn
runs locally in `opts.cwd`. So:

- `location: "remote"` → today's path (`project_id` set, not local_only → ssh-wrapped).
- `location: "local"` → `local_only: true` + `cwd` = mirror root.

The real wiring is **frontend**: the `localOnly` computation currently reads
`tab.kind === "local_agent"` (`CenterPanel.tsx:961`, `DetachedCenterPanel.tsx:939`)
— change to `isLocalAgentKind(kind) || location === "local"`, and resolve `cwd` to
the mirror dir for local-on-remote tabs.

## Sync mechanism (hybrid)

- **Single-file pull** (e.g. selecting one file): SFTP `read_file_on` over the
  pooled `Arc<Sftp>` (`services::remote::pooled_sftp`, `remote.rs:203`).
- **Bulk pull/push** (folder select, "sync now", "sync whole project"): **rsync
  when available on both ends**, else **SFTP-native recursive**.
  - rsync rides the existing pooled master:
    `rsync -e 'ssh -o ControlPath=<control_dir>/cm-%C -o ControlMaster=no …'`
    (the socket path is built in `services/ssh_common.rs:84,172`; `control_dir()`
    in `ssh_exec`). Use `rsync -c` (checksum) as the correctness/conflict basis
    where available. No rsync exists in the codebase today — net-new shell-out.
  - SFTP-native recursive walker is net-new, modeled on `remove_dir_on`
    (`sftp.rs:475`); `list_dir_on` (`sftp.rs:251`) lists a single dir only.
    `download_on` (`sftp.rs:517`, currently `#[allow(dead_code)]`) is the
    per-file primitive (prefer `read_file_on` + non-blocking write).
- **Capability probe:** extend `ssh_tooling_status` (`commands/ssh.rs` /
  `services/ssh_common.rs`) to report local rsync and probe `command -v rsync` on
  the host. If rsync is missing locally, offer the one-click install-via-new-tab
  flow; if missing on the host, **degrade to SFTP** (do not attempt to install on
  an arbitrary remote host).
- **Up-sync safety:** re-stat host; if host == manifest base, write to a temp path
  then `rename_on` (atomic, `sftp.rs:493`); if the base is **stale, block and ask**
  — never auto-clobber. The conflict prompt offers **keep local / take host / skip**
  and a **"view diff"** action that opens the local-vs-host diff in the existing
  in-app diff viewer (`src/components/embed/DiffView.tsx` + `src/lib/viewers/diff.ts`,
  wired through `FileViewerPane.tsx`), fetching the host copy over SFTP for the
  right-hand side. Reuse `RightPanel`'s `askConflict` (`:361`) choice mechanism
  (`replace | rename | skip`; `rename` = keep-both) extended with the diff action.
  Add a max-sync-size guard — `read_file_on`/`write_file_on` buffer whole files in
  RAM and hold the single SFTP channel (`sftp.rs:439,450`); large artifacts need a
  guard/warning.

## Reviewer-verified gaps to design in

- **G1 — Data-at-rest** → resolved by the model itself: the local pairing is
  always present but empty, and bytes reach the local disk only when the user
  explicitly syncs them, so selecting what to sync *is* the consent. No separate
  toggle. (Mirror is removed on project delete — G4.)
- **G2 — Local reads still route to SFTP.** With `project_id` set, the
  absolute-path file readers (`read_file_text:920`, `read_file_bytes:1056`,
  `write_file_text:968` in `commands/fs.rs`) dispatch remote whenever
  `remote_target_for(project_id)` is `Some`. The local source view / local tabs
  need a `source: "local"|"remote"` param (or path-prefix routing: a path under
  the mirror dir ⇒ local read). **Must be resolved in Phase 1** or "local" opens
  silently round-trip SFTP. (`list_dir` already works against a local mirror dir
  because it keys on `project_dir`.)
- **G3 — Symlink escape.** The recursive walker must be lstat-typed and **not
  follow host symlinks** (a `mirror-me -> /etc` symlink would exfiltrate host
  files into the mirror / let up-sync write through it). `confine_remote_abs`
  (`fs.rs:224`) only checks the path string, not symlink targets.
- **G4 — Mirror cleanup on delete.** Confirm project-delete recursively removes
  `<state_dir>/remote-projects/<id>/` (incl. `mirror/`); otherwise mirrored bytes
  leak (contradicts G1).
- **G7 — Manifest write races.** Push-on-save vs a concurrent "sync now" vs two
  tabs saving will clobber `sync.json`. Use a Tauri-managed
  `Mutex<HashMap<projectId, Manifest>>` (same shape as `RemotePoolState`).
- **G8 — Large/binary files.** Size guard; binary files must not go through the
  UTF-8 text path.
- **G9 — "Open auto-syncs" is mostly redundant with the in-app viewers**, which
  already fetch remote bytes over SFTP. Frame auto-cache-on-open as "make bytes
  available to local tabs/agents," not as a prerequisite for *viewing*. Given the
  manual-sync decision, auto-cache-on-open is optional, not the primary path.
- **G11 — P0 local terminal cwd.** Before the mirror exists, a local terminal on
  a remote project should cwd to `remote_project_state_dir(id)` (which exists).

## Phased plan

Each phase is independently shippable and gated by `npx tsc --noEmit` +
`cargo test --manifest-path src-tauri/Cargo.toml`. Live/UI QA is done by the
human (Eldrun is not launched from an agent).

### Phase 0 — Tab locality axis (frontend-only)
- `stores/tabs.ts`: `location?` on `TabEntry` + `SavedTabEntry`; thread through
  `loadFromLayout` + save mapping + `isRestorableTab`; defaults per the table.
- `CenterPanel.tsx` / `DetachedCenterPanel.tsx`: `localOnly` computation honors
  `location`; resolve `cwd` (mirror root, or state dir as the pre-mirror fallback).
- Per-tab local/remote switch + indicator (terminals first).
- Tests: extend tab-persist / resume round-trip tests for `location`.
- **QA:** remote project → spawn remote shell (on host) + local shell (local);
  Windows smoke.

### Phase 1 — Local pairing + selective pull (remote→local) + manifest + green/amber + source toggle
- Mirror dir is the always-present (empty) local twin; created with the project,
  populated only by sync. No consent toggle.
- New `services/remote_sync.rs`: lstat-typed recursive host walker (G3),
  `pull_file`, manifest type + 3-way base compare. Single-writer manifest state
  (G7).
- New `commands/sync.rs`: `sync_mark_selected`, `sync_pull`, `sync_status`,
  `sync_now` (reconcile selected), `sync_whole_project` (optional full pull);
  injected with `RemotePoolState`; registered in `lib.rs`. Emit `sync-progress`.
- Resolve G2: `source` param / path-prefix routing on the file readers so the
  local view reads the mirror.
- `FileTree.tsx`: green/amber/spinner overlay beside `GitMarker`; per-entry
  sync-selection affordance. `RightPanel.tsx`: local/remote source toggle within
  `files`. New `stores/sync.ts` (manifest cache + `sync-progress` subscription).
- Mirror cleanup on delete (G4).
- Tests: walker, symlink-skip, manifest compare.
- **QA:** select a folder → pulls + turns green; edit on host + refresh → amber;
  toggle local/remote source.

### Phase 2 — Selective push (local→remote), guarded
- `sync_push`: user-chosen local→remote sync of selected files — completes the
  **bidirectional** model. Re-stat host → atomic temp + `rename_on`; block on
  stale → conflict modal (keep local / take host / skip + **view diff** via the
  existing `DiffView`); `sha256sum`-over-ssh tie-break; size guard (G8).
- Optionally route remote-project saves from a local editor/tab through
  `sync_push` (still user-scoped — only files marked for local→remote).
- Tests: 3-way base logic incl. stale + tie-break.
- **QA:** edit locally + edit same file on host → block-on-stale modal, no clobber.

### Phase 3 — rsync fast-path for bulk sync
- Extend `ssh_tooling_status` to detect rsync both ends.
- `remote_sync.rs`: rsync transport (ride ControlMaster, `-c`) for bulk
  pull/push/whole-project; SFTP-native fallback retained as the floor.
- Tests: argv builder (ControlPath wiring, fallback selection) — pure, unit-testable.
- **QA:** large folder sync on a Linux host with rsync vs a host without (falls
  back to SFTP); Windows (SFTP floor).

### Phase 4 (optional, cost-gated) — Live push on open buffers
- `notify` (already a dep) watching only mirror files with open editors; debounce
  → `sync_push`. Live **pull** stays out (no cheap SFTP change-notify).

## Implementation status

Phases 0–3 are implemented and gated (`npx tsc --noEmit`, `npx vitest run`,
`cargo test`); live/UI QA is the human's.

- **Phase 0 (done).** `location?: "local" | "remote"` on `TabEntry`/`SavedTabEntry`
  (round-trips via the Rust `TabEntry`'s flattened `extra`, so no schema change);
  `effectiveTabLocation`/`defaultLocationForKind`/`isLocatableKind`/`localTabCwd`
  helpers; `setTabLocation` store action; `CenterPanel`/`DetachedCenterPanel`
  `localOnly` honors locality; the backend (`pty_spawn`) authoritatively resolves
  a local-on-remote tab's cwd to the mirror (and mkdirs it); per-tab badge +
  toggle in `TabBar`. Tests: `TabLocality.test.ts`.
- **Phase 1 (done).** `services/remote_sync.rs` (manifest type + IO, lstat host
  walker G3, `pull_file`, 3-way `compute_state`, single-writer `SyncManifestState`
  G7); `commands/sync.rs` (`sync_pull`/`sync_whole_project`/`sync_now`/
  `sync_mark_selected`/`sync_status`, `sync-progress` events); G2 mirror-path
  routing on the `fs.rs` readers/writers; mirror minted at create + on connect;
  `FileTree` green/amber overlay + select-to-sync; `RightPanel` local/remote
  source toggle; `stores/sync.ts`. `sftp::list_dir_raw_on` is the symlink-safe
  lister. Tests: `remote_sync` unit tests, `SyncStore.test.ts`.
- **Phase 2 (done).** `sync_push` + `push_decision` (block-on-stale; atomic
  temp+`rename_on`); `FileTree` "Push to host" / "Push all to host" + the
  keep-local / take-host / skip conflict modal; `stores/sync.ts` `push`.
- **Phase 3 (done).** `ssh_tooling_status.rsync` (local probe);
  `rsync_available_host` (over-ssh probe); pure `rsync_pull_args` /
  `rsync_ssh_transport` / `should_use_rsync` (ControlMaster-riding `-e`, `-c`);
  rsync fast-path for **directory pulls** with the SFTP walker as the floor.

### Deferred (safe to add later)

- **rsync for PUSH** stays on the guarded SFTP floor on purpose: a bulk rsync push
  would bypass the per-file block-on-stale guard (product decision 5 — never
  clobber). Pulls use rsync (overwriting the user-chosen mirror is intended).
- **`sha256sum` tie-break** for the host-touched-but-unchanged case: the push
  staleness check is conservative (size+mtime base; never clobbers, only
  over-reports a bare `touch` as a conflict the user clears with "keep local"). A
  real content tie-break needs a base hash captured at pull time — not added.
- **"View diff"** in the conflict modal (local mirror vs host over SFTP) — needs a
  new non-git diff source; the keep-local/take-host/skip resolutions ship now.
- **Phase 4** (live push on open buffers) — optional/cost-gated, not started.

## Critical files

- `src-tauri/src/services/sftp.rs` — SFTP primitives (`read_file_on`,
  `write_file_on`, `metadata_on`, `rename_on`, `list_dir_on`, `remove_dir_on`,
  `download_on`).
- `src-tauri/src/services/remote.rs` — `pooled_sftp`, the connection pool.
- `src-tauri/src/services/remote_sync.rs` — **new**: walker, manifest, transport.
- `src-tauri/src/commands/sync.rs` — **new**: sync commands.
- `src-tauri/src/commands/fs.rs` — local-vs-remote read routing (G2), save hook.
- `src-tauri/src/commands/terminal.rs` — `local_only` spawn gate (unchanged).
- `src-tauri/src/commands/projects.rs` — `remote_project_state_dir`, mirror mint
  + delete cleanup, consent flag.
- `src-tauri/src/commands/ssh.rs` + `services/ssh_common.rs` — `ssh_tooling_status`
  rsync probe; ControlMaster socket path.
- `src-tauri/src/lib.rs` — managed state + command registration.
- `src/stores/tabs.ts` — `location` field + persistence.
- `src/stores/sync.ts` — **new**: manifest cache + progress.
- `src/components/files/FileTree.tsx` — overlay + selection.
- `src/components/layout/RightPanel.tsx` — local/remote source toggle.
- `src/components/layout/CenterPanel.tsx` + `DetachedCenterPanel.tsx` —
  `localOnly`/`cwd` computation.
