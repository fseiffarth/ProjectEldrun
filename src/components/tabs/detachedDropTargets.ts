import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  DETACHED_PANES,
  DETACHED_PANES_REQUEST,
  buildSeed,
  detachedDropPreviewEvent,
  detachedSeedEvent,
  type DetachedPanes,
  type PaneRect,
} from "../../stores/detached";
import { pickEdge } from "./dragGeometry";
import { useTabsStore, type DetachedDockTarget, type DropEdge } from "../../stores/tabs";

/** An open popout of the active scope, with its on-screen bounds in logical/CSS
 *  px (matching `ev.screenX/Y`, which WebKitGTK reports in CSS px). */
export interface DetachedTarget {
  label: string;
  groupId: string;
  scope: string;
  x: number;
  y: number;
  w: number;
  h: number;
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
 * The cursor leaves the main viewport while over a popout, but the pointer's
 * implicit grab keeps `ev.screenX/Y` valid, so a synchronous `at()` hit-test on
 * every move/release can tell whether the cursor is over one. `resolve()` is async
 * (per-window IPC), so the caller kicks it off when the drag starts and hit-tests
 * against whatever has resolved; an unfinished resolve simply means no popout
 * target yet (caller falls back to its new-window detach).
 */
export function startDetachedDropSession() {
  let targets: DetachedTarget[] = [];
  let hovered: string | null = null;
  // Each popout's pane geometry (client px), reported once when the drag starts so
  // the host can hit-test the cursor SYNCHRONOUSLY — no release round-trip race.
  const panesByLabel = new Map<string, PaneRect[]>();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<DetachedPanes>(DETACHED_PANES, (ev) => {
    panesByLabel.set(ev.payload.label, ev.payload.panes);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  const resolve = async () => {
    const st = useTabsStore.getState();
    const scope = st.scope;
    const entries = st.detachedGroupsByScope[scope] ?? [];
    const out: DetachedTarget[] = [];
    for (const entry of entries) {
      try {
        const w = await WebviewWindow.getByLabel(entry.label);
        if (!w) continue;
        const [pos, size, scale] = await Promise.all([
          w.outerPosition(),
          w.outerSize(),
          w.scaleFactor(),
        ]);
        const sc = scale || 1;
        out.push({
          label: entry.label,
          groupId: entry.id,
          scope,
          x: pos.x / sc,
          y: pos.y / sc,
          w: size.width / sc,
          h: size.height / sc,
        });
        // Ask the popout for its pane geometry now (its tree is fixed for the drag)
        // so the cursor hit-test is ready before it reaches the popout.
        void emit(DETACHED_PANES_REQUEST, { label: entry.label });
      } catch {
        /* window gone / not yet resolvable — skip it as a target */
      }
    }
    targets = out;
  };

  const at = (screenX: number, screenY: number): DetachedTarget | null =>
    targets.find(
      (t) => screenX >= t.x && screenX <= t.x + t.w && screenY >= t.y && screenY <= t.y + t.h,
    ) ?? null;

  // Resolve the pane the cursor is over inside a popout (synchronously, from its
  // reported geometry). `null` if its panes haven't arrived yet or no pane is hit.
  const resolveInPopout = (
    pop: DetachedTarget,
    screenX: number,
    screenY: number,
  ): DetachedDockTarget | null => {
    const panes = panesByLabel.get(pop.label);
    if (!panes) return null;
    // Decorationless popout → client px = cursor − outer (== inner) position.
    return resolvePaneTarget(panes, screenX - pop.x, screenY - pop.y);
  };

  // Drive the drop preview in the popout under the cursor: resolve the pane HERE
  // and stream the resolved target so the popout renders its per-pane preview;
  // clear the previous popout when the cursor moves off it. `label` is the dragged
  // item's name (shown in the popout's ghost). Pass `pop === null` to clear all.
  const hover = (pop: DetachedTarget | null, screenX: number, screenY: number, label?: string) => {
    const next = pop?.label ?? null;
    if (next !== hovered) {
      if (hovered) void emit(detachedDropPreviewEvent(hovered), { active: false });
      hovered = next;
    }
    if (pop && next) {
      const target = resolveInPopout(pop, screenX, screenY);
      void emit(detachedDropPreviewEvent(next), { active: true, target, screenX, screenY, label });
    }
  };

  // The pane the cursor resolves to in the given popout AT the supplied coords —
  // computed synchronously for the release dock (no stale cross-window cache).
  const targetAt = (
    pop: DetachedTarget,
    screenX: number,
    screenY: number,
  ): DetachedDockTarget | undefined => resolveInPopout(pop, screenX, screenY) ?? undefined;

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

/**
 * Re-seed a popout after something is docked INTO it so it re-renders with the
 * new tab. `landedKey` tags the seed so the popout plays the same drop-in landing
 * for the freshly-docked tab as it does for an in-popout merge. Shared by the tab
 * and file drop paths.
 */
export function reseedDetached(scope: string, groupId: string, landedKey?: string) {
  const entry = useTabsStore
    .getState()
    .detachedGroupsByScope[scope]?.find((d) => d.id === groupId);
  if (!entry) return;
  const seed = buildSeed(
    scope,
    groupId,
    useTabsStore.getState().tabsByScope[scope] ?? [],
    entry.subtree,
  );
  void emit(detachedSeedEvent(entry.label), landedKey ? { ...seed, landedKey } : seed);
}
