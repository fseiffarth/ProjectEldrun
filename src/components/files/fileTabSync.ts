import { reseedDetached } from "../tabs/detachedDropTargets";
import { orderedTabKeys, useTabsStore, type TabEntry } from "../../stores/tabs";

/**
 * Reconcile open file-viewer tabs when a file is deleted, renamed, or moved from
 * the file tree/browser. A viewer tab (`kind: "embed"`) carries the file's
 * absolute path in `embedPath`, set once at open time and otherwise never
 * touched — so without this a delete strands the tab on a gone path and a rename
 * leaves it (and any subsequent save) pointing at the old name.
 *
 * Affected tabs always live in the CURRENT scope: the tree only shows the active
 * project, so a file being edited belongs to that scope — its in-window layout
 * and/or its detached popout windows. Popouts are separate JS heaps that render a
 * streamed seed, so they are updated by re-seeding (or closing) rather than by a
 * shared store write.
 */

/**
 * Keys of every `kind:"embed"` tab (in-app viewer OR external-app embed) whose
 * file was the target: an exact match, or — for a directory op — a child under
 * `target + "/"`.
 */
function matchedKeys(tabs: TabEntry[], target: string): string[] {
  return tabs
    .filter(
      (t) =>
        t.kind === "embed" &&
        !!t.embedPath &&
        (t.embedPath === target || t.embedPath.startsWith(`${target}/`)),
    )
    .map((t) => t.key);
}

/**
 * Close every open embed tab whose file — or containing directory — was just
 * deleted, in the main window AND any detached popout of the current scope.
 */
export function closeTabsForDeletedPath(absPath: string): void {
  const store = useTabsStore.getState();
  const scope = store.scope;
  const affected = new Set(matchedKeys(store.tabsByScope[scope] ?? [], absPath));
  if (affected.size === 0) return;

  const detached = store.detachedGroupsByScope[scope] ?? [];

  // 1. Detached popouts: a group whose ENTIRE tab set is deleted is torn down
  //    (its OS window closes); otherwise drop the matched tabs and re-seed the
  //    popout so it re-renders without them.
  for (const g of detached) {
    const groupKeys = orderedTabKeys(g.subtree);
    const doomed = groupKeys.filter((k) => affected.has(k));
    if (doomed.length === 0) continue;
    if (doomed.length === groupKeys.length) {
      store.closeDetachedGroup(scope, g.id);
    } else {
      for (const key of doomed) {
        store.applyDetachedEdit(scope, g.id, { kind: "close", key });
      }
      reseedDetached(scope, g.id);
    }
  }

  // 2. Live-layout tabs: removeTab collapses emptied groups/splits and kills any
  //    PTY. Detached keys were handled above, so skip them here — removeTab would
  //    drop the payload without repairing the detached subtree.
  const detachedKeys = new Set(detached.flatMap((g) => orderedTabKeys(g.subtree)));
  for (const key of affected) {
    if (detachedKeys.has(key)) continue;
    store.removeTab(key);
  }
}

/**
 * Retarget every open embed tab whose file — or containing directory — was just
 * renamed/moved from `oldAbs` to `newAbs`, in the main window AND any detached
 * popout of the current scope.
 */
export function retargetTabsForRenamedPath(oldAbs: string, newAbs: string): void {
  const store = useTabsStore.getState();
  const scope = store.scope;
  const affected = new Set(matchedKeys(store.tabsByScope[scope] ?? [], oldAbs));
  if (affected.size === 0) return;

  // Rewrite the payloads (embedPath + label) in the store: this re-renders the
  // main window's panes and updates what a re-seed ships to popouts.
  store.retargetTabs(oldAbs, newAbs);

  // Re-seed any detached popout rendering a retargeted tab so it picks up the new
  // embedPath (its subtree keys are unchanged, so only the payload moved).
  for (const g of store.detachedGroupsByScope[scope] ?? []) {
    if (orderedTabKeys(g.subtree).some((k) => affected.has(k))) {
      reseedDetached(scope, g.id);
    }
  }
}
