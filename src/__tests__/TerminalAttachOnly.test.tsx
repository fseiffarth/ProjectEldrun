/**
 * #42: ATTACH-ONLY terminal contract (decision #2). The detached window opens a
 * SECOND TerminalView for the SAME PTY id; it must NEVER spawn the PTY (a
 * duplicate `pty_spawn` would kill+respawn the live one, destroying scrollback /
 * the agent session) and must NEVER kill it on unmount (the main window's pane
 * owns the PTY lifetime). This is the riskiest correctness crux of the feature,
 * so assert it directly: with `attachOnly`, no `pty_spawn` on mount and no
 * `pty_kill` on unmount — but a normal (non-attach) terminal DOES spawn + kill.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, act } from "@testing-library/react";

// jsdom lacks ResizeObserver, which TerminalView observes for refit.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

const { invoke } = vi.hoisted(() => ({
  // `unknown` rather than `undefined`: `pty_scrollback` answers with a string
  // (Group B #235), so the default must not narrow the mock's return type.
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// xterm pulls in canvas/DOM internals jsdom doesn't provide; stub the surface
// TerminalView touches.
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
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ settings: { color_scheme: "dark" } }),
  ),
  // Pass-through: only "system" resolves differently, and these tests pin a
  // concrete scheme.
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../components/terminal/TerminalView";

function names(): string[] {
  return invoke.mock.calls.map((c) => c[0] as unknown as string);
}

describe("TerminalView — attach-only (#42)", () => {
  beforeEach(() => invoke.mockClear());

  it("attachOnly asks for the terminal's history so it doesn't open blank", async () => {
    // Group B #235: an attach-only view opens a fresh xterm on a PTY that has
    // been running without it — a tab just popped out into its own window. It
    // used to render empty until the program next drew (a TUI recovers via the
    // fit's SIGWINCH; a plain shell's history existed only in the main window's
    // hidden xterm), and every seed-driven remount blanked it again.
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "pty_scrollback" ? "$ ls -la\r\ntotal 0\r\n" : undefined),
    );
    await act(async () => {
      render(<TerminalView id="p:hist" cmd="bash" cwd="/p" visible focused attachOnly />);
    });

    expect(names()).toContain("pty_scrollback");
    // …and it is still the PTY's own history it asks for, never a spawn.
    expect(names()).not.toContain("pty_spawn");
    invoke.mockImplementation(() => Promise.resolve(undefined));
  });

  it("a normal terminal spawns instead of asking for history", async () => {
    // The main window's pane is the one that STARTS the program, so there is no
    // history to catch up on — asking would be a round trip per tab at launch.
    await act(async () => {
      render(<TerminalView id="p:fresh" cmd="bash" cwd="/p" visible focused />);
    });

    expect(names()).toContain("pty_spawn");
    expect(names()).not.toContain("pty_scrollback");
  });

  it("attachOnly never spawns the PTY and never kills it on unmount", async () => {
    let unmount = () => {};
    await act(async () => {
      const r = render(
        <TerminalView id="p:a" cmd="bash" cwd="/p" visible focused attachOnly />,
      );
      unmount = r.unmount;
    });
    expect(names()).not.toContain("pty_spawn");

    await act(async () => {
      unmount();
    });
    expect(names()).not.toContain("pty_kill");
  });

  it("a normal (non-attach) terminal DOES spawn on mount and kill on unmount", async () => {
    let unmount = () => {};
    await act(async () => {
      const r = render(
        <TerminalView id="p:b" cmd="bash" cwd="/p" visible focused />,
      );
      unmount = r.unmount;
    });
    expect(names()).toContain("pty_spawn");

    await act(async () => {
      unmount();
    });
    expect(names()).toContain("pty_kill");
  });

  it("registers visibility before spawning, so a fast failing CLI keeps its error output", async () => {
    await act(async () => {
      render(<TerminalView id="p:fast-exit" cmd="openclaw" cwd="/p" visible focused />);
    });

    const spawnAt = names().indexOf("pty_spawn");
    const visibilityAt = names().indexOf("pty_set_visible");
    expect(visibilityAt).toBeGreaterThanOrEqual(0);
    expect(visibilityAt).toBeLessThan(spawnAt);
  });

  it("spawns only once through Strict Mode's development mount replay", async () => {
    await act(async () => {
      render(
        <StrictMode>
          <TerminalView id="p:strict" cmd="agy" args={["--continue"]} cwd="/p" visible focused />
        </StrictMode>,
      );
    });

    expect(names().filter((name) => name === "pty_spawn")).toHaveLength(1);
  });

  it("declares agent kinds in the restriction-only spawn field", async () => {
    await act(async () => {
      render(
        <TerminalView
          id="p:custom-agent"
          cmd="team-wrapper"
          cwd="/p"
          kind="local_agent"
          visible
          focused
        />,
      );
    });
    const call = invoke.mock.calls.find((entry) => entry[0] === "pty_spawn");
    expect((call?.[1] as { opts: { agent: boolean } }).opts.agent).toBe(true);
  });
});
