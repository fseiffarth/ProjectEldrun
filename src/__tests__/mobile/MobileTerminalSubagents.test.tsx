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

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { openSubagent, siblingPosition, stepSibling, subagentsIn } from "../../../mobile-web/src/terminal/subagents";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });


const MAIN = {
  available: true,
  version: "main:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "look around", at: "2026-09-24T10:00:00Z" },
    { kind: "answer", text: "Sending two scouts.", at: "2026-09-24T10:00:01Z" },
    { kind: "agent", text: "Map the backend", role: "Explore", subagent: "00000000000000a1", at: "2026-09-24T10:00:02Z" },
    { kind: "agent", text: "Find the tests", role: "general-purpose", subagent: "00000000000000b2", at: "2026-09-24T10:00:03Z" },
    { kind: "agent", text: "Still starting", role: "Plan", at: "2026-09-24T10:00:04Z" },
    { kind: "answer", text: "Both reported.", at: "2026-09-24T10:05:00Z" },
  ],
};

const SUBAGENTS: Record<string, unknown> = {
  "00000000000000a1": {
    available: true, version: "a1:1", truncated: false,
    entries: [
      { kind: "prompt", text: "Map every backend module", at: "2026-09-24T10:00:02Z" },
      { kind: "agent", text: "Dig into sync", role: "Explore", subagent: "00000000000000c3", at: "2026-09-24T10:00:10Z" },
      { kind: "answer", text: "The backend is in src-tauri.", at: "2026-09-24T10:01:00Z" },
    ],
  },
  "00000000000000b2": {
    available: true, version: "b2:1", truncated: false,
    entries: [{ kind: "answer", text: "Tests live beside the code.", at: "2026-09-24T10:02:00Z" }],
  },
  "00000000000000c3": { available: false, reason: "no_subagent", entries: [], truncated: false },
};

/** A fetch answering the session with MAIN and a subagent read with its own. */
function subagentFetch() {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) {
      const token = new URL(url, "http://phone").searchParams.get("subagent");
      return Promise.resolve(jsonResponse(200, { transcript: token ? SUBAGENTS[token] : MAIN }));
    }
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe("the pure path through subagents", () => {
  const entries = MAIN.entries as TranscriptEntry[];
  it("lists only the subagents that can be opened, and steps among them", () => {
    expect(subagentsIn(entries).map((ref) => ref.token)).toEqual(["00000000000000a1", "00000000000000b2"]);
    const path = openSubagent([], { token: "00000000000000a1", task: "Map the backend", role: "Explore" }, entries, 240);
    expect(siblingPosition(path[0])).toEqual({ index: 0, count: 2 });
    const next = stepSibling(path, 1);
    expect(next[0]).toMatchObject({ token: "00000000000000b2", task: "Find the tests", scrollTop: 240 });
    // Past either end the path stays as it is.
    expect(stepSibling(next, 1)).toBe(next);
    expect(stepSibling(path, -1)).toBe(path);
    expect(stepSibling([], 1)).toEqual([]);
  });
});

describe("Eldrun Mobile Reader opens the subagents an agent spawned", () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
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

  it("draws a spawn as a card that opens its conversation, and the bar goes back up", async () => {
    const fetch = subagentFetch();
    vi.stubGlobal("fetch", fetch);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const session = screen.getByTestId("session-transcript");
    const card = within(session).getByRole("button", { name: "Subagent: Explore · Map the backend" });
    // One whose CLI has not said where it lives yet is there, but shut.
    expect((within(session).getByRole("button", { name: "Subagent: Plan · Still starting" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(card);
    await settle();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("subagent=00000000000000a1"))).toBe(true);
    const sub = screen.getByTestId("subagent-transcript");
    within(sub).getByText("Map every backend module");
    within(sub).getByText("The backend is in src-tauri.");
    // Its task reads as the prompt the conversation was given.
    expect(within(sub).getByRole("group", { name: "Its task" }).textContent).toContain("Map every backend module");
    const bar = screen.getByRole("navigation", { name: "Subagent" });
    within(bar).getByText("Map the backend");
    within(bar).getByText("1 of 2");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Back to the main conversation" }));
    await settle();
    screen.getByTestId("session-transcript");
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
  });

  it("steps to the next subagent without going back, and walks into a subagent's own", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    const bar = () => screen.getByRole("navigation", { name: "Subagent" });
    expect((within(bar()).getByRole("button", { name: "Previous subagent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(bar()).getByRole("button", { name: "Next subagent" }));
    await settle();
    within(bar()).getByText("Find the tests");
    within(bar()).getByText("2 of 2");
    within(screen.getByTestId("subagent-transcript")).getByText("Tests live beside the code.");
    fireEvent.click(within(bar()).getByRole("button", { name: "Previous subagent" }));
    await settle();

    // A subagent's own subagent opens one level deeper; the way back names
    // the conversation it came from. One that cannot be read says so.
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Dig into sync" }));
    await settle();
    within(bar()).getByText("Dig into sync");
    screen.getByText("This subagent’s conversation can’t be read");
    fireEvent.click(within(bar()).getByRole("button", { name: "Back to Map the backend" }));
    await settle();
    within(bar()).getByText("Map the backend");
  });

  it("goes back to the session when a prompt is sent from a subagent's conversation", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    screen.getByTestId("subagent-transcript");
    const field = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(field, { target: { value: "and the frontend?" } });
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await settle();
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
    within(screen.getByTestId("session-transcript")).getByText("and the frontend?");
  });
});
