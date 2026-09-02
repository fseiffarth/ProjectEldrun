import { useBoxesStore, BOX_SCOPE_PREFIX } from "../stores/boxes";
import { useProjectsStore } from "../stores/projects";
import { ROOT_SCOPE, useTabsStore } from "../stores/tabs";

/**
 * Show the tab a surface is pointing at: make it the visible tab of its
 * subwindow, then bring its scope up. That order is deliberate —
 * `revealTabInScope` writes the scope's own layout, which the switch then
 * mirrors, so the tab is already showing when the scope arrives instead of
 * appearing a frame later.
 *
 * One helper rather than a copy per surface: the pill status bars and the
 * Agents view are two ways of saying "that agent over there wants something",
 * and the only useful next step is the same one in both.
 *
 * Two fallbacks, both for a jump the reveal alone cannot make:
 *  - In a popout this store owns no layout, so the scope-addressed reveal finds
 *    nothing; `setActive` is forwarded to the main window and does the same job
 *    for the scope the popout is showing.
 *  - A tab in a hidden subwindow or a detached window isn't in the scope's
 *    visible tree; the switch still happens, since landing in the right scope is
 *    the half of the request that can be honoured.
 */
export function jumpToTab(scope: string, key: string) {
  const tabs = useTabsStore.getState();
  if (!tabs.revealTabInScope(scope, key) && tabs.scope === scope) tabs.setActive(key);
  if (scope.startsWith(BOX_SCOPE_PREFIX)) {
    if (tabs.scope !== scope) void useBoxesStore.getState().openBox(scope.slice(BOX_SCOPE_PREFIX.length));
    return;
  }
  const { activeId, setActive } = useProjectsStore.getState();
  const target = scope === ROOT_SCOPE ? null : scope;
  if (activeId !== target) void setActive(target);
}
