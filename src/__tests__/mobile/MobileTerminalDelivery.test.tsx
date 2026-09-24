/**
 * A prompt on a half-open link is acked or marked failed.
 *
 * The desktop acks every binary input frame by its ordinal on the socket
 * (`pty_bridge.rs`, `TerminalEvent::Ack`). A frame nothing acks within
 * `ACK_DEADLINE` was buffered into a dead link: the prompt's bubble stays
 * exactly where it is, says so, and offers Resend, which sends the same words
 * as new frames under the same bubble; the ack for those clears the marker.
 * The bubble is never removed or re-ordered.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        type: "normal",
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array | string, callback?: () => void) { callback?.(); }
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
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) { this.sent.push(typeof value === "string" ? value : "<bytes>"); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  /** Binary input frames sent so far — what the desktop's ack counts. */
  get frames() { return this.sent.filter((frame) => frame === "<bytes>").length; }
  ack(seq = this.frames) { this.onmessage?.({ data: JSON.stringify({ type: "ack", seq }) } as MessageEvent); }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const STORED = {
  available: true,
  version: "1200:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "add a clear button", at: "2026-09-15T05:49:39.013Z" },
    { kind: "answer", text: "Looking at the composer." },
  ],
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const bubble = () => screen.getAllByRole("group", { name: "Your prompt" }).find((row) => row.textContent?.includes("also the tests"))!;

describe("Eldrun Mobile prompt delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: STORED }));
      return Promise.resolve(jsonResponse(200, {}));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function sendPrompt() {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "also the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The message goes as several frames with gaps between them.
    await tick(600);
    expect(socket().frames).toBeGreaterThan(1);
    expect(bubble().hasAttribute("data-send-failed")).toBe(false);
  }

  it("marks the bubble not delivered when nothing acks its frames, and a resend clears it on the ack", async () => {
    await sendPrompt();
    const shown = bubble();
    const framesBefore = socket().frames;

    // Nothing acks: past the deadline the bubble says so — in place, unchanged.
    await tick(5_200);
    expect(bubble()).toBe(shown);
    expect(shown.getAttribute("data-send-failed")).toBe("true");
    expect(shown.textContent).toContain("also the tests");
    expect(shown.textContent).toContain("Not delivered");
    const rows = screen.getAllByRole("group", { name: "Your prompt" });
    expect(rows[rows.length - 1]).toBe(shown);

    // Resend: the same words go again as new frames, under the same bubble.
    fireEvent.click(screen.getByRole("button", { name: "Resend" }));
    await tick(600);
    expect(bubble()).toBe(shown);
    expect(socket().frames).toBeGreaterThan(framesBefore);
    expect(shown.textContent).toContain("Sending again");

    // The desktop acks every frame written so far: delivered.
    act(() => socket().ack());
    await tick(0);
    expect(bubble()).toBe(shown);
    expect(shown.hasAttribute("data-send-failed")).toBe(false);
    expect(shown.textContent).not.toContain("Not delivered");
    expect(shown.textContent).not.toContain("Sending again");
  });

  it("never marks a prompt the desktop acked", async () => {
    await sendPrompt();
    act(() => socket().ack());
    await tick(6_000);
    expect(bubble().hasAttribute("data-send-failed")).toBe(false);
    expect(screen.queryByText(/Not delivered/)).toBeNull();
  });

  it("marks the prompt at once when the socket closes under it", async () => {
    await sendPrompt();
    act(() => socket().close());
    await tick(0);
    expect(bubble().getAttribute("data-send-failed")).toBe("true");
    // The composer's own notice is for keystrokes with no bubble; the bubble
    // carries this one.
    expect(screen.queryByText(/That did not reach the desktop/)).toBeNull();
  });

  it("refuses to hand a frame to a socket whose send buffer has stalled", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    socket().bufferedAmount = 1024 * 1024;
    const before = socket().frames;
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(socket().frames).toBe(before);
    screen.getByText(/That did not reach the desktop/);
  });
});
