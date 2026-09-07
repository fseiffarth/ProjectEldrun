/**
 * The Alerts group used to be rendered by `ProjectFilesPane`, which the shared
 * viewer mounts only for the *files* view — so a user who left the side panel on
 * Git (or Agents, or Windows) saw no alerts at all, and the header's 🔔 read as
 * on while nothing was showing. Mail, appointments and cards are global, so the
 * strip now belongs to `ProjectFilesView` and follows every view's body.
 *
 * A box's multi-root view was the last exception and is one no longer — see
 * `SidePanelBox.test.tsx`. Only the docked subwindow column (`compact`) still
 * withholds the group, on space grounds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { Settings } from "../types";
import { clearFileViewSnapshots } from "../lib/fileViewSnapshots";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../stores/settings", () => {
  const state: {
    settings: Settings | null;
    updateSettings: (patch: Partial<Settings>) => Promise<void>;
  } = { settings: null, updateSettings: vi.fn(async () => {}) };
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
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
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

async function renderOnView(view: string) {
  settingsState.settings = {
    files_alerts: true,
    side_panel_view_by_project: { "proj-1": view },
  } as Settings;
  let container!: HTMLElement;
  await act(async () => {
    container = render(<SidePanel open={true} />).container;
  });
  return container;
}

describe("side panel alerts across views", () => {
  it.each(["files", "git", "orange", "agents", "windows"])(
    "renders the alerts group in the %s view",
    async (view) => {
      const container = await renderOnView(view);
      expect(container.querySelector(".alerts-section")).not.toBeNull();
    },
  );

  it("is a view the panel really entered, not a silent fall back to Files", async () => {
    // Guards the case above: a view that was unavailable would render Files —
    // and its alerts — while claiming to prove nothing.
    const container = await renderOnView("git");
    expect(screen.getByRole("button", { name: "Git" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".alerts-section")).not.toBeNull();
  });

  it("stays hidden while the machine-wide switch is off", async () => {
    settingsState.settings = {
      files_alerts: false,
      side_panel_view_by_project: { "proj-1": "git" },
    } as Settings;
    let container!: HTMLElement;
    await act(async () => {
      container = render(<SidePanel open={true} />).container;
    });
    expect(container.querySelector(".alerts-section")).toBeNull();
  });
});
