/**
 * The composer's `/` menu (`mobile-web/src/slashCommands.ts`). A phone draft
 * never reaches the CLI's own input line before Send, so the menu a TUI opens
 * under a typed `/` never shows on the phone; the composer offers its own —
 * the slash commands this phone sent to the tab's CLI before, kept per CLI,
 * then a built-in list of the commands that CLI documents.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetSlashCommand,
  readSlashCommands,
  rememberSlashCommand,
  slashCatalog,
  slashCli,
  slashSuggestions,
} from "../../../mobile-web/src/slashCommands";

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

const sent: string[] = [];
class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(data: string) { sent.push(String(data)); }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";

const KEY = "eldrun.mobile.slashCommands";
const CLAUDE_TAB = { id: "tab-c", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
const lines = (draft: string, cli: string, used: string[] = []) => slashSuggestions(draft, cli, used).map((row) => row.line);

describe("Eldrun Mobile slash commands — which CLI", () => {
  it("keys the known families by their label, and any other CLI by its own first word", () => {
    expect(slashCli("Claude")).toBe("claude");
    expect(slashCli("Claude Code (fenced)")).toBe("claude");
    expect(slashCli("Codex")).toBe("codex");
    expect(slashCli("Gemini CLI")).toBe("gemini");
    expect(slashCli("OpenCode mini")).toBe("opencode");
    expect(slashCli("Goose")).toBe("goose");
    expect(slashCli("  ")).toBe("agent");
  });

  it("offers each CLI only its own spelling — Codex starts over with /new, Claude Code with /clear", () => {
    expect(slashCatalog("codex").map((entry) => entry.command)).toContain("/new");
    expect(slashCatalog("codex").map((entry) => entry.command)).not.toContain("/clear");
    expect(slashCatalog("claude").map((entry) => entry.command)).toContain("/clear");
    expect(slashCatalog("gemini").map((entry) => entry.command)).toContain("/compress");
    expect(slashCatalog("goose")).toEqual([]);
  });
});

describe("Eldrun Mobile slash commands — the store", () => {
  it("keeps what was sent per CLI, newest first, arguments and all", () => {
    const storage = memoryStorage();
    rememberSlashCommand("claude", "/model opus", storage, 1);
    rememberSlashCommand("claude", "  /compact   keep the plan ", storage, 2);
    rememberSlashCommand("codex", "/new", storage, 3);
    expect(readSlashCommands("claude", storage)).toEqual(["/compact keep the plan", "/model opus"]);
    expect(readSlashCommands("codex", storage)).toEqual(["/new"]);
    expect(readSlashCommands("gemini", storage)).toEqual([]);
  });

  it("moves a line sent again to the front instead of keeping it twice, and forgets on request", () => {
    const storage = memoryStorage();
    rememberSlashCommand("claude", "/model opus", storage, 1);
    rememberSlashCommand("claude", "/usage", storage, 2);
    rememberSlashCommand("claude", "/model opus", storage, 3);
    expect(readSlashCommands("claude", storage)).toEqual(["/model opus", "/usage"]);
    forgetSlashCommand("claude", "/model opus", storage);
    expect(readSlashCommands("claude", storage)).toEqual(["/usage"]);
    forgetSlashCommand("claude", "/usage", storage);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("ignores what is not a one-line slash command", () => {
    const storage = memoryStorage();
    for (const draft of ["plain prompt", "/", "//comment", "/model\nsecond line", `/x ${"a".repeat(300)}`]) {
      rememberSlashCommand("claude", draft, storage, 1);
    }
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("caps each CLI's list, so a year of commands cannot fill the store", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 40; index += 1) rememberSlashCommand("claude", `/cmd${index}`, storage, index);
    const kept = readSlashCommands("claude", storage);
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe("/cmd39");
  });

  it("reads anything but the written shape as nothing kept, and survives a blocked store", () => {
    for (const stored of ["[]", "null", "{oops", '{"claude":"/clear"}', '{"claude":[{"line":"no slash","at":1}]}', '{"claude":[{"line":"/x"}]}']) {
      expect(readSlashCommands("claude", memoryStorage({ [KEY]: stored }))).toEqual([]);
    }
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(readSlashCommands("claude", throwing)).toEqual([]);
    expect(() => rememberSlashCommand("claude", "/clear", throwing)).not.toThrow();
  });
});

describe("Eldrun Mobile slash commands — the suggestions", () => {
  it("offers nothing unless the draft is one line starting with a slash", () => {
    expect(lines("", "claude")).toEqual([]);
    expect(lines("compact", "claude")).toEqual([]);
    expect(lines("/compact\nmore", "claude")).toEqual([]);
  });

  it("puts the reader's own lines ahead of the built-in ones, and does not repeat the draft itself", () => {
    const used = ["/model opus", "/mcp"];
    expect(lines("/m", "claude", used)).toEqual(["/model opus", "/mcp", "/model", "/memory"]);
    expect(lines("/model", "claude", used)).toEqual(["/model opus"]);
    expect(lines("/model o", "claude", used)).toEqual(["/model opus"]);
    expect(lines("/clear", "claude")).toEqual([]);
  });

  it("falls back to commands that contain what was typed", () => {
    expect(lines("/pact", "claude")).toEqual(["/compact"]);
  });

  it("leaves room for the argument after a command that takes one", () => {
    const rows = slashSuggestions("/mod", "claude", []);
    expect(rows[0]).toMatchObject({ line: "/model", args: true, used: false });
    expect(slashSuggestions("/usa", "claude", [])[0]).toMatchObject({ line: "/usage", args: false });
  });
});

describe("Eldrun Mobile slash commands — the composer", () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }))));
    localStorage.setItem("eldrun.mobile.view.agent", "terminal");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens a menu under a typed slash, and a pick only fills the field", async () => {
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull();

    fireEvent.change(field, { target: { value: "/mod" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    const before = sent.length;
    fireEvent.click(within(menu).getByText("/model"));
    expect(field.value).toBe("/model ");
    // Nothing went to the session: the reader still sends it.
    expect(sent.length).toBe(before);
  });

  it("remembers a slash command sent to this CLI and offers it first the next time", async () => {
    const view = render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "/model opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(readSlashCommands("claude")).toEqual(["/model opus"]);
    // A prompt is not a command, and is not kept.
    fireEvent.change(field, { target: { value: "fix the build" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(readSlashCommands("claude")).toEqual(["/model opus"]);
    view.unmount();

    render(<Terminal tab={{ ...CLAUDE_TAB, id: "tab-other" }} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Message agent"), { target: { value: "/mo" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    const picks = within(menu).getAllByRole("button").filter((button) => button.classList.contains("slash-pick"));
    expect(picks[0].textContent).toContain("/model opus");

    fireEvent.click(within(menu).getByRole("button", { name: "Forget /model opus" }));
    expect(readSlashCommands("claude")).toEqual([]);
  });

  it("keeps one CLI's commands out of another's menu", async () => {
    rememberSlashCommand("codex", "/review the auth change");
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Message agent"), { target: { value: "/rev" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    expect(within(menu).queryByText("/review the auth change")).toBeNull();
    expect(within(menu).getByText("/review")).toBeTruthy();
  });
});
