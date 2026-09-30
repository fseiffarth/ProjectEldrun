/**
 * A prompt sent while the agent works can be edited until the agent takes it.
 *
 * Instead of typing it into the CLI's own queue, the phone asks the desktop to
 * hold it (`POST /tabs/{id}/held`) for the tab's next idle point. Its bubble
 * shows at once like any prompt's; its hold menu offers Edit until the
 * session records the prompt. The edit goes to the desktop
 * (`PUT /tabs/{id}/held/{heldId}`) and only then does the bubble take the new
 * words — in its place. A desktop that cannot hold it costs nothing: the
 * words are typed as before.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { type: "normal", length: 0, getLine: () => undefined } };
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
  get frames() { return this.sent.filter((frame) => frame === "<bytes>").length; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", agent_status: "working" as const, available: true, viewer_busy: false };

type Entry = { kind: string; text: string; at?: string };
let entries: Entry[] = [];
let heldAnswer: { status: number; body: unknown } = { status: 201, body: { id: "held-1" } };
let editAnswer: { status: number; body: unknown } = { status: 200, body: { id: "held-1" } };
let calls: { url: string; method: string; body?: string }[] = [];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const bubble = (words: string) => screen.getAllByRole("group", { name: "Your prompt" }).find((row) => row.textContent?.includes(words));
const composer = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;

describe("Eldrun Mobile held prompt edit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem("eldrun.mobile.view.claude-code", "focus");
    entries = [
      { kind: "prompt", text: "add a clear button", at: "2026-09-15T05:49:39.013Z" },
      { kind: "answer", text: "Looking at the composer.", at: "2026-09-15T05:49:45.000Z" },
    ];
    heldAnswer = { status: 201, body: { id: "held-1" } };
    editAnswer = { status: 200, body: { id: "held-1" } };
    calls = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) {
        return Promise.resolve(jsonResponse(200, { transcript: { available: true, version: `v${entries.length}`, truncated: false, entries } }));
      }
      if (url.endsWith("/held")) return Promise.resolve(jsonResponse(heldAnswer.status, heldAnswer.body));
      if (url.includes("/held/")) return Promise.resolve(jsonResponse(editAnswer.status, editAnswer.body));
      return Promise.resolve(jsonResponse(200, {}));
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function sendWhileWorking(words = "also the tests") {
    render(<Terminal tab={TAB} back={() => {}} />);
    await tick(50);
    fireEvent.change(composer(), { target: { value: words } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await tick(600);
  }

  function openMenu(words: string) {
    fireEvent.contextMenu(bubble(words)!);
  }

  it("holds the prompt on the desktop instead of typing it, and shows its bubble at once", async () => {
    await sendWhileWorking();
    expect(socket().frames).toBe(0);
    const hold = calls.find((call) => call.url.endsWith("/tabs/tab-7/held"));
    expect(hold?.method).toBe("POST");
    expect(JSON.parse(hold?.body ?? "{}")).toEqual({ message: "also the tests" });
    // The delivery records it on the desktop; the phone does not report it too.
    expect(calls.some((call) => call.url.endsWith("/prompt"))).toBe(false);
    expect(bubble("also the tests")).toBeTruthy();
    expect(composer().value).toBe("");
  });

  it("rewrites a held prompt from its bubble's menu, and the bubble keeps its place", async () => {
    await sendWhileWorking();
    const shown = bubble("also the tests")!;
    fireEvent.change(composer(), { target: { value: "half a new thought" } });
    openMenu("also the tests");
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    expect(composer().value).toBe("also the tests");
    fireEvent.change(composer(), { target: { value: "also the tests, and the lint" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the edit" }));
    await tick(10);
    const edit = calls.find((call) => call.url.endsWith("/tabs/tab-7/held/held-1"));
    expect(edit?.method).toBe("PUT");
    expect(JSON.parse(edit?.body ?? "{}")).toEqual({ message: "also the tests, and the lint" });
    // Same element, new words; the draft pushed aside comes back.
    expect(bubble("also the tests, and the lint")).toBe(shown);
    expect(composer().value).toBe("half a new thought");
    expect(socket().frames).toBe(0);
  });

  it("keeps the old words and hands the new ones back as a draft when the agent took the prompt first", async () => {
    await sendWhileWorking();
    editAnswer = { status: 409, body: { error: "held_gone" } };
    openMenu("also the tests");
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    fireEvent.change(composer(), { target: { value: "different words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the edit" }));
    await tick(10);
    expect(bubble("also the tests")).toBeTruthy();
    expect(bubble("different words")).toBeUndefined();
    expect(composer().value).toBe("different words");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByText(/already took this prompt/)).toBeTruthy();
  });

  it("offers no Edit once the session recorded the prompt", async () => {
    await sendWhileWorking();
    entries = [...entries, { kind: "prompt", text: "also the tests", at: "2026-09-15T05:50:30.000Z" }];
    await tick(7_000);
    openMenu("also the tests");
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("types the words itself when the desktop cannot hold them", async () => {
    heldAnswer = { status: 503, body: { error: "desktop_unavailable" } };
    await sendWhileWorking();
    expect(socket().frames).toBeGreaterThan(1);
    expect(calls.some((call) => call.url.endsWith("/tabs/tab-7/prompt"))).toBe(true);
    openMenu("also the tests");
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });
});
