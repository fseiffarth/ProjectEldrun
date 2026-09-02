/**
 * The side panel's view switcher used to reset to Files on anything that
 * remounted the shared viewer — a project switch (the panel is keyed by project
 * id) and every relaunch. It now reads and writes `settings.side_panel_view`,
 * so a user living in Git or Agents finds that view where they left it.
 *
 * The second case here is the one the persistence itself cannot fix: a stored
 * view whose button this project has no reason to show (Sessions is remote-only)
 * must render as Files rather than as a room with no door out — without
 * overwriting what is stored, so it comes back on a remote project.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "../types";
import { clearFileViewSnapshots } from "../lib/fileViewSnapshots";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../stores/settings", () => {
  // A stand-in for the real store: selector-aware, with an `updateSettings`
  // that records the patch the panel writes rather than reaching the backend.
  const state: { settings: Settings | null; updateSettings: (patch: Partial<Settings>) => Promise<void> } = {
    settings: null,
    updateSettings: vi.fn(async () => {}),
  };
  return {
    __state: state,
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../stores/projects";
import * as settingsModule from "../stores/settings";
import { SidePanel } from "../components/layout/SidePanel";

const settingsState = (settingsModule as unknown as {
  __state: { settings: Settings | null; updateSettings: ReturnType<typeof vi.fn> };
}).__state;

const LOCAL_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  settingsState.settings = null;
  settingsState.updateSettings = vi.fn(async () => {});
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "git_change_stats") return Promise.resolve([]);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  vi.mocked(useProjectsStore).mockReturnValue(
    { projects: [LOCAL_PROJECT], activeId: "proj-1" } as ReturnType<typeof useProjectsStore>,
  );
});

async function renderPanel() {
  await act(async () => {
    render(<SidePanel open={true} />);
  });
}

describe("side panel view memory", () => {
  it("opens on the stored view instead of falling back to Files", async () => {
    settingsState.settings = { side_panel_view: "git" };
    await renderPanel();
    expect(screen.getByRole("button", { name: "Git" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("writes the view back when the switcher moves", async () => {
    await renderPanel();
    // Unset settings still read as Files, the pre-existing behaviour.
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("true");
    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Agents" }));
    });
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ side_panel_view: "agents" });
  });

  it("falls back to Files for a stored view this project has no button for", async () => {
    // Sessions is remote-only; this project is local, so the stored view has no
    // way back out of itself and must not be entered.
    settingsState.settings = { side_panel_view: "sessions" };
    await renderPanel();
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-pressed")).toBe("true");
    // …and the stored value is left alone, so a remote project still gets it.
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });
});
