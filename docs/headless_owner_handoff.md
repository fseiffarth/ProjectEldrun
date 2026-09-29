# Headless owner — handoff (H1 + H1b + H2)

*Written 2026-09-29 by the H1 agent, extended the same day by the first H1b
agent (stopped early: usage limit), closed by the second H1b agent, and
extended by the H2 agent (the timers). Plan:
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
| `0d706b6b` | **H2, scheduled prompts** | `services/mobile_control/scheduler.rs`: the sidecar's 15 s loop fires scheduled prompts with no window open (tmux `send-keys`/`paste-buffer` into the tab, a dead tab restarted through the H1b spawn); `agent_tasks` / `agent_prompts` transactions hold the file's `FileLock` and have path-based cores (`claim_in`, `complete_in`, `delete_in`, `record_at`, `delete_at`); `timer_lease::holder_in`; the schedule dialog's delivery note + MCP contract. |
| `de732275` | **H2, calendar reminders** | `services/calendar_alarms.rs` (the due set + the cross-process fired record `calendar-alarms-fired.json`), `commands::calendar::calendar_alarms_claim`, the window's `alarms.ts` claims before it shows, `services/mobile_control/alarms.rs` pushes due reminders to the phone with no window (Web Push, the existing `push.rs`). `calendar_recurrence::Occurrence` carries `alarms`. |
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

**Manual checks owed (the plan's H2 exit; Mobile must be enabled so the
sidecar runs — `systemctl --user status eldrun-mobile-host`):**
1. *Closed window.* In a project open a Claude tab, add a one-time schedule
   (Agents ▸ the tab's ⏰) five minutes ahead with a prefix `/clear`, then
   quit Eldrun cleanly (the window's ×; this reaps the tmux sessions, which
   is the relaunch case). Watch `journalctl --user -u eldrun-mobile-host -f`:
   at the minute, `scheduler: restarted 'eldrun-<project>--agent-…'`, then
   within ~45 s `… delivered into …`. `tmux attach -t =<that name>` shows
   `/clear` submitted and the prompt answered. Relaunch Eldrun: the tab is
   attached to that session, the rule is gone from its menu, and the
   project's Sent prompts hold the row (result delivered, the occurrence).
   Variant: leave the window closed but the tab's session alive (kill only
   the window with `kill -TERM <pid>` of the Eldrun process — no reap): no
   restart line, the prompt goes in once the agent has been quiet 30 s.
2. *Two windows.* Open a second Eldrun window on the same state dir (a
   packaged build beside the dev one), schedule a prompt two minutes ahead
   in one; the other's schedule dialog shows "Another Eldrun window holds
   the timers". The prompt arrives once (one history row, one `last`).
   Close the lease-holding window before the minute: the other fires it,
   still once.
3. *Window + sidecar.* With one window open, wait past a schedule: the
   journal shows nothing from the scheduler (the window held the lease).
4. *Reminders.* Phone: Eldrun Mobile ▸ Calendar ▸ Reminders on. Add an
   event with a 15-minute reminder 16 minutes ahead, quit Eldrun cleanly.
   At the minute the phone gets the push (`reminder '…' pushed to 1
   phone(s)` in the journal); relaunch Eldrun: the reminder does not pop up
   again (it is in `calendar-alarms-fired.json`). With the window open
   instead, the popup + toast + push come once and the journal is silent.

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
- (H2) The session file is camelCase (`tabLayout`, `TerminalSession` is
  `rename_all = "camelCase"`); a fixture written as `tab_layout` reads as
  no tabs, silently.
- (H2) `FileLock` is flock, per open file description: a state-dir wrapper
  that takes `lock()` (mutex + file lock) must call the `*_locked` core, not
  the `*_in` variant that takes the file lock again — same-process deadlock.
- (H2) tmux: `send-keys -l` and `set-buffer` are bounded by the 16 KiB
  client message; `load-buffer <file>` is not. `paste-buffer` without `-r`
  replaces every newline with a carriage return (a submit per line).
  `window_activity` is pane output; `session_activity` is client input —
  the wrong one reads an unattached session as idle forever.
- (H2) `clippy::await_holding_lock`: a `MutexGuard` bound in a
  `#[tokio::test]` body must be scoped in a block before the next `.await`
  (`drop()` is not enough for the lint).
- (H2) `agent_prompts::record_at` still reads the live session record and
  the repo head from the process's `storage::state_dir()` (production: the
  same dir); in a lib test they simply answer nothing.
- (H2) A window's reminder engine now asks the backend before showing:
  `CalendarAlarmPush.test.ts`-style tests whose `invoke` mock answers `null`
  get "all granted" (a `null` answer is treated as no record).

## Gate status (at `de732275`, the branch tip)

- `cargo test --no-fail-fast`: **2946 lib tests** and every integration
  binary green (2934 at `313e080b`); the wall-clock `mail_sanitize`
  quadratic-time test failed once in a parallel run and passed alone.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`: green. `npm test`: **635 files, 6457 tests** (634 files / 6455
  tests at `313e080b`). `npm run lint`: 0 errors, 31 pre-existing warnings.
- `git diff --check` clean; `scripts/privacy-check.sh` passed on every commit.

## H2 — the timers, as built

Per step, with the plan's H2 exit ("with the window closed, a scheduled
prompt fires into an agent tab; with two windows open, every schedule fires
exactly once") covered by tests, never live.

1. **Interim lease — done** (`c5fee054`, unchanged in substance):
   `services/timer_lease.rs`, `stores/timerLease.ts`, `TimerLeaseHost`; the
   five window timer hosts tick only under `holdsTimerLease()`. New:
   `holder_in(path, now)` (a read: who holds it, `None` when free or
   expired) and `lease_file(state_dir)`. **The lease is a window lease**: the
   sidecar reads it and never takes it, so a window that opens takes the
   timers back — it can run the ones the sidecar cannot.
2. **Scheduled prompts in the owner — done** (`0d706b6b`).
   `services/mobile_control/scheduler.rs`, a tokio task spawned in
   `host::run` beside the admin socket (ends on the same `shutdown` watch):
   - **Tick** (`tick(ctx, now)`, every 15 s): if `holder_in` names a window
     → nothing. Else `targets(state_dir)` = `agent_tasks::bindings_at` (every
     project/target with an enabled rule) joined to the scope's session file
     (`headless::session_file`, camelCase `tabLayout`) by `scheduleTargetId`
     on an `agent` / `local_agent` tab with a tmux name (`workspace::tmux_of`).
     Per target, rules sorted soonest-first; `verdict` (the twin of
     `scheduleVerdict`: `Wait` inside the hour, `Missed` past it, `None` when
     off / a receipt at or after the occurrence / a finished once).
     `Missed` → `claim_in` + `complete_in(Missed)` + `retire`. `Wait` →
     `runner.probe(tmux)` (`tmux display-message -p -t =<name>:
     '#{session_created}\t#{window_activity}'`); no session → relaunch (below)
     and stop for this target; else `ready(record, probe, now)`; ready →
     `claim_in` → `deliver` (in `spawn_blocking`) → `complete_in(Delivered |
     Failed)` → `retire` → stop for this target (one delivery per tab per
     tick, as the window).
   - **Idle = the hooks' record first, the pane second.** `record` is
     `headless::turn_record` (`live_sessions/<uid>.turn`, shared root or the
     project slice, newest stamp; uid = the tab's `sessionId`). A stamp
     older than `session_created` is the previous process's and ignored.
     `working` / `decision` / `idle` (a `SessionEnd`: the tab is a shell now)
     hold; `done` delivers once it has stood 3 s and the window has painted
     nothing for 2 s; no record (a hookless agent, or a fresh relaunch) needs
     30 s of quiet — the window's `HOOKLESS_DONE_QUIET_MS`. **Why the hooks
     and not tmux alone:** the window's own gate is the hook verdict
     (`agentDeliveryReady`), the agent itself says when a turn ends, and
     output is silent under a long tool; tmux's `window_activity` (updated on
     pane output, unlike `session_activity` which is client input) only
     replaces the byte-settle the window had. Consequence: an untrusted
     Codex (hookless, repaints a spinner every 100 ms even idle) is never
     quiet and never delivered to headless — the window delivers to it.
   - **Delivery** (`TmuxRunner::deliver`): per submission (each prefix
     command, then the message — `submissions()`, sanitized, empties
     skipped): `send-keys -t =<name>: C-a C-k` (the composer reset), then for
     a lone character `send-keys -l -- <c>`, otherwise the text is staged in
     `<state_dir>/mobile-control/schedule-paste.txt` (0600, removed after)
     and `load-buffer -b eldrun-schedule <file>` + `paste-buffer -r -d -b
     eldrun-schedule -t =<name>:` with `-p` for every agent but Claude
     (`bracketsAgentMessage`: tmux brackets only if the pane asked; `-r`
     keeps newlines as newlines — the default turns each into a submit),
     then `send-keys Enter`. Between submissions: 350 ms, then quiet ≥ 1 s
     (≤ 6 s) — `settleBetweenSubmissions`. A tmux command line is capped at
     16 KiB, which is why a 16 KiB message goes through a buffer file.
   - **Relaunch**: kind `agent` only, `headless::launch_options(raw_id, tab)`
     through the host's `HeadlessSpawner.launch` (H1b: `launch_prep::prepare`
     + `spawn_detached_with`, default socket), once per tab per 60 s. The
     prompt goes in on a later tick once the CLI is up and 30 s quiet (no
     record yet) or its hook says done.
   - **Retire** = the window's: `agent_prompts::record_at` (history row under
     `<id>` for a once, `<id>@<occurrence>` otherwise, with label, launch
     `sessionId`, agent, preface, result, `scheduled_for`, `schedule_origin`),
     then for a once `agent_tasks::delete_in` and the carried collected
     prompt removed (`agent_prompts::delete_at`, by id else by sanitized
     text — `promptOfSchedule`). Every firing is `eprintln!`ed (the sidecar's
     journal: `journalctl --user -u eldrun-mobile-host`).
   - **Exactly once**: `agent_tasks` transactions now hold the file's
     `FileLock` (`Guard` = the in-process mutex + `agent_tasks.json.lock`),
     and the path-based cores `claim_in` / `complete_in` / `delete_in` are
     what the sidecar calls — one read-check-write under the lock, so an
     occurrence is claimed by exactly one process however the lease flips.
     Claims survive a restart (unchanged), so nothing re-fires.
     `agent_prompts` got the same lock and `record_at` / `delete_at`.
   - Tests (`scheduler.rs`): verdict + readiness tables, `submissions`,
     `targets`; `a_due_prompt_fires_once_with_no_window_and_restarts_a_dead_tab`
     (the headless exit: relaunch recorded with the tab's `PtyOptions`, a
     stale `working` ignored, delivered once with the preface, claim
     released, receipt, history row, once retired, never twice);
     `receipts_holds_and_failures_are_recorded_the_windows_way`;
     `two_windows_and_the_sidecar_fire_a_schedule_exactly_once` (three
     threads over one state dir; and the sidecar alone fires once);
     `concurrent_claims_through_the_file_lock_admit_one` (eight threads, no
     mutex on that path); `the_sidecar_stands_down_while_a_window_holds_the_timers`;
     `keys_reach_the_pane_on_a_private_socket` (a `cat` pane on `-L`, prefix
     first, the message's newline kept, `kill-server` after; skipped without
     tmux).
   - UI: the schedule dialog's "how delivery works" fold says who delivers
     now (`agentSchedule.openOnly`, pill `agentSchedule.headless`) and which
     timers still need a window (`agentSchedule.windowOnlyTimers`, pill
     `calendar.alarms.headless`); the schedule MCP `CONTRACT` says the same.
3. **Calendar reminders — done** (`de732275`): the notification path
   with no window is the existing Mobile Web Push (`push.rs`, kind
   `calendar`, the same notice the window's `notify` admin call sends).
   - `services/calendar_alarms.rs`: `due_alarms` / `alarm_time` /
     `alarm_window` / `muted_calendars` — the twin of `lib/calendar/alarms.ts`
     over `calendar_recurrence::expand_events` (`Occurrence.alarms` added;
     `Occurrence` lost `Eq` for it) — and the **fired record**
     `<state_dir>/calendar-alarms-fired.json` under its `FileLock`:
     `claim_in(path, keys)` answers the keys nobody had claimed and records
     them all (newest 500). This record, not the lease, is what makes a
     reminder show once across two windows and the sidecar.
   - The window (`alarms.ts::tick`) now claims through
     `calendar_alarms_claim` before showing and keeps `localStorage` as its
     local guard; a key another process claimed joins the local set unshown.
     A backend without the command (or a failing one) leaves the decision to
     the window, as before. Test: `CalendarAlarmClaim.test.ts` (2).
   - `services/mobile_control/alarms.rs`: a 30 s loop in `host::run`; while
     no window holds the lease, `due_to_push` reads `calendar.json`, claims
     the due keys, and each unmuted one becomes a `Notice { Calendar, title,
     "HH:MM · place" | "YYYY-MM-DD" (all-day), tag = key }` →
     `AuthStore::push_deliveries` → `push::send` (gone endpoints forgotten),
     journalled. No words to translate in the body on purpose. A muted
     calendar's reminders are claimed silently, as the window records them.
     Test: `reminders_reach_the_phone_once_with_no_window`.
   - No OS toast and no in-app popup with the window closed — there is no
     window; a phone with reminders on gets the push. A reminder the sidecar
     pushed is on record, so a window opened later does not show it again.
4. **Not moved, still under the window lease (recorded, by design):**
   auto-continue (`AgentContinueHost`: driven by the window's PTY output
   classifier and its own gates), the warm-up cron (`AgentCronHost`: types
   into tabs through the window's registry), CalDAV sync (`CalDavSyncHost`:
   the window's calendar store + credentials flow), git probing (never
   gated — a duplicate probe costs, never fires). Moving auto-continue and
   the cron would reuse `scheduler::TmuxRunner::deliver` + `ready`; CalDAV
   would need the sync client `AppHandle`-free and the credential lookup
   from the sidecar process. The dialog names the three.

**H2 parity gaps, recorded not fixed:** the sidecar does no after-link
chaining (`continueAfterDelivery`: a prompt chart's `after` edge is queued
by the window only — with no window a chain stops after its first hop until
a window opens and its `waitingForIdle` is gone, so the hop is then never
queued; the window's tick only chains deliveries it made) and no prompt
blame (`agent_prompt_blame`). A schedule bound to a tab of a project no
window has loaded still fires only from the sidecar (a window holding the
lease fires only for its loaded scopes — today's behaviour too). The sidecar
only exists while Mobile is enabled: with Mobile off there is no headless
owner, and schedules need a window, as before. A sidecar-delivered prompt
is not counted by the window's usage recap (`recordAuthorizedInput`).

## For H2 (where the timers hooked in — kept for the record)

- `pty_bridge` has the attach side (`tmux_attach_command`) if a tick ever
  needs to read the screen back (`local_tmux_screen_args`); the scheduler
  reads only `window_activity`.

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
  Rust twin. ~~Schedules/prompts writes need `FileLock` in
  `agent_tasks::mutate` / `agent_prompts` first.~~ Done in H2: every
  `agent_tasks` / `agent_prompts` transaction holds the file lock, and the
  path-based cores (`claim_in`, `complete_in`, `delete_in`, `record_at`,
  `delete_at`) are the pattern for `ScheduleMutate` / `PromptMutate` with no
  window (`upsert` still needs an `_in` twin). Mail stays behind the window.
- (H2) `TabPrompt` / `TabInput` with no window: `scheduler::TmuxRunner::deliver`
  is the typing path (reset, buffer paste, Enter) and `scheduler::ready` the
  idle gate; a phone "send now" headless is `submissions()` + `deliver`
  plus `agent_prompts::record_at` — the sidecar's `pty_bridge` already
  writes raw input into an attached session, so only the composer-safe
  submit is new.
- (H2) The window learns of a sidecar-fired schedule at its next load of
  the target (`agent-schedules-changed` is a Tauri event; the sidecar emits
  nothing). Its cached copy is stale until then; a second fire is impossible
  (claim + receipt), but the dialog's status row may lag one tick. A poke
  over the desktop socket, if H3 adds one for creates, should also refresh
  schedules and the alarm store.
- (H2) Timers still window-bound: auto-continue, the warm-up cron, CalDAV
  sync (see "H2 — the timers, as built", item 4). Their move would go beside
  `scheduler.rs` / `alarms.rs` in `host::run`.
