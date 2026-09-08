/**
 * The closed side panel's edge rail (#267).
 *
 * With the panel closed the edge is the only way in, and it used to lead to one
 * place: Files. These pin the rail's contract — one tab per view the panel's own
 * switcher offers, and a click that both *stores* that view (so the panel paints
 * it, per #252) and opens the panel. The mousemove stop is here too: the rail
 * sits on the hover-reveal band, and a reveal on hover would unmount the rail
 * before any of its buttons could be clicked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const shared = vi.hoisted(() => ({
  updateSettings: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  settings: { side_panel_view_by_project: { other: "git" } } as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    onResized: vi.fn().mockResolvedValue(() => {}),
    onScaleChanged: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../stores/projects", () => {
  const state = {
    load: vi.fn(),
    loaded: true,
    // A project is active, so the panel has a target and the edge rail mounts.
    activeId: "proj-1",
    rootDir: "/home/u/eldrun/root",
    switchToast: null,
    clearSwitchToast: vi.fn(),
    connToast: null,
    clearConnToast: vi.fn(),
    projects: [],
  };
  return {
    useProjectsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state },
    ),
    listenProjectRuntimeSwitched: vi.fn().mockResolvedValue(() => {}),
  };
});
vi.mock("../stores/settings", () => {
  const state = {
    load: vi.fn(),
    loaded: false,
    get settings() {
      return shared.settings;
    },
    updateSettings: shared.updateSettings,
  };
  return {
    useSettingsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state, subscribe: () => () => {} },
    ),
    whenSettingsLoaded: () => Promise.resolve(),
    listenSettingsChanged: () => Promise.resolve(() => {}),
  };
});
vi.mock("../stores/boxes", () => ({
  useBoxesStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ load: vi.fn().mockResolvedValue(undefined) }),
  ),
  BOX_SCOPE_PREFIX: "box:",
}));
vi.mock("../stores/timer", () => ({
  useTimerStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ init: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined) }),
  ),
}));

// The panel itself is not under test here — only the rail that opens it.
vi.mock("../components/layout/HeaderBar", () => ({ HeaderBar: () => null }));
vi.mock("../components/layout/CenterPanel", () => ({ CenterPanel: () => null }));
vi.mock("../components/layout/SidePanel", () => ({
  SidePanel: ({ open }: { open: boolean }) => (open ? <div data-testid="side-panel" /> : null),
}));
// Project-scoped hosts that fetch on mount: with a project active they run
// against the blanket `invoke` mock above and have nothing to do with the rail.
vi.mock("../components/common/LocalLossDialog", () => ({ LocalLossDialog: () => null }));
vi.mock("../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));

import { AppShell } from "../components/layout/AppShell";

async function mount() {
  await act(async () => {
    render(<AppShell />);
  });
}

describe("side panel edge rail", () => {
  beforeEach(() => {
    shared.updateSettings.mockClear();
    shared.settings = { side_panel_view_by_project: { other: "git" } };
  });

  it("offers one tab per panel view while the panel is closed", async () => {
    await mount();
    for (const label of ["Files", "Git", "Apps", "Agents"]) {
      expect(screen.getByTitle(`Show the ${label} panel`)).toBeTruthy();
    }
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("stores the clicked view and opens the panel on it", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Show the Git panel"));
    });

    // Both keys: this project's own entry (untouched siblings preserved) and the
    // seed a scope with no entry of its own opens on.
    expect(shared.updateSettings).toHaveBeenCalledWith({
      side_panel_view: "git",
      side_panel_view_by_project: { other: "git", "proj-1": "git" },
    });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    // Opening the panel takes the rail with it, so it can never overlap.
    expect(screen.queryByTitle("Show the Files panel")).toBeNull();
  });

  it("Apps maps to the panel's windows view, not a view of its own", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Show the Apps panel"));
    });
    expect(shared.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ side_panel_view: "windows" }),
    );
  });

  it("does not let the hover-reveal band fire underneath it", async () => {
    await mount();
    const rail = screen.getByTitle("Show the Files panel").parentElement!;
    // The band reveals on a mousemove within 8px of the edge — which is exactly
    // where the rail is. Bubbling to `.app-body` must stop at the rail.
    await act(async () => {
      fireEvent.mouseMove(rail, { clientX: window.innerWidth - 2 });
    });
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });
});
