/**
 * The two mouse gestures an agent pane adds to xterm (TerminalView):
 *
 *  - **double-click pastes** the clipboard at the agent's prompt. The press must
 *    never reach xterm's selection service: a word-select there would be picked
 *    up by copy-on-select and would overwrite the clipboard *being pasted*.
 *  - **a plain drag still selects** while the TUI holds the mouse. Full-screen
 *    agents turn on mouse tracking, after which xterm reports every press to the
 *    program and selects nothing — "can't copy out of an agent tab". The press is
 *    handed to xterm wearing the force-selection modifier instead.
 *
 * Both are agent-pane only (`zoomable`), and the paste goes through `term.paste`
 * so a multi-line clipboard arrives as one bracketed paste rather than a burst of
 * Enters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

// TerminalView opens xterm only into a container that is actually laid out, and
// every jsdom element measures 0×0 with no offsetParent. Give them a box so the
// terminal really does `open()` into the pane — these gestures are all about the
// element xterm creates in there.
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const { termSpy } = vi.hoisted(() => ({
  termSpy: {
    paste: vi.fn(),
    focus: vi.fn(),
    // The live mode the running program sets; flipped per test.
    mouseTrackingMode: "none" as "none" | "any",
    // Whatever xterm's own mousedown listener would have seen, recorded by a
    // stand-in listener the stub installs on the element it is "opened" into.
    seen: [] as MouseEvent[],
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open(parent: HTMLElement) {
      // xterm builds its own element INSIDE the container and binds the
      // selection service to it — so mirror that shape, since the production
      // handler's whole job is to run before a listener living down there.
      const el = document.createElement("div");
      parent.appendChild(el);
      el.addEventListener("mousedown", (e) => termSpy.seen.push(e as MouseEvent));
    }
    write() {}
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = { active: { length: 0, getLine: () => null } };
    attachCustomKeyEventHandler() {}
    getSelection() { return ""; }
    focus() { termSpy.focus(); }
    paste(text: string) { termSpy.paste(text); }
    dispose() {}
    options = {};
    get modes() { return { mouseTrackingMode: termSpy.mouseTrackingMode }; }
    parser = { registerOscHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../components/terminal/TerminalView";

/** Render an agent pane (`zoomable`) and hand back its container element. */
async function agentPane(id: string): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      <TerminalView id={id} cmd="claude" cwd="/p" kind="agent" zoomable visible focused />,
    ).container;
  });
  // Read the pane AFTER the act: React 18 flushes the render when the act block
  // closes, so inside it the container is still empty.
  return container.firstElementChild as HTMLElement;
}

/** Press inside the pane the way a real click lands: on the element xterm built
 *  inside the container, so the container's capture-phase handler runs first and
 *  the selection service's own listener runs last — the ordering the gestures
 *  depend on. */
function press(pane: HTMLElement, detail: number, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail, ...init });
  act(() => {
    (pane.firstElementChild ?? pane).dispatchEvent(ev);
  });
  return ev;
}

describe("agent pane mouse gestures", () => {
  beforeEach(() => {
    termSpy.paste.mockClear();
    termSpy.focus.mockClear();
    termSpy.seen.length = 0;
    termSpy.mouseTrackingMode = "none";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("from the clipboard"), writeText: () => Promise.resolve() },
    });
  });

  it("double-click pastes the clipboard and never reaches xterm", async () => {
    const pane = await agentPane("p:dbl");
    // The opening single click is xterm's own business (it places the caret /
    // clears the selection) — only the second press is the gesture.
    press(pane, 1);
    expect(termSpy.paste).not.toHaveBeenCalled();

    const ev = press(pane, 2);
    await act(async () => {});

    expect(termSpy.paste).toHaveBeenCalledWith("from the clipboard");
    // Taken away from the selection service: no word-select, so copy-on-select
    // cannot overwrite the clipboard this very gesture is pasting.
    expect(termSpy.seen.some((e) => e.detail === 2)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not paste when a modifier is held", async () => {
    const pane = await agentPane("p:mod");
    press(pane, 2, { shiftKey: true });
    await act(async () => {});
    expect(termSpy.paste).not.toHaveBeenCalled();
  });

  it("forces a selection on a plain press while the program holds the mouse", async () => {
    termSpy.mouseTrackingMode = "any";
    const pane = await agentPane("p:grab");
    const ev = press(pane, 1);
    // xterm reads the force-selection modifier off the event object itself.
    expect(ev.shiftKey).toBe(true);
    // …and still gets the press: it is the selection service that must act on it.
    expect(termSpy.seen).toHaveLength(1);
  });

  it("leaves the press alone when the program is not tracking the mouse", async () => {
    const pane = await agentPane("p:free");
    const ev = press(pane, 1);
    // Forcing here would flip xterm into its shift-EXTENDS-the-selection branch,
    // so every new drag would grow the last selection instead of starting one.
    expect(ev.shiftKey).toBe(false);
    expect(termSpy.seen).toHaveLength(1);
  });

  it("is an agent-pane gesture: a shell tab keeps its word-select", async () => {
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <TerminalView id="p:shell" cmd="bash" cwd="/p" kind="shell" visible focused />,
      ).container;
    });
    press(container.firstElementChild as HTMLElement, 2);
    await act(async () => {});
    expect(termSpy.paste).not.toHaveBeenCalled();
    expect(termSpy.seen.some((e) => e.detail === 2)).toBe(true);
  });
});
