/**
 * Keyboard steering as a hierarchy: projects → subwindows → tabs (↓ in, ↑ and
 * Escape out), the new-tab keys inside a pane, the status jumps, the per-level
 * legend table (`steeringKeysFor`) and the region cursor that walks the side
 * panel, the header apps and a pane's + menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));
const jumps = vi.hoisted(() => [] as [string, string][]);
vi.mock("../../lib/shortcuts/tabJump", () => ({
  jumpToTab: (scope: string, key: string) => void jumps.push([scope, key]),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { STEERING_KEYS, steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { NEW_TAB_SHORTCUT_EVENT, type NewTabShortcutDetail } from "../../lib/shortcuts/newTabChord";
import { nextStatusTab, statusTabs } from "../../lib/shortcuts/statusJump";
import {
  activateRegionCursor,
  clearRegionCursor,
  moveRegionCursor,
  placeRegionCursor,
  regionCursor,
  regionTargets,
} from "../../lib/shortcuts/steeringRegion";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

/** Steering listens on `document` in the capture phase, so the key has to
 *  travel through the document, not be dispatched on `window`. */
function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

function twoPanes() {
  const store = useTabsStore.getState();
  store.addTab({ label: "a1", cmd: "bash", cwd: "/p", kind: "shell" });
  store.addTab({ label: "a2", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  const root = allGroups(useTabsStore.getState().layout)[0].id;
  useTabsStore.getState().splitWithTab(b.key, root, "right");
  const groups = allGroups(useTabsStore.getState().layout);
  const a = groups.find((g) => !g.tabKeys.includes(b.key))!;
  useTabsStore.getState().focusGroup(a.id);
  return { a: a.id, b: groups.find((g) => g.tabKeys.includes(b.key))!.id };
}

beforeEach(() => {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useKeyboardSteeringStore.getState().exit();
  jumps.length = 0;
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering levels", () => {
  it("starts on the projects, goes down to subwindows and tabs, and climbs back out", () => {
    const { a, b } = twoPanes();
    render(<Harness />);
    press({ key: " ", ctrlKey: true, shiftKey: true });
    expect(steering()).toMatchObject({ active: true, level: "projects" });

    press({ key: "ArrowDown" });
    expect(steering().level).toBe("panes");
    // ←/→ walk the subwindows while there are two.
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().focusedGroupId).toBe(b);
    press({ key: "ArrowLeft" });
    expect(useTabsStore.getState().focusedGroupId).toBe(a);

    press({ key: "ArrowDown" });
    expect(steering().level).toBe("tabs");
    const group = allGroups(useTabsStore.getState().layout).find((g) => g.id === a)!;
    const before = group.activeKey;
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().activeKey).not.toBe(before);
    expect(useTabsStore.getState().focusedGroupId).toBe(a);

    press({ key: "ArrowUp" });
    expect(steering().level).toBe("panes");
    press({ key: "Escape" });
    expect(steering().level).toBe("projects");
    press({ key: "Escape" });
    expect(steering().active).toBe(false);
  });

  it("steps the tabs straight away when there is only one subwindow", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "t1", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "t2", cmd: "bash", cwd: "/p", kind: "shell" });
    render(<Harness />);
    press({ key: " ", ctrlKey: true, shiftKey: true });
    press({ key: "ArrowDown" });
    const start = useTabsStore.getState().activeKey;
    press({ key: "ArrowRight" });
    expect(useTabsStore.getState().activeKey).not.toBe(start);
    // Nothing further down to go to.
    press({ key: "ArrowDown" });
    expect(steering().level).toBe("panes");
  });

  it("opens new tabs in the focused pane by type, then steps aside", () => {
    twoPanes();
    render(<Harness />);
    const requests: NewTabShortcutDetail[] = [];
    const onRequest = (e: Event) => {
      requests.push((e as CustomEvent<NewTabShortcutDetail>).detail);
      e.preventDefault();
    };
    window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    try {
      press({ key: " ", ctrlKey: true, shiftKey: true });
      press({ key: "ArrowDown" });
      press({ key: "n" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "shell" });
      expect(steering().active).toBe(false);

      press({ key: " ", ctrlKey: true, shiftKey: true });
      press({ key: "ArrowDown" });
      press({ key: "2" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "agent", slot: 1 });

      press({ key: " ", ctrlKey: true, shiftKey: true });
      press({ key: "ArrowDown" });
      press({ key: "+" });
      expect(requests[requests.length - 1]?.request).toEqual({ kind: "menu" });
      expect(steering()).toMatchObject({ active: true, level: "region", region: "addTab" });
    } finally {
      window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
    }
  });

  it("digits on the project level jump stations and stay in the mode", () => {
    render(<Harness />);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      activeId: null,
      setActive,
      projects: [{ id: "x", name: "x", status: "active", position: 0, local_file: "/x/project.json" }],
    });
    press({ key: " ", ctrlKey: true, shiftKey: true });
    press({ key: "2" });
    expect(setActive).toHaveBeenCalledWith("x");
    expect(steering()).toMatchObject({ active: true, level: "projects" });
  });

  it("Q / R / D jump to the next tab in that state and land on the tab level", () => {
    const store = useTabsStore.getState();
    const t1 = store.addTab({ label: "t1", cmd: "claude", cwd: "/p", kind: "agent" });
    const t2 = store.addTab({ label: "t2", cmd: "claude", cwd: "/p", kind: "agent" });
    useActivityStore.setState({
      attentionByTab: { [`p:${t1.key}`]: "decision", [`p:${t2.key}`]: "done" },
      busyByTab: {},
    });
    render(<Harness />);
    press({ key: " ", ctrlKey: true, shiftKey: true });
    press({ key: "d" });
    expect(jumps).toEqual([["p", t2.key]]);
    expect(steering().level).toBe("tabs");
    press({ key: "q" });
    expect(jumps[jumps.length - 1]).toEqual(["p", t1.key]);
    // Nothing is working: the key does nothing.
    press({ key: "r" });
    expect(jumps).toHaveLength(2);
  });
});

describe("status walk", () => {
  const tab = (key: string, kind: TabEntry["kind"] = "agent") => ({ key, kind }) as TabEntry;

  it("orders by station ring, then any other scope, then strip order, and wraps", () => {
    useProjectsStore.setState({
      projects: [{ id: "p", name: "p", status: "active", position: 0, local_file: "/p/project.json" }],
    });
    const tabsByScope = { "box:1": [tab("z")], p: [tab("b"), tab("a")], root: [tab("r")] };
    const attention = { "p:a": "done", "p:b": "done", "box:1:z": "done", "root:r": "done" } as const;
    const list = statusTabs("done", {}, { ...attention }, tabsByScope);
    expect(list.map((t) => `${t.scope}:${t.key}`)).toEqual(["root:r", "p:b", "p:a", "box:1:z"]);
    expect(nextStatusTab(list, { scope: "box:1", key: "z" }, 1)).toEqual({ scope: "root", key: "r" });
    expect(nextStatusTab(list, null, -1)).toEqual({ scope: "box:1", key: "z" });
    expect(nextStatusTab([], null, 1)).toBeNull();
  });

  it("counts only terminal tabs as working", () => {
    const list = statusTabs("working", { "p:a": true, "p:v": true }, {}, { p: [tab("a"), tab("v", "embed")] });
    expect(list).toEqual([{ scope: "p", key: "a" }]);
  });
});

describe("legend table", () => {
  const base: SteeringLegendState = {
    level: "projects",
    sideRegion: false,
    multiPane: false,
    apps: { mail: false, calendar: false, todo: false },
    statusCounts: { decision: 0, working: 0, done: 0 },
  };
  const labels = (s: Partial<SteeringLegendState>) =>
    steeringKeysFor({ ...base, ...s }).map((k) => k.labelKey);

  it("lists a header app only while it is switched on", () => {
    expect(labels({})).not.toContain("steering.mail.label");
    expect(labels({ apps: { mail: true, calendar: false, todo: false } })).toContain("steering.mail.label");
  });

  it("names what ←/→ do on the panes level", () => {
    expect(labels({ level: "panes", multiPane: true })).toContain("steering.focus.label");
    expect(labels({ level: "panes", multiPane: true })).not.toContain("steering.tabs.label");
    expect(labels({ level: "panes" })).toContain("steering.tabs.label");
    expect(labels({ level: "tabs", multiPane: true })).toContain("steering.tabs.label");
  });

  it("shows the new-tab keys inside a pane and the status jumps only when something is in that state", () => {
    expect(labels({ level: "panes" })).toEqual(
      expect.arrayContaining(["steering.newShell.label", "steering.newAgent.label", "steering.newTabMenu.label"]),
    );
    expect(labels({})).not.toContain("steering.nextDone.label");
    expect(labels({ statusCounts: { decision: 0, working: 0, done: 2 } })).toContain("steering.nextDone.label");
  });

  it("never lists the same key twice on one level", () => {
    const states: Partial<SteeringLegendState>[] = [
      { level: "projects", apps: { mail: true, calendar: true, todo: true } },
      { level: "panes", multiPane: true },
      { level: "panes" },
      { level: "tabs" },
      { level: "region", sideRegion: true },
    ];
    for (const s of states) {
      const keys = steeringKeysFor({ ...base, ...s, statusCounts: { decision: 1, working: 1, done: 1 } }).map(
        (k) => k.keys,
      );
      expect(new Set(keys).size, JSON.stringify(s)).toBe(keys.length);
    }
    expect(STEERING_KEYS.every((k) => k.levels.length > 0)).toBe(true);
  });
});

describe("region cursor", () => {
  function surface() {
    document.body.innerHTML = `
      <div id="root">
        <button id="b1">one</button>
        <div id="row" style="cursor: pointer"><span id="label" style="cursor: pointer">row</span></div>
        <input id="field" type="text" />
        <button id="gone" hidden>hidden</button>
      </div>`;
    // jsdom lays nothing out; give every element a box.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 10,
      height: 10,
    } as DOMRect);
    return document.getElementById("root")!;
  }

  it("finds controls and clickable rows once, skipping what is hidden", () => {
    const root = surface();
    expect(regionTargets(root).map((el) => el.id)).toEqual(["b1", "row", "field"]);
  });

  it("walks with wrapping, presses a button, and hands a text field the caret", () => {
    const root = surface();
    const clicked = vi.fn();
    document.getElementById("row")!.addEventListener("click", clicked);
    expect(placeRegionCursor(root)).toBe(true);
    expect(regionCursor()?.id).toBe("b1");
    moveRegionCursor(root, -1);
    expect(regionCursor()?.id).toBe("field");
    moveRegionCursor(root, 1);
    moveRegionCursor(root, 1);
    expect(regionCursor()?.id).toBe("row");
    expect(regionCursor()?.classList.contains("steer-cursor")).toBe(true);
    expect(activateRegionCursor()).toBe("press");
    expect(clicked).toHaveBeenCalledTimes(1);
    moveRegionCursor(root, 1);
    expect(activateRegionCursor()).toBe("type");
    expect(document.activeElement?.id).toBe("field");
    expect(document.querySelector(".steer-cursor")).toBeNull();
  });
});
