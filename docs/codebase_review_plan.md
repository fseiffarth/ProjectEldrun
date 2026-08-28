# Codebase Review Plan — 2026-08-27

Merged findings of five parallel review agents, each covering one slice of the
repository: frontend application logic (`src/`), CSS/UI unification, Rust
backend (`src-tauri/src/`), the remote/sync/security-sensitive subsystem, and
performance/bundle/cruft. Every finding below was **code-verified** by the
reporting agent (file:line refs as of `develop`, 2026-08-27); speculative items
were dropped. Overlaps found independently by two agents are merged and marked
*(×2)* — independent confirmation, higher confidence.

Severity: **HIGH** = real user-visible defect or data-safety risk;
**MED** = correct-in-common-case but breaks under load/race/locale, or
substantial maintenance debt; **LOW** = cheap cleanup, cosmetic, or
defense-in-depth.

Nothing here has been fixed yet — this document is the work plan. Tick items as
they land.

## Top priorities

1. Byte-sync rsync fast path copies `.git`/nested repos/symlinks (§1.1) — data-safety.
2. `projects.json` non-atomic writes + default-on-corruption wipe (§2.1) — registry loss.
3. `setViewerState` guard silently drops viewer-state persistence (§3.1).
4. Sync Tauri commands freezing the window: app launch, project search, archive/import, spreadsheet/sqlite (§4).
5. 6.8 MB startup chunk: lazy viewers + split i18n dictionaries + defer mermaid/katex (§5).
6. `--accent-color` / phantom CSS tokens — styles silently not rendering, wrong colors in all themes (§7.1–7.2).
7. Manual sync push/pull bypasses `drop_tracked` under lockstep (§1.2).
8. Blurred-box-shadow animations violating the repo's own WebKitGTK rule (§7.3).
9. Eldrun Mobile desktop surface fully hardcoded English (§8.1).
10. `fs-change` debounce drains 5 events/sec — minutes-stale file tree after bursts (§4.4).

---

## 1. Remote sync & git lockstep

Highest-stakes area: these findings touch user data. Credentials/VPN, the
mobile sidecar, and frontend remote gating were audited and came back **clean**
(see §12).

- [x] **1.1 HIGH (invariant violation)** — The rsync fast path copies `.git`,
  `.eldrun`, nested repos, and symlinks — everything the SFTP walker exists to
  exclude. `rsync_pull_args` (`src-tauri/src/services/remote_sync.rs:677-696`)
  builds exactly `["-a","-c","-e",<ssh>, target, dest]` with **no excludes**;
  `pull_subtree` (`src-tauri/src/commands/sync.rs:1707`) takes this path for any
  directory pull including whole-project "Sync all". The walker it bypasses
  (`remote_sync.rs:530-540`) skips `.eldrun`, `.git`, nested-repo boundaries
  (#23 D2), and all symlinks (G3). Failure: with lockstep on and rsync present
  both ends (the common Linux case), a confirmed "Sync all" overwrites the
  mirror's `.git/` with the host repo's bytes — possibly mid-write — corrupting
  lockstep's model of the mirror repo; the transfer preview
  (`commands/sync.rs:1230-1296`) prices from the walker listing so the user
  approves a transfer that writes files the preview never named, and
  `local_loss` audits none of them. Fix: add
  `--exclude=/.git --exclude=.eldrun --exclude=.git` (plus a nested-`.git`
  pre-probe or dir-merge rule) and `--no-links`; or refuse the fast path when
  `rel == ""` on a git-backed mirror.
- [x] **1.2 MED (invariant violation)** — Manual push/pull never subtracts the
  lockstep-owned tracked set; the `drop_tracked` split holds only for the
  background engine (`services/sync_auto.rs:341-350, 414-418`). `sync_push`
  (`commands/sync.rs:1419-1440`) and `pull_subtree` (`:1650-1741`) filter only
  `is_excluded`. Failure: a whole-mirror byte-push of tracked files lands them
  as loose bytes on the host — the #28p D1 wedge; uncommitted tracked edits
  pushed this way leave the host tree dirty and every later `merge --ff-only`
  refused, a standing red "blocked" state with no obvious cause. Fix: apply
  `drop_tracked` (or a filter over `git_peer::tracked_paths`) in both commands
  when lockstep is on, surface a "N tracked files travel as commits" count, and
  fold in the rsync-path fix (1.1).
- [x] **1.3 MED (race)** — No per-project serialization between the git_peer
  poll loop and the manual commands. `git_peer_sync_now`/`pair_confirm`/
  `checkout`/`resolve`/`restore_backup` (`commands/git_peer.rs:65-230`) call
  straight into `detect_and_sync`/`reconcile_with` while `poll_loop`
  (`services/git_peer.rs:3322-3398`) runs the same passes every 12 s. Both use
  the same fixed bundle paths (`git_peer.rs:1223-1230`), and `cleanup_bundles`
  (`:2008-2020`) can delete the file the other pass is still uploading. No data
  loss (update-ref validates objects; force paths are user-gated) but transient
  red "Sync failed"/"blocked" flashes for work that was fine, and
  `git_peer.json`/`local_loss.json` are last-writer-wins. Fix: per-project
  `tokio::Mutex` around the reconcile body (shape already exists as
  `WorkerSyncRegistry.in_flight`), or per-pass unique bundle names.
- [x] **1.4 LOW (bug)** — The `.git` watcher never attaches when the mirror repo
  is created *after* `start()` (`services/git_peer.rs:3264-3279` checks
  `gitdir.exists()` once). A fresh remote project's mirror repo is created by
  initial pairing — after start — and `worker_sync::fan_out` fires only from
  the watcher branch (`:3384-3394`) and the initial call, never from the
  interval arm. Commits silently stop reaching workers until reconnect or a
  manual "Sync code now". Fix: re-attempt attach on the interval tick, mirroring
  `sync_auto::ensure_watcher` (`sync_auto.rs:222-250`).
- [x] **1.5 LOW (bug)** — `worker_sync_now` bypasses the in-flight guard the
  registry exists for: `commands/remote.rs:345-352` calls
  `worker_sync::sync_worker` directly instead of `sync_worker_guarded`
  (`worker_sync.rs:406-427`). A manual sync racing a commit-triggered fan-out
  has two writers on the same bundle files → corrupted bundle → spurious error
  (recoverable). Fix: route through the guarded entry.
- [x] **1.6 LOW (bug)** — `parse_outputs_listing` breaks on git's
  `core.quotepath` quoting (`services/worker_sync.rs:461-490`): any non-ASCII
  output path (`ergebnisse-übersicht.csv`) is stat'd and pulled as its quoted
  literal → nonexistent SFTP path → lands in `errors`. The listing script also
  uses GNU-only `stat -c %s` (0-byte previews on BSD/macOS workers). Fix:
  `git -c core.quotepath=false ls-files` (or `-z` + NUL split); portable stat.
- [x] **1.7 LOW (bug)** — `pull_file` writes the mirror non-atomically
  (`remote_sync.rs:583` plain `fs::write`) while the push side carefully does
  temp+rename (`push_file_atomic`, `:812-840`). A crash mid-pull leaves a
  truncated mirror file surfacing as a spurious both-sides-diverged conflict.
  Fix: same temp+rename locally.
- [x] **1.8 LOW (race)** — `local_loss` unlocked read-modify-write
  (`services/local_loss.rs:114-119` record, `:157-166` ack_all); git_peer poll
  task and manual sync commands are genuinely concurrent recorders, so two
  simultaneous losses can drop one entry — in the file whose whole purpose is
  never losing the warning. Fix: static `Mutex` around load/save (the
  `PROJECTS_CACHE` pattern, `remote.rs:104`).
- [x] **1.9 LOW (dead code + latent bugs)** — `sync_now`
  (`commands/sync.rs:209-258`) + `useSyncStore.syncNow`
  (`src/stores/sync.ts:451-453`) have no production caller (test-only; the
  GitHistory button is `git_peer_sync_now`). If ever wired as-is it would
  ignore `is_excluded`, ignore the tracked set, and skip `confirmSyncTransfer`.
  Fix: delete both ends (or fix all three gaps before exposure).
- [x] **1.10 MED (efficiency)** — The auto-sync pass re-stats every candidate
  over SFTP although `walk_host_files` already returned size+mtime
  (`services/sync_auto.rs:395-431`): N extra *serial* SFTP round trips per 25 s
  pass. Fix: carry the walk's `(size, mtime)` through; stat only explicit
  `auto_files` and mirror-only candidates.
- [x] **1.11 LOW (efficiency)** — `connect_host` awaits the bounded keychain
  read inline on the async runtime (`services/remote.rs:361-365`; up to 4 s on
  a locked Secret Service, one parked worker per host during multi-host
  activation) while the command layer consistently `spawn_blocking`s the same
  reads (`commands/ssh.rs:529`, `commands/openvpn.rs:104`). Fix: match the
  siblings.
- [x] **1.12 LOW (hardening)** — The VM egress proxy never restricts the
  destination **port** (`services/vm_proxy.rs:128-163`): an in-VM agent may
  CONNECT to `allowed-host:22`. Fits the doc's "narrows the channel" framing as
  a nit — restrict to 443 or log non-443 as a tripwire event.
- [x] **1.13 LOW (duplication)** — `conn_key`'s `\u{1}` composite-key format is
  rebuilt by hand outside its owner (`worker_sync.rs:414` vs
  `remote.rs:45-47`). Export the constructor so the separator can't drift.
- [x] **1.14 LOW (duplication)** — `pairing_dest_probe_error`
  (`git_peer.rs:2638-2648`) is a tested pure function the production path
  doesn't call; `reconcile_with` re-implements it inline (`:2476-2480`), so the
  wipe-safety rule (#28p D3.4) can regress with the suite green. Fix: call the
  function. Related: `cleanup_bundles` ignores three of its six parameters.

## 2. Persistence & JSON stores

- [x] **2.1 HIGH (bug)** — `projects.json`: non-atomic whole-list writes +
  default-on-corruption readers that write back. `write_json`
  (`src-tauri/src/storage.rs:16-26`) truncates in place; ~23 sites rewrite the
  whole list with it (`commands/projects.rs:493,564,767,857,1052,1094,1338,
  1447,1722,1772,1920,2008,2207,3038,3360,3497,3665`, `commands/hpc_ws.rs:896,
  1011`, `commands/git_hosting.rs:97`, `services/vm.rs:850`). Several
  read-then-write sites parse with `unwrap_or_default()` — a torn file becomes
  an empty list, gets one entry pushed, and is **written back**, permanently
  erasing every other project's registration (`restore_archived_project`
  `projects.rs:849-857`, `create_project` `:3009-3038`, `finish_import`
  `:3233`, `read_projects_list` `:342-348`). Writers are genuinely concurrent:
  main-thread setters vs `vm::ensure_booted` on `spawn_blocking`
  (`commands/vm.rs:67` → `services/vm.rs:850`) vs async `hpc_ws_move_root` /
  `extend_project_to_remote`. Fix: one `patch_projects_list(|list| …)` helper
  behind a process-wide mutex, `write_json_atomic`, and parse errors
  propagated — a parse failure on an existing file must never mean "no
  projects". (Natural home: the `patch_project_entry` consolidation, §9.3.)
- [x] **2.2 MED (bug)** — `write_json_atomic` uses one fixed temp name per
  target (`storage.rs:46-48` — always `path.with_extension("json.tmp")`), so
  two concurrent writers of the same store can rename each other's half-written
  temp into place — exactly the two-writer case it advertises for
  (`usage_stats.json` frontend flush vs watcher flush; `calendar.json` CRUD vs
  CalDAV). Fix: unique temp names (pid+counter or `NamedTempFile::new_in`), or
  a per-path write lock.
- [x] **2.3 MED (race)** — `calendar.json`: unsynchronized read-modify-write
  between main-thread CRUD (`commands/calendar.rs:826-905` sync commands via
  `read_data`/`write_data`, `:36-53`) and the background CalDAV merge on the
  blocking pool (`commands/caldav.rs:454-500` → `merge_caldav_calendar_at`).
  Whichever writes last silently discards the other's edit set — and the
  dropped merge's sync tokens were already advanced, so those changes are not
  re-fetched until the next ctag change. Fix: one mutex (or single-writer
  actor) around the calendar RMW; persist tokens only after a landed merge.
- [x] **2.4 MED (race + wipe)** — `time_summary.json`: `record_secs`
  (`schema/time_log.rs:139-176`) = `unwrap_or_default()` load → add →
  non-atomic save, errors swallowed. Main-thread timer flushes
  (`commands/timer.rs:9,18`) race the project-switch worker thread
  (`services/project_runtime.rs:69,393-397`): a race loses seconds; a torn read
  resets the **entire time history** and persists the reset. Fix: atomic write,
  one lock, propagate parse errors on an existing file.
- [x] **2.5 LOW (race)** — `usage_stats.json`: `record` is unlocked
  load→add→save (`schema/usage_stats.rs:281-289`) called from the watcher
  thread (`services/usage_stats.rs:395`) and the blocking pool
  (`commands/usage_stats.rs:37-41`) — lost counters. Best-effort stats by
  design; fix alongside 2.2.
- [x] **2.6 LOW (bug)** — `settings.json` and `terminals.json` written
  non-atomically on hot paths: `save_settings` + per-window-drag debounced
  `save_window_state` (`commands/settings.rs:35,57`); tab-layout writes
  (`services/terminal_service.rs:131,167,462,502`) with a
  `unwrap_or_default()` reader (`:189`) that silently drops the whole tab
  layout after a torn write. Cheap fix: switch to `write_json_atomic` (after
  2.2).

## 3. Tabs, scopes & viewer-state persistence (frontend)

- [x] **3.1 HIGH (bug)** — `setViewerState` silently drops patches to any field
  missing from its hand-maintained equality guard
  (`src/stores/tabs.ts:2417-2454`, list at `:2426-2446`). Verified broken
  persistence: `yamlCollapsed` (`YamlTree.tsx:114`), `gridFocus`
  (`YamlGrid.tsx:80`), `delimiter`/`columnWidths` (`TableView.tsx:237,318`),
  `bibSort`/`bibSortDesc`/`bibCollapsed` (`BibCards.tsx:99-136`), `breakpoints`
  (`FileViewerPane.tsx:5188`), `pdfAutosaveNotes`/`pdfCopyOnSelect`
  (`PdfViewer.tsx:1963,2202`), `deckRailWidth` (`DeckView.tsx:1404`).
  `ViewerStatePersist.test.ts` only exercises compared fields, so tests pass.
  Fix: generic shallow compare over the union of keys of `cur` and `merged`.
- [x] **3.2 MED (bug)** — Box-scope switches have no flush path: the 300 ms
  persist debounce is cancelled on scope change (`CenterPanel.tsx:327-342`) and
  the explicit flush covers root only (`stores/projects.ts:1162-1177`);
  `openBox` just calls `setScope` (`stores/boxes.ts:259-274`). A tab
  opened/closed/moved within 300 ms of entering/leaving a `box:<id>` scope is
  never written — the exact failure mode the root fix's own comment describes.
  Fix: flush the outgoing scope in `openBox` and on leaving a box scope.
- [x] **3.3 MED (bug)** — Root and box restore probes omit `resumeArgs`
  (`CenterPanel.tsx:214,220-228`; `stores/boxes.ts:111-120,135-141`) while the
  project-scope path includes it (`projects.ts:985-993`, `tabs.ts:4098-4105`).
  `isResumableAgentTab` (`tabs.ts:4429-4439`) accepts a custom agent only via
  `resumeArgs?.length`, so a saved custom-agent tab restores in a project scope
  and silently vanishes in root/box scopes. Fix: pass `resumeArgs` through —
  or resolve via 3.4.
- [x] **3.4 MED (duplication)** — Four hand-rolled copies of "hydrate a scope
  from `load_tab_session`": `restoreProjectScopeInner`
  (`projects.ts:980-1002`), `restoreBoxScope` (`boxes.ts:105-152`), the root
  restore (`CenterPanel.tsx:230-268`), `hydrateThenCreateInScope`
  (`tabs.ts:4090-4130`). Already drifted (3.3; per-copy `LayoutEntry` types).
  Fix: one shared `hydrateScopeFromDisk(scope, defaultCwd, opts)` in
  `stores/tabs.ts`.
- [x] **3.5 MED (duplication)** — The ~20-field persisted tab-entry shape is
  maintained field-for-field in two places: `persistScope`'s `tabLayout` map
  (`tabs.ts:4189-4232`) and `setActive`'s switch snapshot
  (`projects.ts:1242-1275`); the code's own comment records that drift here has
  already lost `folder`, viewer scroll state, `agentMode`, and tmux names. Fix:
  one `toSavedTabEntry(t: TabEntry)` used by both.
- [x] **3.6 LOW (duplication)** — `addTab` and `addTabToScope` are
  near-identical (`tabs.ts:2040-2075` vs `:2077-2114`). Fix: implement
  `addTab` as `addTabToScope(get().scope, …)` with `seeded` threaded through.
- [x] **3.7 LOW (bug)** — Split-divider drags handle no `pointercancel` in
  either window (`CenterPanel.tsx:1648-1662`, `DetachedCenterPanel.tsx:593-599`)
  although the same file documents that WebKitGTK "frequently fires
  `pointercancel` INSTEAD of `pointerup`" (`CenterPanel.tsx:570-578`) and every
  other drag path routes through `dragPlatform.cancelCommits`/`bindDragRelease`.
  Also no unmount cleanup for a mid-drag listener pair. Fix: add
  `pointercancel`/`bindDragRelease`.
- [x] **3.8 LOW (duplication)** — Divider-drag fraction math duplicated between
  main window and popout (`CenterPanel.tsx:1612-1646`,
  `DetachedCenterPanel.tsx:577-592`). Fix: pure
  `dividerFraction(node, dividerIndex, pos, total, minPx)` next to
  `applyResize` in tabs.ts.
- [x] **3.9 MED (duplication)** — TabBar re-implements NewTabMenu's entire
  ~80-line data-plumbing block (`TabBar.tsx:264-345` vs
  `NewTabMenu.tsx:73-161`): agent registry probe + event listener, enabled/
  compact/custom agents, `probe_binaries`, local drivers — verbatim in both, so
  the two "+" menus can drift. Fix: extract `useAddTabMenuData(scope)`.

## 4. Main-thread freeze class (sync Tauri commands)

The repo has paid for this pattern twice already (tex recompile, remote git
commands); `commands/git.rs:394-401` shows the canonical fix — `async fn` +
`spawn_blocking`, zero frontend change. These commands still run synchronously
on the main thread: *(several found independently by two agents)*

- [x] **4.1 HIGH** — App-launch X11 window resolution sleep-polls up to 2–4 s:
  `find_window_for_pid`/`find_new_window` (`commands/apps.rs:1819-1832,
  1869-1882`, 20 × 100 ms each, fresh xcb connection per poll) called from sync
  `launch_app` (`:225`), `do_launch` (`:131`), `open_file` (`:343`, worst case
  chains both → ~4 s), and `restore_open_apps` (`:1730`, N apps × 2 s during
  project activation). Single-instance apps (spawned pid execs and exits, no
  window ever carries it) hit the full budget every time. Fix: async +
  `spawn_blocking`, or return immediately and back-fill `window_id` from a
  background thread (`resolve_window_id_for_pid` already exists as the
  non-blocking variant).
- [x] **4.2 HIGH (×2)** — `project_search` walks the whole tree and reads every
  file ≤ 8 MiB synchronously (`commands/search.rs:194-216`) — the window
  freezes for the duration of every search on a large project.
- [x] **4.3 MED (×2)** — Sync commands with work proportional to project/
  archive/file size:
  - `commands/projects.rs`: `archive_project` (`:711`; also calls
    `vm::shutdown` inline — seconds), `restore_archived_project` (`:801`),
    `move_remote_mirror` (`:2229`), `create_project` (`:2849`),
    `import_project` (`:3101`).
  - `commands/fs.rs`: `extract_archive` (`:1125`), `import_external_file`
    (`:1048`), `copy_path`/`move_path` (`:998,1015`), `list_project_paths`/
    `list_project_endings` (`:702-717`) — full recursive walks behind Ctrl+P/
    QuickOpen; the skip list (`fs.rs:2049-2054`) also misses `.venv`, `venv`,
    `__pycache__`, `.tox`, so a 50k-file venv is walked on the main thread
    every Ctrl+P.
  - `commands/sheets.rs:59` `read_spreadsheet` (calamine loads the whole
    workbook); `commands/sqlite.rs:63-71` `sqlite_tables`/`sqlite_page`
    (arbitrary dropped `.db`, possibly on a network mount).
  - `commands/workspace.rs:125-186` `network_conn_type` — spawns `netsh`
    (100–500 ms, uncapped `output()`) / `route`+`networksetup` synchronously,
    polled every 10 s by the header (`HeaderBar.tsx:86-94`).
  Fix for all: async + `spawn_blocking` (+ Python vendor dirs in the Ctrl+P
  skip list; a time cap for `netsh` like `printing.rs`'s `run_capped`).
- [x] **4.4 MED (bug)** — The `fs-change` debounce thread drains its queue at
  5 events/second: `recv()` → `sleep(200 ms)` → generation check, one sleep
  **per queued message** (`commands/fs_watch.rs:71-90`). A burst of 600 raw
  events (archive extraction, build output, `git checkout`) ≈ 2 minutes with no
  emit — presents as "file tree stopped updating". Fix: greedy
  `try_recv()`-drain to the newest generation before sleeping (one sleep per
  burst).
- [x] **4.5 LOW** — Calendar/board commands are sync whole-file RMWs on the
  main thread (`commands/calendar.rs:836-890`; calendar.json "written on every
  drag"). Fine today, jank as CalDAV calendars grow — make async while fixing
  2.3.

## 5. Startup & bundle size

- [x] **5.1 HIGH** — 6.8 MB monolithic startup chunk (of 13 MB `dist/`); the
  only `React.lazy` in the app is the dev-only perf host
  (`AppShell.tsx:89`). Every viewer is statically imported into
  `FileViewerPane` (`src/components/embed/FileViewerPane.tsx:128-175` —
  TableView, NotebookView, SqliteView, PdfView, DeckView), so pdfjs-dist
  (~1.1 MB) + pdf-lib + fontkit are parsed at every launch — and again per
  detached/audience window (single Vite entry, `vite.config.ts`). Fix:
  `React.lazy` the leaf viewers behind the existing dispatch switch; the
  Suspense boundaries are cheap.
- [x] **5.2 HIGH** — `src/lib/i18n.ts` ships all five dictionaries eagerly:
  2.24 MB / 26,455 lines (`en` ~:47, `de` :5389, `es` :10641, `fr` :15891,
  `it` :21141), roughly 1.5–1.7 MB of the startup chunk for languages not in
  use. Fix: split each non-English dict into its own module, `import()` on
  selection; the store already seeds language from a localStorage cache before
  settings load, so preloading `en` + the cached language keeps first paint
  correct.
- [x] **5.3 MED** — mermaid + katex (+ katex CSS and its ~60 font files)
  initialized at module evaluation (`lib/viewers/markdownEnrich.ts:30-37`
  static imports + top-level `mermaid.initialize`), i.e. at startup of every
  window regardless of use. The module is a perfect seam: `FileViewerPane.tsx:34`
  imports exactly one function called from a post-render effect. Fix:
  `await import("../../lib/viewers/markdownEnrich")` at the call site.

## 6. Background cost & polling

The interval/rAF gating discipline otherwise **holds everywhere it was
audited** — all 60 frontend `setInterval` sites and all rAF loops were checked
individually (see §12). These are the exceptions:

- [x] **6.1 MED** — `net_usage` spawns a system-wide `ss -H -t -i -n -p` scan
  *per connected project* every 5 s (`services/net_usage.rs:119-152` →
  `commands/network.rs:544-588`); `-p` resolves socket→process by scanning
  every `/proc/<pid>/fd` on the machine, and the output is system-wide yet run
  N times per tick with all but one master's rows discarded (plus again at 1 Hz
  when the Network pane is open). Fix: run `ss -tinp` once per tick, slice per
  project; keep the per-master `ssh -O check`.
- [x] **6.2 MED** — `useAlertsFeed` arms one 60 s urgent-mail poll per mounted
  file-viewer instance (`src/components/files/useAlertsFeed.ts:180-185`; the
  hook's own comment notes the viewer "is mounted many times at once"), and
  `newCount` in the dep array re-fires the query N× on every mail delivery;
  `TodoMailRail.tsx:54` duplicates the same interval. With a right panel + 4
  Files tabs: 6 identical mail queries/minute in an app that runs for days.
  Fix: hoist to a refcounted module-level poll — the exact retain/release
  pattern of `stores/hostSessions.ts:117-160`.
- [x] **6.3 LOW** — `gitDirty` refresh fires `git_status` **and**
  `git_unpushed_commits` per active local project per 12 s tick
  (`stores/gitDirty.ts:90-95`, `ProjectSwitcher.tsx:184-192`); the unpushed
  probe runs even for non-repos and is only consulted when the tree is clean.
  ~150 git spawns + 300 IPC round trips/minute at 15 projects where half would
  do. Fix: one combined `git_dirty_probe` backend command computing unpushed
  only when clean.
- [x] **6.4 LOW** — `DESCENDANT_CACHE` holds a single entry keyed by root set
  (`src-tauri/src/sysstat.rs:188,217-247`): alternating project-pill hovers
  and the renderer watchdog evict each other and re-walk the full process
  table each sample. Fix: small keyed map (2–4 entries, same TTL).
- [x] **6.5 LOW (note)** — `codex_bind`'s global poller never stops once armed
  (`services/codex_bind.rs:282-293`); empty-tick cost is a mutex lock + 2 s
  sleep — negligible, act only if the empty tick ever grows work. Reviewed
  2026-08-28: left as-is, no code change.

## 7. UI & CSS unification

All styling lives in `src/styles/themes.css` (28.6k lines) + three satellite
CSS files; refs are into themes.css unless noted. The canonical menu chrome,
dialog chrome, hover cards, and scrollbar system were verified healthy —
findings are the divergences.

### Tokens

- [x] **7.1 HIGH (style bug)** — `--accent-color` is referenced in ~8
  declarations but **defined nowhere** (the real token is `--accent`), so the
  styles silently don't render: `.presentation-tool:hover`/`.on`
  (`:1560-1571` — the active presenter tool paints no background while setting
  `color: var(--bg-panel)`, near-invisible), the caret-line gutter cue
  (`:3890-3891`), checkbox `accent-color` (`:1644`), breakpoint focus outline
  (`:3879`); `TableView.tsx:1216` has fallback `#6ab`, which is what *always*
  renders. Fix: global rename to `var(--accent)`.
- [x] **7.2 HIGH (style bug)** — A phantom token family is referenced with
  fallbacks but never defined — the fallbacks are the real design, and they
  disagree: `--bg-hover` (different fallback values at `:69` vs
  `:2135/:5149/:8149`), `--accent-soft` (always falls back to hardcoded
  GitHub-blue `rgba(88,166,255,…)` at `:11756-11837` → **selected file rows
  are blue in all five themes**, including teal/lavender/light), `--error`
  (`:11518`, should be the defined `--danger`), `--text-main` (`:17380`, no
  fallback → color unsets; should be `--text-primary`), plus `--bg-input`,
  `--bg-secondary`, `--bg-subtle`, `--bg-inset`, `--bg-base`,
  `--text-tertiary`, `--shadow-lg`, `--accent-fg`. Fix: define the tokens once
  per theme root or substitute the existing ones (`--danger`,
  `--text-primary`, `color-mix` off `--accent`).
- [x] **7.3 HIGH (style bug)** — Three infinite keyframes animate **blurred**
  box-shadows — the exact pattern the repo's own WebKitGTK rule forbids (and
  that `:12196` documents the correct opacity-based treatment for):
  `right-panel-drop-pulse` (`:7634`, applied to full-size panels during OS
  drags, `:7598`/`:8472`), `drag-insert-pulse` (`:9194`, every pill drag),
  `file-entry-highlight-pulse` (`:11020`, runs for as long as a file-tree
  context menu is open). Compliant siblings to copy: `hint-target-pulse`
  (`:20278` spread-only) and the VPN pulse (`:17055`). Fix: static-shadow
  pseudo-element + opacity animation.
- [x] **7.4 HIGH (style bug)** — `.hint-target` and `@keyframes
  hint-target-pulse` are each defined **twice**: the HintBubble version
  (`:20150,20153` — inset ring kept inside element bounds specifically to
  survive `.tab-bar`'s `overflow:hidden`, per its own comment) and the tour
  version (`:20274,20278` — outward spread ring). Duplicate keyframe names
  mean the later definition wins for **both** consumers
  (`HintHost.tsx:166`, `TourHost.tsx:270`), so hint targets get exactly the
  clipped effect the first block exists to avoid. Fix: rename the tour variant
  (`tour-target-pulse`) or unify deliberately.
- [x] **7.5 MED (unification, ×2)** — Git-state colors hardcoded divergently in
  three places and wrong in the three light themes (light `--warning` is
  `#9a6700`, `--danger` `#d1242f` — `:638-640`): `FileTree.tsx:174-178`
  (staged `#d29922`), `ProjectFilesView.tsx:1330,1360,1384,1413` (staged
  `#e3b341` — a *different* orange, in a verbatim 7-property inline dot style
  repeated four times), vs the token-first good sibling
  `GitHistory.tsx:800-805`. Fix: one shared status→`var(--…)` map + a
  `.git-step-dot` class.

### Menus & layering

- [x] **7.6 HIGH (unification)** — Six hand-rolled context-menu portals
  copy-paste the catcher pattern and diverge from the good siblings
  (`FileTree`, `TabBar`, `common/PageStrip` — all using
  `src/hooks/useClampToViewport.ts`): `MailList.tsx:353-364`,
  `BrowserPane.tsx:333-338` (also missing the `onContextMenu` close handler
  MailList documents), `BrowserSecurityChip.tsx:73-78`,
  `ProjectFilesView.tsx:1233-1242,1554-1559`, `TabLocalityBadges.tsx:178-183`.
  None clamp to the viewport (menus render off-screen near edges); z-index
  scatter: class says 1000 (`:10986`), five sites inline-override to 201,
  TabLocalityBadges uses 41 — *below* `.modal-backdrop` (100) and
  `.hint-bubble` (90). Fix: one shared `ContextMenuPortal` (catcher + clamp +
  class-level z), used by all six.
- [x] **7.7 LOW (unification)** — Tooltip portals hardcode `zIndex: 10000`
  inline with a repeated 6-property style (`DiskUsagePane.tsx:434`,
  `ActivityCalendar.tsx:246`); the layering contract lives in scattered
  comments (90/100/110/1000). Fix: a small set of `--z-*` tokens (or at least
  class-level z) to stop the drift.

### Buttons & chrome

- [x] **7.8 MED (unification)** — Five parallel button families; `mail-btn`
  (68 uses, with `-primary/-danger/-icon/-small`) is a 1:1 variant mirror of
  the declared canonical `settings-btn` (~26 uses) under different names;
  `.btn-primary`/`.btn-danger` (`:17121`) serve dialog CTAs and stray uses
  (`NetworkTrafficPane.tsx:299`, `RemotePaneHold.tsx:25`); `cal-link-btn` (22);
  `tab-add-btn` (22) has escaped its origin and serves as the generic small
  icon button (`git-history-refresh`, downloads `dl-copy-btn`). Fix: fold
  `mail-btn` into `settings-btn` (mechanical rename, same variant semantics);
  give the generic icon button a neutral name.
- [x] **7.9 LOW (unification)** — Dialog footer rows: `project-dialog-actions`
  (35) vs `mail-dialog-actions` (11, `:27167` — same flex/gap/flex-end) vs
  `settings-actions`/`folder-picker-actions`. One `.dialog-actions` class.
- [x] **7.10 LOW (unification)** — Two different dead `--danger` fallbacks
  (`#d9534f` in `TabBar.tsx:1691-1784` vs `#f85149` in FileTree/GitHistory/
  ProjectFilesView/SearchPanel) — the token is defined in every theme, so drop
  or standardize the fallbacks. Also `#fff` on accent backgrounds
  (`GitHistory.tsx:797`, `ImageAnnotator.css:80,86,127`) where
  `--accent-contrast` is the contract (canonical: `.hint-bubble-got-it`,
  `:~20260`).
- [x] **7.11 LOW (dead CSS)** — Tokens defined in all five themes, used
  nowhere: `--helix-green` (`:546,598,642,686,730`), `--offline-bg`
  (`:551,…`), `--scrollbar-track` (`:537`). (`--eldrun-scrollbar` looks unused
  to CSS greps but is read from JS — `lib/customScrollbar.ts:134` — keep.)
- [ ] **7.12 INFO** — `mobile-web/src/style.css` is a self-contained hardcoded
  dark-only palette (248 lines of literal hexes, no shared tokens). Defensible
  for a separate one-look phone bundle; note that any future light mode or
  accent change touches every rule.

## 8. i18n gaps

Rule: all display text goes through `src/lib/i18n.ts`.

- [x] **8.1 HIGH (×2)** — The entire Eldrun Mobile desktop surface is
  hardcoded English: `src/components/mobile/MobileSettings.tsx` (no `useT`
  import at all — "Lock down now" :419, "Set up Tailscale Serve" :440,
  "Computer name" :475, the whole status paragraph :520-531, search
  placeholder + aria-label :542-543, …; also raw settingsUi markup instead of
  the mandated `SettingRow`/`ToggleRow` components) and
  `src/components/header/MobileIndicator.tsx` (`:170,181,186,234,249,273,277`).
  The long lockdown-confirm string is duplicated verbatim in both files
  (`MobileSettings.tsx:360` / `MobileIndicator.tsx:181`). Fix: add a
  `mobile.*` namespace to i18n.ts, share the lockdown-confirm text (or the
  whole action), convert to SettingRow/ToggleRow.
  *(Resolved: full `mobile.*` namespace ×5 languages, lockdown confirm is one
  shared key. The input rows stay raw `settings-card-row`s inside the one
  `SettingsCard` — that is the same multi-row-card pattern `SettingsPanel`
  itself uses, and `SettingRow` would wrap each row in its own card.)*
- [x] **8.2 LOW** — Print-preview strip labels built in DOM without
  `translate()` (`lib/viewers/print.ts:443,445,448,451,452,481` — "Page
  range", "Backgrounds", "Grayscale", …; `translate` from `lib/i18n` works
  outside React).
- [x] **8.3 LOW** — Stragglers in files that otherwise use `t()`: CenterPanel
  drag-ghost hints ("Drop on a folder → move file there", ⇧/⌃ lines,
  `:1467-1476`) and scroll-link title (`:1505`); `RightPanel.tsx:91` long
  English tooltip *(×2)*.

## 9. Duplicated helpers (cross-cutting)

- [x] **9.1 LOW (×2)** — Byte-size formatter implemented **seven** times:
  `lib/viewers/fileUtils.ts:621` (`fmtSize`, plausible canonical),
  `NetworkTrafficPane.tsx:213`, `lib/gpu.ts:104`,
  `RemoteMachinesWindow.tsx:1174`, `lib/mail.ts:903`,
  `SettingsSubPanels.tsx:458`, `dev/perfStats.ts:129` (dev-only, may stay).
  Divergent rounding/units guaranteed over time — consolidate in `lib/`.
  *Done 2026-08-28: canonical `lib/formatBytes.ts` (fmtSize's convention +
  guard + TB rung); `fmtSize` re-exports it, RemoteMachinesWindow /
  SettingsSubPanels / NetworkTrafficPane (KiB→KB display change) fold into it,
  `mail.formatSize` keeps only its ""-for-invalid chip guard. Three deliberate
  variants stay and are named in the module doc: `gpu.ts` (MB-under-a-GiB GPU
  convention), `diskUsage.ts` (compact single-letter, tested), `perfStats`.*
- [x] **9.2 LOW** — `escapeHtml` ×4: `lib/viewers/highlight.ts:37` (canonical),
  `lib/viewers/markdown.ts:21`, `FileViewerPane.tsx:1413`,
  `markdownEnrich.ts:44` (`escapeText`). `lib/mail.ts:786` stays — security
  boundary with its own tests.
  *Done 2026-08-28: all three fold into highlight's; `escapeHtmlText` stays as
  a documented alias for its odt/notebook importers.*
- [x] **9.3 MED** — ~20 hand-rolled backend blocks of "load projects.json →
  find entry → mutate `extra[key]` → write list → mirror into project.json"
  (`set_project_run_host` `projects.rs:1742-1786`, `set_project_python`,
  `set_project_hpc` `hpc_ws.rs:869-905`, `set_project_git_disabled`,
  `persist_mirror_dir`, openvpn/auto_connect/categories/description/…). The
  abstraction exists twice (`patch_remote_spec` `:1427`,
  `patch_compute_hosts` `:1695`) — generalize into
  `patch_project_entry(project_id, patch_entry, patch_project)`. Each copy also
  silently skips the project.json mirror write on parse failure
  (`projects.rs:1726-1730`, `services/vm.rs:853-855`) → the two spec copies
  diverge with no signal. **This helper is the natural single place to land the
  §2.1 mutex/atomic fix.**
  *Done 2026-08-28 (the registry half landed with §2.1's `patch_project_entry`):
  `patch_project_entry_mirrored(id, patch_entry, patch_project)` now owns the
  project.json mirror too — atomic write, and a parse failure on an existing
  project.json is an error naming the stale mirror, never a silent skip. All
  ~17 remaining mirror blocks converted (projects.rs, python.rs, vm.rs,
  services/vm.rs, hpc_ws.rs, git_hosting.rs, git_publish.rs ×3);
  `patch_remote_spec`/`patch_compute_hosts` are thin wrappers over it.*
- [x] **9.4 MED** — Two divergent recursive tree-copiers in one file:
  `copy_tree` (`commands/projects.rs:645` — follows symlinks, keeps `.git`) vs
  `copy_dir_all` (`:3757` — skips `.git`, documented). Concrete bug:
  `copy_tree` `fs::copy`s a **dangling** symlink (stale venv/node bin links)
  and errors out a cross-device `archive_project` *after* files have already
  moved; the multi-step move (`:743-754`) has no rollback, and retry is then
  refused by the `dest.exists()` check (`:733-737`) — stuck state with no UI
  path forward. Fix: one shared core with `keep_git: bool` + explicit symlink
  policy (preserve links, tolerate dangling), plus rollback-or-resume for
  `archive_project`.
  *Done 2026-08-28: one `copy_tree_core(src, dst, keep_git)` — symlinks
  recreated as links (dangling tolerated; Windows degrades to copy/skip when
  link creation is unprivileged), `.git`-of-either-kind rules kept for the
  `keep_git: false` path, tests added. `archive_project` went the resume route:
  the manifest (written last) is the "already archived" marker, so a dest
  without one is a failed partial archive and the pass re-enters it (move_tree
  no-ops on already-moved trees, never deletes src before a full copy).*
- [x] **9.5 LOW** — `stores/projects.ts:1630-1780`: ~15 per-field project
  setters repeating the same invoke-then-map-and-patch body → a
  `patchProject(id, fn)` / `patchProjectRemote(id, fn)` helper.
  *Done 2026-08-28: both helpers added above the store; 22 map-and-patch
  bodies (including the two whole-entry replaces) route through them.*

## 10. Dead code

- [x] **10.1 LOW** — Nine exported frontend functions with zero production and
  zero test references (verified full-tree incl. `__tests__`):
  `lib/browser.ts:408` `hasUserinfo`, `lib/caldavPush.ts:115` `isPushable`,
  `lib/calendarTime.ts:237` `dateInRange`, `lib/hpcHost.ts:99`
  `projectTouchesHpc`, `lib/hpcWorkspace.ts:112` `wsRelease`,
  `lib/recurrence.ts:347` `isRecurring`, `lib/vpnAutoConnect.ts:40`
  `isVpnAutoConnect`, `stores/mail.ts:632` `preferredAccountId`,
  `stores/boxes.ts:306` `memberDirectories` — delete. Test-only:
  `calendarTime.isMultiDay`, `mailFilters.ruleIsUsable`, and in `stores/tabs.ts`
  `neighborGroup` (`:1545`, superseded by the document-order Shift+↑/↓ cycle in
  `hooks/useKeyboard.ts:236-253`), `detachedTabKeys`, `hiddenTabKeys` — delete
  with their tests or mark deliberately test-only.
  *Done 2026-08-28: all fourteen deleted (test-only five removed with their
  test usages; `neighborGroup` took its private `axisOf`/`pathToGroup` helpers
  and the `NavDirection` type with it).*
- [x] **10.2 LOW** — `schema/active_session.rs` defined and re-exported
  (`schema/mod.rs:1,18`) but nothing reads or writes it; self-documented as
  TODO #24 (Group F) — land the read/write path or drop the export until then.
  *Done 2026-08-28: dropped — schema file, `mod.rs` lines, both schema tests
  and the fixture deleted; #24's TODO entry now points at git history.*
- [x] **10.3** — Dead `sync_now` pair → §1.9.

Negative results worth recording: **no** unused npm/cargo dependencies (all
verified against real imports, incl. dynamic ones), **no** orphaned Tauri
commands (every `#[tauri::command]` is registered), **no** dead scripts in
`scripts/`, and `mobile-web/` shares no meaningfully duplicated logic with
`src/` (its boundary helpers are separate by design).

## 11. Smaller correctness fixes

- [x] **11.1 LOW** — Case-insensitive search column mapping is wrong for chars
  whose lowercase expands (`commands/search.rs:62-80` — lowering preserves
  order but not char *count*: `İ` → 2 chars), so jump-to-column drifts right in
  Turkish/German text. Fix: map through char-index pairs instead of counts.
- [x] **11.2** — Worker-output quotepath/stat portability → §1.6; VM proxy port
  restriction → §1.12; local_loss lock → §1.8. (All three landed under §1.)

## 12. Verified clean (negative results)

Reported explicitly so future reviews don't re-plow them:

- **Frontend gating discipline holds**: all 60 `setInterval` sites and all rAF
  loops individually audited — mtime/reload polls gate on `PaneVisibleContext`
  with catch-up on show; monitor/print/network panes gate on visibility +
  in-flight guards; header polls use `saverInterval`+quiesce; FileTree's remote
  tick additionally requires focus and stands down for HPC/fast-mode; hover
  cards/dialogs poll only while open; Tauri `listen` cleanup uses the
  cancelled-flag pattern correctly in the frequently-remounted components.
- **PTY registry**: kill/kill_all walk the subtree before signalling the
  leader; respawn-under-same-id reaps the old subtree; batcher zero-idle-wakeup
  and visible-only routing consistent and tested.
- **Credentials/VPN invariants hold**: `remember: None` never clears;
  `vpn_can_connect_silently` is asked before any `pkexec` and "can't tell"
  answers false; credentials keyed by host/config target, never project id;
  askpass/credfiles 0600; all three frontend auto-connect gates present
  including `silentReconnectDeadHost`.
- **Mobile sidecar**: loopback-only bind; opaque-id posture tripwire-tested
  in-tree (no raw project id or tmux name crosses the browser API).
- **Frontend remote gating**: `useRemoteBlocked` on every sync/git control
  checked; all reachable manual transfers pass `confirmSyncTransfer`; the
  file-source latch prevents disconnected-remote probes.
- **Backend hygiene**: no lock-held-across-await found in the mutex-heavy
  modules checked; git/ollama/mail/caldav/browser/printing surfaces uniformly
  async; persisted schemas keep the `#[serde(flatten)] extra` round-trip
  discipline (deny_unknown_fields only on the mobile network protocol, where
  it's correct).

## 13. Coverage gaps

Areas **not** (or only lightly) examined — a follow-up review would start here:
`FileViewerPane.tsx` bulk (7.8k lines; only viewer-state/zoom sections read),
`PdfViewer.tsx`, `FileTree.tsx` bulk, mail components + `stores/mail.ts` bulk,
`stores/browser.ts`/`lib/browser.ts`, `stores/detached.ts`, header indicators,
calendar view components, deck viewers, `lib/lessons.ts`/`lib/tour.ts`;
backend: `sftp.rs` internals, `ssh_common.rs` dial-policy internals, `vm.rs`
lifecycle, `restore_service.rs`, tmux modules, mail crypto stack
(`mail_crypt`/`mail_pgp`/`mail_sanitize`), `gpustat.rs` internals,
`platform/windows.rs`/`macos.rs` FFI bodies, `mobile_control/` service
internals. Highest-value follow-ups flagged by the agents: the sandbox mount
denylist against the current `~/.claude` layout, `ssh_common.rs`'s
background-dial refusal paths, an exhaustive i18n string sweep, and a runtime
profile to confirm the static perf findings. Exhaustive per-theme visual QA
needs a live window.

## Suggested execution order

Each phase is independently landable on `develop`; within a phase, items are
ordered so shared helpers land before their consumers.

- **Phase A — data safety**: 2.1 + 2.2 + 9.3 (one `patch_project_entry` +
  atomic/locked store writes), then 1.1, 1.2, 2.3, 2.4, 3.1. Highest risk
  reduction per line changed.
- **Phase B — freeze class**: §4 (mechanical async+spawn_blocking conversions,
  the fs_watch drain, Ctrl+P skip list). Backend-only → remember
  `npm run backend:stale` reports these as not-live until a deliberate restart.
- **Phase C — startup & background cost**: 5.1–5.3, 6.1–6.3.
- **Phase D — UI/i18n unification**: 7.1–7.4 first (pure bug fixes), then
  7.5–7.10 and §8. Tag anything user-visible-new with `UntestedTag` per
  convention; theme-color fixes need a live-window check per theme.
- **Phase E — dedup, dead code, small fixes**: §3 dedups (3.4–3.9), §9, §10,
  §11, and the remaining §1 LOWs.

Gates for every phase: `npm run build`, `npm test`,
`cargo test --manifest-path src-tauri/Cargo.toml`, `npm run lint`,
`cargo clippy --all-targets -- -D warnings`, and `scripts/privacy-check.sh`
before push.
