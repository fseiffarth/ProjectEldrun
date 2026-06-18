/**
 * Tests that the AppShell onCloseRequested handler:
 *  1. Prevents the default OS close
 *  2. Flushes the timer
 *  3. Calls win.destroy() to actually close the window
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

// vi.hoisted runs before vi.mock factories, so the shared state is ready when factories execute.
const shared = vi.hoisted(() => ({
  flush: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  destroy: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  handler: null as ((e: { preventDefault: () => void }) => Promise<void>) | null,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    destroy: shared.destroy,
    onCloseRequested: vi.fn().mockImplementation(async (h) => {
      shared.handler = h;
      return () => {};
    }),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

// Paths below are relative to this test file (src/__tests__/), matching the
// resolved module IDs that AppShell uses (src/stores/ and src/components/layout/).
vi.mock("../stores/projects", () => ({
  useProjectsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({
      load: vi.fn(),
      loaded: true,
      activeId: null,
      switchToast: null,
      clearSwitchToast: vi.fn(),
      projects: [],
    }),
  ),
  // AppShell subscribes to runtime-switch events on mount; provide a no-op.
  listenProjectRuntimeSwitched: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ load: vi.fn() }),
  ),
}));
vi.mock("../stores/timer", () => ({
  useTimerStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ init: vi.fn().mockResolvedValue(undefined), flush: shared.flush }),
  ),
}));

// Stub heavy child components to avoid bootstrapping terminals / xterm / etc.
vi.mock("../components/layout/HeaderBar", () => ({ HeaderBar: () => null }));
vi.mock("../components/layout/CenterPanel", () => ({ CenterPanel: () => null }));
vi.mock("../components/layout/BottomBar", () => ({ BottomBar: () => null }));
vi.mock("../components/layout/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("../components/layout/GlobalAppBar", () => ({ GlobalAppBar: () => null }));
vi.mock("../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));

import { AppShell } from "../components/layout/AppShell";

describe("AppShell close handler", () => {
  beforeEach(() => {
    shared.flush.mockClear();
    shared.destroy.mockClear();
    shared.handler = null;
  });

  it("prevents default, flushes timer, then destroys the window", async () => {
    render(<AppShell />);

    expect(shared.handler, "onCloseRequested handler should be registered").not.toBeNull();

    const preventDefault = vi.fn();
    await act(async () => {
      await shared.handler!({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shared.flush).toHaveBeenCalledOnce();
    expect(shared.destroy).toHaveBeenCalledOnce();
  });

  it("still destroys the window even when timer flush rejects", async () => {
    shared.flush.mockRejectedValueOnce(new Error("flush failed"));

    render(<AppShell />);

    expect(shared.handler).not.toBeNull();

    await act(async () => {
      await shared.handler!({ preventDefault: vi.fn() });
    });

    expect(shared.destroy).toHaveBeenCalledOnce();
  });
});
