import { type TabDrag, type FileDragItem } from "../../stores/drag";
import {
  EMPTY_GROUP_ID,
  findGroup,
  useTabsStore,
  type DetachedDockTarget,
  type DropEdge,
  type WindowBounds,
} from "../../stores/tabs";
import { useWindowsStore } from "../../stores/windows";
import { reseedDetached } from "./detachedDropTargets";

/**
 * Should a released file drag open its OWN standalone window rather than land
 * in-window? True only when the user explicitly asked (Shift) or the release is
 * genuinely outside the main window's viewport.
 *
 * A popout whose bounds sit under the cursor deliberately does NOT count here: a
 * FRONT popout is already docked into by the caller before this runs (see
 * FileTree's `overFrontDetached` dock branch); an OCCLUDED popout (behind the
 * main window) means the cursor is really over the main window, so the drop must
 * stay in-window — never spawn a new window the user can't see they are aiming
 * at. Folding `overDetached` into this test was the regression that made a drop
 * over an occluded popout falsely open a new detached viewer window instead of
 * splitting in-window.
 */
export function fileDropGoesToNewWindow(opts: {
  shiftKey: boolean;
  lastClient: { x: number; y: number };
  viewport: { w: number; h: number };
}): boolean {
  return (
    opts.shiftKey ||
    opts.lastClient.x < 0 ||
    opts.lastClient.y < 0 ||
    opts.lastClient.x >= opts.viewport.w ||
    opts.lastClient.y >= opts.viewport.h
  );
}

/**
 * Commit a finished FILE drag (a file row dragged from the FileTree onto a tab
 * bar). Like commitDrop, this is the SINGLE drop authority for file drags and
 * lives outside any component so it can be called from FileTree's own pointerup
 * handler (the only listener guaranteed to see the release on WebKitGTK).
 *
 * Behaviour:
 *  - Dropped on a tab bar → add an "embed" tab named after the file to that
 *    group, at the resolved drop slot. Embed capability does NOT gate this: the
 *    tab is always created. Capability is carried on the tab (embedExec) so a
 *    later phase can render the app frameless in-tab when embeddable; until then
 *    the tab opens the file externally (see EmbedPane).
 *  - Dropped on a subwindow body edge → carve out a NEW subwindow at that edge
 *    holding the same embed tab (splitWithNewTab); a center drop adds it into
 *    that group instead.
 *  - Released OUTSIDE the main window (`detachBounds` set, e.g. dragged onto
 *    another monitor) → if the file has a built-in viewer (pdf/markdown/text/
 *    image), open it in its OWN standalone detached Eldrun window at those bounds
 *    (detachNewTab). If instead it opens in an EXTERNAL app, just launch that app
 *    directly — don't wrap an external-app file in a detached Eldrun subwindow.
 *  - Dropped anywhere else (right panel, empty space, no resolved target) → do
 *    nothing. A drag is purely a drag-to-tab gesture; opening a file is reserved
 *    for double-click in the FileTree, so a stray drop must never open it.
 *
 * R1 (addTab bug): addTab always APPENDS to the FOCUSED group and ignores any
 * index. So to land the tab at the drop slot we focus the target group, addTab,
 * then moveTab(newKey, targetGroup, reorderIndex).
 */
export function commitFileDrop(
  d: TabDrag | null,
  // Owning project for an external-app launch when a non-viewer file is dragged
  // out of the window (the detach branch below opens it externally).
  projectId: string | null,
  projectCwd: string,
  // Set when the file was released outside the main window: spawn a standalone
  // detached window at these screen-px bounds rather than docking into a tab.
  detachBounds?: WindowBounds | null,
  // Set when the file was released over an open popout: dock it as an embed tab
  // INTO that popout instead of spawning a new window (mirrors a tab dragged onto
  // a popout). `target` is the specific pane the popout resolved under the cursor
  // (a body edge splits, center/a slot merges; omitted → its first pane). Takes
  // precedence over `detachBounds` (the cursor is over the popout and therefore
  // also outside the main window).
  detachedTarget?: { scope: string; groupId: string; target?: DetachedDockTarget } | null,
) {
  if (!d || d.kind !== "file" || !d.filePath || !d.fileName) return;

  const cap = d.embedCap;
  const overTabBar = d.reorderGroup != null && d.reorderIndex != null;
  const overSplit = d.overGroup != null && d.edge != null;

  // Shared embed-tab payload for both the tab-bar and the new-subwindow paths.
  const tabPayload = {
    label: d.fileName,
    cmd: "",
    cwd: projectCwd,
    kind: "embed" as const,
    embedPath: d.filePath,
    // A built-in viewer (pdf/markdown/text) renders the file in-app and takes
    // precedence over the external handler — so don't carry embedExec then.
    embedExec: d.viewer ? undefined : (cap?.resolved_exec ?? d.fileExec),
    viewer: d.viewer,
  };

  // Multi-file drag (a selection dragged from the FileTree): replay each drop
  // branch once per file. `items` is that list; a `null` sentinel means "the
  // single primary file", which keeps the original single-file path on
  // `tabPayload` (with its cap-resolved embedExec) byte-for-byte unchanged. A
  // multi-file member has no per-file capability probe, so its tab carries no
  // embedExec — EmbedPane opens a non-viewer file externally, matching the
  // single-file fallback.
  const multi = d.files && d.files.length > 1 ? d.files : null;
  const items: (FileDragItem | null)[] = multi ?? [null];
  const payloadFor = (f: FileDragItem | null) =>
    f
      ? {
          label: f.name,
          cmd: "",
          cwd: projectCwd,
          kind: "embed" as const,
          embedPath: f.path,
          viewer: f.viewer,
        }
      : tabPayload;

  // Released over an open popout → dock the file as a new embed tab INTO it. We
  // create the tab in this scope, then move it into the popout's subtree (the
  // same addTab + dockTabIntoDetached path the tab drag uses); the intermediate
  // in-window tab never renders because both store writes batch in this handler
  // tick. Re-seed (with the new key as landedKey) so the popout renders the tab
  // and plays the drop-in landing. Takes precedence over the new-window branch.
  if (detachedTarget) {
    const store = useTabsStore.getState();
    let firstKey: string | null = null;
    for (const f of items) {
      const entry = store.addTab(payloadFor(f));
      store.dockTabIntoDetached(
        detachedTarget.scope,
        detachedTarget.groupId,
        entry.key,
        detachedTarget.target,
      );
      if (!firstKey) firstKey = entry.key;
    }
    if (firstKey) reseedDetached(detachedTarget.scope, detachedTarget.groupId, firstKey);
    return;
  }

  // Released outside the main window → standalone window, regardless of layout
  // state. Takes precedence over every in-window target below. An external-app
  // file (no built-in viewer) opens directly in that app — don't wrap it in a
  // detached Eldrun subwindow; only built-in viewers get their own window.
  if (detachBounds) {
    for (const f of items) {
      const viewer = f ? f.viewer : d.viewer;
      if (viewer) {
        useTabsStore.getState().detachNewTab(payloadFor(f), detachBounds);
      } else {
        // A multi-file member has no cap probe → open with the OS default; the
        // single primary keeps its resolved handler hint.
        useWindowsStore
          .getState()
          .openFile(
            f ? f.path : d.filePath,
            f ? undefined : cap?.resolved_exec ?? d.fileExec,
            projectId,
            "file_drag_out",
            // Land the external app on the monitor the file was dropped onto:
            // detachBounds is the physical drop rectangle (from the desktop
            // cursor), matching the sibling viewer-window branch above.
            { x: detachBounds.x, y: detachBounds.y },
          )
          .catch((e) => console.error(e));
      }
    }
    return;
  }

  // Empty state: the scope has no layout yet, so the only drop target is the
  // full-panel placeholder subwindow (its tab bar resolves to EMPTY_GROUP_ID as
  // reorderGroup; its body as overGroup). A drop anywhere over the main window
  // therefore becomes the FIRST tab — addTab with no layout builds the root
  // group. A drop with no resolved target (e.g. released over the right panel)
  // falls through and does nothing, so files never leak out as external opens.
  if (!useTabsStore.getState().layout) {
    if (d.reorderGroup === EMPTY_GROUP_ID || d.overGroup === EMPTY_GROUP_ID) {
      for (const f of items) useTabsStore.getState().addTab(payloadFor(f));
    }
    return;
  }

  if (overTabBar) {
    const store = useTabsStore.getState();
    const targetGroup = d.reorderGroup as string;
    if (!findGroup(store.layout, targetGroup)) return;
    // R1: addTab appends to the focused group and ignores index — focus the
    // target, add, then move to the resolved slot. For a multi drag, the files
    // land in order at consecutive slots from the drop index.
    store.focusGroup(targetGroup);
    let slot = d.reorderIndex as number;
    for (const f of items) {
      const entry = store.addTab(payloadFor(f));
      store.moveTab(entry.key, targetGroup, slot++);
    }
    return;
  }

  if (overSplit) {
    const store = useTabsStore.getState();
    const targetGroup = d.overGroup as string;
    if (!findGroup(store.layout, targetGroup)) return;
    // Carve the new subwindow with the first file; splitWithNewTab focuses the
    // new group, so the rest of a multi drag addTab straight into it.
    const [first, ...rest] = items;
    store.splitWithNewTab(payloadFor(first), targetGroup, d.edge as DropEdge);
    for (const f of rest) store.addTab(payloadFor(f));
    return;
  }

  // No valid drop target (released over the right panel, an empty area, etc.):
  // do nothing. A drag is only ever a drag-to-tab gesture; opening a file is
  // reserved for double-click in the FileTree, so a stray drop must NOT open it.
}
