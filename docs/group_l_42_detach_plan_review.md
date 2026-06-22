# Plan Review — Group L #42 (Detach a Subwindow)

Reviewer pass over `docs/group_l_42_detach_plan.md`, cross-checked against the
actual code (`src/stores/tabs.ts`, `src/stores/projects.ts`,
`src/components/terminal/TerminalView.tsx`, `src/components/layout/CenterPanel.tsx`,
`src-tauri/src/terminal/mod.rs`, `src-tauri/src/platform/x11.rs`,
`src-tauri/src/platform/wayland_kde.rs`, `src-tauri/src/services/window_service.rs`,
`src-tauri/src/services/project_runtime.rs`, `src-tauri/src/commands/apps.rs`).

## Verdict

**Sound with changes — but two of the three flagged cruxes are under-specified to
the point of being load-bearing blockers, and the plan's central
"no-second-parking-path" claim has a concrete contradiction in the code that the
plan does not resolve.** The high-level architecture (second `WebviewWindow` +
shared backend window registry + event-passed tab state) is the right shape and
matches how the codebase already works. But the plan must be revised before
implementation on three points: (1) the X11 title-resolution path it relies on
*structurally excludes* the very window it needs to find; (2) the PTY model is a
broadcast model, not a single-subscriber model, so "move ownership" is the wrong
mental model and the real risk is a double-mount + a kill-on-unmount race; (3)
the parkable-override design is sound but needs a sharper, test-backed invariant
than "never add the main id."

None of these sink the architecture. They change Phase 0 and Phase 3 scope.

---

## Findings

### 1. [Blocker] Title-based window resolution scans a list that already drops the detached window.

`find_window_for_title` is proposed (Phase 0) to mirror `find_window_for_pid`,
i.e. scan `x11_client_windows()`. But `x11_client_windows()`
(`apps.rs:1169-1202`) tags every window with `protected: is_protected_window(...)`
(`apps.rs:1199`), and both `find_window_for_pid` (`apps.rs:1114`) and
`find_new_window` (`apps.rs:1140`) filter `!w.protected`. `is_protected_window`
resolves WM_CLASS and calls `is_protected_class` (`apps.rs:1218-1233`), which
returns `true` for `eldrun`. The detached window has WM_CLASS `eldrun`. So a
title resolver written "mirroring `find_window_for_pid`" against
`x11_client_windows()` will **never return the detached window** — it is filtered
out as protected before the title is ever compared.

The plan acknowledges the detached window is protected (Decision #2) but does not
connect that to its own resolution helper, which reuses the protected-filtering
scan path.

**Fix:** `find_window_for_title` must NOT reuse the `protected` filter. Either add
a sibling field to `X11ClientWindow` carrying `_NET_WM_NAME` and match on title
*ignoring* `protected`, or write a dedicated scan that reads `_NET_WM_NAME`
(x11.rs already has `get_window_title` / `net_wm_name` atom, currently private to
`platform::x11`) and matches by exact title regardless of WM_CLASS. Add a pure
unit test that an `eldrun`-class window with the target title resolves (the exact
inverse of today's protected-skip).

### 2. [Blocker] "PTY ownership move" is the wrong model — output is broadcast, and the danger is kill-on-unmount, not stream theft.

PTY output is emitted with `app.emit("terminal-output", ...)`
(`terminal/mod.rs:263-269`), a **broadcast to every webview**, addressed only by
`id`. There is no per-window targeting and nothing "owns" a subscription. So:

- A second `TerminalView` in the detached window with the same `id` does **not**
  steal or duplicate the backend stream — it simply *also* receives the broadcast
  and writes it into its own xterm. Input is symmetric: `pty_write` is keyed by
  `id` (`terminal/mod.rs:124`), so keystrokes from either window reach the one
  PTY. This actually works in the detached window's favor — no backend "retarget"
  command is needed for output routing.

- The real hazard is **double-mount semantics**:
  1. `pty_spawn` with a duplicate id calls `PtyRegistry::insert`, which
     `kill()`s the existing child and respawns (`terminal/mod.rs:104-109`). If the
     detached window's `TerminalView` mounts and runs its `setupAndSpawn`
     (`TerminalView.tsx:185-268`) for the same id, **it will kill and respawn the
     live PTY**, destroying scrollback and the agent session — the exact opposite
     of the plan's "PTY did not respawn" acceptance criterion (test-plan step 1).
  2. `TerminalView`'s unmount cleanup calls `invoke("pty_kill", { id })`
     (`TerminalView.tsx:308`). The main window keeps the detached group's tab in
     `tabsByScope`, so its pane stays mounted as `display:none`
     (`CenterPanel.tsx:441` iterates `tabsByScope`, not the layout) — good, the
     PTY survives detach. **But on re-attach / dock-back, whichever window
     unmounts its `TerminalView` first fires `pty_kill` and tears down the PTY the
     other window is still using.**

**Fix (revise Phase 3):** The detached `TerminalView` must run in an
**attach-only** mode: subscribe to `terminal-output`/`terminal-exit`/`pty_write`
by id, but **never call `pty_spawn`** and **never call `pty_kill`** on unmount —
the PTY's lifetime stays owned solely by the main window's still-mounted pane.
This needs a `TerminalView` prop (e.g. `attachOnly`/`spawn={false}`) plus a way to
prime the detached xterm with current scrollback (broadcast only carries *future*
bytes; the detached window opens mid-stream with a blank screen). The simplest
v1: accept a blank-until-next-output detached terminal (document it) OR add a
backend `pty_snapshot(id)` returning buffered scrollback. The
`PtyRegistry` has no scrollback buffer today (`SCROLLBACK_LIMIT` is declared but
unused for capture), so a true snapshot is new backend work — call it out
explicitly rather than burying it under "move ownership."

This reframes the "biggest backend item" from a nonexistent retarget command to
(a) an attach-only TerminalView mode and (b) an optional scrollback snapshot.

### 3. [Major] The parkable-override weakens the single safety-critical invariant; design it as id-allowlist with a structural guard, not a class bypass.

`show_window`/`hide_window` early-return on `is_protected(...)`
(`x11.rs:114-116`, `135-137`), which reads live WM_CLASS each call. The plan's
override (`parkable_override: HashSet<u64>`) is the right direction, but two
sharpenings are needed:

- The invariant must be enforced as **"the main window id is never inserted into
  the override,"** and that should be *guarded at insertion*, not just by
  convention. The main window's X11 id is knowable (Tauri exposes it / it can be
  resolved at startup). Add an assertion/guard in the override-insert path that
  refuses the main window id, and a test that inserting it is a no-op or panics in
  debug. "We just never add it" is not structural.

- The override gate should be evaluated **before** the `is_protected` early-return
  inside `show_window`/`hide_window` so the override genuinely overrides. Be
  explicit that the override is per-window-id (u64), never per-WM_CLASS, and that
  the default for every non-overridden window is unchanged (still skipped if
  protected). The existing tests (`x11.rs:609-659`) must be kept and joined by:
  (i) overridden `eldrun` id IS parked, (ii) non-overridden `eldrun` id still
  skipped, (iii) the main id can't enter the override.

Note also `make_sticky` is a no-op on X11 (`x11.rs:142-144`); the main window's
"never parked" protection on X11 is *only* the WM_CLASS skip. The override is
literally poking a hole in the one mechanism. Worth a code comment at the gate.

### 4. [Major] `is_project_owned` change has a real precedent gap: `ORIGIN_RESTORED` is in the parking set but the override is not modeled for restored apps.

`window_service::is_project_owned` (`window_service.rs:74-79`) already includes
`ORIGIN_RESTORED`, and `project_window_ids` (`window_service.rs:28-35`) collects
`window_id`s for hide/show. Adding `ORIGIN_DETACHED_SUBWINDOW` there is correct
and minimal. **But** the hide/show path (`project_runtime.rs:125-158`) calls
`backend.hide_window`/`show_window` for those ids — and for the detached window
those calls hit the protected early-return unless the override (Finding 3) is
consulted *inside the backend*. The plan puts the override in `x11.rs` but the
ids flow through `window_service` → `WorkspaceBackend` trait. Confirm the override
state is reachable from the backend (it lives on `X11Backend`, set via a trait
method or a field), and that `WorkspaceBackend::hide_window`'s signature doesn't
need to change (it takes only `window_id: u64`). Cleanest: store the override
`HashSet<u64>` on `X11Backend` itself and add a `set_parkable(id)` trait method
(no-op on null/wayland). The plan's "thread a `&HashSet` param" alternative would
require changing the trait signature across all three backends — prefer the field.

### 5. [Major] Session-restore interaction with detached groups and the `writeScope` owned-keys union is correct in intent but the plan understates the `setActive` save path.

The #55 enforcement runs in **two** places, not one: `writeScope`
(`tabs.ts:464-470`) AND the project-switch snapshot in
`projects.ts:setActive` (`projects.ts:150-174`), which reads
`layoutByScope[prevScope]` and prunes via `pruneSavedTree(serializeTree(...))`.
A detached group has *left* `layoutByScope` (Phase 1), so:

- `saveLayout` (`tabs.ts:1007-1060`) serializes only `layout` (the in-window
  tree). A detached group's tabs are **not in that tree**, so they will be
  **dropped from `project.json` on save** — including on every project switch via
  `setActive`. The plan's Phase 1 says to union detached keys into `ownedKeys`
  inside `writeScope`, which keeps the *payloads* alive in memory, but does
  **not** make them serialize. So detached restorable tabs (shells, resumable
  Claude) would silently *not persist* across a switch-and-back or restart.

  The plan's Phase 3 note ("v1: re-dock on restart, detach is session-only")
  partly covers restart, but **does not** cover the in-session project-switch save
  path: `setActive` snapshots `prevLayout` from `layoutByScope`, which excludes
  the detached group. On switch-back the detached group's tabs would be gone from
  the persisted snapshot. Whether that matters depends on whether the in-memory
  `detachedGroupsByScope` + `tabsByScope` survive the switch (they do — switch
  doesn't clear scopes), so the *live* detached window keeps working; the risk is
  narrower than "lost," but the on-disk `project.json` becomes inconsistent
  (missing the detached tabs) until re-dock.

**Fix:** Decide explicitly: for v1, on detach, either (a) serialize detached
groups back into the saved tree as a normal docked group when persisting (so disk
always reflects "if you restarted, it'd be docked here"), or (b) persist the
detached set separately. Option (a) is simplest and matches the "re-dock on
restart" semantics. Add this to the `saveLayout` / `setActive` snapshot logic,
not just `writeScope`. The plan's test list should add: "a detached group's
restorable tabs still appear in the persisted `tab_groups`/`tab_layout`."

### 6. [Major] `setScope` / project-switch will mount a detached group's panes only in the *main* window, but the detached *window* renders its own scope — confirm the detached window does NOT subscribe to project switches.

The detached `DetachedApp` (Phase 2) must NOT run `CenterPanel`'s scope-switch
effect (`CenterPanel.tsx:128-159`) or `listenProjectRuntimeSwitched`
(`projects.ts:365-401`). If it does, switching projects in the main window would
drive the detached window's store too, and the detached window would try to
restore the *new* project's tabs into its single-group surface. The plan's
"dedicated lightweight `DetachedApp`" recommendation (Phase 2) is therefore not
optional — it is required for correctness. Make it a hard requirement and add a
test that the detached branch does not register the project-runtime listener. The
detached window's parking is driven entirely by the backend moving its OS window
between desktops; its *renderer* must be inert to project switches.

### 7. [Minor] Title collision / resolution race is real but the mitigation is adequate; add a re-resolve hook.

`find_window_for_title` with `project:group` embedded avoids collisions
(Risk #6 is honest). One addition: if the id is still `None` when the first park
is attempted (slow compositor), `hide_windows` silently skips it
(`window_service.rs:11-17` logs but the id was never collected since
`project_window_ids` filters `filter_map(|w| w.window_id)`,
`window_service.rs:33`). So an unresolved detached window **floats across
projects** until resolved — exactly the #42 bug, transiently. Mitigate by
blocking the `detach_subwindow` command's return on a bounded resolve (the plan
spawns a thread; instead resolve before returning, with the existing retry
budget) so the registry always has a `window_id` before the window is usable.

### 8. [Minor] `regenIds` on attach is correct; but focus/active handoff and the "lone group refuse" rule need the empty-layout case spelled out.

`attachGroup` using `_regenLayoutIds` (exported at `tabs.ts:1207`) +
`insertAdjacent` is right. Two edge cases to specify: (a) re-attaching when the
main tree is now empty (all other groups closed while detached) — `insertAdjacent`
requires a target; attach must fall back to installing the subtree as root (the
plan mentions "or as root if empty" — keep that). (b) The "refuse detaching the
lone group" rule (Phase 1) interacts with dock-on-close: if the user detaches the
2nd-to-last group, then closes the *remaining* main group, the main window's
layout is empty but a detached window still exists — dock-back must handle
"target tree is null." Both are covered by (a); just make the test explicit.

### 9. [Minor] Wayland/null degradation is correct and already structural.

`KdeWaylandBackend::hide_window`/`show_window` are no-ops
(`wayland_kde.rs:74-80`) and `NullBackend` likewise (`null.rs:21-27`). A detached
window on those backends simply won't park — it stays on the current desktop,
visible across project switches. This is a graceful (if imperfect) degradation:
no crash, and it matches the documented #18 gap. The plan handles this correctly.
One caveat to document: on Wayland the detached window being non-parked means it
**visibly floats over other projects** — arguably worse UX than on X11. Consider
hiding (minimizing) the detached window via Tauri's own
`window.hide()`/`minimize()` as a Wayland fallback so it at least disappears,
even if it can't be desktop-parked. Optional, but worth a sentence.

### 10. [Minor] Capability/permission for runtime window creation and `emit_to` — verify, don't assume.

The plan flags this (Risk #5) but lists it as a confirm-later. Tauri 2 gates
`WebviewWindow` creation and cross-window events behind capabilities. This is a
hard prerequisite for Phase 2 to even run; promote it into Phase 0's checklist
(it's backend/config, testable that the build accepts it) rather than discovering
it mid-Phase-2.

---

## Phase re-ordering / scope corrections

- **Phase 0** is mis-scoped: it must include (a) the corrected
  `find_window_for_title` that ignores the protected filter (Finding 1), (b) the
  override-insert guard against the main window id (Finding 3), (c) the
  capability/permission config check (Finding 10). As written, Phase 0 would ship
  a resolver that can't find its target.

- **Phase 3** is under-scoped on the backend and over-scoped on the wrong thing.
  Drop "retarget_pty / move output routing" (it doesn't match the broadcast
  model). Add instead: (a) `TerminalView` attach-only mode (no spawn, no
  kill-on-unmount), (b) optional `pty_snapshot` for scrollback priming, (c) the
  detached-group *persistence* fix (Finding 5) which the plan currently scatters
  between Phase 1 and a Phase 3 "follow-up."

- **Phase 4** is correctly "mostly verification," but it depends on Finding 3/4
  being done in Phase 0 — keep that ordering. The integration test asserting a
  detached id is in `project_window_ids(prev)`'s hide set is the right
  guarantee.

- Consider splitting the current Phase 2 (window spawn) and Phase 3 (state
  stream): they are NOT independently testable as claimed, because a detached
  window that spawns its panes (Phase 2) will **respawn the PTYs** (Finding 2)
  before Phase 3's attach-only mode exists. Either Phase 2 must land the
  attach-only TerminalView *with* the window, or Phase 2's detached window renders
  no terminals until Phase 3. Re-sequence so the first window that ever mounts a
  detached terminal is already attach-only.

---

## Questions for the user

**Genuine product / architecture decisions:**

1. **Detached-window scrollback on detach.** Acceptable for v1 that the detached
   terminal opens blank and only shows output produced *after* detach (cheap), or
   is preserving existing scrollback required (needs a new backend
   `pty_snapshot` + a scrollback buffer in `PtyRegistry`, which doesn't exist
   today)?

2. **Persistence semantics.** Confirm v1 = "detach is session-only; a detached
   group re-docks into the main tree on restart, no OS-window respawn." And
   confirm that mid-session **project switches** should persist the detached
   group's tabs as a *docked* group in `project.json` (Finding 5) so disk stays
   consistent — vs. a separate persisted "detached set."

3. **Wayland UX.** When parking isn't supported (KDE Wayland / null), should the
   detached window (a) stay visible floating over other projects (current plan),
   or (b) be `window.hide()`/minimized as a fallback so it at least disappears on
   project switch? (Finding 9.)

4. **The three Phase-gating sign-offs the planner already raised** (second
   `WebviewWindow` architecture; parkable-override approach; button-not-drag for
   v1) all hold up under review — I'd approve all three as proposed, with the
   override hardened per Finding 3. Flagging that these still want your explicit
   go since they're hard to reverse.

**Resolved during review (no user input needed):**

- The PTY model is broadcast, not single-subscriber, so no "retarget" command is
  needed — the fix is attach-only TerminalView semantics (Finding 2). Resolved.
- `find_window_for_title` must bypass the protected filter (Finding 1). Resolved
  — it's a concrete code change, not a decision.
- The override must live as a field on `X11Backend` + a `set_parkable` trait
  method, not a changed `hide_window` signature (Finding 4). Resolved.
- The detached renderer must be inert to project switches (no
  `listenProjectRuntimeSwitched`, no scope-switch effect) (Finding 6). Resolved —
  it's a correctness requirement, not an option.
