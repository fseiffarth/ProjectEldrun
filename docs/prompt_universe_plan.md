# Prompt Universe — a global, cross-project prompt viewer

*Status: plan only. Nothing here is built.*

## Why

The prompt chart (`src/components/agents/PromptChart.tsx`, TODO #262) answers
"what have I asked this project's agents, and what is queued next" — but only for
**one scope at a time**. It is a tab, so it belongs to a project, and a project
switch leaves it behind. The Agents view (`AgentSchedulesView.tsx`) is per-scope
for the same reason. With agents running in several projects at once, the question
with no surface is the *global* one: which agents are working right now, which are
waiting on a decision, what is scheduled tonight, and what finished while I was
looking elsewhere — across every project, in one window.

This is that window: a **global overlay** (the Mail / Calendar / To-do / Skills
family — a header button, mounted once in `AppShell`, surviving a project switch)
whose primary view is a **3D sphere of projects** that drills into one project's
jobs.

Eldrun already has that sphere. `src/components/common/ProjectBlobPane.tsx` is a
working, shipped 3D project cloud that drills from the project cloud into a focused
project's **files**. This feature reuses that engine and swaps the second level from
files to **jobs**. Nothing about the sphere is invented here.

## Decisions taken up front

- **Surface**: an overlay, not a tab. A tab belongs to a scope; this view's whole
  point is that it belongs to none. Same argument that retired the mail tab.
- **Navigation**: drill-down. Level 1 is a sphere of projects, each node ringed by
  its running / waiting / finished counts. Click a project → it flies to the centre
  and its jobs orbit it. Click a job → jump to its tab, or open its card.
- **What a "job" is**: (a) the prompt-chart cards — draft, scheduled, queued, sent,
  chained — and (b) live agent tabs with their running state. **Not** SLURM/HPC
  jobs, **not** warm-up or auto-continue runs. Those have their own surfaces and
  vocabularies; folding them in would make one node kind mean four things.

## Three constraints that shape everything

**No new Tauri command, and no backend change at all.** Both stores are *already*
globally keyed by project id — `useAgentPromptsStore.byProject / .historyByProject /
.linksByProject` and `useAgentSchedulesStore.byTarget` (keyed
`scheduleCacheKey(projectId, targetId)`). Live tabs are `useTabsStore.tabsByScope`
(every loaded scope) and their state is `useActivityStore`. The backend file behind
the prompts is already one `<state_dir>/agent_prompts.json` shaped
`{projects, history, links}`, each a `BTreeMap<project_id, …>`; only the *commands*
are per-project. So the aggregation is a frontend fan-out over commands that already
exist, and the whole feature **hot-reloads into the running window** — no rebuild,
no restart, no `backend:stale`. Do not add a batched `*_list_all` command in v1; if
the fan-out ever measures badly, that is a later, separate change.

**No new dependency, no WebGL.** `package.json` has no three/d3/charting library and
the Tauri CSP forbids CDNs. `ProjectBlobPane` already renders 3D as plain DOM: the
rAF loop rotates each point, does its own perspective divide, and writes a 2D
`transform` — deliberately *not* CSS `perspective`/`preserve-3d`, which WebKitGTK
flattens to a disc while WebView2 honours it. DMABUF is disabled, so everything is
software-rasterized. Follow that path exactly; never animate a blurred `box-shadow`.

**The gate needs no Rust field.** `useExperimental` returns `settings.debug` for an
*unset* flag, and this flag is never written (v1 ships no Settings toggle). So
`prompt_universe` is added to `EXPERIMENTAL_FLAGS` (`src/lib/experimental.ts`) and
to the frontend `Settings` type only (`src/types/index.ts`, beside
`md_graph`/`project_remarks`) — a type-only edit. It is on in Debug mode, off for
everyone else, immediately.

> *Cost of a later plain toggle*, if one is ever wanted: `pub prompt_universe:
> Option<bool>` in `src-tauri/src/schema/settings.rs`, a `ToggleRow` in
> `SettingsPanel.tsx`, `cargo clippy`, and a deliberate restart before an explicit
> on/off can round-trip. Until then serde drops a hand-edited value, so an explicit
> override is impossible — which is fine, because the debug default is the only
> state v1 needs.

## Step 1 — Extract the sphere engine (the only risky step)

`ProjectBlobPane.tsx` is 1065 lines of working, user-facing code. **Three commits,
each green on all gates, with a user QA gate between B and C.**

### Commit A — `src/lib/blobSphere.ts` (pure, no React, no DOM)

Move verbatim: `Vec3`, `fibonacciSphere` (L50-62), `polar`, `donutSlicePath`
(L65-87 — needed again for the overlay's count ring), and the camera constants
`ROT_SENSITIVITY`, `AUTO_SPIN`, `MIN_DOLLY`, `PERSPECTIVE = 1100`, `MAX_DOLLY`,
`NEAR_PLANE = 60`, `NEAR_FADE = 240` (L89-103). Then lift the per-frame arithmetic
out of the loop body (L389-474) so the loop becomes a thin caller:

```ts
export function bloomFactors(progress): { grow; fadeIn }      // easeOutCubic + min(1, p*1.6)
export function convergeAmount(progress): number              // 1 - (1-p)^2
export function nodeFactors(id, convergeId, convAmt, grow, fadeIn): { nodeGrow; nodeFade }
export interface SphereFrame { cx; sx; cy; sy }
export function sphereFrame(rotXDeg, rotYDeg): SphereFrame    // trig once per frame
export interface Projected { tx; ty; scale; opacity; zIndex }
export function projectPoint(p, frame, radius, dolly, nodeGrow, nodeFade): Projected | null
       // null == behind the near plane (hide + click-through)
export function clampDolly(v): number      // [MIN_DOLLY, MAX_DOLLY]
export function clampRotX(v): number       // [-85, 85]
export function cloudRadius(n): number     // min(560, 220 + n*16)
export function hoverCardOrigin(vp, tx, ty, scale, cardW, cardH, winW, winH): { left; top }
```

`src/__tests__/BlobSphere.test.ts`: lattice points lie on radius `r`, with n=0/1 edge
cases; two lattice points never coincide at n=50; `projectPoint` at rot 0 magnifies a
near point (`scale > 1`, higher opacity) and shrinks a far one; returns `null` once
`PERSPECTIVE - (worldZ + dolly) <= NEAR_PLANE`; the near fade is monotonic over the
runway; `clampDolly`/`clampRotX` bounds; `bloomFactors(0) → {0,0}`,
`bloomFactors(1) → {1,1}`; `nodeFactors` pulls the converge target to grow 0 and
fades the rest; `donutSlicePath` emits the even-odd ring form for a full sweep.

Pure move; the diff is reviewable line by line.

### Commit B — `src/components/common/SphereScene.tsx`

Owns `viewportRef`, `sceneRef`, `nodeEls`, `hoverCardRef`, the refs
(`rotX/rotY/dolly/dragging/suppressClick/animProgress/lastTs/convergeId/convergeProgress`),
the rAF effect (still keyed only on `[visible]`, with the `lastTs = 0` reset and the
`offsetParent` skip), `onPointerDown`, `onWheel`, `registerNode`, and the hover-card
pin.

```ts
export interface SphereNode {
  id: string; pos: Vec3;
  className?: string;               // appended to "blob-node"
  style?: React.CSSProperties;      // e.g. { "--cat-color": … }
  body: React.ReactNode;            // the caller's markup
}
export interface SphereSceneHandle { resetDolly(): void }
export interface SphereSceneProps {
  nodes: SphereNode[]; radius: number;
  layoutKey: string;                // bloom restarts when it changes
  visible: boolean;                 // gates the rAF effect
  orbitEnabled?: boolean;           // false = pie mode (drag ignored)
  convergeId: string | null; onConverged?(): void;
  hover: { id; x; y; card: React.ReactNode } | null;
  hoverCardClassName?: string;
  onNodeClick?(node, e): void;      // already suppressed after an orbit drag
  onNodeDoubleClick?(node, e): void; onNodeContextMenu?(node, e): void;
  onNodePointerEnter?(node, e): void; onNodePointerLeave?(node): void;
  onDragStart?(): void;             // caller clears its hover state
  className?: string; children?: React.ReactNode;  // breadcrumb / toggles / hints
}
```

Rules that keep it behaviour-identical:

- Every callback and the `convergeId` / `radius` / `orbitEnabled` / `hover.id`
  values are **mirrored into refs**, so the rAF effect's deps stay `[visible]` — and
  `react-hooks/exhaustive-deps` stays at zero.
- An effect on `[convergeId]` resets `convergeProgress` when it becomes non-null.
- The scene resets `dolly` and clears its own converge refs **before** calling
  `onConverged`, so the caller's `setFocus` commit happens exactly where L491-497
  does it today.
- The click wrapper consumes `suppressClick` (L633-636) before forwarding.
- Class names `blob-viewport / blob-stage / blob-scene / blob-node / blob-hover-card`
  are kept, so **the Projects tab needs no CSS change at all**.

Carry over the three WebKitGTK lessons **as comments** — they are the reason the code
looks the way it does: pointer capture is taken **lazily** past a 4 px threshold
(eager capture routes the `pointerup` to the viewport, so the node never gets its
click and both single- and double-click die); the perspective divide is done by hand
with the scene transform left at `none`; `lastTs = 0` on re-show plus the
`offsetParent` guard, so a hidden spell is not banked as elapsed animation time. Keep
the Energy-Saver freeze by reading `quiesceActive()` *inside* the loop —
`stores/power` exports it non-reactively for exactly this.

`src/__tests__/SphereScene.test.tsx` (jsdom): one `.blob-node[data-x][data-y][data-z]`
per node with the caller's class; `visible={false}` never calls
`requestAnimationFrame` (spy); pointerdown → pointermove > 4 px → pointerup → click
does **not** fire `onNodeClick`, while a stationary press → click does; `onDragStart`
fires once per drag.

**Then `ProjectBlobPane` renders through it.** What moves out: L313-368 refs,
L370-502 loop, L504-557 pointer/wheel handlers. What stays: the node model, the
activity fetch, pie mode (its SVG renders *instead of* `SphereScene`, exactly as it
renders instead of `.blob-stage` today), breadcrumb/toggle/hint (passed as
`children`), the double-click timer (`DBL_CLICK_MS`, L629-670 — a caller concern),
the context menu + `CategoryEditor`, and the hover card *content* (passed as
`hover.card`). Mechanical substitutions: `dolly.current = 0` at L495/588/598/609 →
`sceneRef.current?.resetDolly()`; `viewModeRef` → `orbitEnabled={viewMode !== "pie"}`;
`enterFocus` → `pendingFocus.current = …; setConvergeId(\`p:${id}\`)` with
`onConverged` committing the focus; `layoutKey` passes through unchanged.

> **Stop here and hand the user the Projects-tab regression checklist (§7.1) before
> any overlay work depends on this commit.** If B misbehaves under WebKitGTK, revert
> B alone: the overlay can still be built on `SphereScene` while `ProjectBlobPane`
> keeps its own loop. That is a documented fallback (≈150 duplicated lines, tracked
> as a TODO), not the plan — two divergent sphere implementations is exactly the
> drift `ProjectFilesView` exists to prevent.

### Commit C onward — the overlay.

## Step 2 — The aggregation, pure and tested

`src/lib/promptUniverse.ts` (new). **`now` is always a parameter, never
`Date.now()`** — the `lib/alerts.ts` / `lib/todoBoard.ts` rule: every interesting
case here is a boundary case, and none is testable if the clock is ambient.

```ts
export type TabJobState = "decision" | "working" | "done" | "idle";
export interface ActivitySnapshot { busyByTab; attentionByTab; lastDoneByTab; lastWorkingByTab }
export function tabJobState(ptyId, a: ActivitySnapshot, lastReadAt): TabJobState
  // decision > working > done (attention, or lastDone > lastRead — the MobileBridgeHost rule) > idle

export interface UniverseCounts { decision; working; done; idle; queued; scheduled; chained; drafts; sent }
export type UniverseTop = "decision" | "working" | "done" | "queued"
                        | "scheduled" | "chained" | "drafts" | "sent" | "quiet";
export function topState(c: UniverseCounts): UniverseTop

export interface UniverseProjectNode {
  id; scope; name; status; restored: boolean;
  counts: UniverseCounts; top: UniverseTop; shell: number; color: string | null; categories: string[];
}
export type UniverseJobNode =
  | { id; kind: "tab"; scope; tabKey; label; agent?; state: TabJobState;
      model?; lastPrompt?; targetId; queued; scheduled; workingAt?; doneAt? }
  | { id; kind: "card"; scope; card: PromptChartCard; tabKey?: string };

export function liveStrands(scope, tabs, schedulesByTarget): PromptChartStrand[]
export function buildJobNodes(scope, input): { nodes: UniverseJobNode[]; hidden: number }
export function buildProjectNodes(input): UniverseProjectNode[]
export function orderForLattice(nodes): UniverseProjectNode[]   // busy first, then position
export function ringSegments(c: UniverseCounts): { key; value; token }[]
export type LoadTask = { kind: "prompts" | "history" | "links"; scope }
                     | { kind: "schedules"; scope; targetId };
export function loadPlan(scopes, tabsByScope, cached): LoadTask[]
export async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]>
```

Four reuse rules, each preventing a second answer to a question that already has one:

- The card half **delegates to `buildPromptChart`** (`src/lib/agentPromptChart.ts`),
  once per scope, with strands that file already builds. A second derivation of what
  "queued" means would be a second answer.
- The agent-tab predicate is `isPromptTargetTab`, exported by `PromptChartTab.tsx`
  and already shared with the Agents view.
- State precedence is the one every other surface reads: **decision > working > done
  > idle**. The counts vocabulary is `TabStatusCounts` from `stores/activity`.
- **A restored scope's level-1 counts come *from* `buildJobNodes`**, not from a
  parallel tally — so the ring on the sphere and the nodes inside it can never
  disagree.

Colours reuse `src/lib/categoryColor.ts` (`primaryCategoryColor`,
`projectCategories`) — the same colours the blob tab and the pills already give a
project.

`src/__tests__/PromptUniverse.test.ts`, with a fixed `now`, fixtures in the style of
`AgentPromptChart.test.ts`:

1. `tabJobState` precedence, including done-unseen via `lastDone > lastRead`, and
   done-seen → idle.
2. A scope with two tabs (working, decision) + 1 draft + 1 queued + 1 scheduled +
   3 sent → exact counts, `top === "decision"`.
3. Unrestored scope: `restored: false`, live counts 0, drafts/sent from persisted,
   `top` never a live state.
4. One job node per tab and one per card; a card on a live strand carries that tab's
   `tabKey`, a draft none.
5. Sent window/cap: 30 rows, window `today`, cap 10 → the 10 newest today-rows only;
   `hidden` reports the rest; **tabs are never dropped by the cap**.
6. `orderForLattice` is busy-first; `shell` is 1.0 vs 0.6.
7. `loadPlan` skips cached scopes/targets and includes `root` when asked;
   `runLimited` never exceeds `limit` in flight and settles every task.
8. `ringSegments` omits zero segments and sums to the live + scheduled total.

## Step 3 — The overlay

**`src/stores/promptUniverse.ts`** (new) — `stores/skills.ts`'s shape plus a few
fields, session-only: `open`, `focusProjectId`, `view: "sphere" | "chart"`,
`focusCardId`, `sentWindow`, `hideQuiet`; actions `openOverlay / close /
focusProject / ascend / setView / openCard`. Nothing else: the data lives in the
stores that already own it, and a store-held *copy* would be a second answer to
"what is scheduled" that could disagree with disk (the rule `stores/skills` states).

**`src/components/agents/PromptUniverseOverlay.tsx`** (new) —
`PromptUniverseOverlayHost`, an exact sibling of `TodoOverlayHost`: flag + open gate,
Escape on `window`, `null` when not live, `.modal-backdrop` (backdrop-only
`onMouseDown` close, so an orbit drag ending outside is not read as a dismiss),
`.project-dialog dialog-framed prompt-universe-overlay`, `.settings-title-row` with
`<h2>` + `<UntestedTag />`, `.dialog-close-btn`, and the Sphere/Chart toggle. **One**
Escape listener handles both levels — ascend at level 2, close at level 1 — so it can
never double-fire. Mounted in `AppShell.tsx` between `SkillsOverlayHost` (~L1095) and
`InstallOverlayHost` (~L1102), which must stay on top; DOM order is this family's
z-index tie-break. Not mounted in `DetachedApp`: a popout has no header to open it
from and its Zustand heap is separate.

**`src/components/agents/PromptUniversePane.tsx`** (new) — the loader effect, the two
event listeners, the `now` tick; builds nodes via `promptUniverse.ts`; renders
`SphereScene` or `PromptChart`; owns the context-menu portal and hover cards.

**`src/components/agents/PromptUniverseNodes.tsx`** (new) — memoised bodies:
`ProjectNodeBody` (with its ring), `TabNodeBody`, `CardNodeBody`, `CountRing`.

### Level 1 — projects

One node per `ProjectEntry` (active *and* inactive) plus one for `ROOT_SCOPE` — the
root terminal can host agent tabs too. Box scopes are deferred; `tabsByScope["box:<id>"]`
has the same shape, so adding them later is additive.

- **Shell / distance**: a project with any job signal sits at `s = 1.0` (outer,
  bright); a quiet one (no tabs, no drafts, nothing scheduled, nothing sent in the
  window) at `s = 0.6`, dimmed. Fibonacci slots are assigned busy-first, so busy
  projects spread evenly rather than clumping.
- **Colour**: `--cat-color` from the project's categories, as the blob does; the
  border tint is the top state token (`--status-decision` / `--status-working` /
  `--status-done` from `themes.css:100-102`; queued/scheduled use `--accent`).
- **Ring badge**: a 22 px inline SVG donut built with the existing `donutSlicePath` —
  segments for decision / working / done-unseen / queued / scheduled, plus a text
  badge for drafts. Static per node, re-rendered only when its counts change.
- **Not-restored marker**: a project with no `tabsByScope` key gets a hollow ring
  outline and a `promptUniverse.notRestored` caption. Its ring carries persisted
  counts only.
- **Click**: single → converge → level 2. Double → `setActive(project.id)` and close.
  Right-click: Open project · Show chart here · Open prompt chart tab
  (`openPromptChartTab(scope)`, then close).

### Level 2 — the focused project's jobs

Centre node is the project (click ascends, as the blob's `center` does). Two shells,
so the two job kinds coexist without needing a legend:

- **Inner ring (`s = 0.55`)** — one node per live agent tab (`isPromptTargetTab`).
  Body: agent glyph, tab label, state pill (reusing `agentPrompts.state.*` and the
  `--status-*` tokens with `PromptChartTab`'s precedence),
  `shortModelName(modelByTab[ptyId])`, a one-line `promptByTab[ptyId]`, and
  "N queued · M scheduled" from `schedulesByTarget`.
- **Outer ring (`s = 1.0`)** — one node per `PromptChartCard`: drafts, scheduled,
  queued, chained and sent (windowed and capped, §6). Body: state glyph + word
  (reusing `promptChart.*`), the first line of `message` ellipsed, `at` as an
  absolute `toLocaleTimeString` (so no relative-time strings to translate), and the
  tag count. A card whose strand is a live tab shares that tab's hue through a
  per-tab `--strand-color`, so the two rings read as connected.
- **Click**: a tab node → `jumpToTab(scope, tab.key)` and close. A card node → switch
  to the chart view with that card selected; double-click, when its strand is live,
  jumps to the tab. Right-click: Go to tab · Open in chart · Open prompt chart tab.

### The Sphere / Chart toggle

A `.blob-view-toggle` segmented control in the title row. At level 1 the chart view
shows a small project-pill strip plus the chart for the picked project; at level 2 it
shows the focused project's chart directly. Either way it renders the **existing**
`<PromptChart scope active tabs stateOf>` unchanged — this is the point of building
on the chart rather than beside it: the detail view is the chart that already exists,
hosted a third way (tab, side panel, now here), so the surfaces cannot drift.
`PromptChart` gains exactly one optional prop, `focusCardId?: string` (sets `selected`
and scrolls that card into view; ~6 lines, no behaviour change when absent).
`SphereScene` gets `visible={live && view === "sphere"}`, so the rAF loop is off while
the chart is showing.

The overlay header also carries `ScopeSetStatusBars`
(`src/components/projects/PillStatusBars.tsx`) across every scope — it already merges
bars from several scopes and routes each click through `jumpToTab`, so "something over
there wants you" is answered with no new code.

**`src/components/header/PromptUniverseIndicator.tsx`** (new) — `TodoIndicator.tsx`'s
twin, added to `HeaderBar.tsx`'s global-apps group after `<TodoIndicator />` (L107).
The badge is the **derived** count of agents needing a decision across all scopes
(derived, never acknowledged — the `CalendarIndicator`/`TodoIndicator` rule), read
from `useActivityStore.attentionByScope`, which is already live and costs nothing.

## Step 4 — Loading, and never polling while shut

- **When**: on `live` (flag on and open) the *pane* mounts and a loader effect runs
  `loadPlan(...)`, which yields only the invokes still needed — for every project id
  plus `root`: `load` / `loadHistory` / `loadLinks`, skipping scopes already in
  `byProject` / `historyByProject` / `linksByProject` (render from cache immediately,
  refresh behind it); and for every `(scope, scheduleTargetId)` binding walked from
  `tabsByScope` (the `AgentScheduleHost.tsx:51` `bindings()` pattern), a
  `useAgentSchedulesStore.load` unless the cache key exists. All of it runs through
  `runLimited(tasks, 4)`, so 20 projects means at most 4 in-flight IPCs rather than a
  60-call burst, and every task is settled, never awaited as a chain.
- **Nothing while shut**: the host returns `null` when not live, so the pane — and
  with it every store selector, both `listen()`s, the `now` interval and the rAF — is
  unmounted. This is structural (the `TodoOverlay → TodoPane` shape), not a flag
  someone has to remember to check.
- **Refresh**: while live, `listen("agent-prompts-changed")` →
  `useAgentPromptsStore.getState().refreshLoaded()` and
  `listen("agent-schedules-changed")` → `useAgentSchedulesStore.getState().refreshLoaded()`
  — both methods already exist. Use `PromptChart`'s `disposed`/`stop` unlisten guard
  (`PromptChart.tsx:95-101`). Live tab state needs no listener: the activity, tabs and
  models stores are subscribed reactively.
- **Unloaded scopes, honestly**: a project with no `tabsByScope` key has no live tabs
  *and no schedule targets*, so its running / decision / queued / scheduled counts are
  **unknown, not zero**. Hence `restored: false`, persisted drafts and sent rows only,
  and a caption saying the project's tabs have not been loaded this session. Level 2
  for such a project shows the persisted cards around an empty inner ring with the
  same notice.

### Why the overlay must not restore unloaded scopes

`restoreProjectScope` reads a session file without activating the project and spawns
no PTY — so it looks harmless, and it is not. It writes `tabsByScope[scope]`, and
`AgentScheduleHost.bindings()` walks **all** of `tabsByScope`. A restored but
PTY-less agent tab with a due one-time rule would therefore be picked up by the
scheduler, its `ready()` gate would never arm, and after the one-hour window the rule
is recorded **"missed" and deleted** — a destructive side effect caused by opening a
*viewer*.

So v1 restores nothing, and "not restored" is shown as the honest state it is. A
per-node "restore this project's tabs" action can be offered later, once the
scheduler is verified to skip PTY-less tabs.

## Step 5 — Strings and style

**Strings**: a `promptUniverse.*` group in `src/lib/i18n.ts`, after the
`promptChart.*` block (~L1001) — `overlayTitle`, `indicator`, `indicatorDecisions`
(`{count}`), `viewSphere`, `viewChart`, `hintProjects`, `hintJobs`, `hintChart`,
`back`, `notRestored`, `notRestoredHint`, `quiet`, `hideQuiet`, `sentWindow`,
`sentToday`, `sentWeek`, `sentAll`, `moreHidden` (`{count}`),
`ring.{decision,working,done,queued,scheduled,drafts,sent}`, `job.tab`, `job.card`,
`menu.{openProject,showChart,openPromptChartTab,goToTab,openInChart}`, `noProjects`,
`noJobs`, `loading`. Reuse `agentPrompts.state.*`, the `promptChart.*` state words,
`pill.categoriesLabel` and `common.close` rather than restating them.

`src/__tests__/i18n.test.ts` is a key-**parity** test: a key added to `en` without
matching entries in all four of `src/lib/i18nDicts/{de,es,fr,it}.ts` **fails the
suite**. Write all five languages in the same commit.

**CSS**:

- `src/styles/mail-todo.css` — add `.prompt-universe-overlay` to the shared size rule
  at L390-397 and `.prompt-universe-overlay-body` to the body rule at L398, so the
  global overlays keep one box and the window does not jump between them. Indicator
  styles go beside `.todo-indicator-*`.
- `src/styles/subwindows.css`, after the blob block — `.pu-node-*`, `.pu-ring`, and
  `.pu-node-tab` / `.pu-node-card` sizes extending `.blob-node`. **Plus one fix that
  matters**: `.blob-hover-card` is `z-index: 40`, below `--z-modal: 100`, so inside
  this overlay the hover card would paint *under* the backdrop. The overlay passes
  `hoverCardClassName="pu-hover-card"` with `z-index: var(--z-modal-elevated)`. (The
  context menu at `--z-menu: 1000` is already fine.)
- Node rings reuse `--status-*`, the tab ring's own colours, so the sphere and the
  tab bar cannot disagree.

**`UntestedTag`** on the overlay heading and the header button, staying until the user
says this feature is tested.

**`src/CLAUDE.md`** — file-map rows for the new files, per repo convention.

Not touched: `SettingsPanel.tsx`, anything under `src-tauri/`, `DetachedApp.tsx`,
`PromptChartTab.tsx`.

## Step 6 — Performance under the software rasterizer

- Level 1 is ≤ ~60 nodes; level 2 is bounded by `maxJobs = 96` — tabs are always
  kept, cards are newest-first, and the overflow becomes a `moreHidden` hint pointing
  at the chart, which is the surface built for hundreds of cards. Sent defaults to
  window `today`, cap 24. So 20 projects × 40 cards never renders at once: level 1
  carries counts, level 2 carries one project.
- Sent cards outside the window are excluded **before** layout, not hidden after it —
  the rule `selectAlerts` follows about muting before the cap.
- Node bodies are fixed-size single-line boxes (no wrapping, no measurement), memoised
  on primitive props; the ring is a static SVG. No blurred shadows anywhere
  (`.blob-node:hover` already uses a 0-blur ring), no `backdrop-filter`,
  `will-change: transform` stays on `.blob-node`.
- The rAF loop's cost is unchanged (one `transform`/`opacity`/`zIndex` write per node;
  `getBoundingClientRect` only for the hovered node) and it is off whenever `visible`
  is false: overlay shut (unmounted), chart view, or Energy Saver (auto-spin frozen by
  `quiesceActive()`). Nodes past the near plane already get `pointer-events: none` and
  `opacity: 0` from the shared projection — that is the culling. If QA shows jank from
  `busyByTab` churn, throttle that selector with a 250 ms deferred value (noted, not
  built).

## Step 7 — Verification

**Automated** (every gate is at zero and must stay there):

- `npm test` — new: `BlobSphere.test.ts`, `SphereScene.test.tsx`,
  `PromptUniverse.test.ts`, `PromptUniverseOverlay.test.tsx` (host renders nothing
  when the flag is off or closed; a dialog with its `aria-label` when open under
  `{debug: true}`; Escape ascends at level 2 and closes at level 1), plus one
  assertion in `Experimental.test.ts` that the new flag follows `debug`. Existing
  `AgentSchedulesView.test.tsx` and any blob-pane test must pass **unchanged** — that
  is the guard on Step 1.
- `npm run build` — the only type-check; it proves the `SphereScene` prop contract
  across both consumers, covers `mobile-web/` too.
- `npm run lint` at zero — proves the ref-mirroring kept `exhaustive-deps` clean.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` —
  unaffected (no Rust change), still run.

**7.1 Manual QA — the user runs it; agents never launch or restart Eldrun.**

*After commit B, before any overlay work — the Projects tab must be unchanged:*
orbit drag; wheel fly-through and near-plane fade; single-click focus (converge, then
files bloom); double-click opens the scope; right-click menu; pie toggle and back;
breadcrumb; Escape ascends; the hover card tracks the spin; Energy Saver freezes the
spin; switching away from root stops the rAF (CPU idle).

*After the overlay lands, with agents running in at least two projects:*

1. Debug mode on → a new header button appears after ☑; off → button and overlay gone.
2. The overlay opens over whatever is on screen, survives a project switch, closes on
   Escape and on a backdrop press — but **not** on an orbit drag that ends outside.
3. Level 1: ring counts match the Agents view and the pill bars for a project with a
   working and a waiting agent; an inactive project shows the not-restored marker, not
   zeros.
4. Click a project → converge → tabs on the inner ring, cards on the outer; hover
   cards render **above** the backdrop; clicking a tab closes the overlay on that tab
   in that scope; clicking a card opens the chart with it selected; Sphere/Chart
   toggles; Escape ascends, then closes.
5. Send a prompt from a tab while the overlay is open → counts and cards update
   without reopening (the event path).
6. Close the overlay → no rAF, no timers (devtools Performance idle).
7. Switch language → every overlay string translates; the Untested pill is present.

WebKitGTK pointer and render behaviour, real invoke timing, and the hot-reload itself
are the parts that **cannot** be verified without the user.
