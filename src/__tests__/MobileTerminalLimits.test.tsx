import { act, render } from "@testing-library/react";
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

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const NOW = 1_788_609_600; // 2026-09-04 12:00:00 UTC

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}


const PANEL = [
  "Current session: 71% used · resets 6:20pm",
  "Current week (all models): 94% used · resets Mon 9am",
  "Current week (Fable): 12% used",
].join("\n");

function statusFetch(usage: unknown) {
  return vi.fn((url: string) => url.endsWith("/status")
    ? Promise.resolve(jsonResponse(200, {
      report: { state: "idle", label: "Claude", project: "p", today: { prompts: 0, worked_s: 0, decisions: 0, done: 0 }, usage },
    }))
    : Promise.resolve(jsonResponse(404, { error: "not_found" })));
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

describe("Eldrun Mobile facts row shows the account's 5h and weekly windows", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the usage panel on open and prints the session and all-models week", async () => {
    const fetchMock = statusFetch({ label: "Claude Code", supported: true, raw: PANEL, cached: false });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/tabs/tab-7/status")).toBe(true);
    const limits = [...container.querySelectorAll(".session-facts .fact-limit")];
    expect(limits.map((node) => node.textContent)).toEqual(["5h 71%", "week 94%"]);
    // Nearly spent is called out; the session window is not there yet.
    expect(limits.map((node) => node.classList.contains("high"))).toEqual([false, true]);
  });

  it("shows nothing for a CLI without a usage readout", async () => {
    vi.stubGlobal("fetch", statusFetch({ label: "Gemini CLI", supported: false, cached: false }));
    const { container } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(container.querySelector(".session-facts")).toBeNull();
  });

  it("asks nothing for a shell tab", async () => {
    const fetchMock = statusFetch({ label: "Claude Code", supported: true, raw: PANEL, cached: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={{ ...TAB, kind: "shell" as const }} back={() => {}} />);
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/status"))).toBe(false);
  });
});
