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
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
      // A reconnect notice arrives as a string; session bytes as an array.
      if (typeof value !== "string") terminalState.lines = new TextDecoder().decode(value).split("\n");
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
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
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
}

import { Terminal } from "../../mobile-web/src/screens/Terminal";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

/** A fetch answering the outbox (empty) and the transcript with whatever
 * `transcript` holds at the time of the call. */
function sidecarFetch(transcript: () => unknown) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: transcript() }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

const STORED = {
  available: true,
  version: "1200:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "add a clear button", at: "2026-09-15T05:49:39.013Z" },
    { kind: "answer", text: "Looking at the composer.\n\nDone: the ✕ empties the draft." },
  ],
};

describe("Eldrun Mobile Focus reads the stored session", () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on Terminal, and remembers Focus for the agent once chosen", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    const { unmount } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    await settle();
    expect(localStorage.getItem("eldrun.mobile.view.claude-code")).toBe("focus");
    unmount();

    // Another Claude tab opens where this one was left; a Codex tab does not.
    render(<Terminal tab={{ ...TAB, id: "tab-8" }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("session-transcript");
  });

  it("lays the stored prompts and answers out as a chat and polls with the last version", async () => {
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    const fetchMock = sidecarFetch(() => STORED);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const calls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(calls.find((url) => url.includes("/transcript"))).toBe("/api/v1/tabs/tab-7/transcript?limit=120");
    const chat = screen.getByTestId("session-transcript");
    const prompt = screen.getByRole("group", { name: "Your prompt" });
    expect(prompt.textContent).toBe("add a clear button");
    expect(prompt.className).toBe("readable-turn user");
    const answer = chat.querySelector(".readable-turn.agent.answer");
    expect(answer?.textContent).toContain("Done: the ✕ empties the draft.");
    // The next read names the version it holds, so an unmoved file answers small.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    const again = fetchMock.mock.calls.map(([url]) => url as string).filter((url) => url.includes("/transcript"));
    expect(again[again.length - 1]).toBe("/api/v1/tabs/tab-7/transcript?version=1200%3A1&limit=120");

    // Copy copies the stored turns, prompts marked the way the screen marks them.
    fireEvent.click(screen.getByRole("button", { name: "Copy the session text" }));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("> add a clear button\n\nLooking at the composer.\n\nDone: the ✕ empties the draft.");
  });

  it("falls back to the screen when the session is unavailable, and can be switched to it", async () => {
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    let stored: unknown = { available: false, reason: "no_session", entries: [], truncated: false };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    // The session as it paints: the echo, the answer, the live input box last.
    const bytes = new TextEncoder().encode("> hello\n\n⏺ Hi there.\n\n> ");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(screen.getByText("Hi there.").closest(".readable-turn")?.className).toBe("readable-turn agent answer");
    // The toggle is still there, dimmed; a tap says why instead of switching.
    const dimmed = screen.getByRole("button", { name: "Session" });
    expect(dimmed.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("No session id for this tab yet")).toBeNull();
    fireEvent.click(dimmed);
    screen.getByText("No session id for this tab yet");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    stored = STORED;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByTestId("session-transcript");
    fireEvent.click(screen.getByRole("button", { name: "Screen" }));
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(screen.getByText("Hi there.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session" }));
    screen.getByTestId("session-transcript");
  });

  it("clears the draft with the composer's ✕", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Clear the message" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a long dictated draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear the message" }));
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear the message" })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("asks a socket that came back with the page to prove itself, and reconnects when it does not", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = FakeWebSocket.instances[0];
    expect(first.sent.some((frame) => frame.includes("\"ready\""))).toBe(true);
    const before = first.sent.length;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(first.sent.slice(before).some((frame) => frame.includes("\"ping\""))).toBe(true);
    // No pong within the resume grace: the socket is closed, and a new one opened.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.useRealTimers();
  });
});
