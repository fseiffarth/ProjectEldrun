import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
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

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
const secs = (iso: string) => Date.parse(iso) / 1000;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

function sidecarFetch(files: unknown[], transcript?: unknown) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files }));
    if (url.includes("/transcript") && transcript) return Promise.resolve(jsonResponse(200, { transcript }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe("Eldrun Mobile Focus posts the files the agent sent into the chat", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("places a picture between the stored turns by time, as an agent message that opens full-screen", async () => {
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "run12.png", kind: "image/png", size: 48_000, modified: secs("2026-09-15T05:03:00Z") },
    ], {
      available: true,
      version: "1:1",
      truncated: false,
      entries: [
        { kind: "prompt", text: "plot run 12", at: "2026-09-15T05:00:00Z" },
        { kind: "answer", text: "Here is the plot.", at: "2026-09-15T05:02:00Z" },
        { kind: "prompt", text: "thanks", at: "2026-09-15T06:00:00Z" },
      ],
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    // No strip above the composer: the picture is in the chat instead.
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();
    const chat = screen.getByTestId("session-transcript");
    const turns = Array.from(chat.querySelectorAll(".readable-turn"));
    expect(turns.map((turn) => turn.classList.contains("outbox-message") ? "file" : turn.textContent))
      .toEqual(["plot run 12", "Here is the plot.", "file", "thanks"]);
    const message = within(chat).getByRole("group", { name: "From the agent" });
    expect(message.className).toContain("readable-turn agent");
    expect(message.querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/run12.png");
    expect(message.textContent).toContain("run12.png");

    fireEvent.click(within(message).getByRole("button", { name: "Open run12.png" }));
    expect(screen.getByRole("dialog", { name: "run12.png" }).querySelector("img")?.getAttribute("src")).toBe("/api/v1/tabs/tab-7/outbox/run12.png");
  });

  it("closes the screen's chat with the files, oldest first, and keeps the strip for the Terminal view", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", sidecarFetch([
      { name: "paper.pdf", kind: "application/pdf", size: 400, modified: 200 },
      { name: "plot.png", kind: "image/png", size: 9_000, modified: 100 },
    ]));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const messages = screen.getAllByRole("group", { name: "From the agent" });
    expect(messages.map((message) => message.querySelector("img") ? "plot.png" : message.querySelector("strong")?.textContent))
      .toEqual(["plot.png", "paper.pdf"]);
    fireEvent.click(within(messages[1]).getByRole("button", { name: "Open paper.pdf" }));
    expect(open).toHaveBeenCalledWith("/api/v1/tabs/tab-7/outbox/paper.pdf", "_blank", "noopener");
    expect(screen.queryByRole("region", { name: "Files from the agent" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await settle();
    expect(screen.queryAllByRole("group", { name: "From the agent" })).toEqual([]);
    screen.getByRole("region", { name: "Files from the agent" });
  });
});
