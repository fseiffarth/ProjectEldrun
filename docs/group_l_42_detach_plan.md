# Group L #42 — Detach a Subwindow Out of the Eldrun Main Window

Implementation-ready plan. Target: Linux X11/KDE. Native window tracking on
Windows/macOS is noted but not blocking (Group H / #19).

---

## Decisions needing user sign-off (high-stakes / hard to reverse)

1. **Architecture: second Tauri WebviewWindow rendering the same React tree,
   selected by a `?detached=<scope>:<groupId>` URL query.** (Not a native child
   window.) This is reversible in principle but sets the whole shape of the
   feature, so confirm before Phase 2. Rationale below (Q3).

2. **Parking a detached window requires whitelisting it past `PROTECTED_CLASSES`.**
   A detached Tauri window shares Eldrun's PID and `eldrun` WM_CLASS, which
   `is_protected_class` (x11.rs) currently refuses to park — by design, so the
   main window is never hidden. We must distinguish the *detached* Eldrun window
   from the *main* Eldrun window and park only the former. The recommended
   mechanism (override by explicit X11 window id, never by WM_CLASS) is safe but
   touches the single most safety-critical invariant in the codebase ("Eldrun's
   own window must NEVER be parked" — see x11.rs tests). **Sign off on the
   approach in Phase 4 before implementing.**

3. **Detach gesture = explicit "pop out" button on the subwindow tab bar** (not
   drag-past-edge) for v1. Drag-past-edge is a fast-follow once the plumbing is
   proven. If you want drag-past-edge in v1, say so — it adds meaningful
   WebKitGTK risk (Q1).

Everything else below is mechanical and follows existing patterns.

---

## Summary & chosen architecture

A tiling subwindow (a `GroupNode` in `layoutByScope`, from Group D.11/#36) can be
popped out of the main Eldrun window into its own borderless OS window. The
detached window renders the *same* React app under a query param that tells it to
mount only that one group's panes. It stays bound to its owning project and is
registered in the existing window registry as a project-owned window, so the
existing project-switch parking path (`services::project_runtime::switch` →
`window_service::hide_windows`/`show_windows` → `platform::*`) hides it on the
parked desktop when its project goes inactive and re-shows it on switch-back —
**no parallel parking path is introduced**. Re-attach is an explicit "dock back"
affordance that moves the group back into the main window's layout tree and
closes the detached OS window.

### The 5 open questions, answered

| # | Question | Decision | One-line rationale |
|---|----------|----------|--------------------|
| 1 | Detach gesture | **Explicit "pop out" button** on the subwindow tab bar (drag-past-edge deferred to a fast-follow). | A button needs zero new pointer-geometry/edge-crossing detection, sidestepping WebKitGTK's unreliable pointer stream that already forced the pointer-based drag workarounds; drag-out can layer on later via the existing drag store. |
| 2 | Re-attach | **"Dock back" button** in the detached window's tab bar (and dock-on-close) that re-inserts the group into the main tree; drag-back deferred. | Symmetric with the pop-out button and equally cheap; the layout-tree merge is the real work and is gesture-independent. |
| 3 | Detached window kind | **Second Tauri `WebviewWindow`** loading the same bundle with `?detached=<scope>:<groupId>`. | Reuses the entire React render path (TerminalView, FileViewerPane, stores) with no native reparenting; a native child window can't host the WebView's PTY/viewer panes and X11 reparenting was deliberately dropped in the Tauri rewrite (apps.rs header). |
| 4 | How `layoutByScope` tracks an out-of-window group | The group **leaves the in-window tree** and is recorded in a new per-scope `detachedGroupsByScope` map (group subtree + window label). The in-window tree collapses as if the group closed; the detached window owns/renders that subtree from the same tabs store. | Keeps the in-window `LayoutTree` render honest (it only draws docked groups) while the tab payloads stay in the one shared per-scope store, so PTYs never unmount and #55 scope-binding still holds. |
| 5 | Tie into window registry + X11/KDE parking + z-order (#17) | Register the detached window as a `TrackedWindow` with a **new origin `ORIGIN_DETACHED_SUBWINDOW`** (project-owned) and its resolved **X11 window id**; parking flows through the unchanged `project_runtime::switch` path. | The switch coordinator already hides/shows every project-owned window id; adding one more origin means detached windows are parked/raised and z-order-tracked (#17) for free, with no second code path. |

### Data-flow shape

```
[Main window]                              [Detached window (Tauri WebviewWindow)]
 tabs store (per-scope maps)  ──shared?──   NO: separate JS heap, separate store
   layoutByScope[scope]                      its own tabs store, seeded over IPC
   detachedGroupsByScope[scope] ──┐
                                  │ backend is the source of truth for which
                                  │ groups are detached (persisted per project)
 project switch ──► switch_project_runtime ──► hide/show ALL project-owned window ids
                                              (now incl. detached subwindow id)
```

Important correction to a tempting-but-wrong design: the two windows are
**separate WebView processes with separate JS heaps**. They cannot share a
Zustand store by reference. The main window remains the authority for the tab
*payloads* of a detached group; it ships them to the detached window over a Tauri
event at creation and on change, and the detached window ships tab edits back.
See "Risks" for why we keep the backend as the durable source of truth for the
*detached set* (which groups are popped out), even though tab payloads stream
between windows.

---

## Phasing (each phase independently testable)

### Phase 0 — Backend: window-id resolution for an Eldrun-owned second window (prerequisite, no UI)

**Why first:** the entire parking story depends on being able to (a) find the
detached window's X11 id and (b) park *it* without parking the main window. Prove
this in isolation before any UI exists.

**Files:**
- `src-tauri/src/commands/apps.rs`
  - Add `pub const ORIGIN_DETACHED_SUBWINDOW: &str = "detached_subwindow";`.
  - Make it project-owned: it must be matched by `window_service::is_project_owned`.
  - Reuse `find_window_for_pid` — but the detached window shares Eldrun's PID, so
    `find_window_for_pid(pid)` returns the *first* Eldrun client window (could be
    the main window). Instead resolve the detached window's id by its **Tauri
    window label / title**: set a unique title on the detached `WebviewWindow`
    (e.g. `Eldrun — <project> — <groupId>`) and scan `x11_client_windows()` for
    the window whose `_NET_WM_NAME` matches, with the existing retry loop. Add a
    `find_window_for_title(title, attempts)` helper mirroring `find_window_for_pid`.
- `src-tauri/src/services/window_service.rs`
  - `is_project_owned` → add `ORIGIN_DETACHED_SUBWINDOW` to the matched set, so
    `project_window_ids` / `project_tracked_ids` include detached windows in the
    hide/show + persistence sets.
- `src-tauri/src/platform/x11.rs`
  - **Parking past the protected class.** `show_window`/`hide_window` currently
    early-return for any `is_protected` window (WM_CLASS `eldrun`). Add an
    explicit *allowlist of window ids the app owns and DOES want parked*. Concrete
    recommendation: thread a `&HashSet<u64> parkable_override` (or a small method
    `set_parkable(window_id)`) so the backend parks a window whose id is in the
    override even if its WM_CLASS is `eldrun`. The main window's id is NEVER added
    to the override, so the critical invariant (main Eldrun window never parked)
    is preserved structurally. Add tests asserting: (i) a non-overridden `eldrun`
    window is still skipped; (ii) an overridden id is moved to `PARKED_DESKTOP`.
  - Keep the `make_sticky` main-window protection untouched.

**Testable now (cargo, headless-safe):** pure-function tests for
`is_project_owned(ORIGIN_DETACHED_SUBWINDOW) == true`, for the parkable-override
gate in the protection check, and for `find_window_for_title` string matching
(factor the match predicate into a pure function the way `is_protected_class` is).
The actual X11 move stays untestable headless (note it for manual QA).

---

### Phase 1 — Frontend store: model a detached group (no OS window yet)

**Why second:** get the layout-tree bookkeeping correct and unit-tested before
any multi-window complexity. A "detached" group can first be exercised purely
in-store.

**Files:**
- `src/stores/tabs.ts`
  - Add `detachedGroupsByScope: Record<string, DetachedGroup[]>` where
    `DetachedGroup = { id: string; subtree: GroupNode; label: string }`. (Only a
    single `GroupNode` detaches in v1 — not an arbitrary split subtree — keeping
    the merge math simple. Note the restriction.)
  - `detachGroup(groupId)`: find the group in the current scope's tree; if it is
    the *only* group, refuse (can't empty the in-window layout) OR allow and show
    the empty-state placeholder — **recommend refuse in v1** (simpler, matches
    "a subwindow" framing). Remove the group node from the tree (reuse the
    `collapse` path used by `closeGroup`, but WITHOUT dropping the tab payloads —
    the tabs stay in `tabsByScope`), and push `{ id, subtree, label }` into
    `detachedGroupsByScope[scope]`. Re-pick focus on the surviving tree
    (mirrors `removeTab`/`closeGroup` focus logic).
  - `attachGroup(detachedId, targetGroupId?, edge?)`: pop the entry from
    `detachedGroupsByScope[scope]`, regenerate its ids via `_regenLayoutIds`, and
    inject it back via `insertAdjacent` (or as root if the tree is empty). Tab
    payloads already live in `tabsByScope`, so nothing respawns.
  - `writeScope` invariant: extend `pruneLayoutToKeys` semantics so detached
    groups' tab keys are ALSO counted as "owned" (a detached group's tabs must
    not be pruned away as orphans). Concretely: when computing `ownedKeys`, union
    in the keys held by `detachedGroupsByScope[scope]`. This is the critical #55
    interaction — detached tabs are still scope-bound, just not in the visible
    tree.
  - `setScope`: leave `detachedGroupsByScope` untouched on scope change (it is
    per-scope already); the detached OS window's lifetime is managed by the
    project-switch path, not by `setScope`.
- `src/components/layout/CenterPanel.tsx`
  - The flat pane layer (`allTabs.map`) must KEEP rendering panes for tabs that
    live in a detached group of a non-active... no: a detached group's panes are
    rendered by the *detached window*, not the main one. So in the main window,
    `groupOfKey` (built from `allGroups(layoutByScope[scope])`) naturally won't
    include detached groups → their panes go `display:none` here. That is
    correct: the main window stops painting them; the detached window paints them.
    Add a guard test that detaching a group makes its tabs invisible in the main
    window's pane layer.

**Testable now (vitest):** `SubwindowDetach.test.ts` — detach removes the group
from `layoutByScope` and records it in `detachedGroupsByScope`; attach restores
it; tab payloads survive both; `writeScope`/save-side pruning does not drop
detached tabs; the #55 owned-keys union holds.

---

### Phase 2 — Spawn the detached Tauri window rendering the group

**Files:**
- `src-tauri/tauri.conf.json`
  - No statically-declared second window. We create it at runtime so its label
    and title are dynamic. (Confirm the Tauri capability/permission set allows
    `WebviewWindowBuilder` at runtime; add a capability entry if the default
    capabilities gate window creation.)
- New command `src-tauri/src/commands/subwindow.rs` (register in
  `commands/mod.rs` + `lib.rs` `generate_handler!`):
  - `detach_subwindow(app, win_registry, project_id, group_id, label)`:
    1. Build a `WebviewWindowBuilder` with URL `index.html?detached=<project_id>:<group_id>`,
       `decorations(false)`, a unique window label `detached-<project_id>-<group_id>`,
       and a unique **title** (used by Phase 0's `find_window_for_title`).
    2. After show, spawn a thread that resolves the X11 id via
       `find_window_for_title` and inserts a `TrackedWindow` with
       `origin = ORIGIN_DETACHED_SUBWINDOW`, `project_id = Some(project_id)`,
       `window_id = Some(resolved)`, `id = "detached-<project>-<group>"`.
    3. Register the id in the override allowlist from Phase 0 (parkable).
    4. Return the registry id to the frontend.
  - `attach_subwindow(app, win_registry, registry_id)`: close the
    `WebviewWindow` by label and remove its `TrackedWindow` + override entry.
- `src/stores/tabs.ts` (or a thin `src/stores/detached.ts`): make `detachGroup`
  also `invoke("detach_subwindow", …)` and `attachGroup` also
  `invoke("attach_subwindow", …)`. Keep the store mutation and the IPC call in
  one action so they can't drift.
- `src/main.tsx` / `src/App.tsx`: read `?detached=` from `location.search`. When
  present, render a **DetachedApp** root instead of the full `AppShell`:
  - mount theme injection + global key handlers as usual;
  - mount a single-group center surface (a stripped CenterPanel that renders only
    the one group's tab bar + pane layer, no project switcher / right panel /
    header project chrome — or render `AppShell` with everything but the center
    panel hidden via a `detached` flag). **Recommend a dedicated lightweight
    `DetachedApp` + `DetachedCenterPanel`** to avoid the main shell's
    project-switch effects firing in the child window.
- New `src/components/tabs/PopOutButton.tsx` (or inline in `TabBar.tsx`): a
  button in the subwindow tab bar next to `subwindow-close`, shown when
  `groupCount > 1`, calling `detachGroup(groupId)`. In the detached window's tab
  bar, the same slot renders a "dock back" button calling `attachGroup`.

**Testable now:** vitest can test the URL parsing (`parseDetachedParam`) and the
DetachedApp branch selection as a pure function; cargo can test the registry
insert/remove and id-format helpers. Window creation itself is manual QA.

---

### Phase 3 — Stream tab state between the two windows

The detached window has its own JS heap and its own tabs store. It must render
the group's live tabs and reflect edits both ways.

**Files:**
- `src/stores/detached.ts` (new) + `src/App.tsx` detached branch:
  - On mount, the detached window requests its seed: `invoke` a command that
    reads from a small backend relay, OR (simpler) the main window emits a
    `detached-seed-<groupId>` event carrying the group's `TabEntry[]` + subtree;
    the detached window listens and `loadFromLayout`s into its own scope.
  - Edits in the detached window (activate tab, rename, close, add) emit a
    `detached-edit-<groupId>` event the main window applies to its
    `detachedGroupsByScope` entry (and vice versa). Keep the event payloads small
    and last-writer-wins; this is a single group, so conflicts are rare.
  - **PTY note:** PTYs are backend-owned and addressed by `"<scope>:<tabKey>"`
    (see CenterPanel `TerminalView id`). Both windows must use the SAME id so the
    detached window *attaches to the existing PTY* rather than spawning a new one.
    This is the subtle correctness crux — verify `TerminalView`/`terminal_service`
    attach-by-id semantics: a second `TerminalView` with the same id in a second
    WebView must re-attach to the running PTY, not kill/respawn it. If the current
    PTY model is single-subscriber, this phase needs a backend change to allow a
    PTY's output stream to be re-targeted to the detached window (move ownership)
    rather than duplicated. **Flag for design review — this may be the largest
    backend item.** Simplest correct v1: when a group detaches, the PTYs' output
    routing moves to the detached window (the main window stops rendering those
    panes anyway), and moves back on re-attach.
- `src-tauri/src/schema/project.rs` / persistence: persist the detached set per
  project so a detached group restores to a docked group on relaunch (v1: on
  restart, detached groups re-dock into the main tree — do NOT auto-respawn OS
  windows at startup; simpler and avoids a window-spawn storm). Record this as a
  follow-up if persistence of the detached *state* is wanted; v1 can treat
  detach as session-only and re-dock on restart.

**Testable now (vitest):** the edit/seed reducers as pure functions (apply a
`detached-edit` payload to a `detachedGroupsByScope` entry; build a seed payload
from a group). PTY re-attach is manual QA.

---

### Phase 4 — Wire detached windows into project-switch parking (the core requirement)

**Why this works with zero new parking path:** by Phase 2 a detached window is
already a project-owned `TrackedWindow` with a real X11 id. The switch
coordinator (`services::project_runtime::switch`) already calls
`project_window_ids(prev)` → `hide_windows` and `project_window_ids(next)` →
`show_windows`. So a detached window for an inactive project is parked on the
hidden desktop and re-shown on switch-back automatically.

**Files (mostly verification + the protected-class override hookup):**
- `src-tauri/src/services/project_runtime.rs` — no structural change. Confirm the
  hide step (step 5) and show step (step 8) pick up `ORIGIN_DETACHED_SUBWINDOW`
  via the `is_project_owned` change from Phase 0. Add an integration-style unit
  test (the file/window logic is already split into `window_service` pure-ish
  helpers) asserting a detached window id is included in `project_window_ids` for
  its project and excluded for others.
- `src-tauri/src/platform/x11.rs` — ensure the hide call for a detached window
  passes the parkable-override gate (Phase 0). Without the override, `hide_window`
  would early-return on the `eldrun` WM_CLASS and the detached window would float
  free across all projects — exactly the bug #42 forbids. This is the single most
  important correctness link; it gets a dedicated test.
- `src-tauri/src/platform/wayland_kde.rs` — `hide_window`/`show_window` are
  no-ops today (#18). Detached-window parking on KDE Wayland is therefore a no-op
  too; document it as a known gap tied to #18 (KWin scripting needed). Do NOT
  block #42 on it — X11/KDE-X11 is the target.
- #17 (z-order): since detached windows are ordinary tracked window ids, whatever
  z-order tracking #17 adds to the registry covers them with no extra work. Note
  the dependency but don't implement #17 here.

**Testable now (cargo):** `project_window_ids` includes/excludes the detached id
correctly per project; the x11 override gate test from Phase 0 is the parking
guarantee. Cross-desktop move = manual QA.

---

### Phase 5 — Polish & re-attach UX

**Files:**
- `src/components/tabs/TabBar.tsx` / `DetachedCenterPanel` — dock-back button,
  dock-on-close (closing the detached OS window re-docks the group rather than
  destroying its tabs), focus handoff.
- `src/styles/themes.css` — style the pop-out/dock buttons (reuse `.subwindow-close`).
- Optional fast-follow (separate change, not v1): **drag-past-edge to detach.**
  Extend the existing pointer drag (`drag.ts`/`commitDrop.ts`/CenterPanel's
  window listeners): when the committed pointer position on release is outside the
  main window bounds (`e.screenX/screenY` vs window outer rect), call
  `detachGroup` instead of a split/move. This reuses the proven pointer-drag
  machinery; the only new bit is the out-of-bounds test on release. Drag-back is
  the inverse (a tab dragged from the detached window released over the main
  window). Defer until v1 buttons are validated.

---

## Risks & unknowns

1. **WebKitGTK drag-past-edge detection (deferred risk).** HTML5 DnD is broken on
   WebKitGTK and the codebase already works around an unreliable pointer stream
   (pointercancel-instead-of-pointerup, terminal pointerup not reaching
   mid-gesture listeners — see CenterPanel/TabBar comments). A drag that must
   detect crossing the OS window edge compounds this: `elementFromPoint` is
   useless outside the window, and pointer events stop at the window border. v1
   sidesteps this entirely with a button. If drag-out is required, the only
   reliable signal is the release coordinate (`screenX/screenY`) compared to the
   window's outer rect, captured in TabBar's pointerup (the one handler that
   fires) — prototype this in isolation before committing.

2. **Two WebViews cannot share a Zustand store.** The detached window is a
   separate JS heap. All "shared layout" must be message-passed (Tauri events).
   Keep payloads small and make the main window authoritative for the detached
   set; the backend persists the detached set, not the live tab tree.

3. **PTY ownership on detach (likely the biggest backend item).** PTYs are
   addressed by `"<scope>:<tabKey>"` and currently rendered by exactly one
   `TerminalView`. Moving a group to a second WebView means a second
   `TerminalView` for the same id. If the terminal stream is single-subscriber,
   the detached window will either steal or duplicate the stream. Resolve by
   *moving* PTY output routing to the detached window on detach (main window stops
   rendering those panes regardless) and back on attach. This needs a
   `terminal_service` review and possibly a `retarget_pty(id, window_label)`
   command. **Design-review this before Phase 3.**

4. **Parking an Eldrun-owned window safely (Decision #2).** The hard invariant is
   "the main Eldrun window must NEVER be parked" (x11.rs tests). We must park a
   *different* `eldrun`-WM_CLASS window. The override-by-explicit-id approach
   keeps the invariant structural (main id is never in the override set), but it
   weakens a safety check that exists for good reason — review carefully and keep
   the existing WM_CLASS skip as the default for all non-overridden windows.

5. **Tauri multi-window event routing.** Verify event scoping: emitting to a
   specific window label vs. broadcasting. Use `app.emit_to(label, …)` for
   targeted seed/edit events so the main window's listeners don't also fire on
   the detached window and vice versa. Confirm capability/permission config
   allows runtime `WebviewWindowBuilder` and cross-window `emit_to`.

6. **X11 id resolution race.** The detached window's X11 id is found by title via
   a retry loop (same pattern as `find_window_for_pid`). A slow compositor could
   delay the id; until resolved the window has `window_id: None` and won't park.
   Mitigate with the existing retry budget and re-resolve on first park if still
   None. Title collisions are avoided by embedding `project:group` in the title.

7. **KDE Wayland parking is a no-op (#18).** Detached-window parking degrades to
   nothing on KDE Wayland until KWin scripting lands. Acceptable per the target
   (X11/KDE-X11); document the gap.

8. **Restart semantics.** v1 treats detach as session-only: on relaunch, a
   previously-detached group re-docks into the main tree (no OS window respawn
   storm). Persisting + respawning detached windows is a deliberate follow-up.

---

## Test plan

### Automated — frontend (vitest, `src/__tests__/`)
- `SubwindowDetach.test.ts` (Phase 1):
  - detach removes the group from `layoutByScope[scope]`, records it in
    `detachedGroupsByScope[scope]`, keeps every tab payload in `tabsByScope`.
  - attach re-injects the group (ids regenerated) and empties the detached entry.
  - detaching the lone group is refused (v1 rule).
  - `writeScope`/save-side pruning does NOT drop a detached group's tabs;
    the #55 owned-keys union still rejects a foreign-scope tab.
  - main window's pane layer hides detached-group tabs (`groupOfKey` excludes them).
- `DetachedParam.test.ts` (Phase 2): `parseDetachedParam("?detached=p1:g-3")`
  → `{ scope: "p1", groupId: "g-3" }`; absent → null (main app).
- `DetachedSync.test.ts` (Phase 3): pure reducers — build a seed payload from a
  group; apply a `detached-edit` payload (activate/rename/close/add) to a
  `detachedGroupsByScope` entry.

### Automated — backend (cargo, `src-tauri/`)
- `apps.rs` / `window_service.rs`:
  - `is_project_owned(ORIGIN_DETACHED_SUBWINDOW)` is true; `project_window_ids`
    includes a detached window for its project and excludes it for others
    (extend the existing `tracked(...)` test fixtures around line 1257).
  - `find_window_for_title` predicate (pure match) hits exact/`project:group` titles.
- `platform/x11.rs`:
  - non-overridden `eldrun` window is still skipped by hide/show (invariant
    preserved);
  - an id in the parkable override IS moved to `PARKED_DESKTOP` even with WM_CLASS
    `eldrun` (the parking guarantee for #42).
- `services/project_runtime`: a detached window id flows into the hide set for the
  previous project and the show set for the next.

### Manual (the agent cannot launch Eldrun — user runs these after a backend rebuild)
1. Open a project with ≥2 subwindows; click "pop out" on one. A borderless OS
   window appears showing that group's tabs; its panes (terminal/agent/viewer)
   keep working (PTY did not respawn — same scrollback).
2. The main window's layout collapses to fill the freed space; remaining tabs
   unaffected.
3. Switch to another project. The detached window is parked on the hidden desktop
   (gone from view), NOT floating over the new project.
4. Switch back. The detached window reappears, still bound to the right project.
5. Switch projects repeatedly; the detached window never leaks across projects
   and never covers the wrong project.
6. Click "dock back" (and separately: close the detached window) — the group
   re-docks into the main layout with its tabs/PTYs intact.
7. Verify the MAIN Eldrun window is never parked/hidden during any of the above
   (the critical invariant).
8. KDE Wayland: confirm graceful degradation (detached window simply not parked;
   no crash) — expected gap per #18.

---

## File touch summary

| File | Phase | Change |
|------|-------|--------|
| `src-tauri/src/commands/apps.rs` | 0,2 | `ORIGIN_DETACHED_SUBWINDOW`, `find_window_for_title`, registry insert |
| `src-tauri/src/services/window_service.rs` | 0,4 | include detached origin in project-owned set |
| `src-tauri/src/platform/x11.rs` | 0,4 | parkable-override gate past `is_protected`; tests |
| `src-tauri/src/platform/wayland_kde.rs` | 4 | document no-op gap (#18) |
| `src-tauri/src/commands/subwindow.rs` (new) | 2 | `detach_subwindow` / `attach_subwindow` |
| `src-tauri/src/commands/mod.rs`, `lib.rs` | 2 | register commands |
| `src-tauri/tauri.conf.json` / capabilities | 2 | allow runtime window creation + `emit_to` |
| `src-tauri/src/services/terminal_service.rs` | 3 | PTY retarget on detach/attach (design-review) |
| `src/stores/tabs.ts` | 1 | `detachedGroupsByScope`, `detachGroup`, `attachGroup`, owned-keys union |
| `src/stores/detached.ts` (new) | 2,3 | IPC wiring, seed/edit reducers |
| `src/main.tsx` / `src/App.tsx` | 2 | `?detached=` branch → `DetachedApp` |
| `src/components/layout/CenterPanel.tsx` (+ `DetachedCenterPanel` new) | 1,2 | hide detached panes in main; single-group surface in detached |
| `src/components/tabs/TabBar.tsx` / `PopOutButton.tsx` (new) | 2,5 | pop-out / dock-back buttons |
| `src/components/tabs/commitDrop.ts`, `src/stores/drag.ts` | 5 (deferred) | optional drag-past-edge detach |
| `src/styles/themes.css` | 5 | button styling |
| `src/__tests__/SubwindowDetach.test.ts`, `DetachedParam.test.ts`, `DetachedSync.test.ts` (new) | 1–3 | vitest |
