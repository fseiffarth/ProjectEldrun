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
  invoke: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
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
    focus() {}
    dispose() {}
    options = {};
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
}));

import { TerminalView } from "../components/terminal/TerminalView";

function names(): string[] {
  return invoke.mock.calls.map((c) => c[0] as unknown as string);
}

describe("TerminalView — attach-only (#42)", () => {
  beforeEach(() => invoke.mockClear());

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
});
