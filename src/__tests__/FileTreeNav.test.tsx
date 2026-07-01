/**
 * Render tests for the right-panel file tree navigation:
 * - #2 (Group D.1): a file's `.file-name` span carries a native `title` with the
 *   full name so long names are readable on hover (CSS ellipsis aside).
 * - #3 (Group D.1): entering a subfolder renders a breadcrumb (↑, ⌂ root crumb,
 *   and a crumb per path segment); clicking the root crumb navigates back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn() }),
}));
vi.mock("../stores/settings", () => ({ useSettingsStore: () => null }));

import { useProjectsStore } from "../stores/projects";
import { RightPanel } from "../components/layout/RightPanel";

const mockUseProjectsStore = vi.mocked(useProjectsStore);

const ACTIVE_PROJECT = {
  id: "proj-1",
  name: "TestProject",
  status: "active",
  position: 0,
  local_file: "/tmp/test-project/project.json",
};

function fileEntry(name: string, is_dir = false) {
  return {
    name,
    path: `/tmp/test-project/${name}`,
    is_dir,
    size: 1,
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".")) : null,
    mime: null,
  };
}

const LONG_NAME = "this-is-a-very-long-file-name-that-would-be-truncated.txt";

// list_dir returns root contents at "" and the subfolder's contents at "sub".
function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string, args?: { relPath?: string }) => {
    if (cmd === "list_dir") {
      return Promise.resolve(
        args?.relPath === "sub"
          ? [fileEntry("deep.txt")]
          : [fileEntry("sub", true), fileEntry(LONG_NAME)],
      );
    }
    if (cmd === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function renderPanel() {
  await act(async () => {
    render(<RightPanel open={true} />);
  });
}

describe("file tree navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
    // Apply the selector like real zustand: FileTree subscribes with selectors
    // (e.g. `(s) => !!s.projects.find(...)?.remote`), so the mock must run the
    // selector against the state — returning the whole state object would make
    // those boolean selectors truthy (a non-empty object) and mis-flag the local
    // test project as remote.
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      rightPanelFolderByProject: {},
      setRightPanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("#2 shows the full file name in a title attribute", async () => {
    await renderPanel();
    const nameSpan = await screen.findByText(LONG_NAME);
    expect(nameSpan.classList.contains("file-name")).toBe(true);
    expect(nameSpan.getAttribute("title")).toBe(LONG_NAME);
  });

  it("#3 builds a breadcrumb on entering a subfolder and the root crumb goes back", async () => {
    const user = userEvent.setup();
    await renderPanel();

    // No breadcrumb at the project root.
    expect(document.querySelector(".file-tree-breadcrumb")).toBeNull();

    // Enter the subfolder.
    await user.click(await screen.findByText("sub"));

    const crumb = await screen.findByText("sub", { selector: ".file-tree-crumb" });
    expect(crumb).toBeTruthy();
    expect(document.querySelector(".file-tree-up")).toBeTruthy();
    expect(document.querySelector(".file-tree-crumb[title='Project root']")).toBeTruthy();
    // The subfolder's contents are now listed.
    expect(await screen.findByText("deep.txt")).toBeTruthy();

    // Clicking the root crumb returns to the top (breadcrumb disappears).
    await user.click(screen.getByTitle("Project root"));
    await screen.findByText(LONG_NAME);
    expect(document.querySelector(".file-tree-breadcrumb")).toBeNull();
  });

  it("#1 'New File' from the context menu prompts and calls create_file", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("created.ts");
    await renderPanel();

    // Right-click the file-tree background to open the root context menu (New
    // File / New Folder live there, not on the per-entry menu), then choose New File.
    await screen.findByText("sub");
    fireEvent.contextMenu(document.querySelector(".file-tree")!);
    await user.click(await screen.findByText("New File"));

    expect(promptSpy).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("create_file", {
      projectDir: "/tmp/test-project",
      relPath: "created.ts",
    });
    promptSpy.mockRestore();
  });
});
