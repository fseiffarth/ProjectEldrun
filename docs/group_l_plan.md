# TODO Group L — Implementation Plan: Center Panel Tabs, Subwindows & Navigation

## Scope decisions & recommended order

1. **#55 — tab→project mapping leak (Bug)** — FIRST. It is a correctness defect in the layout/scope model that #57 and #62 build on. Fixing it first prevents the other features from inheriting or masking the leak.
2. **#56 — right-click tab → inline rename** — small, self-contained in `TabBar.tsx`.
3. **#57 — open README.md by default when no tabs** — builds on the empty-scope path in `CenterPanel.tsx`, reuses the existing `viewer` embed-tab machinery.
4. **#62 — fast keyboard navigation** — UX layer over the now-correct layout model; touches `useKeyboard`/`App`/store but no schema change.
5. **#42 — drag subwindow out to a standalone OS window** — LAST, and **recommend deferring to its own dedicated pass** (see reasoning at the end). It needs a second Tauri webview window, native-window-id registration into the existing parking registry, and a detach/reattach gesture that fights WebKitGTK pointer quirks. It is larger than #55+#56+#57+#62 combined and should not block shipping the rest.

The coder should land #55–#57 and #62 as four separate commits (each with its test green) before touching #42.

---

## Item #55 — Fix tab→project mapping leak

### Root cause / mechanism
Tabs are stored per scope in `useTabsStore`: `tabsByScope`, `layoutByScope`, `focusedGroupByScope` keyed by `scope` (= `activeId` or `"root"`). Three things keep tabs bound to a project:

- The flat pane layer renders **every** scope's tabs (`tabsByScope` flattened) but only marks a pane `visible` when `scopeKey === scope` AND the tab is the active key of its current-scope group. The PTY id is namespaced `${scopeKey}:${tab.key}` to avoid cross-project PTY collision.
- Restore is gated by the guard `nextScope in useTabsStore.getState().tabsByScope` (CenterPanel) and `!(scopeKey in tabsStore.tabsByScope)` (projects.ts).

The leak surfaces (e.g. a `TODO.md` tab showing under the wrong project). Likely contributing mechanisms to audit and fix:

1. **`writeScope` mirrors flat state by `s.scope`, but `loadFromLayout`/`setActive` race.** `writeScope` writes flat `tabs`/`layout` whenever `s.scope === scope`. The real risk is the **guard key**: the guard checks *presence of the scope key in `tabsByScope`*, not that the loaded payload belongs to the project. If two code paths (`load_project` in CenterPanel + `project-runtime-switched` in projects.ts) both resolve and the scope key was deleted/never set, the second writes the *other* project's snapshot. Confirm `previous_local_file`/`next_local_file` are matched to the right ids in `switch_project_runtime` (commands/project_runtime.rs).
2. **Saved tab keys are not project-namespaced on disk.** `loadFromLayout` mints fresh keys via `keyMap` precisely because saved keys collide across projects (the counter resets each session). Audit every place that reads `tab_layout`/`tab_groups`: if any path uses the *saved* key directly (without `keyMap`) to address a pane or PTY, that is the leak.
3. **Empty-scope vs uninitialized-scope ambiguity.** `writeScope` collapses a lone empty root group to `null` and *keeps* the scope key in the map. But the restore guards test `scope in tabsByScope`. A scope that was visited and emptied is "initialized" (key present, value `[]`) and must NOT re-restore from disk. Verify a freshly-activated project that was never visited this session has **no** key, so it restores from its *own* `local_file`, never inheriting the currently-mounted flat state.

### Exact files + functions to change
- `src/stores/tabs.ts`: `writeScope`, `loadFromLayout`, `setScope`. Add an **invariant assertion / defensive filter**: when writing a scope, every tab key in `layoutByScope[scope]` must exist in `tabsByScope[scope]` and vice-versa (orphan keys dropped). Consider storing the owning `scope` on each `TabEntry` (a `scope?: string` field set at `addTab`/`loadFromLayout` time) so a stray cross-scope key is detectable and droppable in `writeScope`. This is the strongest fix: it makes the binding explicit rather than positional.
- `src/components/layout/CenterPanel.tsx`: the `useEffect` (`load_project` restore). Tighten the guard to compare the loaded `localFile`'s project id against `scopeForLoad` before `loadFromLayout`, and confirm `groupOfKey`/`activeKeyOfGroup` only ever index the *current* scope's layout (`layoutByScope[scope]`).
- `src/stores/projects.ts`: `listenProjectRuntimeSwitched` and `setActive` snapshot construction. Confirm the snapshot's `tabLayout` is filtered to *restorable* tabs of the *outgoing* project and persisted under `previousId`'s file only.
- `src-tauri/src/services/project_runtime.rs` `switch` + `src-tauri/src/commands/project_runtime.rs`: verify `previous_local_file`/`next_local_file` are resolved from the correct project ids (no off-by-one).
- `src-tauri/src/schema/project.rs`: no shape change required. Keep disk format unchanged, enforce binding only in memory.

### Approach
Make the project→tab binding an explicit, asserted invariant in `writeScope`: drop any layout key not present in that scope's `tabsByScope` entry, and (with the optional `scope` field) drop any tab whose `scope` differs from the map key it's being written under. Add the guard-key tightening in both restore paths. This converts a positional/timing bug into a structurally impossible state.

### Automated test (`src/__tests__/TabScopeBinding.test.ts`)
- Two scopes A and B each load a layout with the *same* saved key `agent-1` — assert the rendered/visible pane for scope A never references B's tab payload.
- Directly inject a corrupt state (`layoutByScope.A` references a key only present in `tabsByScope.B`) and assert that after any mutating action the orphan key is dropped and A shows only its own tabs.
- Switch-race: populate A, switch to B, resolve a *late* `loadFromLayout(targetScope=A)` and assert B's flat `tabs`/`activeKey` are untouched and A's map still holds A's tabs.

---

## Item #56 — Right-click a tab → inline rename

### Mechanism
Currently `onContextMenu` opens a context menu (`showTabMenu`) whose "Rename tab" item calls `renameFromMenu` → `window.prompt`. The spec wants right-click to *immediately* enter inline rename mode (no menu, no prompt dialog).

### Exact files + functions
- `src/components/tabs/TabBar.tsx`:
  - Add state `const [editingKey, setEditingKey] = useState<string | null>(null)`.
  - Change `onContextMenu` on the tab div to `e.preventDefault(); e.stopPropagation(); focusGroup(groupId); setEditingKey(tab.key);` — drop the `setTabMenu` rename path. Recommendation: right-click = inline rename; close stays on the × button and keyboard close from #62. Remove the tab context menu entirely to avoid two right-click behaviours.
  - Render: when `editingKey === tab.key`, replace `<span className="tab-label">` with a controlled `<input>` that mounts focused + text selected (`autoFocus`, `ref` + `select()`), commits on Enter / blur via `renameTab(tab.key, value)` then `setEditingKey(null)`, cancels on Escape, and `stopPropagation` on pointer/click so editing doesn't trigger drag or activation.
- Reuse existing `renameTab` store action (already trims and ignores empty).

### WebKitGTK note
The input lives inside the tab whose `onPointerDown` starts a drag. Guard: in `onTabPointerDown` early-return if `editingKey === tab.key` (or if `e.target` is the input). `e.button !== 0` already ignores right-click for drags; ensure `preventDefault` so the native menu never appears.

### Automated test (`src/__tests__/TabInlineRename.test.tsx`)
- Fire `contextMenu` on a tab; assert an input appears with the tab's current label selected and **no** context menu.
- Type a new value, press Enter; assert label updated and input gone.
- Press Escape; assert label unchanged and input gone.
- (Optional) assert a `pointerdown` on the input does not start a drag.

---

## Item #57 — Open README.md by default for a project with no tabs

### Mechanism
When a project is activated and has **no tabs to restore**, open its `README.md` in an in-app **viewer** tab (`viewer: "markdown"` embed). The empty path today renders the `EMPTY_GROUP_ID` placeholder. #57 replaces that default with a README viewer tab when the file exists.

### Where to hook
In `CenterPanel.tsx`'s scope-init effect. Today, when `load_project` returns no restorable tabs nothing is added. Add: if the project scope has just been initialized with zero tabs AND scope newly visited, attempt to open `README.md`:

1. Resolve the README path: `${projectCwd}/README.md`. Check existence with an existing file-stat/read/list command (prefer reusing FileBrowser's directory listing or an existing read command over adding a new one). Only add a tiny `file_exists` command if nothing reusable exists.
2. If it exists, build a viewer embed tab with the same payload shape `commitFileDrop` uses:
   ```
   { label: "README.md", cmd: "", cwd: projectCwd, kind: "embed",
     embedPath: `${projectCwd}/README.md`, embedExec: undefined, viewer: "markdown" }
   ```
   and call `loadFromLayout([...], projectCwd, scopeForLoad)` with a single-group tree (or `addTab` after `setScope`). Because this is a *restorable* embed it persists and re-restores naturally.

### Important guards
- Only open the README when the scope is **freshly visited this session** and produced **zero** restorable tabs — never when the user has intentionally closed all tabs. Run it in the *same first-visit branch* that does the disk restore, in its `restorable.length === 0` arm.
- Root scope (`!activeId`) must NOT get a README tab.
- Use the `viewer: "markdown"` constant from `fileUtils.ts`.

### Exact files + functions
- `src/components/layout/CenterPanel.tsx`: the restore effect.
- Possibly `src-tauri/src/commands/*` for an existence check **only if** no reusable command exists.
- `schema/project.rs`: no change (viewer embed tab already round-trips via `extra`).

### Automated test (`src/__tests__/ReadmeDefaultTab.test.tsx`)
- Mock existence/read invoke to report `README.md` present; simulate first-visit activation with empty `tab_layout`; assert one tab created with `kind: "embed"`, `viewer: "markdown"`, `embedPath` ending `/README.md`.
- Mock README absent → assert no tab created.
- Assert a scope that was visited and emptied does NOT get a README tab on re-render.

---

## Item #62 — Fast keyboard navigation

### Target set
- Fullscreen a tab/subwindow (and exit).
- Switch projects: `Shift+Ctrl+Tab` cycles projects.
- Switch subwindows: `Shift`+arrows focuses the subwindow in that direction.
- Switch tabs within a subwindow: `Shift+Tab` cycles tabs.
- Close tab/subwindow from keyboard.

### Mechanism / where
Global key handling lives in `src/hooks/useKeyboard.ts` (only F11 + Super today), wired in `AppShell.tsx`. Extend `useKeyboard` (or add a sibling hook) to drive store actions:

- Focus subwindow: `focusGroup(groupId)`. Add a pure helper `neighborGroup(layout, currentGroupId, direction)` in `tabs.ts` that walks the tree using split `dir` + child order (no pixel geometry for a first cut).
- Cycle tabs in focused group: `Shift+Tab` → next key in the focused group's `tabKeys` then `setGroupActive`.
- Cycle projects: `Shift+Ctrl+Tab` → from `useProjectsStore`, active projects sorted by position, find current `activeId`, `setActive(next)`.
- Fullscreen a tab/subwindow (app-internal zoom, not OS fullscreen — F11 already does OS fullscreen): add `fullscreenGroupId` state; when set, CenterPanel renders only that group's body full-bleed (keep panes mounted so PTYs survive). Toggle via a chord (e.g. `Ctrl+Enter`); exit on Escape.
- Close tab: `removeTab(activeKey)`; close subwindow: `closeGroup(focusedGroupId)`.

### Exact files + functions
- `src/stores/tabs.ts`: add pure helper `neighborGroup(layout, fromGroupId, dir)` and (optionally) `fullscreenGroupId` state + `toggleFullscreen(groupId)`. Keep store helpers pure; do wiring in the hook.
- `src/hooks/useKeyboard.ts` (or new `useCenterPanelNav.ts`): add keydown branches. **Critical:** terminals (xterm) consume keystrokes; only act on unambiguous chords (Shift+Ctrl, Shift+Arrow) and not while inline-renaming or when `e.target` is editable. `preventDefault` only when you act.
- `src/components/layout/CenterPanel.tsx`: honor `fullscreenGroupId` (render that group full-bleed; keep panes mounted — reposition, don't unmount).
- `src/components/layout/AppShell.tsx`: wire the new hook.
- `schema/project.rs`: no change (fullscreen is ephemeral).

### Risks
- **Modifier capture vs xterm**: do not break terminal input.
- **WebKitGTK**: some chords may be intercepted by the webview; Super and F11 already reach `window` keydown via `useKeyboard`. Document chord choices; manual test confirms.
- Directional focus via tree order (not pixels) can feel off for nested splits; acceptable for v1.

### Automated test (`src/__tests__/KeyboardNav.test.ts` + `.test.tsx`)
- Pure helper `neighborGroup`: build split trees and assert left/right/up/down resolve correctly, including edges.
- Tab cycling: 3 tabs, simulate `Shift+Tab` handler, assert `activeKey` advances and wraps.
- Project cycling: stub 3 active projects, assert `Shift+Ctrl+Tab` calls `setActive` with next id.
- Fullscreen toggle: assert `toggleFullscreen(g)` sets/clears `fullscreenGroupId` and Escape clears it.
- Close: assert handlers call `removeTab`/`closeGroup`.

---

## Item #42 — Drag a subwindow out to a standalone OS window (DEFER recommended)

### Why defer
Qualitatively larger than the other four combined, highest platform risk:
- Needs a **second Tauri webview window** rendering (a slice of) the React tree, or a native child — an architectural decision the TODO itself lists as open.
- Detached window must be **registered into the parking registry** (`TrackedWindow` in `commands/apps.rs`, with `project_id` + native OS window id) so `window_service::hide_windows`/`show_windows` (X11/KDE backends) park it on project switch. Getting the **native OS window id** of a Tauri window and feeding it to X11/KDE is non-trivial and platform-specific.
- The **detach gesture** is a pointer drag past the window edge — exactly the fragile WebKitGTK area (pointercancel-instead-of-pointerup, mid-gesture listener loss).
- The **layout-tree model** (`layoutByScope`) has no representation for "a group that lives in another window".

Recommend doing #42 as a **separate planned pass** after #55/#56/#57/#62 ship, with its own design doc settling the open questions. If it must be in-scope now, sequence it strictly last and budget it as the bulk of the effort.

### If/when picked — approach sketch
1. **Window surface**: create a second Tauri `WebviewWindow` (label `detached-<groupId>`) via a command; render a minimal React entry mounting a single `Subwindow`. Zustand store is per-webview, so state must be **synced across windows** via Tauri events (or host the group's PTYs in the main window and mirror).
2. **Registry + parking**: on detach, obtain the new window's native id and `register_window(project_id, origin="detached_subwindow")` so `project_window_ids` includes it; existing hide/show parks it. Add `origin` handling in `is_project_owned`/`is_project_opened_window`.
3. **Layout model**: mark the group detached in `layoutByScope` (remove from in-window tree, keep tabs in `tabsByScope`, with a `detachedWindowLabel` marker).
4. **Z-order / #17**: tie into existing z-order work.
5. **Reattach**: drag back in / close detached window → re-insert the group into the main tree, unregister the window.

### Test (future)
Rust: a `register_window(origin="detached_subwindow", project_id=A)` window is included in `project_window_ids(A)` and excluded for `B`. Frontend: detaching a group removes it from `layoutByScope` while preserving its tabs in `tabsByScope`; reattaching restores the tree.

---

## Cross-cutting risks & coder guardrails

- **Do NOT launch Eldrun** to verify (a second instance corrupts workspace state). Frontend (`src/`) edits hot-reload — do not ask the user to restart for TSX/CSS. Only `src-tauri/` changes need a rebuild/restart; flag any Rust change for the user to rebuild.
- **WebKitGTK pointer quirks**: any new pointer interaction (#56 input, #42 detach) must follow the existing pattern — bind release handlers inside `pointerdown`, treat `pointercancel` as commit-not-abort, `preventDefault` to suppress native selection. See `TabBar.onTabPointerDown` and `CenterPanel`'s drag listeners.
- **Never unmount PTYs** during #57/#62 changes: keep the flat pane-layer model. Fullscreen (#62) must reposition, not conditionally render, panes.
- **Disk format stability**: #55–#57 should require **no breaking change** to `schema/project.rs` / `tab_layout` / `tab_groups`. Keep on-disk format unchanged; enforce binding in memory only.
- **Verification per item**: run `npx tsc --noEmit` and `cargo test --manifest-path src-tauri/Cargo.toml` for any backend touch; run the new vitest files. Land #55/#56/#57/#62 each as its own commit with its test green.

## Path correction vs file map
Global key handlers no longer live in `App.tsx` (now a thin shell) — they live in `src/hooks/useKeyboard.ts`, wired from `AppShell.tsx`.

### Critical files
- src/stores/tabs.ts
- src/components/layout/CenterPanel.tsx
- src/components/tabs/TabBar.tsx
- src/stores/projects.ts
- src/hooks/useKeyboard.ts
- (#42 only) src-tauri/src/commands/apps.rs, src-tauri/src/services/project_runtime.rs, src-tauri/src/lib.rs, src-tauri/tauri.conf.json
