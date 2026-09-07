/**
 * #42: a popout's visibility follows the active SCOPE, not the active project.
 *
 * A detached subwindow is an OS window of its own, so nothing about switching
 * what the main window shows hides it — the backend parks the outgoing scope's
 * popouts and un-parks the incoming scope's. That park used to ride entirely on
 * `switch_project_runtime`, which entering a `box:<id>` scope never performs
 * (`openBox` only sets the scope), so a project's popout kept floating over the
 * box's tabs. Every scope change funnels through `setScope`, which is where the
 * sync is now asked for.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTabsStore } from "../stores/tabs";
import { setDetachedWindowContext } from "../stores/detachedContext";

/** The scopes `sync_detached_scope` was asked to make visible, in order. */
function syncedScopes(): string[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "sync_detached_scope")
    .map((c) => (c[1] as { scope: string }).scope);
}

beforeEach(() => {
  invokeMock.mockClear();
  setDetachedWindowContext(null);
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("popout visibility follows the scope", () => {
  it("entering a box scope syncs the popouts to that box", () => {
    useTabsStore.getState().setScope("box:b7");
    expect(syncedScopes()).toEqual(["box:b7"]);
  });

  it("a project switch and a return to the root sync too", () => {
    useTabsStore.getState().setScope("p2");
    useTabsStore.getState().setScope("root");
    expect(syncedScopes()).toEqual(["p2", "root"]);
  });

  it("re-setting the same scope asks for nothing", () => {
    useTabsStore.getState().setScope("p1");
    expect(syncedScopes()).toEqual([]);
  });

  it("a popout's own heap never drives which windows the main window shows", () => {
    setDetachedWindowContext({
      scope: "p1",
      groupId: "g-1",
      label: "detached-p1-g-1",
      targetGroupId: () => "g-1",
      pushEdit: () => {},
      closeTab: () => {},
    });
    useTabsStore.getState().setScope("box:b7");
    expect(syncedScopes()).toEqual([]);
    setDetachedWindowContext(null);
  });
});
