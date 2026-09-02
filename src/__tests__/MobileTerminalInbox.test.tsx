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
    write(value: Uint8Array, callback?: () => void) {
      terminalState.lines = new TextDecoder().decode(value).split("\n");
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

/** Repaints the session with `screen` and lets the reading view rebuild. */
async function paint(screenText: string) {
  const bytes = new TextEncoder().encode(screenText);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
}

const settle = (ms: number) => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fileInput = () => screen.getByTestId("inbox-file-input") as HTMLInputElement;
const composer = () => screen.getByLabelText("Message agent") as HTMLTextAreaElement;

function pick(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

describe("Eldrun Mobile composer + and the frozen reading view", () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the phone's files and a project @ from the +", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    const sheet = screen.getByRole("dialog", { name: "Add to the message" });
    expect(sheet.textContent).toContain("From this phone");
    expect(sheet.textContent).toContain("A project file (@)");

    // The project option is the old +: an @ into the draft, no sheet left up.
    fireEvent.click(screen.getByRole("button", { name: /A project file/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe("@");

    // The phone option opens the native picker — the hidden file input.
    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    fireEvent.click(screen.getByRole("button", { name: /From this phone/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    expect(fileInput().multiple).toBe(true);
  });

  it("sends a picked file into the project inbox and writes the desktop's reference into the draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {
      attachment: { name: "20260831-120000-IMG_0042.jpg", reference: ".eldrun/inbox/20260831-120000-IMG_0042.jpg", size: 3 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "look at this" } });

    pick([new File(["abc"], "IMG_0042.jpg", { type: "image/jpeg" })]);
    expect(screen.getByRole("status").textContent).toContain("IMG_0042.jpg");
    await settle(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/tabs/tab-7/inbox?name=IMG_0042.jpg");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    expect(init.body).toBeInstanceOf(File);

    // Delivered: the reference is in the draft and the pending row is gone.
    expect(composer().value).toBe("look at this @.eldrun/inbox/20260831-120000-IMG_0042.jpg ");
    expect(screen.queryByRole("status")).toBeNull();
    // The picker is reset so the same photo can be picked again.
    expect(fileInput().value).toBe("");
  });

  it("reports a refused or oversized file and keeps the draft untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(507, { error: "inbox_full" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});

    const huge = new File([""], "movie.mp4", { type: "video/mp4" });
    Object.defineProperty(huge, "size", { value: 24 * 1024 * 1024 + 1 });
    pick([huge, new File(["abc"], "notes.txt", { type: "text/plain" })]);
    await settle(0);

    // The oversized one never left the phone.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // (The voice-unavailable notice is also an alert in jsdom; count only ours.)
    const failed = () => Array.from(document.querySelectorAll(".inbox-upload.error")).map((row) => row.textContent ?? "");
    expect(failed().some((text) => text.includes("movie.mp4") && text.includes("larger than 24 MB"))).toBe(true);
    expect(failed().some((text) => text.includes("notes.txt") && text.includes("inbox is full"))).toBe(true);
    expect(composer().value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss movie.mp4" }));
    expect(failed()).toHaveLength(1);
    expect(failed()[0]).toContain("notes.txt");
  });

  it("holds the reading view still while a composer sheet is up and resumes when it closes", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint("Earlier answer\n> \n? for shortcuts");
    expect(screen.getByText("Earlier answer")).toBeTruthy();

    // Claude's silent default earns the mode sheet from the label alone.
    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    expect(screen.getByRole("dialog", { name: "Permission mode" })).toBeTruthy();

    // The session repaints under the sheet; the reading view does not follow.
    await paint("Earlier answer\n> \nplan mode on (shift+tab to cycle)");
    expect(screen.queryByText("plan mode on (shift+tab to cycle)")).toBeNull();
    // …but the sheet read the live screen: Plan is now the current mode.
    const plan = screen.getAllByRole("button").find((button) => button.querySelector("strong")?.textContent === "Plan");
    expect(plan?.getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("plan mode on (shift+tab to cycle)")).toBeTruthy();
  });
});
