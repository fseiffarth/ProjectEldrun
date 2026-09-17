/**
 * The root console: the root scope reached as a floating subwindow
 * (Ctrl+Shift+R) instead of a scope to switch to. These tests lock the wiring
 * that makes it safe to float over a project: opening it never moves the active
 * project, its panes are attach-only views of the root tabs' own PTYs (so
 * closing it ends nothing), a tab added from it lands in the ROOT scope, and a
 * row a root agent wrote through Eldrun's MCP tools reaches the calendar store
 * and the CalDAV write hook.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "root_mcp_status"
      ? Promise.resolve({ running: true, tools: ["calendar_add_event"] })
      : Promise.resolve(undefined),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));

const paneProps: Array<Record<string, unknown>> = [];
vi.mock("../components/tabs/TabPane", () => ({
  TabPane: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return null;
  },
}));
vi.mock("../components/tabs/NewTabMenu", () => ({
  NewTabMenu: (props: { scope: string; onPick: (spec: Record<string, unknown>) => void }) => (
    <button
      data-testid="pick-shell"
      data-scope={props.scope}
      onClick={() => props.onPick({ label: "Shell", cmd: "", cwd: "", kind: "shell" })}
    />
  ),
}));

import { allGroups, useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import { useCalendarStore } from "../stores/calendar";
import { toggleRootConsole, useRootOverlayStore } from "../stores/rootOverlay";
import { setCalendarWriteHandler } from "../lib/calendarWriteHook";
import { RootOverlayHost } from "../components/layout/RootOverlay";
import { SHORTCUT_DEFS, chordMatches, resolveChord } from "../lib/shortcuts";

function seedRootTabs() {
  const tabs = useTabsStore.getState();
  const a = tabs.addTabToScope("root", { label: "Claude", cmd: "claude", cwd: "/r", kind: "agent" });
  const b = tabs.addTabToScope("root", { label: "Shell", cmd: "", cwd: "/r", kind: "shell" });
  return { a, b };
}

beforeEach(() => {
  cleanup();
  paneProps.length = 0;
  listeners.clear();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1" });
  useRootOverlayStore.setState({ open: false });
  useCalendarStore.setState({ events: [], tasks: [] });
});

describe("the rootConsole shortcut", () => {
  it("defaults to Ctrl+Shift+R and collides with no other default", () => {
    const chord = resolveChord("rootConsole", undefined);
    expect(chord).toEqual({ key: "r", ctrl: true, shift: true });
    const same = SHORTCUT_DEFS.filter(
      (d) =>
        d.default.key === "r" && !!d.default.ctrl && !!d.default.shift && !d.default.alt && !d.default.meta,
    );
    expect(same.map((d) => d.action)).toEqual(["rootConsole"]);
    const press = new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true });
    expect(chordMatches(chord, press)).toBe(true);
  });

  it("toggles the overlay without touching the active project or scope", () => {
    toggleRootConsole();
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
    toggleRootConsole();
    expect(useRootOverlayStore.getState().open).toBe(false);
  });
});

describe("RootOverlayHost", () => {
  it("renders nothing while closed and the root tabs as attach-only panes when open", async () => {
    const { b } = seedRootTabs();
    render(<RootOverlayHost />);
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => useRootOverlayStore.getState().show());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();

    const latest = new Map(paneProps.map((p) => [(p.tab as { key: string }).key, p]));
    expect(latest.size).toBe(2);
    for (const props of latest.values()) {
      expect(props.attachOnly).toBe(true);
      expect(props.scope).toBe("root");
    }
    // The scope's own active tab (the last added) is the one shown.
    expect(latest.get(b.key)?.visible).toBe(true);
  });

  it("switches tabs locally and closes a tab in the ROOT scope", async () => {
    const { a, b } = seedRootTabs();
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());

    fireEvent.mouseDown(screen.getByText("Claude"));
    const [group] = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(group.activeKey).toBe(a.key);
    // The project on screen keeps its own scope.
    expect(useTabsStore.getState().scope).toBe("p1");

    const closeButtons = screen.getAllByTitle("Close tab");
    fireEvent.click(closeButtons[1]);
    expect((useTabsStore.getState().tabsByScope.root ?? []).map((t) => t.key)).toEqual([a.key]);
    expect(b.key).not.toBe(a.key);
  });

  it("adds a tab to the root scope, never to the project on screen", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    fireEvent.click(screen.getByTitle("New tab"));
    const pick = screen.getByTestId("pick-shell");
    expect(pick.getAttribute("data-scope")).toBe("root");
    fireEvent.click(pick);
    expect(useTabsStore.getState().tabsByScope.root).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope.p1 ?? []).toHaveLength(0);
  });

  it("Escape outside a pane closes it; the project stays where it was", async () => {
    seedRootTabs();
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(useProjectsStore.getState().activeId).toBe("p1");
  });

  it("renders a split root layout as one subwindow per group, each pane over its own group", async () => {
    const { a, b } = seedRootTabs();
    const store = useTabsStore.getState();
    const [group] = allGroups(store.layoutByScope.root ?? null);
    store.splitWithTabInScope("root", a.key, group.id, "right");
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());

    const groups = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(groups).toHaveLength(2);
    expect(document.querySelectorAll(".root-overlay-group")).toHaveLength(2);
    // Both tabs are the active one of their own subwindow, so both are shown.
    const latest = new Map(paneProps.map((p) => [(p.tab as { key: string }).key, p]));
    expect(latest.get(a.key)?.visible).toBe(true);
    expect(latest.get(b.key)?.visible).toBe(true);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("merges a row a root agent wrote over MCP and announces it for CalDAV — while closed", async () => {
    const announced: unknown[] = [];
    const uninstall = setCalendarWriteHandler(async (event) => {
      announced.push(event);
    });
    render(<RootOverlayHost />);
    const row = { id: "e1", calendar_id: "default", title: "Review", start: "2026-09-18T14:00", end: "2026-09-18T15:00", all_day: false };
    await act(async () => listeners.get("root-mcp-changed")?.({ payload: { kind: "event", op: "upsert", row } }));
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual(["e1"]);
    expect(announced).toHaveLength(1);

    await act(async () => listeners.get("root-mcp-changed")?.({ payload: { kind: "event", op: "delete", row } }));
    expect(useCalendarStore.getState().events).toHaveLength(0);
    uninstall();
  });
});
