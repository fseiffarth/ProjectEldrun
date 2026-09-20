import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], alternate: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.alternate ? "alternate" : "normal"; },
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
    { kind: "answer", text: "Looking at the composer." },
    { kind: "answer", text: "Done: the **✕** empties the draft. See [the docs](https://example.com)." },
  ],
};

describe("Eldrun Mobile Focus reads the stored session", () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
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

  it("opens an agent tab on its stored session, and remembers Terminal for the agent once chosen", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    const { unmount } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("session-transcript");
    // The default is not written down as the reader's choice.
    expect(localStorage.getItem("eldrun.mobile.view.claude-code")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await settle();
    expect(localStorage.getItem("eldrun.mobile.view.claude-code")).toBe("terminal");
    unmount();

    // Another Claude tab opens where this one was left.
    render(<Terminal tab={{ ...TAB, id: "tab-8" }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-transcript")).toBeNull();
  });

  it("opens on Terminal when no stored session reads and Focus was never chosen", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: false, reason: "unsupported", entries: [], truncated: false })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("eldrun.mobile.view.claude-code")).toBeNull();
  });

  it("opens a shell tab on Terminal", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={{ ...TAB, id: "tab-9", kind: "shell", agent_label: undefined }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
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
    // One bubble per message the agent wrote, its Markdown formatted, its
    // link only a label.
    const answers = chat.querySelectorAll(".readable-turn.agent.answer");
    expect([...answers].map((bubble) => bubble.textContent)).toEqual(["Looking at the composer.", "Done: the ✕ empties the draft. See the docs."]);
    expect(answers[1].querySelector("strong")?.textContent).toBe("✕");
    expect(chat.querySelector("a")).toBeNull();
    // The next read names the version it holds, so an unmoved file answers small.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    const again = fetchMock.mock.calls.map(([url]) => url as string).filter((url) => url.includes("/transcript"));
    expect(again[again.length - 1]).toBe("/api/v1/tabs/tab-7/transcript?version=1200%3A1&limit=120");

    // Each message copies itself, as the agent wrote it; there is no
    // copy-everything button over the chat.
    expect(screen.queryByRole("button", { name: "Copy the session text" })).toBeNull();
    const copy = within(answers[1] as HTMLElement).getByRole("button", { name: "Copy message" });
    fireEvent.click(copy);
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Done: the **✕** empties the draft. See [the docs](https://example.com).");
    within(answers[1] as HTMLElement).getByRole("button", { name: "Copied" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Copy message" }));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("add a clear button");
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
    // The choice is a list under the Focus button; Session is there, dimmed,
    // saying why, and a tap on it does not switch.
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    const dimmed = screen.getByRole("menuitemradio", { name: /Session/ });
    expect(dimmed.getAttribute("aria-disabled")).toBe("true");
    expect(dimmed.textContent).toContain("No session id for this tab yet");
    expect(screen.getByRole("menuitemradio", { name: /Screen/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(dimmed);
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(screen.queryByRole("menu")).toBeNull();

    stored = STORED;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByTestId("session-transcript");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Screen/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(screen.getByText("Hi there.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Session/ }));
    screen.getByTestId("session-transcript");
  });

  it("reads a full-screen agent's stored session in Focus instead of the full-screen notice", async () => {
    const openCode = { ...TAB, id: "tab-oc", label: "OpenCode", agent_label: "OpenCode" };
    localStorage.setItem("eldrun.mobile.view.opencode", "focus");
    let stored: unknown = STORED;
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={openCode} back={() => {}} />);
    await settle();
    // OpenCode's TUI draws on the alternate screen.
    terminalState.alternate = true;
    const bytes = new TextEncoder().encode("┃ Build  grok-4.5\n┃ > 1. Yes\n┃   2. No");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    screen.getByTestId("session-transcript");
    expect(screen.queryByText("Full-screen program")).toBeNull();
    // The frame is read for the one thing the stored session cannot carry: the
    // choice the agent is waiting on. A fullscreen agent draws it there and
    // nowhere else — no scrollback holds it — and it has to pass the same
    // shape check as a dialog on a scrolling screen.
    within(screen.getByRole("group", { name: "On screen now" })).getByText("Yes");

    // Switched to the screen, the full-screen program says so, as before.
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Screen/ }));
    screen.getByText("Full-screen program");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    // The notice leads back to the stored session; with none, it is only the notice.
    fireEvent.click(screen.getByRole("button", { name: "Read the agent's stored conversation" }));
    screen.getByTestId("session-transcript");
    stored = { available: false, reason: "unsupported", entries: [], truncated: false };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByText("Full-screen program");
    expect(screen.queryByRole("button", { name: "Read the agent's stored conversation" })).toBeNull();
  });

  it("shows a sent prompt as the reader's bubble at once, and never changes it", async () => {
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    let stored = STORED;
    const fetchMock = sidecarFetch(() => stored);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "also the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    // The desktop is told the words, for the tab's prompt history.
    const report = fetchMock.mock.calls.find(([url]) => (url as string).endsWith(`/tabs/${TAB.id}/prompt`)) as unknown[] | undefined;
    expect(report?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ message: "also the tests" }) });
    // In the chat at once, as any prompt, not a "Sent" strip under it.
    const chat = screen.getByTestId("session-transcript");
    const prompts = () => [...chat.querySelectorAll(".readable-turn.user")];
    const bubble = prompts()[1];
    expect(bubble.textContent).toBe("also the tests");
    expect(bubble.className).toBe("readable-turn user");
    expect(document.querySelector(".last-sent")).toBeNull();

    // The agent answered, then took the prompt in: the record lands after
    // that answer in the file, the bubble stays where it was, as it was.
    stored = { ...STORED, version: "1300:2", entries: [
      ...STORED.entries,
      { kind: "answer", text: "Still on the button.", at: "2026-09-15T05:51:00.000Z" },
      { kind: "prompt", text: "also the tests", at: "2026-09-15T05:52:00.000Z" },
    ] };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toBe(bubble);
    expect(bubble.textContent).toBe("also the tests");
    expect(bubble.nextElementSibling?.textContent).toBe("Still on the button.");
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
