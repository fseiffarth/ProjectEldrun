/**
 * The question an agent is waiting on, in Focus.
 *
 * The stored session cannot carry a choice the agent has not been given yet,
 * so Focus shows the live screen under it. It used to show it as *text* — the
 * dialog's rows as the TUI drew them, answerable only by walking a highlight
 * with the arrow keys, which the phone has no room for. The rows are now a
 * list: numbered as the dialog numbered them, and a tap sends the same keys.
 *
 * The screen below is the one claude-code paints for a permission prompt.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], type: "normal" as "normal" | "alternate" }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.type; },
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
  static instances: FakeWebSocket[] = [];
  static sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  /** Keystrokes go out as bytes; the control frames (resize, attach) are JSON
   * strings and are not what this test reads. */
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../mobile-web/src/screens/Terminal";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;

const TAB = { id: "tab-q", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

const STORED = {
  available: true,
  version: "1200:1",
  truncated: false,
  entries: [{ kind: "answer", text: "I'll add the clear button." }],
};

/** The permission prompt, as the reading view has it once the box frame is
 * stripped: what is asked, then the rows that answer it. */
const QUESTION = [
  "Edit file",
  "  src/lib/i18n.ts",
  "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  "  esc to cancel",
].join("\n");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const sidecarFetch = () => vi.fn((url: string) => {
  if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
  if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: STORED }));
  return Promise.resolve(jsonResponse(404, { error: "not_found" }));
});

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const settle = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
};

const question = () => screen.getByRole("group", { name: "On screen now" });
const rows = () => Array.from(question().querySelectorAll(".option-list button"), (row) => row.textContent ?? "");

describe("Eldrun Mobile Focus — the question an agent is waiting on", () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.type = "normal";
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", sidecarFetch());
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the dialog's rows by their own numbers, and answers the one tapped", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    screen.getByTestId("session-transcript");

    await paint(QUESTION);
    // What the rows answer is still shown as the screen drew it…
    within(question()).getByText(/Do you want to make this edit/);
    // …and the rows themselves are a list, under the dialog's own numbers.
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain("1");
    expect(rows()[0]).toContain("Yes");
    expect(rows()[2]).toContain("No, and tell Claude what to do differently");
    // Not twice: the rows are the list, not the list and the text behind it.
    expect(within(question()).queryByText(/2\. Yes, allow all edits/)).toBeNull();

    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("Yes, allow all edits during this session"));
    // One row down from the highlight, then Enter — the arrow row's own keys.
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, "\r"]);

    // The same row cannot be sent twice while the session catches up.
    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("No, and tell Claude what to do differently"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([]);
  });

  it("reads the question off a fullscreen agent's own frame", async () => {
    // Claude Code under `"tui": "fullscreen"` draws its whole session on the
    // alternate screen. There is no scrollback there for the reading view to
    // grow from — Focus reads the stored session instead — but the choice the
    // agent is waiting on is on that frame and nowhere else, so the frame is
    // read for it.
    terminalState.type = "alternate";
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(QUESTION);

    within(question()).getByText(/Do you want to make this edit/);
    expect(rows()).toHaveLength(3);
    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("Yes, allow all edits during this session"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, "\r"]);
  });

  it("gives the list back when the answer never lands", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(QUESTION);

    fireEvent.click(within(question()).getByText("Yes"));
    await settle(400);
    FakeWebSocket.sent = [];
    // The session never moved off the question: rather than leave a block that
    // can no longer be answered, the rows go live again.
    await settle(6_500);
    fireEvent.click(within(question()).getByText("Yes"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual(["\r"]);
  });
});
