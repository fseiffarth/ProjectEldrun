/**
 * Linux (the test environment's platform): Ctrl+W typed into a terminal is the
 * terminal's — readline's word-rubout, Claude Code's delete-word — never the
 * app's close-tab. The macOS ⌘W exception (`MacCmdCloseFromEditor.test.tsx`)
 * must not leak here, and neither may Super+W, which arrives as `metaKey`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { IS_MAC } from "../../lib/platform";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

describe("Ctrl+W from a focused terminal off macOS", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
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
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    useTabsStore.getState().focusGroup(allGroups(useTabsStore.getState().layout)[0].id);
  });

  it("runs on a non-Mac platform", () => {
    expect(IS_MAC).toBe(false);
  });

  it("leaves Ctrl+W and Super+W to the terminal", () => {
    render(<Harness />);
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    document.body.appendChild(ta);
    for (const init of [
      { key: "w", ctrlKey: true },
      { key: "w", metaKey: true },
    ]) {
      const ev = press(ta, init);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });

  it("still closes the tab on Ctrl+W when no field has focus", () => {
    render(<Harness />);
    press(window, { key: "w", ctrlKey: true });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});
