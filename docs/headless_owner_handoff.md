# Headless owner — handoff (H1)

*Written 2026-09-29 by the H1 agent. Plan: [`headless_owner_plan.md`](headless_owner_plan.md).
Worktree: `.claude/worktrees/agent-a48b863224fa9d19d`, branch
`worktree-agent-a48b863224fa9d19d` (based on `develop` at `ad117b09`).
Nothing was run live; every claim below is gates + tests only.*

## What is done, with commits

| Commit | Phase | Content |
|---|---|---|
| `5a38d310` | H0 | already merged into `develop` (verified by the coordinator). #172 parent-dir fsync with a test seam; #171 calendar CAS on a file `rev` + per-record `rev`s; the sidecar answers Todo / Calendar / Schedules / Prompts / AgentTranscript off the state dir with the window closed (`services/mobile_control/headless.rs`, `services/calendar_recurrence.rs`, `services/todo_board.rs`), phone screens show them read-only. |
| `6562c91a` | **H1** | **complete in the sense below.** The workspace service, the desktop switched to it, `save_tab_layout` refused once a scope is versioned, CAS for settings and boxes, `storage::FileLock`. |
| `c5fee054` | H2 interim | landed before the scope was narrowed to H1; all gates green. The single-client timer lease (`services/timer_lease.rs`, `stores/timerLease.ts`, `TimerLeaseHost`), the five timer hosts gated on `holdsTimerLease()`, the schedule dialog's note. The H2 subagent should build on it or drop it — it is one self-contained commit. |
| `1981a679` | H3 draft | on the side branch `worktree-agent-a48b863224fa9d19d-h3-wip`, **not gate-clean**, not on this branch. See "For H3" below. |

## The H1 design as built

**The owner is the versioned session file plus its lock, not a process.**
`services/workspace.rs` is `AppHandle`-free; the desktop runs it in-process
and the Mobile sidecar can run the same code against the same file (the
sidecar only exists while Mobile is enabled, so a process-owner would leave
the desktop without one). Every entry point holds `storage::FileLock`
(`<file>.lock`, advisory, cross-process) across its read-merge-write.

**On-disk shape — unchanged, plus bookkeeping** (all in `extra` maps, so an
older Eldrun round-trips it):
- `TerminalSession.extra.workspaceVersion` (`u64`, `0`/absent = never synced),
  `workspaceClosed` (`[{id, version}]`, last 64 tombstones).
- `TabEntry.extra.id` (stable identity, uuid), `createdVersion`.
- `tab_groups`, `active_tab_index`, `open_tab_sessions` stay the desktop
  client's own fields: the merge never reads them; they are written as sent.
  This is the "TerminalSession split" — at the API, not into a second file.

**API** (`src-tauri/src/services/workspace.rs`):
- `snapshot_in(path) -> Snapshot{version, session}`; adopts a pre-service file
  once (ids + version 1) if it holds tabs; an absent/empty file stays 0.
- `sync_in(path, ClientSync{base_version, tabs, groups, sessions,
  active_tab_index, allow_clear}) -> SyncOutcome{version, tabs, ops, stale}`.
  The merge: a client tab whose id is held → kept with the client's fields
  (`Updated`); a client tab with no id or an unheld id → `Created` (unless
  tombstoned after the client's base: the close stands); a held tab absent
  from the snapshot → `Closed` if `createdVersion <= base` (the client knew
  it), kept in place otherwise; the client's order applies to tabs it knows
  (`Reordered`). Base 0 = "never received a version" = the snapshot is the
  whole set (legacy clients). Empty `tabs` without `allow_clear` = no-op.
  Nothing written when nothing changed; every write bumps the version.
- `edit_in(path, |session| …)` for backend-side whole edits (adopt from a
  folder, path rewrite, detach cwd rewrite): assigns ids, bumps, tombstones.
- `bump_raw_version(&mut Value)` for the raw-JSON path rewrite.
- Project-keyed wrappers `snapshot / sync / edit` add
  `terminal_service::after_state_session_write` (host-bound marker prune +
  project-tree export copy, which strips the bookkeeping).
- Constants: `OWNED_ERROR`, `VERSION_KEY`, `CLOSED_KEY`, `TAB_ID_KEY`,
  `TAB_CREATED_KEY`.

**Commands** (`src-tauri/src/commands/projects.rs`, registered in `lib.rs`):
`workspace_snapshot { projectId }` and `workspace_sync { projectId,
localFile, baseVersion?, tabs, groups, sessions, activeTabIndex?,
allowClear }` — the same flat payload as `save_tab_layout` plus the version,
so the frontend's one persisted shape (`toSavedTabEntry`) is the wire shape.
`workspace_sync` emits `workspace:patch { scope, version, ops }` to every
window (`WORKSPACE_PATCH_EVENT`); nothing listens yet.

**Frontend** (`src/stores/tabs.ts`): `TabEntry.id` / `SavedTabEntry.id`
round-trip (`toSavedTabEntry`, `loadFromLayout` keep it while `key` is
re-minted); `workspaceVersionByScope`; `hydrateScopeFromDisk` →
`loadWorkspaceSnapshot` (falls back to `load_tab_session` on an older
backend); `persistScope` → `syncWorkspace` (falls back to `save_tab_layout`)
and `adoptSyncOutcome` (version + minted ids). `snapshotScopeForSwitch`
carries `workspaceVersion`; `projects.ts` sends it in the switch payload
(`PreviousProjectSnapshot.workspace_version`); `ProjectPill` close-all uses
`syncWorkspace` with `allowClear`. 16 test files were re-pointed from
`save_tab_layout` to `workspace_sync`, 3 from `load_tab_session` to
`workspace_snapshot`.

**Whole-snapshot writers, all routed** (`terminal_service.rs`):
`write_terminal_session` returns `OWNED_ERROR` once `workspace::is_owned`;
`save_terminal_session(…, base_version)` (the switch snapshot, never clears,
no session list) is a `workspace::sync`; `adopt_untrusted_session` is an
`edit_in` (strips a folder's bookkeeping first); `rewrite_session_paths`
holds the lock and bumps the raw version; the detach path in
`commands/projects.rs` is a `workspace::edit`. `tests/project_tree_intent.rs`
lists `services/workspace.rs` as a defining file.

**CAS for the whole-document saves:** `Settings.rev` (every write moves it;
`save_settings` — the frontend's fallback only — refuses a stale document;
`patch_settings` strips a caller's `rev` and bumps); `ProjectBox.rev`
(`write_boxes` stamps per changed box; `save_boxes` refuses a stale list).
`storage::patch_json` now holds the `FileLock` too. Default apps: no CAS (a
bare map, nowhere to hold a revision) — deviation.

## Deviations from the plan (all recorded in the plan's status block)

1. Owner = versioned file + lock, both processes run the service (above).
2. Ops are derived by the service from the client's snapshot against its base
   version, not sent one by one; the store's internals are untouched.
3. **No `tmux -L eldrun`**, no owner-side spawning or name minting: `-L`
   would hide every live session from a window that had not restarted, and a
   detached `tmux new-session` path does not exist in `pty_spawn`. Names are
   still minted in `tabs.ts` (`withTmuxSession` / `newTmuxSessionName`).
4. Per-client layout split at the API only (no second file).
5. Default-apps CAS not done.
6. `Catalog` / `Activity` / `GitStates` still answered by the window (the
   sidecar's file catalog already marks `desktop_available: false`).
7. Field edits are last-writer-wins **by client** on this branch: a client's
   snapshot overwrites held fields it differs from. The H3 draft adds
   `updatedVersion` so a change written after a client's base is kept over
   that client's stale copy — needed before the sidecar writes tabs.

## Remaining H1 steps (if anyone takes them further), in order

1. `updatedVersion` per tab + "held wins when updated after the client's
   base" (the draft on the H3 branch has it, with tests) — prerequisite for
   any second writer.
2. A `workspace:patch` listener in the desktop that refreshes
   `workspaceVersionByScope` and reconciles label/colour/close from a
   re-fetched snapshot (the draft's `adoptSyncOutcome(scope, outcome,
   sentKeys)` does this from a sync answer; `WorkspaceSync.test.ts`).
3. Owner-side minting: `workspace_sync` could mint `tmuxSession` for a
   created PTY tab lacking one; `expected_tmux` in `discovery.rs` is the
   shape check. Owner-side spawning needs a detached tmux path first.
4. `tmux -L eldrun` only with a migration for live sessions on the default
   socket (`tmux_local.rs`, `discovery::live_tmux`, `pty_bridge` attach).
5. Default apps: replace `save_default_apps` with a patch (`patch_json`).

## Gotchas

- The `rtk` shell hook rewrites commands; in this worktree plain `git` and
  compound shell lines are refused by the isolation guard — use
  `/usr/bin/git` from the worktree dir and put scripts in the scratchpad.
- `node_modules` is a hard-link copy of the main checkout's (never symlink:
  pdf.js tests collect zero).
- `cargo test` stops after a failing lib target, so the integration test
  binaries (`tests/*.rs`) do not run; use `--no-fail-fast`. Two of them bite:
  `project_tree_intent.rs` (every `.tab_layout`/`.tab_groups` read needs a
  `project-tree-read: ok` marker or a defining-file entry) and
  `services_tests.rs` (calls `save_terminal_session` / `save_tab_layout`; a
  `save_tab_layout` after a sync on the same scope is now refused — one test
  was rewritten to sync instead).
- `services::mail_sanitize::tests::a_body_full_of_links_does_not_take_quadratic_time`
  and the two `terminal::route_tests` are wall-clock sensitive: they failed
  under parallel load (and on the untouched baseline) and pass alone.
- `root_mcp_review` compares calendar rows as JSON: `rev` had to join the
  store-owned fields (`STORE_FIELDS`), and its undo tests compare content
  minus revisions now (a revisioned file is never byte-identical after an
  undo).
- `TabEntry` in Rust keeps everything but key/label/cmd/cwd/sessionId in
  `extra`, so the merge compares whole tabs as JSON (`comparable`) and the
  frontend's re-minted `key` counts as a change (harmless: every persist
  wrote before too).
- `File::lock` (std, Rust ≥ 1.89) backs `FileLock`; flock is per open file
  description, so never take the lock twice in one call path.
- The post-commit hook prints "EMBEDDED MOBILE PWA IS STALE" — expected, the
  running app was never restarted.
- ESLint: 31 pre-existing warnings (0 errors) in files this work never
  touched (`TerminalView.tsx`, `TodoAgendaRail.tsx`, `notebook.ts`,
  `mobile-web/.../Terminal.tsx`).

## Gate status (at c5fee054, the branch tip)

- `npm run build`: green (tsc + both bundles).
- `npm test`: **632 files / 6447 tests** green (baseline before any change:
  631 files / 6444 tests; H0/H1 kept 631/6444, H2 added one file and three
  tests).
- `cargo test --no-fail-fast`: all targets green at the tip (2924 lib tests +
  every integration binary); at earlier points only the wall-clock tests
  above failed.
- `npm run lint`: 0 errors, 31 pre-existing warnings.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `scripts/privacy-check.sh`: passed before each commit.

## For H2 (where the timers hook in)

- The lease is in `c5fee054`: `services/timer_lease.rs` (`acquire_in` /
  `release_in`, 30 s TTL), `commands/agent_tasks.rs::timer_lease_{acquire,
  release}`, `stores/timerLease.ts` (`holdsTimerLease()`, optimistic default,
  10 s heartbeat from `layout/TimerLeaseHost.tsx`), gates in
  `AgentScheduleHost`, `AgentContinueHost`, `AgentCronHost`,
  `CalDavSyncHost` ticks and `stores/calendar/alarms.ts::tick`. Git probing
  is not gated. The dialog note is `agentSchedule.leaseElsewhere`
  (untested-tagged).
- The port proper: `services/agent_tasks.rs` (`claim` / `complete`),
  `services/schedule_mcp.rs::next_occurrence`, and `headless.rs::next_run_key`
  are the backend pieces a scheduler loop can use; delivery into a tab needs
  a tmux `send-keys` path (`pty_bridge` has the attach side).

## For H3

- The draft on `worktree-agent-a48b863224fa9d19d-h3-wip` (`1981a679`):
  `workspace::{rename,color,reorder,close}_tab_in` by tmux name +
  `updatedVersion`; `host.rs` fallbacks; `adoptSyncOutcome` reconcile.
  Known bug: `host.rs::session_file()` must use
  `state.config.state_dir.join("sessions").join(project_key(raw))` rather
  than `storage::state_dir()`; three old host tests
  (`renaming_a_tab_needs_the_desktop_bridge…`, `moving_a_tab…`,
  `closing_a_tab…`) still assert the pre-H3 503 contract and need the new
  one (200 + `desktop_available: false`).
- Calendar/todo writes from the sidecar are safe now (`commands::calendar::*_at`
  are path-based and CAS); the mobile action → record mapping lives in
  `MobileBridgeHost.tsx` (`calendarMutate`, `todoMutate`) and would need a
  Rust twin. Schedules/prompts writes need `FileLock` in
  `agent_tasks::mutate` / `agent_prompts` first. Mail stays behind the window.
