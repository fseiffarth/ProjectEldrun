import { type TabDrag } from "../../stores/drag";
import {
  EMPTY_GROUP_ID,
  findGroup,
  useTabsStore,
  type DropEdge,
  type WindowBounds,
} from "../../stores/tabs";
import { useWindowsStore } from "../../stores/windows";

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

  // Released outside the main window → standalone window, regardless of layout
  // state. Takes precedence over every in-window target below. An external-app
  // file (no built-in viewer) opens directly in that app — don't wrap it in a
  // detached Eldrun subwindow; only built-in viewers get their own window.
  if (detachBounds) {
    if (d.viewer) {
      useTabsStore.getState().detachNewTab(tabPayload, detachBounds);
    } else {
      useWindowsStore
        .getState()
        .openFile(d.filePath, cap?.resolved_exec ?? d.fileExec, projectId, "file_drag_out")
        .catch((e) => console.error(e));
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
      useTabsStore.getState().addTab(tabPayload);
    }
    return;
  }

  if (overTabBar) {
    const store = useTabsStore.getState();
    const targetGroup = d.reorderGroup as string;
    if (!findGroup(store.layout, targetGroup)) return;
    // R1: addTab appends to the focused group and ignores index — focus the
    // target, add, then move to the resolved slot.
    store.focusGroup(targetGroup);
    const entry = store.addTab(tabPayload);
    store.moveTab(entry.key, targetGroup, d.reorderIndex as number);
    return;
  }

  if (overSplit) {
    const store = useTabsStore.getState();
    const targetGroup = d.overGroup as string;
    if (!findGroup(store.layout, targetGroup)) return;
    store.splitWithNewTab(tabPayload, targetGroup, d.edge as DropEdge);
    return;
  }

  // No valid drop target (released over the right panel, an empty area, etc.):
  // do nothing. A drag is only ever a drag-to-tab gesture; opening a file is
  // reserved for double-click in the FileTree, so a stray drop must NOT open it.
}
