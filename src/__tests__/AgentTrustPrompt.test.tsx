/**
 * A new Claude tab in a folder Claude has never been trusted in must NOT be
 * auto-typed at.
 *
 * Every Claude tab carries an `initialInput` of `/rename <project>`, submitted
 * with a bare Enter a beat after the TUI starts drawing. In an untrusted folder
 * the first thing Claude draws is its trust dialog, whose highlighted row is
 * `No, exit` — so that Enter answered it and the tab died on launch with
 * nothing but `[process exited]`. Every box folder is new, which is where this
 * surfaced, but a freshly created project hit it just as hard.
 *
 * The gate asks the backend whether the question is coming and, when it is,
 * leaves the tab entirely alone: the user answers, and the rename is skipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

// The PTY event bus, captured so the test can fire `terminal-ready` and a first
// output chunk the way the backend would.
const { bus } = vi.hoisted(() => ({
  bus: {
    ready: new Map<string, () => void>(),
    output: new Map<string, (data: string) => void>(),
  },
}));
vi.mock("../lib/terminalBus", () => ({
  onTerminalOutput: (id: string, h: (data: string) => void) => {
    bus.output.set(id, h);
    return () => bus.output.delete(id);
  },
  onTerminalReplay: () => () => {},
  onTerminalReady: (id: string, h: () => void) => {
    bus.ready.set(id, h);
    return () => bus.ready.delete(id);
  },
  onTerminalExit: () => () => {},
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = { active: { length: 0, getLine: () => null } };
    attachCustomKeyEventHandler() {}
    getSelection() { return ""; }
    focus() {}
    dispose() {}
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ settings: { color_scheme: "dark" } }),
  ),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../components/terminal/TerminalView";
import { clearClaimedInitialInputsForTest } from "../lib/terminalControl";

/** Fire `terminal-ready` plus a first output chunk, then let the boot cushion
 *  and the type/Enter timers run out. */
async function launch(id: string) {
  await act(async () => {
    bus.ready.get(id)?.();
    bus.output.get(id)?.("\x1b[?25l");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
}

function writes(): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === "pty_write");
}

describe("auto-typed initial input vs. Claude's trust dialog", () => {
  beforeEach(() => {
    invoke.mockClear();
    bus.ready.clear();
    bus.output.clear();
    clearClaimedInitialInputsForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    invoke.mockImplementation(() => Promise.resolve(undefined));
  });

  it("types nothing into a Claude tab whose folder is not trusted yet", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? false : undefined),
    );
    const id = "box:b1:t1";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd="/home/u/eldrun/boxes/new-box"
          kind="agent"
          initialInput="/rename New Box"
          visible
          focused
        />,
      );
    });
    await launch(id);

    const probe = invoke.mock.calls.find((c) => c[0] === "claude_folder_trusted");
    expect(probe?.[1]).toEqual({ cwd: "/home/u/eldrun/boxes/new-box" });
    // Neither the rename text nor — the fatal half — the Enter that would have
    // confirmed `No, exit`.
    expect(writes()).toHaveLength(0);
  });

  it("still types the rename once the folder is trusted", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? true : undefined),
    );
    const id = "p1:t1";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd="/home/u/eldrun/projects/p"
          kind="agent"
          initialInput="/rename P"
          visible
          focused
        />,
      );
    });
    await launch(id);

    // The text, then the Enter as its own write.
    expect(writes().length).toBeGreaterThanOrEqual(2);
  });

  it("does not probe for a non-Claude tab, and still types its input", async () => {
    // A shell tab's initialInput is a command the user asked to run; Claude's
    // trust dialog has nothing to do with it.
    const id = "p1:sh";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="bash"
          cwd="/home/u/eldrun/projects/p"
          kind="shell"
          initialInput="pytest -q"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(invoke.mock.calls.some((c) => c[0] === "claude_folder_trusted")).toBe(false);
    expect(writes().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the old behavior when the backend has no such probe", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      cmd === "claude_folder_trusted"
        ? Promise.reject(new Error("unknown command"))
        : Promise.resolve(undefined),
    );
    const id = "p1:old";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd="/home/u/eldrun/projects/p"
          kind="agent"
          initialInput="/rename P"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(writes().length).toBeGreaterThanOrEqual(2);
  });
});
