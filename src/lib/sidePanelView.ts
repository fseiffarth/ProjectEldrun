import type { FilesPanelView, Settings } from "../types";

/** The side panel remembers which view it is on per scope: a project by its id,
 *  and the root/box scopes by their scope name (project ids are UUIDs, so the
 *  two can't collide). Shared so the panel and the edge rail that opens it name
 *  the same entry — one of them keying differently would silently open the panel
 *  on someone else's last view. */
export function sidePanelViewKey(activeId: string | null, scope: string): string {
  return activeId ?? scope;
}

/** The settings patch that puts the panel on `view`: this scope's own entry, and
 *  the `side_panel_view` seed a scope with no entry of its own opens on. */
export function sidePanelViewPatch(
  view: FilesPanelView,
  viewKey: string,
  current: Settings | null | undefined,
): Partial<Settings> {
  return {
    side_panel_view: view,
    side_panel_view_by_project: {
      ...(current?.side_panel_view_by_project ?? {}),
      [viewKey]: view,
    },
  };
}
