import { type TabDrag } from "../../stores/drag";
import { findGroupOfTab, useTabsStore } from "../../stores/tabs";

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
      store.moveTab(d.key, d.overGroup);
    } else {
      store.splitWithTab(d.key, d.overGroup, d.edge);
    }
  }
}
