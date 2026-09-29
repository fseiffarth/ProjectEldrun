# Headless owner — handoff (H1 + H1b in progress)

*Written 2026-09-29 by the H1 agent, extended the same day by the H1b agent
(stopped early: usage limit). Plan: [`headless_owner_plan.md`](headless_owner_plan.md).
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
| `1981a679` | H3 draft | on the side branch `worktree-agent-a48b863224fa9d19d-h3-wip`, **not gate-clean**, not on this branch. See "For H3" below. Its `updatedVersion` half is now on this branch (`1a44acc1`); its `adoptSyncOutcome` half is not (H1b step 2, below). |

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
window (`WORKSPACE_PATCH_EVENT`); nothing listens yet.

**Frontend** (`src/stores/tabs.ts`): `TabEntry.id` / `SavedTabEntry.id`
round-trip (`toSavedTabEntry`, `loadFromLayout` keep it while `key` is
re-minted); `workspaceVersionByScope`; `hydrateScopeFromDisk` →
`loadWorkspaceSnapshot` (falls back to `load_tab_session` on an older
backend); `persistScope` → `syncWorkspace` (falls back to `save_tab_layout`)
and `adoptSyncOutcome` (version + minted ids only — see H1b step 2).
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
`storage::patch_json` now holds the `FileLock` too. Default apps: no CAS yet
(H1b step 7).

## H1b — status per step

The user accepted H1 as built; H1b completes what the plan meant by H1. The
step numbers are the coordinator's brief.

1. **`updatedVersion` — done** (`1a44acc1`). Test:
   `a_change_written_after_the_clients_base_is_kept_over_its_stale_copy`
   (uses `edit_in` as the "other writer"; the H3 draft's `rename/color/
   close_tab_in` were **not** ported — they are H3's). The two-client test's
   assertion flipped from "A" to "A renamed" (the rename now stands).
2. **Desktop `workspace:patch` listener — not done.** Port from the H3 draft
   (`git show 1981a679:src/stores/tabs.ts`, the `adoptSyncOutcome(scope,
   outcome, sentKeys)` version, and
   `git show 1981a679:src/__tests__/tabs/WorkspaceSync.test.ts`, 2 tests):
   it takes a newer label/colour from the answer and removes a tab this
   window *sent* (`sentKeys`) that the answer no longer holds, through
   `removeTabInScope` so the pane tree follows; `persistScope` passes `keep`
   as `sentKeys`. Then add a small `WorkspacePatchHost` (beside
   `layout/TimerLeaseHost.tsx`, mounted in `AppShell.tsx` next to it at
   ~line 1421) that `listen("workspace:patch")`s; when `version >` the
   scope's `workspaceVersionByScope` and the scope is hydrated, fetch
   `workspace_snapshot` and call `adoptSyncOutcome(scope, {version, tabs:
   tabLayout, ops, stale: true}, new Set(keys of tabsByScope[scope]))`. Note
   the listener only fires for Tauri-side syncs (a popout/second window); a
   sidecar write is another process and reaches a window at its next sync
   (stale answer) or hydrate. `adoptSyncOutcome` does not *add* tabs created
   elsewhere — leave that for H3 or state it.
3. **Owner-side minting — done on the owner** (`1a44acc1`,
   `mint_for_created`), **deviation on the client:** `tabs.ts`'s
   `withTmuxSession` / `newTmuxSessionName` were **kept**. Reason: a window
   creates the tab synchronously (`addTabToScope`) and `TerminalView` spawns
   the PTY on mount with `tab.tmuxSession`, *before* the debounced sync could
   answer a minted name; removing the client mint would spawn window-created
   tabs unwrapped. The owner's mint covers every other writer (the sidecar,
   a legacy client). Both mint the same shape; the Rust test
   `a_created_pty_tab_is_given_a_tmux_name_…` checks it against
   `expected_tmux`'s rules.
4. **Owner-side spawning — not done.** Design decided, nothing written:
   - `tmux_local.rs`: factor `wrap_pty_options_local`'s body into
     `local_tmux_argv(opts, detached: bool) -> Vec<String>` (same argv, `-d`
     inserted right after `-A`, same launcher-script fallback over
     `TMUX_ARGV_BUDGET`) and add `spawn_detached_with(opts, socket:
     Option<&str>) -> Result<(), String>` (Unix only): `paths::command_no_window("tmux")`
     (+ `-L socket` when given — for tests only; production passes `None`),
     `current_dir(opts.cwd)`, env `TERM=xterm-256color`, `COLORTERM`,
     `PATH = paths::effective_path()`, then `opts.env` into the client env
     (that is how the `SECRET_ENV` tokens reach the session via
     `update-environment` — never on argv, #864), `.output()`, non-zero →
     `Err(stderr)`. The existing test
     `a_real_tmux_session_gets_the_secret_from_the_client_environment` shows
     the private-socket pattern (`tmux -L eldrun-test-… -f /dev/null`, and
     `kill-server` at the end).
   - **The launch assembly must be shared, not copied** (plan §5): move
     `commands/terminal.rs::pty_spawn`'s body from the `opts.cwd.is_empty()`
     resolve (line ~264) through the tmux wrap (line ~762) into a new
     `services/launch_prep.rs::prepare(opts, session_name, pool:
     Option<&RemotePoolState>) -> Result<PreparedLaunch, String>` (async only
     for `remote::connect_host`; `None` + a remote project → `Err`).
     `PreparedLaunch { opts, named, interrupted, mcp_spawn_guard,
     resume_claim, fenced_registration, host_agent_tab, spawned_tab_id }`
     with `commit(self)` doing what `pty_spawn` does after a successful
     spawn (`guard.keep()`, `claim.keep()`, `register_tab`,
     `track/untrack_host_agent_tab`) and `mcp_token_handed_out()` for the
     `SESSIONS_EVENT` emit that stays in `pty_spawn`. Everything in that
     block is already `AppHandle`-free (`agent_fence`, `agent_home`,
     `agent_session`, `root_mcp::apply_*` — which no-op in the sidecar
     because `root_mcp::runtime()` is `None` there — `codex_bind`,
     `agent_turn::bind_tab`, `sandbox::enforce_spawn_authority`, the O#149
     cwd gate, `resolve_agent_remote_control`/`append_claude_name`/
     `vm_spawn_refusal`/`cwd_within`/`scope_root_for` move along).
     `pty_spawn` keeps: the crash-loop check, `terminal::spawn_pty`, the
     emit, `commit()`. The fence stays fail-closed by construction (same
     `decide`).
   - The sidecar then spawns a tab with no window: build `PtyOptions` (id
     `headless:<tmux>`, 80×24, `agent: kind == agent`, `project_id:
     Some(raw_id)` or `None` for `root`, `tmux_session: Some(minted)`,
     `schedule_target_id`), `launch_prep::prepare(opts, None, None).await`,
     `tmux_local::spawn_detached_with(&prepared.opts, None)`, `commit()`.
     The window later attaches through its ordinary restore (`loadFromLayout`
     keeps `tmuxSession`; `tmux new-session -A` attaches instead of creating).
     Known parity gaps to record, not fix: `--name`, `initialInput`
     (`/rename`) and the Remote-Control flag come from the window's
     `TerminalView`; a sidecar-started agent runs without them until it is
     restarted from a window.
5. **`tmux -L eldrun` — decided: keep the default socket.** Sessions cannot
   move between tmux servers, so a switch needs a union of two servers
   (`-L eldrun` for new sessions, default for the live ones) at every
   touch point: `tmux_local::{kill_eldrun_sessions, local_tmux_*_args}`,
   `commands/terminal.rs::local_tmux_{list,kill,rename…}`,
   `discovery::live_tmux`, `pty_bridge::{tmux_attach_command,
   tmux_capture_command, tmux_window_size_command}`, the phone's screen
   capture (`local_tmux_screen_args`), `agent_fence::live_unfenced_by_scope`
   (pane pids), plus per-name server resolution (`has-session` on each) for
   attach/kill/rename. A window that has not restarted keeps spawning on the
   default socket. The gain (a private server) is small against the reach
   of that migration and the user's live sessions; a private socket is only
   used by tests (`spawn_detached_with(_, Some(..))`). Record this in the
   plan's status block when H1b closes.
6. **Headless `Catalog` / `Activity` / `GitStates` / `Create` — not done.**
   Design decided:
   - `host.rs`: each route's `match admin::desktop_call(..)` gets an arm for
     `desktop_down(&response)` (helper exists, line ~300) that answers from
     `headless::*` with `desktop_available: false`. Routes: `project`
     (Catalog, ~line 620), `activity` (~542), `projects` (GitStates, ~480),
     `create_tab` → `create_through_desktop` (~824).
   - `headless.rs` additions: `agents(state_dir, host_key) ->
     Vec<AgentCatalogEntry>` = built-ins in `discovery::resumable`'s list
     that are installed (`commands::agents::binary_is_installed(bin)`) and
     not in `settings.json`'s `extra["disabled_agents"]`, id =
     `key_id(host_key, "agent", &[bin])` (what the desktop's
     `mobile_opaque_id("agent", cmd)` mints), `modes: []` (the desktop sends
     none too); custom agents skipped (need `probe_binaries`; say so).
     `statuses(...)`/`timings(...)` from the hooks' turn records
     `<state_dir>/live_sessions/<uid>.turn` and
     `<live_sessions>/<project_key>/<uid>.turn` (`agent_turn::parse_turn_record`;
     uid = the tab's `session_id`): working→`working`, decision→`question`,
     done→`done`, idle→none; the record's second word is epoch seconds →
     `working_at`/`done_at` in ms; model via
     `agent_session::agent_session_model(cmd, Some(project_id), uid)`.
     `prompts` via `agent_session::agent_session_recent_prompts(cmd,
     Some(project_id), uid)` → `AgentTabPrompts{tmux_session, prompts:[{text,
     at}]}`. Schedule summaries from the existing `headless::schedules` per
     tab with a `schedule_target_id` (total / enabled / next = min of
     `next_runs` / upcoming ≤ 3). `closed: []`. Git dot:
     `commands::git::git_status_probe(dir, false)` +
     `git_unpushed_commits_blocking` (both sync, hardened git; run in
     `spawn_blocking`; cache 10 s per project in a new `HostState` field —
     the projects route is polled every few seconds).
   - `headless::create_tab(state_dir, host_key, project: &ResolvedProject,
     request: CreateTabRequest, launch: impl AsyncFnOnce(PtyOptions) ->
     Result<(), String>) -> Result<String /*tmux*/, &'static str /*code*/>`:
     refuse with `desktop_unavailable` what needs the window (`local`,
     `sign_in`, `cloud`, `worktree`, `like_tab`, a `mode`); `kind: shell` →
     label "Shell", cmd ""; `kind: agent` → bin from the agents list above
     (`unknown_agent` otherwise), label = registry label, `sessionId` =
     uuid, `env.ELDRUN_TAB_UID` = it, args `["--session-id", uuid]` for
     `claude`/`gemini` only (mirrors `newTabItems.ts::buildStaticTabSpec`);
     cwd = `project.root`; `mobileRequestHash = key_id(host_key, "request",
     &[idempotency_key])`; then `workspace::create_tab_in(session_path, raw_id,
     tab, Some(hash))` (persist first), then `launch(opts)`; on launch
     failure `edit_in` the tab back out and answer `launch_failed`. The
     route seam (`launch`) is what the host test stubs; the real closure is
     `prepare` + `spawn_detached_with(.., None)`. `created_through_desktop`'s
     40×125 ms catalog poll then finds the tab (`available` needs the
     session on the default socket → in a unit test with a stubbed launch
     the row is there with `available: false`; assert on the session file
     and the catalog row, not on `available`).
   - Exit test for the brief (backend): a `#[tokio::test]` in `host.rs`
     posting `/api/v1/projects/{id}/tabs` with no desktop socket, a stubbed
     launch recording the `PtyOptions`, asserting the session file gained
     an owner-minted tab (id, `eldrun-<raw>--agent-…`, `scheduleTargetId`,
     `mobileRequestHash`), that the recorded options carry
     `tmux_session == that name`, that a repeat post creates nothing, and
     that the answer leaks no raw id / path / tmux name. Plus a `#[cfg(unix)]`
     `tmux_local` test that `spawn_detached_with(.., Some(private socket))`
     creates a session `has-session` finds (kill-server after). The
     `launch_prep` move is covered by the existing terminal/fence tests
     (behaviour-preserving move; `cargo test --no-fail-fast`).
7. **Default apps CAS — not done.** `commands/default_apps.rs`: add
   `patch_default_apps { set: HashMap<String,String>, remove: Vec<String> }`
   on `storage::patch_json(path, DefaultApps::default(), |apps| …)`; make
   `save_default_apps` go through `patch_json` too (whole replace under the
   lock; kept for older frontends). Register in `lib.rs` next to
   `save_default_apps` (~line 1387). Callers: `SetDefaultAppDialog.tsx`
   (~line 152: `set {ext: exec}` or `remove [ext]`) and
   `SettingsSubPanels.tsx::FileTypeSettings` (~line 285: diff `apps` vs
   `next` into set/remove), both with the `isUnknownCommand` fallback to
   `save_default_apps` (pattern in `tabs.ts::syncWorkspace`). Give the
   dialog an `UntestedTag` (`setDefaultApp.patch` row in
   `src/lib/untested.ts`, area `files`).

**Untested pills owed for H1b** (none added yet): the patch listener has no
visible control — the register test requires a call site per row, so tag
the nearest visible surface (the default-apps dialog for step 7; for step 6
the phone's project screen already renders `desktop_available: false`
read-only hints in `mobile-web`, and `isUntested("mobile.…")` rows are used
there — add `mobile.headless.create` on the ＋ sheet's create button).

**Manual checks owed (the plan's H1 exit, once steps 4 + 6 land):** quit
Eldrun cleanly (the window's ×; this also reaps every `eldrun-*` session —
so start the Mobile sidecar first or leave it running as its systemd unit);
on the phone open a Mobile-enabled project, press ＋, start Claude; the
row should appear within ~5 s with the tmux name hidden; relaunch Eldrun,
open the project: the new Claude tab is there and attached to the running
session (its screen shows the CLI already started, not a fresh launch);
`tmux ls` on the desktop shows one `eldrun-<project>--agent-…` for it.
Also: with the window closed, the phone's project list shows git dots and
the Agents list shows the working/done state of a tab that ran a turn.

## Deviations from the plan (all recorded in the plan's status block, except the H1b ones — add them when H1b closes)

1. Owner = versioned file + lock, both processes run the service (above).
2. Ops are derived by the service from the client's snapshot against its base
   version, not sent one by one; the store's internals are untouched.
3. **No `tmux -L eldrun`** (H1b step 5, reasons above); owner-side spawning
   pending (step 4). Names: the owner mints for created tabs lacking one;
   the window still pre-mints its own (step 3, reason above).
4. Per-client layout split at the API only (no second file).
5. Default-apps CAS pending (step 7).
6. `Catalog` / `Activity` / `GitStates` / `Create` still answered by the
   window (step 6 pending; the sidecar's file catalog already marks
   `desktop_available: false`).
7. ~~Field edits last-writer-wins by client~~ — fixed in `1a44acc1`
   (`updatedVersion`).

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
- The post-commit hook prints "EMBEDDED MOBILE PWA IS STALE" — expected, the
  running app was never restarted.
- ESLint: 31 pre-existing warnings (0 errors) in files this work never
  touched (`TerminalView.tsx`, `TodoAgendaRail.tsx`, `notebook.ts`,
  `mobile-web/.../Terminal.tsx`).

## Gate status (at `1a44acc1`, the branch tip)

- `cargo test --no-fail-fast`: **2927 lib tests** (+3 over `c5fee054`) and
  every integration binary green; the one wall-clock test above failed in
  the parallel run and passed alone.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run build`, `npm test`, `npm run lint`: **not rerun for `1a44acc1`**
  — no file under `src/`, `mobile-web/` or `package.json` changed since
  `c5fee054`, where they stood at green / **632 files, 6447 tests** / 0
  errors + 31 pre-existing warnings. Rerun them before the next frontend
  commit and compare the count.
- `git diff --check` clean; `scripts/privacy-check.sh` passed on the staged
  commit.

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
- **Where a sidecar-side tick sends keys into a tab (once H1b step 4 lands):**
  the tab is named by its tmux session (`workspace::tmux_of`, the catalog's
  `ResolvedTab::tmux_name`); delivery is `tmux send-keys -t =<name>: -l
  <text>` then `send-keys -t =<name>: Enter` through
  `paths::command_no_window("tmux")` on the default socket (the same server
  the window's and the sidecar's spawns use — step 5 kept it). If the
  session is not live (`tmux has-session -t =<name>` fails), the sidecar can
  start it with the step-4 path (`launch_prep::prepare` +
  `spawn_detached_with`) from the tab's persisted record (`cmd`, `cwd`,
  `sessionId`, resume via `agent_session::resolve_agent_session`) and then
  deliver — that is "fires once with no client". The lease then only has to
  say whether a window holds the timers; the sidecar takes them when none
  does (`timer_lease::acquire_in` from the sidecar process, same file).
- `pty_bridge` has the attach side (`tmux_attach_command`) if a tick needs to
  read the screen back (`local_tmux_screen_args`).

## For H3

- The draft on `worktree-agent-a48b863224fa9d19d-h3-wip` (`1981a679`):
  `workspace::{rename,color,reorder,close}_tab_in` by tmux name (build them
  on this branch's `edit_in(path, scope, …)` + `tmux_of`); `host.rs`
  fallbacks; `adoptSyncOutcome` reconcile (now H1b step 2).
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
