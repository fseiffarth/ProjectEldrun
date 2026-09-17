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
// The docked file column is the shared ProjectFilesTab host (a whole viewer);
// what this suite is about is WHICH scope's group node the console writes.
vi.mock("../components/files/SubwindowFilesSidebar", () => ({
  DEFAULT_GROUP_FILES_WIDTH: 300,
  clampFilesWidth: (w: number) => w,
  SubwindowFilesSidebar: (props: { scope: string; cwd: string; viewerId?: string }) => (
    <div data-testid="root-files" data-scope={props.scope} data-cwd={props.cwd} data-viewer={props.viewerId} />
  ),
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
import { useMailStore } from "../stores/mail";
import { useTodoStore } from "../stores/todo";
import {
  clampRootOverlayFrame,
  filledRootOverlayFrame,
  rootOverlayFrameDrag,
  toggleRootConsole,
  useRootOverlayStore,
  MIN_ROOT_OVERLAY_HEIGHT,
  MIN_ROOT_OVERLAY_WIDTH,
} from "../stores/rootOverlay";
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
  useRootOverlayStore.setState({ open: false, frame: null, filled: false });
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

  it("merges a board card a root agent wrote, deletes it, and pushes no board-only move", async () => {
    const announced: unknown[] = [];
    const uninstall = setCalendarWriteHandler(async (event) => {
      announced.push(event);
    });
    useCalendarStore.setState({
      taskColumns: [{ id: "col-doing", name: "Doing", position: 0 }],
    } as never);
    render(<RootOverlayHost />);
    const row = { id: "t1", calendar_id: "default", title: "Ship", priority: 0, percent: 0, column: "col-doing" };
    await act(async () => listeners.get("root-mcp-changed")?.({ payload: { kind: "task", op: "upsert", row, local: false } }));
    expect(useCalendarStore.getState().tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(announced).toHaveLength(1);

    // A move's rank/column rows are Eldrun's own: merged, never announced.
    await act(async () =>
      listeners.get("root-mcp-changed")?.({ payload: { kind: "task", op: "upsert", row: { ...row, rank: 2048 }, local: true } }),
    );
    expect(useCalendarStore.getState().tasks[0].rank).toBe(2048);
    expect(announced).toHaveLength(1);

    await act(async () => listeners.get("root-mcp-changed")?.({ payload: { kind: "task", op: "delete", row, local: false } }));
    expect(useCalendarStore.getState().tasks).toHaveLength(0);
    expect(announced).toHaveLength(2);
    uninstall();
  });

  it("shows the overlay a root agent asked for and steps out of its way", async () => {
    render(<RootOverlayHost />);
    const open = async (payload: unknown) => {
      useRootOverlayStore.setState({ open: true });
      await act(async () => listeners.get("root-mcp-open")?.({ payload }));
      expect(useRootOverlayStore.getState().open).toBe(false);
    };
    await open({ overlay: "mail" });
    expect(useMailStore.getState().overlayOpen).toBe(true);
    await open({ overlay: "calendar" });
    expect(useCalendarStore.getState().overlayOpen).toBe(true);
    await open({ overlay: "todo", task_id: "t9" });
    expect(useTodoStore.getState()).toMatchObject({ overlayOpen: true, focusTaskId: "t9" });
    useMailStore.setState({ overlayOpen: false });
    useCalendarStore.setState({ overlayOpen: false });
    useTodoStore.getState().closeOverlay();
  });
});

describe("the console's docked file viewer", () => {
  it("◫ opens a column on the ROOT group node, rooted at the root folder", async () => {
    seedRootTabs();
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    expect(screen.queryByTestId("root-files")).toBeNull();

    fireEvent.click(screen.getByTitle("Open a file viewer in this subwindow"));
    const [group] = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(group.filesOpen).toBe(true);
    // The project on screen is untouched — root is not the active scope.
    expect(useTabsStore.getState().scope).toBe("p1");
    expect(useTabsStore.getState().layoutByScope.p1 ?? null).toBeNull();

    const column = screen.getByTestId("root-files");
    expect(column.getAttribute("data-scope")).toBe("root");
    expect(column.getAttribute("data-cwd")).toBe("/r");
    expect(column.getAttribute("data-viewer")).toBe(`group:${group.id}`);

    fireEvent.click(screen.getByTitle("Close this subwindow's file viewer"));
    expect(allGroups(useTabsStore.getState().layoutByScope.root ?? null)[0].filesOpen).toBe(false);
  });

  it("gives each subwindow of a split root layout its own column", async () => {
    const { a } = seedRootTabs();
    const store = useTabsStore.getState();
    const [group] = allGroups(store.layoutByScope.root ?? null);
    store.splitWithTabInScope("root", a.key, group.id, "right");
    const [g1, g2] = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    store.setGroupFilesInScope("root", g2.id, true);

    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    const columns = screen.getAllByTestId("root-files");
    expect(columns).toHaveLength(1);
    expect(columns[0].getAttribute("data-viewer")).toBe(`group:${g2.id}`);
    // Both subwindows carry their own ◫ — one open, one closed.
    expect(screen.getAllByTitle("Open a file viewer in this subwindow")).toHaveLength(1);
    expect(screen.getAllByTitle("Close this subwindow's file viewer")).toHaveLength(1);
    expect(g1.id).not.toBe(g2.id);
  });
});

describe("the console's frame", () => {
  it("fills the window and comes back, remembering nothing else", async () => {
    seedRootTabs();
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    fireEvent.click(screen.getByTitle("Fill the window"));
    expect(useRootOverlayStore.getState().filled).toBe(true);
    fireEvent.click(screen.getByTitle("Back to the previous size"));
    expect(useRootOverlayStore.getState()).toMatchObject({ filled: false, frame: null });
  });

  it("clamps a remembered frame into the window it actually opens in", () => {
    // Sized on a wide external display, opened on a laptop panel.
    expect(clampRootOverlayFrame({ x: 2400, y: 1300, width: 1600, height: 900 }, 1280, 800)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
    // A window smaller than the minimum still yields a usable console at 0,0.
    expect(clampRootOverlayFrame({ x: 10, y: 10, width: 300, height: 100 }, 320, 200)).toEqual({
      x: 0,
      y: 0,
      width: MIN_ROOT_OVERLAY_WIDTH,
      height: MIN_ROOT_OVERLAY_HEIGHT,
    });
    expect(filledRootOverlayFrame(1000, 600)).toEqual({ x: 16, y: 16, width: 968, height: 568 });
  });

  it("moves, resizes, and pins the far edge past the minimum", () => {
    const start = { x: 100, y: 100, width: 800, height: 500 };
    expect(rootOverlayFrameDrag(start, "move", 40, -30, 1920, 1080)).toEqual({
      x: 140,
      y: 70,
      width: 800,
      height: 500,
    });
    // A south-east corner grows both axes; a north-west one moves the origin.
    expect(rootOverlayFrameDrag(start, "se", 60, 40, 1920, 1080)).toEqual({
      x: 100,
      y: 100,
      width: 860,
      height: 540,
    });
    expect(rootOverlayFrameDrag(start, "nw", 50, 20, 1920, 1080)).toEqual({
      x: 150,
      y: 120,
      width: 750,
      height: 480,
    });
    // The left edge dragged far right stops at the minimum with the RIGHT edge
    // where it was — it must not start pushing the console across the screen.
    const pinned = rootOverlayFrameDrag(start, "w", 700, 0, 1920, 1080);
    expect(pinned.width).toBe(MIN_ROOT_OVERLAY_WIDTH);
    expect(pinned.x + pinned.width).toBe(start.x + start.width);
  });
});
