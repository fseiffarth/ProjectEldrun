import { createContext, useContext } from "react";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

/**
 * The scope the tabs a view opens belong to, when that is NOT the active scope.
 *
 * The root console is the case: it floats over whatever project is on screen,
 * so its file column, Files tabs and viewers render root's tabs while the store's
 * current scope is the project's. Every "open a viewer" path defaulted to
 * `addTab` — the active scope — so a PDF double-clicked in the console landed in
 * the project underneath. `RootOverlay` provides `ROOT_SCOPE`; everywhere else
 * this is null and the old current-scope path runs unchanged.
 *
 * A detached popout does not use this: its store owns no layout, and its tabs
 * already stream through `FileDropContext` / the detached window context.
 */
export const TabScopeContext = createContext<string | null>(null);

export function useTabScope(): string | null {
  return useContext(TabScopeContext);
}

/**
 * Open `tab` in `scope` and bring it to the front of its subwindow — or, when
 * `matches` picks a tab that scope already has, focus that one instead
 * (`replace` closes it and opens the fresh copy: a diff or a compiled PDF that
 * must re-read). The scope-addressed twin of the `tabs.find` / `addTab` /
 * `setActive` sequence the open-a-file paths use.
 */
export function openTabInScope(
  scope: string,
  tab: Omit<TabEntry, "key">,
  matches?: (t: TabEntry) => boolean,
  opts?: { replace?: boolean },
): TabEntry {
  const store = useTabsStore.getState();
  const prior = matches ? (store.tabsByScope[scope] ?? []).find(matches) : undefined;
  if (prior && !opts?.replace) {
    store.setActive(prior.key);
    return prior;
  }
  if (prior) store.removeTabInScope(scope, prior.key);
  const entry = useTabsStore.getState().addTabToScope(scope, tab);
  useTabsStore.getState().setActive(entry.key);
  return entry;
}
