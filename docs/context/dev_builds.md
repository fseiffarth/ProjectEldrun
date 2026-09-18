# Dev builds, hot reload, and the frozen "Eldrun (dev)" binary

Why Eldrun's run/rebuild pipeline works the way it does. `AGENTS.md` § Running
holds the rules an agent must follow; this file holds the mechanics and the
history behind them. Read it when touching `package-dev*.sh`,
`start-eldrun-*.sh`, `backend-stale.sh`, the `post-commit` hook, or
`services::mobile_control::live_pwa` — or when asked why a build is stale.


**Agents must never start Eldrun** (user, 2026-07-29) — not via
`./start-eldrun-tauri-hotreload.sh`, not via `npm run tauri:dev`, not
backgrounded, not "just to check one thing". **Never stop an instance you did
not start**, either: a running window holds the user's open tabs and live
terminals. The app's lifecycle is the user's alone.

To verify something live, ask the user to launch Eldrun (or use a window they
already have open) and report back, or hand them the exact steps to click
through. Otherwise report the automated gates only, and say plainly that the
change was not run live.

- `src/` changes hot-reload into a running window — don't ask for a restart.
- `src-tauri/` changes do not: `tauri dev` runs with `--no-watch`, because its
  Rust watcher rebuilds *and relaunches the window* on any backend write,
  taking the user's open tabs with it. Backend edits accumulate harmlessly
  until the user restarts deliberately. `tauri:dev:watch` is the opt-in
  escape hatch.
- The cost is a backend fix that compiles and is silently not in the window.
  **Run `npm run backend:stale` after backend edits and report the result**;
  never restart the app to apply them. It knows every shape Eldrun runs in
  (hot-reload, frozen `package:dev`, packaged, AppImage), and it asks the
  running Mobile sidecar over loopback which PWA bundle it is actually serving
  — mtimes are a proxy, that answer is not.
- The phone's PWA is embedded into the binary too (`build.rs` bakes
  `mobile-dist/` in), so it goes stale on its own schedule and nothing in the
  window says so. `beforeDevCommand` re-bundles it on every dev start, and a
  `post-commit` hook reports the seam when it drifts anyway; `npm run
  mobile:bundle` rebuilds it without the type-check, `mobile:build` with.
  **A commit now reaches the phone without a relaunch** (2026-09-17):
  `package-dev.sh` publishes the bundle it just built into `target/mobile-pwa/`
  with a `.stamp`, and `services::mobile_control::live_pwa` serves that in place
  of the embedded copy, so a pull-to-refresh is the whole update path. In
  `--head` mode it publishes *before* cargo starts — the bundle takes two
  seconds, the compile takes two minutes. It is opt-in at compile time
  (`ELDRUN_MOBILE_LIVE_DIR`, set only by `package-dev.sh` and the hot-reload
  launcher, so a released binary reads nothing off the disk), never serves an
  overlay older than the bundle compiled in, and refuses a bundle missing its
  shell or its stamped entry rather than mixing two. The overlay carries the
  PWA, **not** the sidecar's HTTP API: a mobile feature whose backend half is
  not in the running window will render and then fail its request, which
  `backend:stale` reports rather than hides.
- Double-starts are blocked by `scripts/guard-single-instance.sh` (wired into
  the launcher and the `pretauri:dev` hook). It also refuses when port 1420 is
  held by an orphaned vite — a second `tauri dev` would otherwise attach to the
  *first* session's dev server and silently render its stale module graph.
- Dogfooding: `./start-eldrun-dev-sandbox.sh` runs the same dev server with
  `ELDRUN_STATE_DIR`/`ELDRUN_HOME` redirected under
  `~/.local/share/eldrun-dev/`, so a disposable dev window coexists with a
  packaged daily-driver Eldrun (`npm run package`) without sharing any state —
  sessions live in the packaged build, out of HMR's reach. Still one dev
  session at a time (port 1420), and still launched by the user only.
- `npm run package:dev` freezes the *current working tree* as a release binary
  behind the "Eldrun (dev)" desktop entry (`start-eldrun-dev-build.sh`, binary
  at `~/.local/share/eldrun/eldrun-dev`). No hot reload: the user works and
  spots bugs in it, then checks fixes in the hot-reload window. Both use the
  real state, so **only one runs at a time** — each launcher refuses with a
  desktop notification while the other is up. Re-run it to move the frozen
  window to a newer snapshot.
- **Every commit re-freezes it by itself** (user, 2026-09-03): the `post-commit`
  hook queues `scripts/package-dev-auto.sh`, which builds detached (the commit
  never waits), nice'd/`SCHED_IDLE` so it does not fight the window it serves,
  and coalescing — each pass first waits until no commit has landed for 30 s
  (`ELDRUN_DEV_BUILD_SETTLE`), and a commit landing mid-build queues one more
  pass instead of a second build, so a commit series or a rebase costs one
  build and ends on the *last* commit.
  **It freezes the commit, not the tree** (user, 2026-09-14): `package-dev.sh
  --head` checks `HEAD` out into the detached worktree `target/freeze-tree`
  (node_modules symlinked, cargo target dir shared) and builds there, so the
  frozen binary is exactly one commit — never "+local" with someone else's
  dirty edits swept in, and never failed by an `npm run build` that rewrites
  `dist/` mid-compile. `npm run package:dev` by hand still freezes the live
  tree, as the explicit way to try an uncommitted change. It
  installs and notifies; it never launches or stops anything, and a running
  frozen window keeps its old inode until the user relaunches it. **From an
  agent tab it builds and stops there** (2026-09-04): `services::agent_fence`
  gives an agent a tmpfs `$HOME`, so the install wrote 75 MB into a directory
  that died with the tab and the notification had no session bus to reach —
  every commit reporting success while the desktop icon stayed two days behind.
  The build is real (`target/` is inside the bound project), so
  `start-eldrun-dev-build.sh` adopts `target/release/eldrun` at launch instead,
  in the user's own session, trusting the `.frozen` record `package-dev.sh`
  leaves beside a binary that passed `scripts/assert-embedded-frontend.sh` —
  not a re-run of that check, since `dist/` moves on with every gate an agent
  runs and a launch-time re-check refused four days of good builds
  (2026-09-14). The launcher notifies either way: what it adopted, or why not.
  **A failed pass does not end the queue** (2026-09-15): a commit that landed
  mid-build is a different tree — usually the one that fixes it, since a
  change split over two commits compiles only as a pair — so the loop goes on
  to it instead of leaving it "queued" for good. A failure is written to
  `~/.local/share/eldrun/package-dev-auto.failed` (commit, status, when),
  which `--status`, `npm run backend:stale` and the launcher all read: the
  launcher compares the installed snapshot's recorded commit (`.frozen`, now
  kept beside the installed binary) with `HEAD` and notifies how many commits
  behind it is opening, and why — the hook's own failure notice never
  arrives from an agent tab.
  It declines in CI and from a linked worktree (freezing an agent's tree over
  the user's binary is exactly the surprise to avoid). Off with `git config
  eldrun.autoDevBuild false`, or `ELDRUN_NO_AUTO_DEV_BUILD=1` for one commit;
  `scripts/package-dev-auto.sh --status` says what it is doing and
  `~/.local/share/eldrun/package-dev-auto.log` holds the last build's output.

