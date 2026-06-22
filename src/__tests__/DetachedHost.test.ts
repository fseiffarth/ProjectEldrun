/**
 * #42: the MAIN window's host side of the detached protocol
 * (`listenDetachedHost`) and its wiring.
 *
 * Regression guard: `listenDetachedHost` was dead code (never called), so a
 * popped-out window hung on "Loading subwindow…" forever. These tests assert
 * (1) the host registers all three channels and drives the real tabs store
 * (seed → edit → dock), and (2) AppShell wires the host on the MAIN-window
 * startup path (it imports and calls `listenDetachedHost`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
// Vite/Vitest `?raw` import loads the AppShell source as a string (no node:fs).
import appShellSource from "../components/layout/AppShell.tsx?raw";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// Capture registered listeners by channel and the emitted payloads so we can
// drive the host as the detached window would.
type Handler = (ev: { payload: unknown }) => void;
const { handlers, emitted, emit, listen } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    handlers,
    emitted,
    emit: vi.fn((event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    }),
    listen: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve(() => handlers.delete(event));
    }),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));

import { useTabsStore, type GroupNode } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import {
  listenDetachedHost,
  DETACHED_REQUEST_SEED,
  DETACHED_EDIT,
  DETACHED_DOCK,
  DETACHED_CLOSE,
  detachedSeedEvent,
  type DetachedSeed,
} from "../stores/detached";

function reset() {
  handlers.clear();
  emitted.length = 0;
  invokeMock.mockClear();
  emit.mockClear();
  listen.mockClear();
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useProjectsStore.setState({ projects: [] });
}

/** Detach the second of two row-split groups, returning its id + label. */
function detachSecond(): { groupId: string; label: string; bKey: string } {
  const store = useTabsStore.getState();
  const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  void a;
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const root = useTabsStore.getState().layout as { children: GroupNode[] };
  const right = root.children[1];
  const label = useTabsStore.getState().detachGroup(right.id, { skipBackend: true })!;
  return { groupId: right.id, label, bKey: b.key };
}

describe("detached host (#42)", () => {
  beforeEach(reset);

  it("registers all protocol channels", async () => {
    await listenDetachedHost();
    expect(handlers.has(DETACHED_REQUEST_SEED)).toBe(true);
    expect(handlers.has(DETACHED_EDIT)).toBe(true);
    expect(handlers.has(DETACHED_DOCK)).toBe(true);
    expect(handlers.has(DETACHED_CLOSE)).toBe(true);
  });

  it("a seed request emits the group's tabs + subtree to the requesting label", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();

    handlers.get(DETACHED_REQUEST_SEED)!({
      payload: { label, scope: "p", groupId },
    });

    const seedEvent = emitted.find((e) => e.event === detachedSeedEvent(label));
    expect(seedEvent).toBeDefined();
    const seed = seedEvent!.payload as DetachedSeed;
    expect(seed.tabs.map((t) => t.key)).toEqual([bKey]);
    expect(seed.subtree.tabKeys).toEqual([bKey]);
  });

  it("an edit is applied to the host's detached record", async () => {
    const { groupId } = detachSecond();
    await listenDetachedHost();

    handlers.get(DETACHED_EDIT)!({
      payload: { scope: "p", groupId, edit: { kind: "close", key: "nope" } },
    });
    // The close of a non-owned key leaves the record intact (still detached).
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
  });

  it("an active-scope dock re-docks the group and closes the OS window", async () => {
    const { groupId, label } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_DOCK)!({ payload: { scope: "p", groupId } });

    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a cross-scope dock drops the record + closes the window without touching the live scope", async () => {
    const { groupId, label } = detachSecond();
    // Simulate the detached group's scope no longer being active.
    useTabsStore.setState({ scope: "other" });
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_DOCK)!({ payload: { scope: "p", groupId } });

    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a WM-close drops the group's tabs (no dock-back), kills their PTYs, and closes the window", async () => {
    const { groupId, label, bKey } = detachSecond();
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_CLOSE)!({ payload: { scope: "p", groupId } });

    // The detached record is gone and the popout's tab payload was dropped — not
    // re-injected into any layout — so it won't restore.
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(useTabsStore.getState().tabsByScope["p"]?.some((t) => t.key === bKey)).toBe(false);
    // The PTY is killed explicitly (the main pane isn't mounted to do it on unmount).
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: `p:${bKey}` });
    // And the OS window is closed.
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: label });
  });

  it("a WM-close persists the (parked) scope so its tabs don't restore", async () => {
    const { groupId } = detachSecond();
    // Parked: the popout's scope is no longer the active one in the main window.
    useTabsStore.setState({ scope: "other" });
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", local_file: "/p/project.json" } as never],
    });
    await listenDetachedHost();
    invokeMock.mockClear();

    handlers.get(DETACHED_CLOSE)!({ payload: { scope: "p", groupId } });

    expect(invokeMock).toHaveBeenCalledWith(
      "save_tab_layout",
      expect.objectContaining({ localFile: "/p/project.json" }),
    );
  });

  it("the combined unlisten removes every channel", async () => {
    const un = await listenDetachedHost();
    un();
    expect(handlers.has(DETACHED_REQUEST_SEED)).toBe(false);
    expect(handlers.has(DETACHED_EDIT)).toBe(false);
    expect(handlers.has(DETACHED_DOCK)).toBe(false);
    expect(handlers.has(DETACHED_CLOSE)).toBe(false);
  });

  it("AppShell wires the host on main-window startup (regression: it was dead code)", () => {
    // The blocker was that no main-window code imported/called the host. Assert
    // the wiring statically so a regression (removing the call) fails the suite.
    const src = appShellSource as string;
    expect(src).toMatch(/import\s*\{[^}]*listenDetachedHost[^}]*\}\s*from\s*["'][^"']*detached["']/);
    expect(src).toMatch(/listenDetachedHost\s*\(/);
  });
});
