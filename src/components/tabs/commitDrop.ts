import { type TabDrag } from "../../stores/drag";
import { findGroupOfTab, useTabsStore } from "../../stores/tabs";
import { useLinkRoutingStore } from "../../stores/linkRouting";
import { openLinkedFile } from "../embed/FileViewerPane";

/**
 * Commit a finished tab drag. Reads store actions from getState() so it can live
 * outside any component. A reorder target adjusts the slot for the source's
 * removal; an edge target splits (or moves into, for center).
 *
 * This lives in its own module (not in CenterPanel) because it is the SINGLE
 * drop authority and must be callable from TabBar's pointerup handler too: on
 * WebKitGTK the terminal `pointerup` is only delivered to window listeners bound
 * before the gesture's implicit pointer capture (i.e. TabBar's, bound at
 * pointerdown). CenterPanel's listeners are added mid-gesture and never see the
 * release, so they cannot be the sole committer.
 */
export function commitDrop(d: TabDrag | null) {
  if (!d) return;
  // #42: a detached-window drag is committed by CenterPanel's cross-window END
  // handler (via attachGroup), not here — guard so a stray pointerup on the main
  // window can never mis-commit it as a tab move.
  if (d.kind === "detached") return;
  // #50: a link dragged out of a viewer onto a subwindow records a session-only
  // route (linkingTab, targetPath) → that group, then opens the file there. The
  // pure routing/open is reused so a click later honours the same target.
  if (d.kind === "link") {
    commitLinkDrop(d);
    return;
  }
  const store = useTabsStore.getState();
  if (d.reorderGroup && d.reorderIndex != null) {
    if (d.reorderGroup === d.fromGroup) {
      const found = findGroupOfTab(store.layout, d.key);
      if (!found) return;
      const from = found.index;
      // The slot indexes the array *before* the source is spliced out, so a
      // target to its right shifts left by one once it's removed.
      const to = from < d.reorderIndex ? d.reorderIndex - 1 : d.reorderIndex;
      if (to !== from && to >= 0) store.reorderInGroup(d.reorderGroup, from, to);
    } else {
      store.moveTab(d.key, d.reorderGroup, d.reorderIndex);
    }
    return;
  }
  if (d.overGroup && d.edge) {
    if (d.edge === "center") {
      // Dropping onto the body of the SAME subwindow it came from is a no-op:
      // keep the tab where it is rather than moving it to the end of its own
      // group. (A non-center edge is a real split-off intent, so it's allowed.)
      if (d.overGroup === d.fromGroup) return;
      store.moveTab(d.key, d.overGroup);
    } else {
      store.splitWithTab(d.key, d.overGroup, d.edge);
    }
  }
}

/**
 * Commit a "link" drag (#50): the user dragged a file link onto a subwindow to
 * make it the session-only target for that link. Record the override route and
 * open the linked file there. Exported for the unit test.
 */
export function commitLinkDrop(d: TabDrag) {
  if (!d.overGroup || !d.linkTargetPath || !d.linkingTabKey || !d.viewer) return;
  useLinkRoutingStore
    .getState()
    .setRoute(d.linkingTabKey, d.linkTargetPath, d.overGroup);
  const dir = d.linkTargetPath.slice(0, d.linkTargetPath.lastIndexOf("/")) || "/";
  openLinkedFile(d.linkingTabKey, dir, {
    path: d.linkTargetPath,
    viewer: d.viewer,
    label: d.linkTargetPath.slice(d.linkTargetPath.lastIndexOf("/") + 1),
  });
}
