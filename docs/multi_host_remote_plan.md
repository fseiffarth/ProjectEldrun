# Multi-Host Remote Projects — Plan (experiment-worker model)

**Goal.** Let one remote project reach **N** remote machines, not just one, so the
**same code** can be run as experiments across several hosts (e.g. different GPU
boxes). A tab's `local / remote` toggle becomes a **list**:
`local | primary | gpu-2 | gpu-3 …`.

**Model (decided).**
- **One primary host, N extra "worker" hosts.** The primary stays exactly as
  today: it owns files, git, the local mirror, and full bidirectional sync. Extra
  hosts are **experiment workers**.
- **Extra hosts stay in sync with the canonical code — one-way.** Code (git-tracked
  files) is pushed *source → each extra*; it is never pulled back. So all machines
  run the same commit.
- **Files on extra hosts are read-only.** You never *edit* on a worker; the UI
  offers no write there, and a re-sync overwrites any drift. This is precisely what
  lets the sync be one-way: with no edits on the workers, there is **no merge
  conflict, no divergence, and no destructive local-loss** — the entire scary half
  of the existing lockstep machinery is dodged.
- **Experiments still write their outputs.** "Read-only" means *code* is read-only,
  **not** the filesystem. A run writes checkpoints / logs / metrics freely; the sync
  never touches untracked/gitignored paths (it does `fetch + reset --hard` but
  **never** `git clean`), so outputs survive every sync.
- **Outputs stay on each worker, pulled on demand** (recommended default; §4.4).
  Auto-pulling multi-GB checkpoints from N machines is the byte-sync-scope footgun
  CLAUDE.md already warns about, so it is opt-in per machine.
- **Per-host lamps, on-demand connect.** Each host has its own connection lamp in
  the pill. Auto-connect is an opt-in per host.

**Two load-bearing insights.**
1. **The bidirectional subsystem is untouched.** Everything that owns the primary's
   files/git/sync — `services/git_peer.rs` (~200 KB), `remote_sync.rs`,
   `sync_auto.rs`, all of `commands/fs.rs` + `commands/git.rs` + `commands/sync.rs`
   — resolves *the* host through `remote_target_for(project_id)` /
   `remote_target_for_dir(project_dir)`, both reading the single `extra["remote"]`.
   Store extra hosts under a **separate** key (`extra["compute_hosts"]`) and that
   whole subsystem keeps meaning "the primary" with zero change.
2. **Worker sync is push-only, so it inherits none of the hard parts.** The
   existing lockstep is bidirectional (pull, divergence, conflict, local-loss
   auditing). The worker fan-out reuses only the *outbound* primitives —
   bundle-create + apply — and never the inbound half. It is a new, deliberately
   thin push-only path, not a second full lockstep.

---

## 1. Data model

### 1.1 Backend — `schema/project.rs`

An extra host is a `RemoteSpec` + a stable id + a display label. Reusing
`RemoteSpec` verbatim means every existing execution helper (`ssh_exec`, `sftp`,
`remote_usage`, monitor/disk/gpu/python) works unchanged — they already take
`&RemoteSpec`.

```rust
/// An additional SSH machine a project runs experiments on. Its code is kept in
/// one-way sync from the canonical source (the local mirror); its files are
/// read-only (edits forbidden). It never owns git/sync/mirror state of its own —
/// the primary `remote` does. `id` is stable (referenced by tab locations + the
/// pool key + the fan-out state); `label` is the pill/tab display name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeHost {
    pub id: String,                 // stable, e.g. "h1"; primary is implicit "primary"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,      // "gpu-2"; falls back to host
    /// Keep this worker's tracked tree synced to the source HEAD (default true).
    #[serde(default = "default_true")]
    pub sync_code: bool,
    /// Pull this worker's experiment OUTPUTS back on demand only, never
    /// automatically (default false — outputs stay on the worker).
    #[serde(default)]
    pub pull_outputs: bool,
    #[serde(flatten)]
    pub spec: RemoteSpec,           // user/host/port/remote_path/openvpn/auto_connect/key_auth
}
```

Add to `Project`:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub compute_hosts: Vec<ComputeHost>,
```

**Migration: none.** Existing projects have no `compute_hosts`; `#[serde(default)]`
yields `[]`. The primary is still `Project.remote`, unchanged.

### 1.2 Mirroring into `projects.json` — `commands/projects.rs`

`project_extra(...)` (~`:2352`) mirrors `remote` + `mirror` into the always-local
`projects.json` entry so resolvers stay synchronous. Add a mirror of
`compute_hosts` under `extra["compute_hosts"]` (array). That is the only place
workers need to reach the local `projects.json`; every resolver below reads it.

New host CRUD commands (mirror the existing `patch_remote_spec` at `:851`):
- `add_compute_host(project_id, ComputeHost)` — append + write `project.json`
  **and** `extra["compute_hosts"]`, minting `id` if absent.
- `remove_compute_host(project_id, host_id)` — disconnect it, stop its fan-out,
  then drop it.
- `patch_compute_host(project_id, host_id, patch)` — for `auto_connect` /
  `key_auth` / `openvpn` / `sync_code` / `pull_outputs`.

### 1.3 Frontend — `types/index.ts`

```ts
export interface ComputeHost extends RemoteSpec { id: string; label?: string; sync_code?: boolean; pull_outputs?: boolean; }
export interface ProjectEntry { /* … */ remote?: RemoteSpec; compute_hosts?: ComputeHost[]; }
```

---

## 2. Worker code sync — one-way, code-only (the heart of this change)

**Canonical source = the local mirror.** It is already lockstep-paired with the
primary (`git_peer`), so the local mirror always holds the project's current
committed code. The workers are fed **from the mirror**, one-way. (Feeding from the
mirror, not primary→worker directly, means Eldrun — which already holds SSH to both
legs — is the courier; it assumes no primary↔worker network path or shared keys.)

**Direction & grain.**
- Source → worker only. A worker's tree is **never** read back into the mirror
  (that is what makes it conflict-free).
- Tracked files only. The push makes the worker's tracked tree equal the source
  HEAD; untracked/gitignored paths (experiment outputs, datasets staged on the
  worker) are left alone.

**Mechanism (reuses `git_peer` outbound primitives; a new push-only mode).**
Per worker, first sync bootstraps a bare-ish working clone at `worker:remote_path`
(git init + fetch, or clone from a bundle Eldrun ships over SFTP — same
`remote_bundle_path` + apply primitives lockstep uses local↔primary). Each
subsequent sync:
1. On the mirror, `git bundle` the current HEAD (or an incremental bundle since the
   worker's last-known head).
2. Ship the bundle to `worker:remote_path/.git/eldrun-worker.bundle` over SFTP.
3. On the worker: `git fetch` the bundle, then `git checkout -f <HEAD>` /
   `reset --hard <HEAD>` — **tracked files only**.
4. **Never `git clean`.** Untracked outputs survive by construction. (Contrast: the
   primary's lockstep *does* clean in some refused-FF cases and audits the loss;
   the worker path deliberately never does, because a worker holds irreplaceable
   run outputs, not a recoverable mirror.)

**Per-worker state.** A tiny `worker_sync.json` under the worker's slot in the
project state dir records its `last_head` (the commit last pushed) so an
incremental bundle is cheap. No manifest, no byte-walk — code is git, and git
already knows what changed.

**Triggers.**
- On worker **connect** (bring it up to the current HEAD).
- On a new **commit** to the mirror/primary (the same signal `git_peer` already
  watches via the `.git` watcher) → fan out to every connected, `sync_code`
  worker.
- Manual **"Push code to machines"** action in the pill.

Because the primary already commits-then-syncs (lockstep is commit-gated), a worker
receives an edit at the same moment the primary does: **on commit**, not on save.
This is the identical mental model the primary already has (CLAUDE.md,
`git_lockstep_case_matrix.md` #5/#7) — extended to N workers.

**Reusing infrastructure vs. new code.** New: a `WorkerSyncRegistry` (per
`(project, host)`), the push-only fan-out loop, `worker_sync.json`,
`fetch + reset` (no clean) on the worker. Reused unchanged: bundle create/ship
primitives in `git_peer`, the `.git` commit watcher, `run_git_remote` /
`run_remote_script` over the worker's ControlMaster.

---

## 3. Connection layer

### 3.1 Already N-host-safe (no change)

- **ControlMaster sockets** are `cm-%C`, hashed per user/host/port
  (`ssh_exec.rs:63-70`, `ssh_common.rs:88`). Two hosts → two sockets, free.
- **Keychain credentials** keyed by host target `ssh:user@host:port`
  (`remote_credentials.rs:28`) — each worker saves its own password, no collision.
- **VPN** machine-wide, config-keyed, holder-refcounted (`vpnStatus.ts`,
  `openvpn.rs`). A worker on a different tunnel just adds a holder/config.

### 3.2 Pool — `services/remote.rs`

Re-key `RemotePool.conns` from `HashMap<project_id, _>` to a composite key:

```rust
fn conn_key(project_id: &str, host_id: &str) -> String { format!("{project_id}\u{1}{host_id}") }
```

- `connect(pool, project_id, host_id, password)` — resolve the spec: `"primary"` →
  `remote_target_for` (unchanged), else the `compute_hosts` entry. **Only the
  primary touches the mirror** (`mirror_dir` at `:166` stays behind the primary
  branch).
- `disconnect` / `is_connected` / `pooled_sftp` thread `host_id`. File/git/sync
  callers pass the constant `"primary"` (they *are* the primary subsystem).
- `connected_ids` → `connected_targets -> Vec<(project_id, host_id)>`.

### 3.3 Connect / disconnect commands — `commands/remote.rs`

- `remote_connect(…, project_id, host_id: Option<String>, password)` (default
  `"primary"`). Primary connect keeps wiring `git_peer` + `sync_auto` (`:73-90`).
  A **worker** connect instead kicks the **worker code-sync** fan-out (§2) and
  skips byte-sync/lockstep.
- `remote_disconnect(…, project_id, host_id)` — primary stops git_peer + sync_auto;
  a worker stops only its fan-out + pool entry.

### 3.4 Traffic accounting — `services/net_usage.rs` (phase 3, optional)

Sum all of a project's hosts under the project bucket initially (keeps the existing
per-project shape); per-`(project,host)` buckets can come later.

---

## 4. Frontend

### 4.1 Tab location — `stores/tabs.ts`

```ts
export type TabLocation = "local" | "remote" | `host:${string}`;  // local | primary | worker id
```

- `remoteHostIdOf(loc)` → `"primary"` for `"remote"`, the id for `"host:<id>"`,
  `null` for `"local"`.
- `defaultLocationForKind` (`:3596`) unchanged; `localTabCwd` (`:3627`) unchanged
  (only `"local"` uses the mirror; a worker locality returns `fallback`).
- `SavedTabEntry.location` (`:368`) is already a string → new values round-trip. A
  location naming a deleted host falls back to `"remote"` on load.

### 4.2 PTY spawn — backend

- `PtyOptions` (`terminal/mod.rs:36`): add
  `#[serde(default)] pub remote_host_id: Option<String>`.
- `wrap_pty_options` (`ssh_exec.rs:472`): resolve the spec by host id — primary via
  `remote_target_for` (unchanged), else the worker spec; `remote_dir =
  spec.remote_path`; `ssh_pty_args(&spec, cmd)` as today.
- `commands/terminal.rs:141` passes `opts.remote_host_id`; `TerminalView.tsx:29`
  passes it from `remoteHostIdOf(tab location)`.

### 4.3 Connection state + pill — `stores/remoteStatus.ts`, `RemoteConnMenu.tsx`

- `byProject: Record<projectId, Record<hostId, { ssh; vpn }>>`; `setSsh/​setVpn`
  gain `hostId`; add `sshOf(projectId, "primary")` so untouched readers change in
  one line. `clear(projectId)` wipes all hosts; add `clearHost`.
- Pill shows **one lamp per host** (primary + each worker). Clicking a lamp opens
  the connect flow for that host. `connectDialog` opens with `{ projectId, hostId }`
  (default `"primary"`); `RemoteConnectDialog` / `useRemoteReconnect` parametrize by
  `hostId` (their `liveTerms`, `pendingRemotePassword`, lamp reads become
  `(projectId, hostId)`-keyed).

### 4.4 Managing workers + outputs — pill

A "Remote machines…" section lists hosts with **Add machine** (reuses
`RemoteProjectSection` / `useRemoteSession` to collect user/host/port/remote_path +
optional VPN → `add_compute_host`) and per-worker controls:
- **Sync code now** (manual fan-out trigger) and a "last synced: <commit>" line.
- **Pull outputs…** — a one-shot, on-demand pull of the worker's *untracked* output
  paths into a local `outputs/<host-label>/` folder (never automatic). This is the
  one place worker→local bytes ever move, and it is user-initiated. The
  `sync_auto_preview`-style size-confirm applies (a checkpoint dir can be huge).
- Toggles: `sync_code` (default on), `pull_outputs`-on-demand-only (default), and
  auto-connect.

### 4.5 Tab UI

- **TabBar badge** (`TabBar.tsx:1156`): the 2-state `local↔remote` toggle becomes a
  small menu (`Local`, `Primary (host)`, each worker label) → `setTabLocation`.
- **Hold gate** (`CenterPanel.tsx:976`): read the lamp of *the tab's* host
  (`remoteHostIdOf`), not the single project lamp — a pane on gpu-2 holds iff gpu-2
  is down, independent of the primary. `remoteHost` label = that host's label.
- **TabHoverCard** / **RemotePaneHold** show the target host's label.

### 4.6 Read-only enforcement on workers

Workers never expose an editing surface:
- No worker file tree/git/source-switch (the file UI stays `Local | Remote(primary)`
  — §6). If a *read-only* worker file browser is ever wanted, it is a later,
  separate SFTP-read view; not in scope here.
- Any code drift on a worker is silently overwritten by the next `reset --hard`
  (§2) — which is safe *because* editing is forbidden, so drift can only be
  accidental, and outputs (untracked) are never in `reset`'s path.

---

## 5. Monitoring per worker

`system_monitor_snapshot` (`monitor.rs:25`), `disk_usage_scan` (`disk_usage.rs:66`),
the remote GPU snapshot (`sysstat::REMOTE_SNAPSHOT_SCRIPT`), and the python probe
(`python.rs:389`) each already resolve *a* spec from `project_id`; add an optional
`host_id` that selects the worker (primary when absent). The monitor / disk panes
gain a host selector; a run tab on gpu-2 probes gpu-2's interpreter.

---

## 6. Explicitly NOT changing

- `remote_target_for` / `remote_target_for_dir` / `RemoteTarget` stay
  **primary-only**. All file/git/sync keeps calling them.
- `git_peer.rs` (bidirectional lockstep), `remote_sync.rs`, `sync_auto.rs`,
  `local_loss.rs`, the mirror, `commands/fs.rs` / `git.rs` / `sync.rs` — the
  primary path is **untouched**. The worker fan-out (§2) is *new, additive,
  push-only* code that reuses their bundle primitives.
- File tree / file-source switch / `fileSourcePref` stay `Local | Remote(primary)`.

---

## 7. Phasing & tests

**Phase 1 — connect to N workers + run tabs on them.**
Schema `ComputeHost` + `compute_hosts` + `projects.json` mirror + CRUD (§1); pool
composite key (§3.2); `TabLocation` `host:<id>` + `PtyOptions.remote_host_id` +
`wrap_pty_options` resolve + TerminalView (§4.1-4.2); `remoteStatus` re-key +
per-host lamps + connect-dialog `hostId` + TabBar badge menu (§4.3-4.5).
Rust tests: two hosts one project — independent connect/disconnect/`is_connected`;
`conn_key` uniqueness; `wrap_pty_options` builds `ssh` args to a worker; primary
path unchanged (extend `remote.rs` tests at `:315`).

**Phase 2 — worker code sync (§2).**
Push-only fan-out (bundle → ship → `fetch`+`reset --hard`, no clean),
`worker_sync.json`, commit-watch + connect + manual triggers, "last synced" UI.
Rust tests (drive like `examples/lockstep_drv.rs`): a commit on the mirror reaches
the worker's tracked tree; an untracked output file on the worker **survives** a
sync; a worker-side code edit is overwritten; sync is never triggered
worker→mirror.

**Phase 3 — outputs + monitoring + polish.**
On-demand **Pull outputs** with size-confirm (§4.4); per-worker monitoring (§5);
per-worker auto-connect; per-host net_usage; stale-host-id fallback.

**Live QA (hand to user — I can't launch Eldrun):** add gpu-2; connect it while the
primary stays down; open a shell + a Claude tab on gpu-2, confirm `hostname`;
commit on the primary and confirm the change appears on gpu-2's tracked tree;
create an output file on gpu-2, sync again, confirm it survives; try to edit a
tracked file on gpu-2 and confirm the next sync reverts it; confirm the primary's
file tree / git / sync are visibly unaffected; disconnect gpu-2 and confirm only
its panes hold.

## 8. Risks / edge cases

- **"Read-only" ≠ read-only filesystem.** The single most important invariant:
  the worker sync must **never `git clean`** and never touch untracked paths, or it
  eats experiment output. Enforced in §2 step 4 and tested in Phase 2.
- **Output pull-back is the only worker→local byte path** and is user-initiated +
  size-confirmed (§4.4) — never a background pass.
- **Uncommitted local edits don't reach workers.** Same commit-gated model as the
  primary (a worker gets code on commit, not on save). Document, as CLAUDE.md does
  for the primary.
- **Tab location naming a deleted worker** → fall back to primary (§4.1).
- **VPN**: a worker sharing the primary's config is free (refcount); a worker
  needing a *different* `redirect-gateway` config is a machine-wide routing
  conflict the existing `VpnIndicator` already surfaces — note it in the add-host
  UI, no new mechanism.
- **Agent resume on a worker** works (spec-agnostic `ssh -tt` + `ELDRUN_TAB_UID`),
  but moving a tab worker→primary respawns it on the primary as a fresh
  conversation — the same caveat the current local↔remote switch has. Document.
- **First-worker connectivity assumption**: Eldrun couriers code mirror→worker, so
  it needs SSH to the worker (it already does, to run tabs) but **no** primary↔worker
  path — deliberately, since workers are often on isolated cluster networks.

---

## 8b. Shared-filesystem workers (added 2026-07-19, now the default)

Many clusters give the login node (primary) and every compute node a **shared
filesystem** — the same project folder is visible on all of them at one path. Copying
the code to each worker and one-way syncing it is then pure waste: the worker already
*is* looking at the primary's tree. So a worker gains a `shared_fs` flag
(`schema::project::ComputeHost.shared_fs`), and **a newly added machine defaults to it**
(the schema default stays `false` for back-compat — existing synced workers are
untouched on load — but the "Add machine" form ticks it on; "Sync a copy" is the opt-out
into the §2 synced-copy worker, for hosts that don't share storage).

- **What it does.** Nothing is copied and **git never runs on the host**. A tab on a
  shared-fs worker just `cd`s into `spec.remote_path` (the project folder as visible on
  that machine) and runs there — the process executes *on the worker*, reading/writing the
  shared tree. `wrap_pty_options` already resolves the spec by host id and uses
  `spec.remote_path`, so tab spawn needed **no** change.
- **The load-bearing safety invariant.** The §2 push (`git init` + `fetch` +
  `reset --hard`) must **never** fire on a shared-fs host — that path IS the primary's
  real working tree, and a `reset --hard` there would clobber the primary's state. Three
  guards enforce it: (1) `remote_connect` skips `on_worker_connect` for a shared host;
  (2) `fan_out` filters through the pure `wants_code_fanout(host) = !shared_fs && sync_code`
  (unit-tested); (3) `sync_worker` itself early-returns a no-op skip for a shared host, so
  even a stray manual `worker_sync_now` is harmless.
- **No Sync / Pull outputs.** A shared-fs worker's outputs land in the primary's own
  folder (moved by the primary's ordinary sync), so "Sync code now" / "Pull outputs" /
  "Auto-sync code" are hidden for it in `RemoteMachinesWindow`; the row carries a "Shared
  filesystem" badge instead of a "last synced" line.

## 9. Implementation status (2026-07-19)

**Phases 1 & 2 fully implemented; Phase 3 implemented except per-worker monitoring.**
All `cargo test` (853) + `vitest` (1703) green; live QA (§7) still owed (I can't launch
Eldrun).

**Backend.** `schema::project::ComputeHost` + `Project.compute_hosts` (§1.1);
`projects.rs` mirror into `extra["compute_hosts"]` + CRUD `add_/remove_/patch_compute_host`
(§1.2). `services::remote` re-keyed to a composite `conn_key(project, host)` with
`PRIMARY_HOST` wrappers keeping every file/git/sync caller unchanged; `connect_host`/
`disconnect_host`/`disconnect_project`/`is_connected_host`/`pooled_sftp_host`/
`connected_targets`/`remote_target_for_host`/`compute_hosts_for` (§3.2). `commands::remote`
threads `host_id` (default primary) through `remote_connect`/`remote_disconnect`, adds
`remote_disconnect_all_hosts`, `remote_connected_targets`, `worker_sync_now`,
`worker_outputs_preview`, `worker_pull_outputs` (§3.3). `PtyOptions.remote_host_id` +
`wrap_pty_options` resolve-by-host (§4.2). `services::worker_sync` = the whole §2 push-only
fan-out + §4.4 output pull; wired into `git_peer::start`/`poll_loop` so a mirror commit
fans out to connected workers.

**Frontend.** `TabLocation` gains `` `host:${string}` `` + `remoteHostIdOf` (§4.1);
`remoteStatus` split primary(`byProject`)/workers(`byHost`) with `sshOf`/`vpnOf` (§4.3);
`TerminalView.remoteHostId` from `TabPane` (§4.2); per-host pill lamps (`RemoteConnMenu`) +
`connectDialog.hostId` + `useRemoteReconnect(project, host?)` + `RemoteConnectDialog`
host-aware (§4.3); TabBar locality badge → Local/Primary/worker **menu** (§4.5);
`CenterPanel` hold gate per-host (§4.5); `RemoteMachinesWindow` = the §4.4 pill section
(add machine, connect, sync-now, pull-outputs w/ size-confirm, toggles); deactivation
disconnects all hosts; `AppShell` lamp-reconcile uses `remote_connected_targets`.

**Deferred (documented).** Per-worker **monitoring** host selector (§5) — `SystemMonitorPane`
is mid-refactor by another working copy (pre-existing tsc errors), so not touched; the
backend monitor commands still take only `project_id`. Per-`(project,host)` **net_usage**
buckets (§3.4) — `connected_ids` sums a project's hosts under one bucket as the plan
allows. Per-worker **auto-connect on launch** — the toggle persists via `patch_compute_host`,
but `autoConnectRemote` (`stores/projects`) still probes the primary only.
