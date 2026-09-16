import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The harness is MobileTerminalReadableView.test.tsx's: xterm faked down to a
// buffer the test writes whole, and a WebSocket that opens on its own.
const terminalState = vi.hoisted(() => ({
  lines: [] as string[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array, callback?: () => void) {
      terminalState.lines = new TextDecoder().decode(value).split("\n");
      callback?.();
    }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../mobile-web/src/screens/Terminal";

const STATUS_ROW = "~/eldrun/projects/demo (develop) · Opus · 42% context";

/** A Claude Code screen: a turn, then the input box with the statusline the
 * TUI draws under it. */
const CLAUDE_SCREEN = [
  "> fix the failing test",
  "",
  "⏺ Reading the test first.",
  "  It fails on the second assertion.",
  "",
  "╭──────────────────────────────────────╮",
  "│ >                                    │",
  "╰──────────────────────────────────────╯",
  STATUS_ROW,
].join("\n");

async function openAgent(screenText: string) {
  render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
  await act(async () => {});
  const bytes = new TextEncoder().encode(screenText);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
}

/** A one-finger drag from `from` to `to`, released at once (well inside the
 * swipe's time limit). Dispatched the way the implementation listens: touch
 * pointer events where the engine has them, touch events otherwise. */
function drag(target: Element, from: [number, number], to: [number, number]) {
  act(() => {
    if ("PointerEvent" in window) {
      const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from[0], clientY: from[1] }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to[0], clientY: to[1] }));
    } else {
      const touchEvent = (type: string, [clientX, clientY]: [number, number]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touch = { identifier: 7, target, clientX, clientY, pageX: clientX, pageY: clientY, screenX: clientX, screenY: clientY };
        const list = type === "touchend" ? [] : [touch];
        Object.defineProperty(event, "touches", { value: list });
        Object.defineProperty(event, "targetTouches", { value: list });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        return event;
      };
      target.dispatchEvent(touchEvent("touchstart", from));
      target.dispatchEvent(touchEvent("touchend", to));
    }
  });
}

const output = () => screen.getByRole("region", { name: "Session output" });
const strip = () => screen.queryByRole("status", { name: "Status line" });
const rowTexts = () => Array.from(document.querySelectorAll(".focus-statusline-row"), (row) => (row.textContent ?? "").trim());

describe("Eldrun Mobile Focus status line", () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    localStorage.setItem("eldrun.mobile.view.agent", "focus");
    localStorage.setItem("eldrun.mobile.view.shell", "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the status row out of the output until a right swipe reveals it", async () => {
    await openAgent(CLAUDE_SCREEN);

    // Focus cuts the input frame, the statusline under it included.
    expect(within(output()).getByText("Reading the test first.")).toBeTruthy();
    expect(within(output()).queryByText(/42% context/)).toBeNull();
    expect(strip()).toBeNull();

    drag(output(), [100, 300], [220, 310]);

    const shown = strip();
    expect(shown).not.toBeNull();
    expect(shown?.className).toBe("focus-statusline");
    expect(rowTexts()).toContain(STATUS_ROW);
    expect(document.querySelector(".focus-statusline-empty")).toBeNull();
    // Revealing it does not paint it back into the output.
    expect(within(output()).queryByText(/42% context/)).toBeNull();
  });

  it("closes on a left swipe", async () => {
    await openAgent(CLAUDE_SCREEN);
    drag(output(), [100, 300], [220, 300]);
    expect(strip()).not.toBeNull();

    drag(output(), [260, 300], [120, 295]);
    expect(strip()).toBeNull();
  });

  it("closes on its ✕", async () => {
    await openAgent(CLAUDE_SCREEN);
    drag(output(), [100, 300], [220, 300]);
    expect(strip()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide status line" }));
    expect(strip()).toBeNull();
  });

  it("does not open on a mostly vertical drag", async () => {
    await openAgent(CLAUDE_SCREEN);
    // Far enough sideways to count, but less than half the vertical travel:
    // that is a scroll, not a swipe.
    drag(output(), [100, 100], [170, 300]);
    expect(strip()).toBeNull();
  });

  it("says so when the screen has no status line", async () => {
    await openAgent("⏺ Done.\nAll 12 tests pass.");
    drag(output(), [100, 300], [220, 300]);

    expect(strip()).not.toBeNull();
    expect(document.querySelectorAll(".focus-statusline-row")).toHaveLength(0);
    expect(document.querySelector(".focus-statusline-empty")?.textContent).toBe("No status line on screen");
  });

  it("has no strip in Terminal view", async () => {
    await openAgent(CLAUDE_SCREEN);
    drag(output(), [100, 300], [220, 300]);
    expect(strip()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.queryByRole("region", { name: "Session output" })).toBeNull();
    expect(strip()).toBeNull();

    const body = document.querySelector(".terminal-body");
    expect(body).not.toBeNull();
    drag(body!, [100, 300], [220, 300]);
    expect(strip()).toBeNull();
  });
});
