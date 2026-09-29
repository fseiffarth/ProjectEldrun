/**
 * Ctrl+Shift+←/→ step the focused pane's tabs from a focused terminal too.
 *
 * Every other nav chord stays the terminal's while xterm's helper textarea has
 * focus; the two tab steps are handed to the window (the terminal leaves them
 * unhandled — `terminalYieldsChord` — and the keyboard hook admits them —
 * `terminalMayTakeChord`). Shift+Tab stays the terminal's (the agents' mode
 * cycle), plain Shift+Arrow stays the terminal's too (an agent CLI, e.g.
 * Codex, uses it itself), other fields keep it for selection, and the root
 * console's terminals keep it too.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { terminalYieldsChord } from "../../lib/shortcuts/terminalTabChord";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useFullscreenMode } from "../../lib/window/fullscreenMode";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function resetTabs() {
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
}

function terminalTextarea(parent: HTMLElement = document.body): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  parent.appendChild(ta);
  return ta;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function twoTabs() {
  const store = useTabsStore.getState();
  store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  useTabsStore.getState().focusGroup(allGroups(useTabsStore.getState().layout)[0].id);
}

const activeKey = () => allGroups(useTabsStore.getState().layout)[0].activeKey;

describe("tab steps from a focused terminal", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    resetTabs();
    useSettingsStore.setState({ settings: null });
  });

  it("Ctrl+Shift+→ and Ctrl+Shift+← step the pane's tabs and claim the key", () => {
    twoTabs();
    render(<Harness />);
    const ta = terminalTextarea();
    const before = activeKey();
    const ev = press(ta, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(activeKey()).not.toBe(before);
    press(ta, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(activeKey()).toBe(before);
  });

  it("leaves plain Shift+Arrow to the terminal (an agent CLI's own chord)", () => {
    twoTabs();
    render(<Harness />);
    const ta = terminalTextarea();
    const before = activeKey();
    const ev = press(ta, { key: "ArrowRight", shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(activeKey()).toBe(before);
  });

  it("leaves Shift+Tab to the terminal", () => {
    twoTabs();
    render(<Harness />);
    const before = activeKey();
    const ev = press(terminalTextarea(), { key: "Tab", shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(activeKey()).toBe(before);
  });

  it("leaves Ctrl+Shift+Arrow to any other text field", () => {
    twoTabs();
    render(<Harness />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    const before = activeKey();
    const ev = press(input, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(activeKey()).toBe(before);
  });

  it("leaves Ctrl+Shift+Arrow to a root console terminal", () => {
    twoTabs();
    render(<Harness />);
    const overlay = document.createElement("div");
    overlay.className = "root-overlay";
    document.body.appendChild(overlay);
    const ta = terminalTextarea(overlay);
    const before = activeKey();
    press(ta, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(activeKey()).toBe(before);
    expect(terminalYieldsChord(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true }), null)).toBe(false);
  });

  it("the terminal yields the chord as bound, not the default", () => {
    const ta = terminalTextarea();
    const key = (init: KeyboardEventInit) => {
      const ev = new KeyboardEvent("keydown", init);
      Object.defineProperty(ev, "target", { value: ta });
      return ev;
    };
    expect(terminalYieldsChord(key({ key: "ArrowRight", ctrlKey: true, shiftKey: true }), null)).toBe(true);
    expect(terminalYieldsChord(key({ key: "ArrowUp", ctrlKey: true, shiftKey: true }), null)).toBe(false);
    const rebound = { prevTab: { key: "ArrowLeft", alt: true } };
    expect(terminalYieldsChord(key({ key: "ArrowLeft", altKey: true }), rebound)).toBe(true);
    expect(terminalYieldsChord(key({ key: "ArrowLeft", ctrlKey: true, shiftKey: true }), rebound)).toBe(false);
  });

  it("F11 is handed to the window from any terminal and toggles fullscreen", async () => {
    useFullscreenMode.setState({ on: false });
    render(<Harness />);
    const overlay = document.createElement("div");
    overlay.className = "root-overlay";
    document.body.appendChild(overlay);
    for (const ta of [terminalTextarea(), terminalTextarea(overlay)]) {
      const ev = new KeyboardEvent("keydown", { key: "F11" });
      Object.defineProperty(ev, "target", { value: ta });
      expect(terminalYieldsChord(ev, null)).toBe(true);
    }
    const ev = press(terminalTextarea(), { key: "F11" });
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(useFullscreenMode.getState().on).toBe(true));
  });
});
