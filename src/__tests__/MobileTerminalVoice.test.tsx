import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MobileSpeechRecognition,
  MobileSpeechRecognitionErrorEvent,
  MobileSpeechRecognitionResultEvent,
} from "../../mobile-web/src/voiceInput";

// The pane's live bracketed-paste state, which the screen reads off xterm.
const terminalModes = vi.hoisted(() => ({ bracketedPasteMode: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = terminalModes;
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeRecognition implements MobileSpeechRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: MobileSpeechRecognitionResultEvent) => void) | null = null;
  onerror: ((event: MobileSpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.(); }
}

import { Terminal } from "../../mobile-web/src/screens/Terminal";

function finalResult(transcript: string): MobileSpeechRecognitionResultEvent {
  return {
    resultIndex: 0,
    results: { 0: { 0: { transcript }, isFinal: true, length: 1 }, length: 1 },
  } as unknown as MobileSpeechRecognitionResultEvent;
}

describe("Eldrun Mobile terminal dictation", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    FakeWebSocket.instances = [];
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    terminalModes.bracketedPasteMode = false;
    vi.useRealTimers();
    delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    vi.unstubAllGlobals();
  });

  it("offers phone dictation for any agent and stages final text without submitting", async () => {
    render(<Terminal tab={{ id: "opaque-tab", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await act(async () => {});
    const speech = FakeRecognition.instances[0];
    expect(speech).toMatchObject({ continuous: true, interimResults: true, maxAlternatives: 1 });

    act(() => speech.onresult?.(finalResult("fix the mobile voice input")));

    const binary = FakeWebSocket.instances[0].sent.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value));
    expect(binary).toHaveLength(0);
    expect((screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement).value).toBe("fix the mobile voice input");
    expect(screen.getByRole("status").textContent).toContain("Heard: fix the mobile voice input");
  });

  it("does not add dictation to ordinary shell tabs", async () => {
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
  });

  it("submits shell commands from Focus view and keeps visible sent feedback", async () => {
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Shell command" });
    fireEvent.change(composer, { target: { value: "npm test" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const binary = FakeWebSocket.instances[0].sent.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value));
    expect(new TextDecoder().decode(binary[binary.length - 1] as Uint8Array)).toBe("npm test\r");
    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
  });

  it("keeps the native shell composer available beside the read-only terminal", async () => {
    render(<Terminal tab={{ id: "opaque-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const focus = screen.getByRole("button", { name: "Focus" });
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(focus.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(terminal);
    expect(terminal.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Shell command" })).toBeTruthy();
  });

  it("replaces the active agent prompt from the native composer in Terminal view", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    const send = screen.getByRole("button", { name: "Send" });
    const dictate = screen.getByRole("button", { name: "Dictate" });
    expect(dictate.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "fix the mobile terminal" } });
    expect((send as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(send);
    // A control byte and the text may not share one write: the agent TUI reads
    // the chunk as a single keypress and drops the rest, which delivered a bare
    // Enter and no message at all. Line reset, text and submit go out spaced.
    const decode = () => FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    expect(decode()).toEqual(["\u0001\u000b"]);
    expect((composer as HTMLTextAreaElement).value).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(decode()).toEqual(["\u0001\u000b", "fix the mobile terminal", "\r"]);
  });

  it("sends a multi-line agent draft as one message with soft newlines", async () => {
    render(<Terminal tab={{ id: "opaque-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const sent = FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    // Ctrl-J between the lines, a single carriage return at the end: the agent
    // receives one two-line message instead of submitting each line.
    expect(sent).toEqual(["\u0001\u000b", "first line", "\n", "second line", "\r"]);
  });

  it("sends a bracketed paste when the agent's pane has the mode on", async () => {
    terminalModes.bracketedPasteMode = true;
    render(<Terminal tab={{ id: "opaque-agent", label: "Codex", kind: "agent", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    const composer = screen.getByRole("textbox", { name: "Message agent" });
    fireEvent.change(composer, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const sent = FakeWebSocket.instances[0].sent
      .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
      .map((value) => new TextDecoder().decode(value as Uint8Array));
    // The closing marker ends the message, so the carriage return still submits
    // even when the link delivers both writes to the TUI in one chunk.
    expect(sent).toEqual([
      "\u0001\u000b",
      "\u001b[200~first line\nsecond line\u001b[201~",
      "\r",
    ]);
  });

  it("clears Focus state when React reuses the screen for another tab", async () => {
    const { rerender } = render(<Terminal tab={{ id: "shell-a", label: "Shell A", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});
    const composer = screen.getByRole("textbox", { name: "Shell command" });
    fireEvent.change(composer, { target: { value: "secret for tab a" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.change(composer, { target: { value: "unsent draft" } });

    rerender(<Terminal tab={{ id: "shell-b", label: "Shell B", kind: "shell", available: true, viewer_busy: false }} back={() => {}} />);
    await act(async () => {});

    expect(screen.queryByText("secret for tab a")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Shell command" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
  });
});
