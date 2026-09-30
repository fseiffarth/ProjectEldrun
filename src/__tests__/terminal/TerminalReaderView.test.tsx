import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const sendSteeringPrompt = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args) }));
const submitCommand = vi.fn((..._args: unknown[]) => Promise.resolve("p:agent-1"));
vi.mock("../../lib/agents/scheduledAgentInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agents/scheduledAgentInput")>()),
  submitScheduledAgentCommand: (...args: unknown[]) => submitCommand(...args),
}));
const written: string[] = [];
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: (_id: string, bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); return Promise.resolve(); },
}));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { TerminalPromptStrip } from "../../components/terminal/TerminalPromptStrip";
import { mergeTranscript, readerOffered, readerRequest, rememberReader, rememberedReader } from "../../lib/agents/agentReader";
import { useAgentReaderStore, useReaderOpen } from "../../stores/agents/agentReader";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { noteSentPrompt } from "../../lib/agents/sentPrompts";
import type { Terminal } from "@xterm/xterm";

/** A pane's xterm as far as the Reader reads it: its active buffer. */
function fakeTerminal(rows: string[]): Terminal {
  return {
    buffer: { active: { get length() { return rows.length; }, getLine: (row: number) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) } },
    onWriteParsed: () => ({ dispose() {} }),
  } as unknown as Terminal;
}

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const transcript = {
  available: true,
  version: "v1",
  truncated: true,
  entries: [
    { kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" },
    { kind: "answer", text: "Done — **two** changes.", at: "2026-09-30T08:01:00Z" },
    { kind: "prompt", text: "/model opus", at: "2026-09-30T08:02:00Z" },
  ],
};

function reader(host: HTMLElement, onShowTerminal = () => {}) {
  return render(
    <TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused onShowTerminal={onShowTerminal} />,
  );
}

describe("the agent pane's Reader", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? transcript : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ open: false });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("draws the stored conversation: prompts, formatted answers, commands as rules", async () => {
    reader(host);
    await screen.findByText("fix the parser");
    expect(host.querySelector(".terminal-reader-turn.user")?.textContent).toContain("fix the parser");
    expect(host.querySelector(".terminal-reader-turn.agent strong")?.textContent).toBe("two");
    expect(host.querySelector(".terminal-reader-command")?.textContent).toBe("/model opus");
    expect(screen.getByRole("button", { name: "Show earlier turns" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({
      agent: "claude", projectId: "p", sessionId: "launch-1", tabDir: "/p", since: 1000, version: null,
    }));
  });

  it("sends a prompt through the prompt box's path and shows it as sending", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    sendSteeringPrompt.mockImplementation((_tab: TabEntry, text: string) => { noteSentPrompt("st-1", text); return Promise.resolve(); });
    reader(host);
    await screen.findByText("fix the parser");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "and add a test" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "and add a test");
    expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("and add a test");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a prompt steering's box sent at once, and keeps it while the agent works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const term = fakeTerminal(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]);
    try {
      useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
      registerTerminal("p:agent-1", term);
      reader(host);
      await screen.findByText("fix the parser");
      act(() => noteSentPrompt("st-1", "queued while busy"));
      expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("queued while busy");
      noteSentPrompt("st-2", "another tab's prompt");
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("queued while busy");
      expect(host.textContent).not.toContain("another tab's prompt");
    } finally {
      unregisterTerminal("p:agent-1", term);
      vi.useRealTimers();
    }
  });

  it("keeps the text and says why when the prompt did not go in", async () => {
    sendSteeringPrompt.mockRejectedValue(new Error("agent terminal is not ready"));
    reader(host);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(screen.getByRole("alert").textContent).toMatch(/Not sent/);
    expect((box as HTMLTextAreaElement).value).toBe("hello");
  });

  it("goes back to the terminal on Esc", async () => {
    const back = vi.fn();
    reader(host, back);
    await screen.findByText("fix the parser");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(back).toHaveBeenCalled();
  });

  it("hides the composer while steering holds the keyboard, and takes it back after", async () => {
    act(() => useKeyboardSteeringStore.getState().enter());
    try {
      reader(host);
      await screen.findByText("fix the parser");
      expect(screen.queryByRole("textbox")).toBeNull();
      act(() => useKeyboardSteeringStore.getState().handOff("prompt"));
      expect(screen.queryByRole("textbox")).toBeNull();
      act(() => useKeyboardSteeringStore.getState().exit());
      expect(document.activeElement).toBe(screen.getByRole("textbox"));
    } finally {
      act(() => useKeyboardSteeringStore.getState().exit());
    }
  });

  it("says why when there is no session to read", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, sessionId: undefined }] } }));
    reader(host);
    await waitFor(() => expect(host.textContent).toMatch(/no session id yet/));
    expect(invoke).not.toHaveBeenCalledWith("agent_tab_transcript", expect.anything());
  });
});

describe("the Reader's subagents", () => {
  let host: HTMLElement;
  const session = {
    available: true,
    version: "s1",
    truncated: false,
    entries: [
      { kind: "prompt", text: "survey the repo", at: "2026-09-30T08:00:00Z" },
      { kind: "agent", text: "Find the parser", role: "Explore", subagent: "sa-1", at: "2026-09-30T08:00:10Z" },
      { kind: "agent", text: "Find the tests", role: "Explore", subagent: "sa-2", at: "2026-09-30T08:00:11Z" },
      { kind: "agent", text: "Not recorded yet", at: "2026-09-30T08:00:12Z" },
      { kind: "answer", text: "Both found.", at: "2026-09-30T08:02:00Z" },
    ],
  };
  const conversations: Record<string, unknown> = {
    "sa-1": { available: true, version: "a1", truncated: false, entries: [
      { kind: "prompt", text: "Find the parser" },
      { kind: "answer", text: "It lives in parse.ts." },
      { kind: "agent", text: "Read parse.ts", role: "general-purpose", subagent: "sa-1-1" },
    ] },
    "sa-2": { available: true, version: "a2", truncated: false, entries: [{ kind: "answer", text: "Tests sit beside the sources." }] },
    "sa-1-1": { available: false, reason: "no_transcript", entries: [], truncated: false },
  };
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    invoke.mockImplementation((command: string, args?: { subagent?: string | null }) => {
      if (command !== "agent_tab_transcript") return Promise.resolve([]);
      return Promise.resolve(args?.subagent ? conversations[args.subagent] : session);
    });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("opens a subagent's own conversation from its card and goes back up", async () => {
    reader(host);
    fireEvent.click((await screen.findByText("Find the parser")).closest("button")!);
    await screen.findByText("It lives in parse.ts.");
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ sessionId: "launch-1", subagent: "sa-1" }));
    const bar = screen.getByRole("navigation", { name: "Subagent" });
    expect(bar.textContent).toContain("Find the parser");
    expect(screen.queryByText("Both found.")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Back to the main conversation" }));
    await screen.findByText("Both found.");
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
  });

  it("cannot open a subagent whose CLI has not said where it lives", async () => {
    reader(host);
    expect((await screen.findByText("Not recorded yet")).closest("button")?.disabled).toBe(true);
  });

  it("steps between siblings and opens nested subagents; Esc goes up one level", async () => {
    reader(host);
    fireEvent.click((await screen.findByText("Find the parser")).closest("button")!);
    await screen.findByText("It lives in parse.ts.");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next subagent" }));
    await screen.findByText("Tests sit beside the sources.");
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous subagent" }));
    fireEvent.click((await screen.findByText("Read parse.ts")).closest("button")!);
    await waitFor(() => expect(host.textContent).toContain("This subagent’s conversation can’t be read"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await screen.findByText("It lives in parse.ts.");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await screen.findByText("Both found.");
  });

  it("lists every subagent of the session and opens one from the list", async () => {
    reader(host);
    const toggle = await screen.findByRole("button", { name: /Subagents \(3\)/ });
    fireEvent.click(toggle);
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    fireEvent.click(within(list).getByText("Find the tests").closest("button")!);
    await screen.findByText("Tests sit beside the sources.");
  });

  it("goes back to the session when a prompt is sent from a subagent", async () => {
    sendSteeringPrompt.mockImplementation((_tab: TabEntry, text: string) => { noteSentPrompt("st-1", text); return Promise.resolve(); });
    reader(host);
    fireEvent.click((await screen.findByText("Find the parser")).closest("button")!);
    await screen.findByText("It lives in parse.ts.");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "now fix it" } });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "now fix it");
    await screen.findByText("Both found.");
    expect(host.querySelector(".terminal-reader-turn.pending")?.textContent).toContain("now fix it");
  });
});

describe("the Reader's live rows", () => {
  let host: HTMLElement;
  let term: Terminal | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    written.length = 0;
    invoke.mockReset();
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_tab_transcript" ? { ...transcript, truncated: false } : []));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    if (term) unregisterTerminal("p:agent-1", term);
    host.remove();
    vi.useRealTimers();
  });

  it("answers the question on screen with a click: arrows from the highlight, then Enter", async () => {
    term = fakeTerminal([
      "> fix the strings", "", "Edit file", "  src/lib/i18n.ts", "",
      "Do you want to make this edit to i18n.ts?",
      "❯ 1. Yes", "  2. Yes, allow all edits during this session", "  3. No, and tell Claude what to do differently",
      "", "  esc to cancel",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const group = await screen.findByRole("group", { name: "Waiting for your answer" });
    expect(group.textContent).toMatch(/Do you want to make this edit/);
    fireEvent.click(screen.getByRole("button", { name: /Yes, allow all edits/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(written).toEqual(["\u001b[B", "\r"]);
    // Nothing can be clicked twice while the session redraws.
    expect((screen.getByRole("button", { name: /No, and tell Claude/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an agent's own question as its header, its question and tagged rows — not the screen", async () => {
    term = fakeTerminal([
      "> push it", "",
      "● My fix is ready, but pushing develop now would also push four",
      "  other commits.", "",
      "☐ Push scope", "",
      "Four other-session commits sit unpushed on develop. How should I land my",
      "Windows/CodeQL fix?", "",
      "❯ 1. Fix only (Recommended)", "     Put my fix directly on the pushed main.",
      "  2. Push everything", "     Push develop with all four commits.",
      "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const group = await screen.findByRole("group", { name: "Waiting for your answer" });
    expect(group.querySelector(".terminal-reader-question-tabs")?.textContent).toBe("Push scope");
    expect(group.querySelector(".terminal-reader-question-ask")?.textContent)
      .toBe("Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?");
    expect(group.querySelector(".terminal-reader-question-context")).toBeNull();
    expect(group.textContent).not.toMatch(/☐|My fix is ready|\(Recommended\)/);
    expect(group.querySelector(".terminal-reader-recommended")?.textContent).toBe("Recommended");
  });

  it("shows the agent at work and stops it with Esc", async () => {
    term = fakeTerminal(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]);
    registerTerminal("p:agent-1", term);
    reader(host);
    const status = await screen.findByText("Agent is working…");
    expect(status.parentElement?.textContent).toMatch(/9s · 1.2k tokens/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop" })); });
    expect(written).toEqual(["\u001b"]);
  });

  it("names the model at work and shows the status line's facts with the account's limits", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(
      command === "agent_tab_transcript" ? { ...transcript, truncated: false }
        : command === "agent_usage" ? {
          agent: "claude", label: "Claude", supported: true, cached: false,
          raw: "Current session: 71% used\nCurrent week (all models): 94% used\nCurrent week (Fable): 12% used",
        }
          : []));
    term = fakeTerminal([
      "> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", ">",
      "~/p (develop) · Opus 4.1 · 85% context left",
    ]);
    registerTerminal("p:agent-1", term);
    reader(host);
    expect(await screen.findByText("Opus is working…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Opus 4.1" })).toBeTruthy();
    const facts = host.querySelector(".terminal-reader-facts")!;
    expect(facts.textContent).toContain("⎇ develop");
    expect(facts.textContent).toContain("85% context");
    await waitFor(() => expect(facts.textContent).toContain("5h 29%"));
    expect(facts.textContent).toContain("week 6%");
    expect(host.querySelector(".terminal-reader-fact.high")?.textContent).toBe("week 6%");
  });

  it("opens the session's own /model picker as a list and answers it there", async () => {
    submitCommand.mockClear();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [{ ...tab, scheduleTargetId: "st-1" }] } }));
    const rows = [">", "~/p (develop) · Opus 4.1 · 85% context left"];
    term = fakeTerminal(rows);
    registerTerminal("p:agent-1", term);
    reader(host);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Opus 4.1" })); });
    expect(submitCommand).toHaveBeenCalledWith("st-1", "/model");
    rows.splice(0, rows.length,
      "> /model", "", "Select model", "Switch between Claude models.", "",
      "  1. Default (recommended)   Opus",
      "❯ 2. Sonnet                  Everyday tasks",
      "  3. Haiku                   Fastest",
      "", "Enter to confirm · Esc to exit");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const list = screen.getByRole("dialog", { name: "Select model" });
    // The picker is listed once — not also as a question in the chat.
    expect(screen.queryByRole("group", { name: "Waiting for your answer" })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Haiku/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(written).toEqual(["\u001b[B", "\r"]);
    rows.splice(0, rows.length, ">", "~/p (develop) · Haiku 4.5 · 85% context left");
    // Gone after the answer: a short wait for a next step (Codex's reasoning
    // level), then the list closes.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Haiku 4.5" })).toBeTruthy();
  });
});

describe("the Chat switch on the prompt strip", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve([]));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
  });

  it("shows only when offered and flips between Reader and Terminal", async () => {
    const toggle = vi.fn();
    const { rerender } = render(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} />,
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { pressed: false, name: /Chat/ })).toBeNull();
    rerender(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} reader={{ open: false, onToggle: toggle }} />,
    );
    fireEvent.click(screen.getByRole("button", { pressed: false, name: /Chat/ }));
    expect(toggle).toHaveBeenCalled();
    rerender(
      <TerminalPromptStrip ptyId="p:agent-1" scope="p" tabKey="agent-1" background="#000" foreground="#fff" onReturnFocus={() => {}} reader={{ open: true, onToggle: toggle }} />,
    );
    expect(screen.getByRole("button", { pressed: true, name: /Terminal/ })).toBeTruthy();
  });
});

describe("agentReader helpers", () => {
  beforeEach(() => localStorage.clear());

  it("offers the Reader only for agents whose transcript is read", () => {
    expect(readerOffered(tab)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "codex" })).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "gemini" })).toBe(false);
    expect(readerOffered({ kind: "local_agent", cmd: "ollama" })).toBe(false);
    expect(readerOffered({ kind: "shell", cmd: "bash" })).toBe(false);
    expect(readerOffered(undefined)).toBe(false);
  });

  it("builds the read like the phone bridge: root has no project, --continue has no launch floor", () => {
    expect(readerRequest("p", { ...tab, sessionId: undefined }, "/p", undefined, 60)).toBeNull();
    expect(readerRequest("root", tab, "/r", "v9", 60)).toMatchObject({ projectId: null, version: "v9", limit: 60 });
    expect(readerRequest("p", { ...tab, args: ["--continue"] }, "/p", undefined, 60)).toMatchObject({ since: null });
    expect(readerRequest("p", tab, "/p", undefined, 60)).toMatchObject({ subagent: null });
    expect(readerRequest("p", tab, "/p", undefined, 60, "sa-1")).toMatchObject({ subagent: "sa-1" });
  });

  it("keeps what is shown when the read answers unchanged", () => {
    const shown = { available: true, entries: [], truncated: false, version: "v1" };
    expect(mergeTranscript(shown, { available: true, unchanged: true, entries: [], truncated: false })).toBe(shown);
  });

  it("remembers one choice for every agent pane; the terminal is the default", () => {
    expect(rememberedReader()).toBe(false);
    rememberReader(true);
    expect(rememberedReader()).toBe(true);
    rememberReader(false);
    expect(rememberedReader()).toBe(false);
    // The per-CLI choice it replaced carries over when any CLI was on the Reader.
    localStorage.clear();
    localStorage.setItem("eldrun.agentReader.byAgent", JSON.stringify({ codex: true }));
    expect(rememberedReader()).toBe(true);
  });

  it("picking the Reader in one pane switches every pane that offers it", () => {
    const { result: claude } = renderHook(() => useReaderOpen(true));
    const { result: gemini } = renderHook(() => useReaderOpen(false));
    act(() => useAgentReaderStore.getState().set(true));
    expect(claude.current).toBe(true);
    expect(gemini.current).toBe(false);
    expect(rememberedReader()).toBe(true);
    act(() => useAgentReaderStore.getState().set(false));
    expect(claude.current).toBe(false);
  });
});
