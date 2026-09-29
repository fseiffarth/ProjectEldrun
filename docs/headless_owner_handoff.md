# Headless owner — handoff (H1 + H1b)

*Written 2026-09-29 by the H1 agent, extended the same day by the first H1b
agent (stopped early: usage limit) and closed by the second H1b agent. Plan:
[`headless_owner_plan.md`](headless_owner_plan.md).
Worktree: `.claude/worktrees/agent-a48b863224fa9d19d`, branch
`worktree-agent-a48b863224fa9d19d` (based on `develop` at `ad117b09`).
Nothing was run live; every claim below is gates + tests only.*

## What is done, with commits

| Commit | Phase | Content |
|---|---|---|
| `5a38d310` | H0 | already merged into `develop` (verified by the coordinator). #172 parent-dir fsync with a test seam; #171 calendar CAS on a file `rev` + per-record `rev`s; the sidecar answers Todo / Calendar / Schedules / Prompts / AgentTranscript off the state dir with the window closed (`services/mobile_control/headless.rs`, `services/calendar_recurrence.rs`, `services/todo_board.rs`), phone screens show them read-only. |
| `6562c91a` | **H1** | **complete in the sense below.** The workspace service, the desktop switched to it, `save_tab_layout` refused once a scope is versioned, CAS for settings and boxes, `storage::FileLock`. |
| `c5fee054` | H2 interim | landed before the scope was narrowed to H1; all gates green. The single-client timer lease (`services/timer_lease.rs`, `stores/timerLease.ts`, `TimerLeaseHost`), the five timer hosts gated on `holdsTimerLease()`, the schedule dialog's note. The H2 subagent should build on it or drop it — it is one self-contained commit. |
| `e262b6db` | docs | the H1 handoff (this file's first version). |
| `1a44acc1` | **H1b, steps 1 + 3 + the create primitive** | `updatedVersion` per tab (held wins when updated after the client's base); owner-side minting of a created PTY tab's tmux name (and an agent's `scheduleTargetId`) in `services/workspace.rs`; `workspace::create_tab_in` — the sidecar's headless create primitive, idempotent on `mobileRequestHash`. Tests in `workspace.rs`. |
| `dce19aef` | **H1b step 2** | the desktop `workspace:patch` listener: `adoptSyncOutcome(scope, outcome, sentKeys)` reconcile + `applyWorkspacePatch` in `tabs.ts`, `layout/WorkspacePatchHost.tsx` mounted in `AppShell`; `WorkspaceSync.test.ts` (4 tests). |
| `732409e1` | **H1b step 4** | `services/launch_prep.rs::prepare` (the launch assembly moved out of `pty_spawn`), `tmux_local::{local_tmux_argv, spawn_detached_with}` (the detached spawn, tested on a private socket). |
| `84a8677d` | **H1b step 6** | headless `Catalog` / `Activity` / `GitStates` / `Create` (`headless.rs`, `host.rs::HeadlessSpawner`), the phone's ＋ starts a shell or agent with no window; the H1 exit test in `host.rs`. |
| `dce35fa4` | **H1b step 7** | default apps CAS: `patch_default_apps`, `lib/defaultApps.ts`, the dialog and Settings → File types patch one entry. |
| `1981a679` | H3 draft | on the side branch `worktree-agent-a48b863224fa9d19d-h3-wip`, **not gate-clean**, not on this branch. See "For H3" below. Its `updatedVersion` half (`1a44acc1`) and its `adoptSyncOutcome` half (`dce19aef`) are both on this branch now; what remains there is the per-tab edit primitives and the host fallbacks. |

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
- `TabEntry.extra.id` (stable identity, uuid), `createdVersion`,
  **`updatedVersion`** (H1b: the version the tab's fields last changed at).
- `tab_groups`, `active_tab_index`, `open_tab_sessions` stay the desktop
  client's own fields: the merge never reads them; they are written as sent.
  This is the "TerminalSession split" — at the API, not into a second file.

**API** (`src-tauri/src/services/workspace.rs`):
- `snapshot_in(path) -> Snapshot{version, session}`; adopts a pre-service file
  once (ids + version 1) if it holds tabs; an absent/empty file stays 0.
- `sync_in(path, scope, ClientSync{base_version, tabs, groups, sessions,
  active_tab_index, allow_clear}) -> SyncOutcome{version, tabs, ops, stale}`.
  **`scope` is new in H1b** (the project id, `box:<id>` or `root` — what a
  minted tmux name carries). The merge: a client tab whose id is held → kept
  with the client's fields (`Updated`) **unless the held copy's
  `updatedVersion > base`, in which case the held copy stands (the client's
  is older knowledge, no op)**; a client tab with no id or an unheld id →
  `Created` (unless tombstoned after the client's base: the close stands),
  and a created PTY tab lacking a tmux name / an agent lacking a schedule
  binding gets them minted (`mint_for_created`); a held tab absent from the
  snapshot → `Closed` if `createdVersion <= base` (the client knew it), kept
  in place otherwise; the client's order applies to tabs it knows
  (`Reordered`). Base 0 = "never received a version" = the snapshot is the
  whole set (legacy clients). Empty `tabs` without `allow_clear` = no-op.
  Nothing written when nothing changed; every write bumps the version.
- `edit_in(path, scope, |session| …)` for backend-side whole edits (adopt
  from a folder, path rewrite, detach cwd rewrite, the headless create):
  assigns ids, mints tmux names for new PTY tabs, stamps `updatedVersion` on
  every tab the edit changed, bumps, tombstones.
- **`create_tab_in(path, scope, tab, request_hash) -> CreatedTab{tab,
  existed}`** (H1b): appends one owner-minted tab; a tab already carrying
  `mobileRequestHash == request_hash` is answered instead and nothing is
  written (the check and the append run under the one lock).
- `mint_tmux_session(scope, kind)` → `eldrun-<project_key(scope)>--<shell|agent>-<uuid>`,
  the shape `discovery::expected_tmux` checks and `tabs.ts`'s
  `newTmuxSessionName` mints. `tmux_of(tab)` = `tmuxSession` else `tmuxAttach`.
- `bump_raw_version(&mut Value)` for the raw-JSON path rewrite.
- Project-keyed wrappers `snapshot / sync / edit` add
  `terminal_service::after_state_session_write` (host-bound marker prune +
  project-tree export copy, which strips the bookkeeping).
- Constants: `OWNED_ERROR`, `VERSION_KEY`, `CLOSED_KEY`, `TAB_ID_KEY`,
  `TAB_CREATED_KEY`, `TAB_UPDATED_KEY`.

**Commands** (`src-tauri/src/commands/projects.rs`, registered in `lib.rs`):
`workspace_snapshot { projectId }` and `workspace_sync { projectId,
localFile, baseVersion?, tabs, groups, sessions, activeTabIndex?,
allowClear }` — the same flat payload as `save_tab_layout` plus the version,
so the frontend's one persisted shape (`toSavedTabEntry`) is the wire shape.
`workspace_sync` emits `workspace:patch { scope, version, ops }` to every
window (`WORKSPACE_PATCH_EVENT`); `layout/WorkspacePatchHost.tsx` listens
and hands it to `tabs.ts::applyWorkspacePatch` (H1b step 2).

**Frontend** (`src/stores/tabs.ts`): `TabEntry.id` / `SavedTabEntry.id`
round-trip (`toSavedTabEntry`, `loadFromLayout` keep it while `key` is
re-minted); `workspaceVersionByScope`; `hydrateScopeFromDisk` →
`loadWorkspaceSnapshot` (falls back to `load_tab_session` on an older
backend); `persistScope` → `syncWorkspace` (falls back to `save_tab_layout`)
and `adoptSyncOutcome(scope, outcome, sentKeys)` (version, minted ids, a
newer label/colour from the answer, and a sent tab the answer no longer
holds leaves through `removeTabInScope` — H1b step 2).
`snapshotScopeForSwitch` carries `workspaceVersion`; `projects.ts` sends it
in the switch payload (`PreviousProjectSnapshot.workspace_version`);
`ProjectPill` close-all uses `syncWorkspace` with `allowClear`. 16 test files
were re-pointed from `save_tab_layout` to `workspace_sync`, 3 from
`load_tab_session` to `workspace_snapshot`.

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
`storage::patch_json` now holds the `FileLock` too. Default apps (H1b step
7): `patch_default_apps { set, remove }` merges under the lock and answers
the stored map; `save_default_apps` (whole replace, older frontends) goes
through the same lock.

## H1b — status per step (all done)

The user accepted H1 as built; H1b completes what the plan meant by H1. The
step numbers are the coordinator's brief.

1. **`updatedVersion` — done** (`1a44acc1`). Test:
   `a_change_written_after_the_clients_base_is_kept_over_its_stale_copy`.
2. **Desktop `workspace:patch` listener — done** (`dce19aef`).
   `adoptSyncOutcome(scope, outcome, sentKeys)`: a held label/colour newer
   than this window's copy is adopted; a tab this window *sent* (`sentKeys`,
   `persistScope` passes `keep`) that the answer no longer holds was closed
   elsewhere and leaves through `removeTabInScope` (pane tree follows); order
   is not reconciled; a tab created elsewhere is **not added** (it arrives at
   the next hydrate — H3). `applyWorkspacePatch({scope, version, ops})`:
   when the scope is loaded and `version >` the known one, fetch
   `workspace_snapshot` and adopt with every held key as sent; the window's
   own sync echoes here too (idempotent). `WorkspacePatchHost` is mounted in
   `AppShell` next to `TimerLeaseHost`. The event only fires for Tauri-side
   syncs (a second window); a sidecar write is another process and reaches a
   window at its next sync (stale answer) or hydrate. Tests:
   `src/__tests__/tabs/WorkspaceSync.test.ts` (4).
3. **Owner-side minting — done** (`1a44acc1`); the window keeps pre-minting
   its own names (`withTmuxSession` / `newTmuxSessionName`): `TerminalView`
   spawns on mount with `tab.tmuxSession`, before a debounced sync could
   answer. Both mint the same shape.
4. **Owner-side spawning — done** (`732409e1`).
   - `services/launch_prep.rs::prepare(opts, session_name, pool:
     Option<&RemotePoolState>) -> Result<PreparedLaunch, String>` is
     `pty_spawn`'s former body from the empty-cwd resolve through the local
     tmux wrap, **moved, not copied** (the helpers `vm_spawn_refusal`,
     `cwd_within`, `scope_root_for`, `append_claude_name`,
     `resolve_agent_remote_control` and their tests moved with it).
     `PreparedLaunch { opts, named, interrupted, … }` with `commit(self)`
     (guard.keep, claim.keep, `register_tab`, `track/untrack_host_agent_tab`)
     and `mcp_token_handed_out()`; a dropped `PreparedLaunch` releases the
     MCP token and the Codex resume claim as a failed spawn always did.
     `pool: None` + a remote project → `Err` (the headless path only starts
     local tabs). `pty_spawn` keeps the crash-loop check, `terminal::spawn_pty`
     (on `prepared.opts.clone()`), the `SESSIONS_EVENT` emit and `commit()`.
   - `tmux_local::local_tmux_argv(session, opts, detached)` is the one argv
     (`-d` after `-A` when detached, launcher-script fallback either way);
     `wrap_pty_options_local` calls it. `spawn_detached_with(opts, socket:
     Option<&str>)` (Unix): `paths::command_no_window("tmux")` [+ `-L socket
     -f /dev/null`, tests only], `current_dir(opts.cwd)`, `TERM`,
     `COLORTERM`, `PATH = effective_path()`, then `opts.env` on the client
     (secrets reach the session via `update-environment`, never argv),
     stdin null, `.output()`, non-zero → `Err(stderr)`. Tests: argv pair, the
     refusal without a name, and a live private-socket session
     (`a_detached_spawn_creates_a_session_the_server_finds`, `kill-server`
     after).
   - Parity gaps, recorded not fixed: `--name`, `initialInput` (`/rename`)
     and the Remote-Control flag come from the window's `TerminalView`; a
     sidecar-started agent runs without them until restarted from a window.
     A headless spawn has no crash-loop guard (no registry).
5. **`tmux -L eldrun` — decided: keep the default socket** (reasons in the
   plan's status block). A private socket is only used by tests.
6. **Headless `Catalog` / `Activity` / `GitStates` / `Create` — done**
   (`84a8677d`).
   - `headless.rs`: `agents(state_dir, host_key, installed)` = the resumable
     built-ins (`discovery::RESUMABLE_BUILTINS`, now a `pub(super)` const)
     that are installed and not in `settings.json`'s `disabled_agents` (id or
     bin), id = `key_id(host_key, "agent", &[bin])`, `modes: []`; custom
     agents are not offered. `turn_readings(state_dir, pid, tabs)` reads
     `<state_dir>/live_sessions/<uid>.turn` and `…/<project_key>/<uid>.turn`
     (newest stamp wins; uid = the tab's `sessionId`): working→`working`,
     decision→`question`, done→`done`, idle/none→a timing row when the
     transcript names a model; prompts via
     `agent_session_recent_prompts`. `schedule_summaries` (total / enabled /
     `next` = min of `next_runs` / `upcoming` ≤ 3). `activity(state_dir,
     catalog)` folds every project. `git_dot_for(dir)` = `gitDirtyState`'s
     ladder over `commands::git::git_status_probe` +
     `git_unpushed_commits_blocking` (both now `pub(crate)`, hardened git,
     `spawn_blocking`). `ReadingCache` (`READING_TTL` 10 s) holds git dots and
     readings per raw id in `HostState.readings`.
   - `headless::create_tab(state_dir, host_key, project, request, agents,
     launch)`: refuses `sign_in` / `cloud` / `worktree` / `local` /
     `like_tab` / `mode` and the **root scope** with `DesktopUnavailable`;
     `unknown_agent` when the pick is not in `agents`; builds the record
     (`tab_record`: shell = label "Shell", cmd ""; agent = registry label,
     bin, `sessionId` uuid, `env.ELDRUN_TAB_UID`, `--session-id` for
     claude/gemini; `mobileRequestHash = key_id(host_key, "request",
     &[idempotency_key])`; key `headless-<uuid>`), `workspace::create_tab_in`
     on `headless::session_file(state_dir, raw_id)` (persist first, so a
     window opening meanwhile merges it in), then `launch(launch_options(…))`
     (id `headless:<tmux>`, 80×24, `project_id: Some(raw_id)` — box scopes
     included); a failed launch `edit_in`s the record back out →
     `launch_failed` (502). `existed` answers without launching.
   - `host.rs`: `HeadlessSpawner { launch: HeadlessLaunch, installed }` on
     `HostState` (`Default` = `launch_prep::prepare(opts, None, None)` +
     `spawn_detached_with(&prepared.opts, None)` + `commit()`; the registry's
     `binary_is_installed`). Routes: `projects` (git dots via
     `headless_git_dot` when `desktop_down`), `activity`, `project` (agents,
     statuses, schedules, prompts, timings, `closed: []`, git), `create_tab`
     (calls the desktop first; `desktop_down` → `create_headless`, which
     polls `catalog_fresh` for the tmux row **without** `available` and
     answers `201 { tab, desktop_available: false }`). `create_through_desktop`
     stays for the sign-in route. A persist/launch failure is
     `eprintln!`ed (the sidecar's journal).
   - `schema::project::TabEntry.key` is `#[serde(default)]` now: the host
     fixtures (and any hand-made file) write tabs without a key, and the
     workspace service refused to read them.
   - Tests: `a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner`
     (the H1 exit test: minted record with id / `eldrun-<raw>--agent-…` /
     `scheduleTargetId` / `mobileRequestHash` / `sessionId`, the recorded
     `PtyOptions`, repeat = same tab + no second spawn, catalog + activity
     list it, no leak of raw id / tmux / uid / target / path, cloud refused
     503, shell created too) and
     `a_headless_launch_that_fails_takes_the_minted_tab_back_out`.
   - Phone (`mobile-web`): `NewTabSheet` takes `headless` beside `busy`: the
     shell and a plain agent are enabled with the desktop away; modes, cloud,
     a linked worktree, local models and the sign-in entry are held; a note
     (`mobile.newTab.headless`) with the `mobile.headless` untested mark.
     `Project.tsx`'s notice is `mobile.project.desktopUnavailable` (was
     hardcoded). `MobileNewTabSheet.test.tsx`'s away-test asserts the new
     contract.
7. **Default apps CAS — done** (`dce35fa4`). `commands/default_apps.rs`:
   `patch_default_apps { set, remove } -> DefaultApps` on
   `storage::patch_json` (+ `patch_default_apps_at` for the test);
   `save_default_apps` is a whole replace under the same lock. Frontend:
   `src/lib/defaultApps.ts` (`patchDefaultApps(patch, whole)` with the
   `isUnknownCommand` fallback to `save_default_apps`, `diffDefaultApps`),
   used by `SetDefaultAppDialog` (global scope; pill `setDefaultApp.patch`)
   and `SettingsSubPanels::FileTypeSettings`. Tests:
   `src/__tests__/files/DefaultAppsPatch.test.ts` (4),
   `default_apps::tests::patches_compose_instead_of_overwriting`.

**Untested rows added for H1b:** `mobile.headless` (the ＋ sheet's note with
the desktop away; covers step 6's readings too) and `setDefaultApp.patch`
(the dialog title). The patch listener (step 2) has no visible control and
carries no pill.

**Manual checks owed (the plan's H1 exit):** quit Eldrun cleanly (the
window's ×; this also reaps every `eldrun-*` session — so start the Mobile
sidecar first or leave it running as its systemd unit); on the phone open a
Mobile-enabled project, press ＋, start Claude; the row should appear within
~2 s with the tmux name hidden and its screen unavailable; relaunch Eldrun,
open the project: the new Claude tab is there and attached to the running
session (its screen shows the CLI already started, not a fresh launch);
`tmux ls` on the desktop shows one `eldrun-<project>--agent-…` for it.
Also: with the window closed, the phone's project list shows git dots and
the Agents list shows the working/done state of a tab that ran a turn;
Settings → File types on one window and the Set-default-app dialog on
another save different entries within a second and both survive.

## Deviations from the plan (all recorded in the plan's status block)

1. Owner = versioned file + lock, both processes run the service (above).
2. Ops are derived by the service from the client's snapshot against its base
   version, not sent one by one; the store's internals are untouched.
3. **No `tmux -L eldrun`** (H1b step 5, reasons above); owner-side spawning
   shares the window's launch assembly (`launch_prep`, step 4) and the
   default server. Names: the owner mints for created tabs lacking one; the
   window still pre-mints its own (step 3, reason above).
4. Per-client layout split at the API only (no second file).
5. ~~Default-apps CAS pending~~ — done (step 7): a patch command, not a
   revision on the bare map.
6. ~~`Catalog` / `Activity` / `GitStates` / `Create` still answered by the
   window~~ — done (step 6) for a shell / plain agent create; a sign-in,
   cloud, worktree, local-model, mode or root-console create still needs
   the window, and custom agents are not offered headless.
7. ~~Field edits last-writer-wins by client~~ — fixed in `1a44acc1`
   (`updatedVersion`).
8. `adoptSyncOutcome` does not add a tab created elsewhere (H3).

## Gotchas

- The `rtk` shell hook rewrites commands; in this worktree plain `git` and
  compound shell lines are refused by the isolation guard — use
  `/usr/bin/git` from the worktree dir, `rtk proxy <cmd>` to read source
  unfiltered, and put scripts in the scratchpad.
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
  and the two `terminal::route_tests` are wall-clock sensitive: they fail
  under parallel load (again at `1a44acc1`) and pass alone.
- `storage::state_dir()` honours `ELDRUN_STATE_DIR`, but it is process-wide
  and the lib tests run in one process: never set it in a lib test (see
  `ssh_common.rs` ~line 1061). `launch_prep` (step 4) reads
  `projects.json` from it, so a host test that exercises the real launch
  would need an integration binary of its own (`tests/*.rs`, one test) —
  hence the `launch` seam in step 6.
- `root_mcp_review` compares calendar rows as JSON: `rev` had to join the
  store-owned fields (`STORE_FIELDS`), and its undo tests compare content
  minus revisions now (a revisioned file is never byte-identical after an
  undo).
- `TabEntry` in Rust keeps everything but key/label/cmd/cwd/sessionId in
  `extra`, so the merge compares whole tabs as JSON (`comparable`, which
  strips `createdVersion` and `updatedVersion`) and the frontend's re-minted
  `key` counts as a change (harmless: every persist wrote before too; it
  also means a window's first sync after a restart stamps `updatedVersion`
  on every tab — a phone edit that lands *between* that window's hydrate
  and its first sync is kept only because the phone's stamp is newer than
  the window's base, which is the version it hydrated at: correct, but
  remember the key churn when reading `updatedVersion` in a test).
- `File::lock` (std, Rust ≥ 1.89) backs `FileLock`; flock is per open file
  description, so never take the lock twice in one call path
  (`create_tab_in` therefore does its existence check *inside* `edit_in`'s
  closure and aborts the write with a sentinel error).
- `tests/project_tree_intent.rs` flags any `.tab_layout` read without a
  `// project-tree-read: ok — …` marker, `headless.rs`'s launch-failure
  `retain` included.
- `launch_prep::prepare` reads `projects.json`/`settings.json` from
  `storage::state_dir()`; the host test therefore stubs `HeadlessSpawner`
  (`headless_host(launch)`) and never runs the real launch.
  `agent_session_model` / `agent_session_recent_prompts` read the real state
  dir too (a fabricated uid answers nothing).
- A headless-created session is reaped by the window's clean quit like every
  `eldrun-*` session (`kill_eldrun_sessions`); the sidecar itself never owns
  the process (the tmux server does).
- The post-commit hook prints "EMBEDDED MOBILE PWA IS STALE" — expected, the
  running app was never restarted.
- ESLint: 31 pre-existing warnings (0 errors) in files this work never
  touched (`TerminalView.tsx`, `TodoAgendaRail.tsx`, `notebook.ts`,
  `mobile-web/.../Terminal.tsx`).

## Gate status (at `dce35fa4`, the branch tip)

- `cargo test --no-fail-fast`: **2934 lib tests** and every integration
  binary green; the wall-clock `mail_sanitize` tests failed in the parallel
  runs and passed alone each time.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: green. `npm test`: **634 files, 6455 tests** (632 /
  6447 at `c5fee054`). `npm run lint`: 0 errors, 31 pre-existing warnings.
- `git diff --check` clean; `scripts/privacy-check.sh` passed on every commit.

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
  are the backend pieces a scheduler loop can use.
- **Where a sidecar-side tick sends keys into a tab (H1b step 4 landed):**
  the tab is named by its tmux session (`workspace::tmux_of`, the catalog's
  `ResolvedTab::tmux_name`); delivery is `tmux send-keys -t =<name>: -l
  <text>` then `send-keys -t =<name>: Enter` through
  `paths::command_no_window("tmux")` on the default socket (the same server
  the window's and the sidecar's spawns use — step 5 kept it). If the
  session is not live (`tmux has-session -t =<name>` fails), the sidecar can
  start it with the step-4 path — `headless::launch_options(raw_id, &tab)`
  builds the `PtyOptions` from the persisted record, then the host's
  `HeadlessSpawner.launch` (`prepare` resolves the resume args through
  `agent_session::resolve_agent_session`; the sidecar process has no
  `RemotePoolState`, so only local tabs) — and then
  deliver — that is "fires once with no client". The lease then only has to
  say whether a window holds the timers; the sidecar takes them when none
  does (`timer_lease::acquire_in` from the sidecar process, same file).
- `pty_bridge` has the attach side (`tmux_attach_command`) if a tick needs to
  read the screen back (`local_tmux_screen_args`).

## For H3

- The draft on `worktree-agent-a48b863224fa9d19d-h3-wip` (`1981a679`):
  `workspace::{rename,color,reorder,close}_tab_in` by tmux name (build them
  on this branch's `edit_in(path, scope, …)` + `tmux_of`); `host.rs`
  fallbacks (`adoptSyncOutcome` is on this branch already, `dce19aef`).
  Use `headless::session_file(state_dir, raw_id)` for the path (the draft's
  `session_file()` used `storage::state_dir()`, which is why its fixture's
  scope was not found); the create route's `desktop_down` → headless shape
  in `create_tab` / `create_headless` is the pattern; three old host tests
  (`renaming_a_tab_needs_the_desktop_bridge…`, `moving_a_tab…`,
  `closing_a_tab…`) still assert the pre-H3 503 contract and need the new
  one (200 + `desktop_available: false`).
- `adoptSyncOutcome` should also *add* a tab created elsewhere (a phone
  create while a window is open reaches it today only at the next hydrate;
  the window's `workspace:patch` listener only hears Tauri-side syncs, so a
  sidecar create needs either a poll of `workspace_snapshot` or the sidecar
  poking the window over the desktop socket).
- Calendar/todo writes from the sidecar are safe now (`commands::calendar::*_at`
  are path-based and CAS); the mobile action → record mapping lives in
  `MobileBridgeHost.tsx` (`calendarMutate`, `todoMutate`) and would need a
  Rust twin. Schedules/prompts writes need `FileLock` in
  `agent_tasks::mutate` / `agent_prompts` first. Mail stays behind the window.
