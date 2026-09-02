import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  DETACHED_PANES,
  DETACHED_PANES_REQUEST,
  detachedDropPreviewEvent,
  reseedDetached,
  type DetachedPanes,
  type PaneRect,
} from "../../stores/detached";

// The one reseed path lives in the store module now (#230: the copy that used to
// live here dropped the project context on every dock). Re-exported so the drop
// paths keep importing it from beside the drop session.
export { reseedDetached };
import { pickEdge } from "./dragGeometry";
import {
  snapshotFrame,
  physToClient,
  pointInOuter,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/coords";
import { useTabsStore, type DetachedDockTarget, type DropEdge } from "../../stores/tabs";

/** An open popout of the active scope, with its physical-px window frame (see
 *  lib/coords). All hit-tests take a physical desktop cursor (`PhysPoint`) — never
 *  DOM `ev.screenX/Y`, whose units diverge across engines under DPI scaling. */
export interface DetachedTarget {
  label: string;
  groupId: string;
  scope: string;
  /** The popout window's physical-px frame: its outer rect for the AABB test and
   *  its inner origin/scale for mapping the cursor into the popout's client px. */
  frame: WindowFrame;
}

/** Hit-test a cursor (popout-client px) against a popout's reported panes: over a
 *  bar → merge into that group (center); over a body → edge-split (pickEdge). The
 *  host runs this SYNCHRONOUSLY, so the release uses the final cursor with no
 *  cross-window round-trip race. Bars win over bodies (a bar overlaps no body).
 *  Exported for unit tests. */
export function resolvePaneTarget(
  panes: PaneRect[],
  x: number,
  y: number,
): { groupId: string; edge: DropEdge } | null {
  for (const p of panes) {
    const b = p.bar;
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      return { groupId: p.groupId, edge: "center" };
    }
  }
  for (const p of panes) {
    const b = p.body;
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      const edge = pickEdge(
        { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top },
        x,
        y,
      );
      return { groupId: p.groupId, edge };
    }
  }
  return null;
}

/**
 * A drag gesture's view of the current scope's popouts as drop targets. Shared by
 * the tab drag (`TabBar`) and the file drag (`FileTree`) so both light up the
 * popout under the cursor and dock into it identically — rather than each
 * re-implementing the cross-window hit-test (the divergence that left file drags
 * spawning a new window over a popout instead of docking into it).
 *
 * The cursor leaves the main viewport while over a popout. The caller tracks it via
 * the cross-platform `cursorPosition()` poll (`startCursorPoll`, physical desktop
 * px), so a synchronous `at()` hit-test on every tick/release can tell whether the
 * cursor is over a popout. `resolve()` is async (per-window IPC), so the caller
 * kicks it off when the drag starts and hit-tests against whatever has resolved; an
 * unfinished resolve simply means no popout target yet (caller falls back to its
 * new-window detach).
 */
export function startDetachedDropSession(opts?: {
  /** Whose popouts are drop targets. Defaults to the ACTIVE scope (a main-window
   *  drag). A drag that starts in a popout passes that popout's scope (#238): a
   *  root or box popout is never parked, so one can be dragged from while a
   *  project is active — and its tab must only ever light up and land in a
   *  sibling of its OWN scope, never in the active project's popouts. */
  scope?: string;
}) {
  let targets: DetachedTarget[] = [];
  let hovered: string | null = null;
  // Each popout's pane geometry (client px), reported once when the drag starts so
  // the host can hit-test the cursor SYNCHRONOUSLY — no release round-trip race.
  const panesByLabel = new Map<string, PaneRect[]>();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  // Awaited by `resolve()` before it asks any popout for its panes (#238): the
  // request used to go out while this `listen` was still registering, and a
  // popout that answered promptly answered nobody — `targetAt` then resolved
  // undefined and the dock silently landed in the first pane.
  const listening = listen<DetachedPanes>(DETACHED_PANES, (ev) => {
    panesByLabel.set(ev.payload.label, ev.payload.panes);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  const resolve = async () => {
    await listening;
    if (disposed) return;
    const st = useTabsStore.getState();
    const scope = opts?.scope ?? st.scope;
    const entries = st.detachedGroupsByScope[scope] ?? [];
    const out: DetachedTarget[] = [];
    for (const entry of entries) {
      try {
        const w = await WebviewWindow.getByLabel(entry.label);
        if (!w) continue;
        // Snapshot the popout's physical-px frame (outer rect + inner origin/scale).
        // All later hit-tests stay in physical desktop px — no `/scale` divisions.
        const frame = await snapshotFrame(w);
        out.push({ label: entry.label, groupId: entry.id, scope, frame });
        // Ask the popout for its pane geometry now (its tree is fixed for the drag)
        // so the cursor hit-test is ready before it reaches the popout.
        void emit(DETACHED_PANES_REQUEST, { label: entry.label });
      } catch {
        /* window gone / not yet resolvable — skip it as a target */
      }
    }
    targets = out;
  };

  // Pure physical AABB: is the desktop cursor over a popout's OUTER rect?
  const at = (cursorPhys: PhysPoint): DetachedTarget | null =>
    targets.find((t) => pointInOuter(t.frame, cursorPhys)) ?? null;

  // Resolve the pane the cursor is over inside a popout (synchronously, from its
  // reported geometry). `null` if its panes haven't arrived yet or no pane is hit.
  const resolveInPopout = (
    pop: DetachedTarget,
    cursorPhys: PhysPoint,
  ): DetachedDockTarget | null => {
    const panes = panesByLabel.get(pop.label);
    if (!panes) return null;
    // Map the physical cursor into the popout's OWN client px via its inner
    // origin/scale (physToClient), the only DPI-correct conversion — then hit-test.
    const c = physToClient(pop.frame, cursorPhys);
    return resolvePaneTarget(panes, c.x, c.y);
  };

  // Drive the drop preview in the popout under the cursor: resolve the pane HERE
  // and stream the resolved target so the popout renders its per-pane preview;
  // clear the previous popout when the cursor moves off it. `label` is the dragged
  // item's name (shown in the popout's ghost). Pass `pop === null` to clear all.
  const hover = (pop: DetachedTarget | null, cursorPhys: PhysPoint, label?: string) => {
    const next = pop?.label ?? null;
    if (next !== hovered) {
      if (hovered) void emit(detachedDropPreviewEvent(hovered), { active: false });
      hovered = next;
    }
    if (pop && next) {
      const target = resolveInPopout(pop, cursorPhys);
      void emit(detachedDropPreviewEvent(next), {
        active: true,
        target,
        cursorPhysX: cursorPhys.x,
        cursorPhysY: cursorPhys.y,
        label,
      });
    }
  };

  // The pane the cursor resolves to in the given popout AT the supplied physical
  // cursor — computed synchronously for the release dock (no stale cross-window cache).
  const targetAt = (
    pop: DetachedTarget,
    cursorPhys: PhysPoint,
  ): DetachedDockTarget | undefined => resolveInPopout(pop, cursorPhys) ?? undefined;

  // Clear any active highlight and tear down the panes listener. Call once the
  // gesture ends (release/abort).
  const dispose = () => {
    if (hovered) void emit(detachedDropPreviewEvent(hovered), { active: false });
    hovered = null;
    disposed = true;
    unlisten?.();
  };

  return { resolve, at, hover, targetAt, dispose };
}
