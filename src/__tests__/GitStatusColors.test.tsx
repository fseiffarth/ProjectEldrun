/**
 * Tests for git status color bars:
 * - STATUS_COLOR mapping (untracked/modified=red, staged=orange, unpushed=green, ignored=gray)
 * - RightPanel git action buttons have correct color bars
 * - Hovering a button shows the relevant staged/unpushed list
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STATUS_COLOR } from "../components/files/FileTree";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/projects", () => ({
  useProjectsStore: vi.fn(),
}));
vi.mock("../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn() }),
}));
vi.mock("../stores/settings", () => ({
  useSettingsStore: () => null,
}));

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

type Change = { path: string; added: number; deleted: number; binary: boolean };

function setupInvoke({
  staged = 0,
  unstaged = 0,
  untracked = 0,
  has_remote = true,
  fileList = {} as Record<string, string>,
  unpushedCommits = [] as string[],
  changeStats = {} as Record<string, Change[]>,
} = {}) {
  mockInvoke.mockImplementation((cmd: string, args?: { scope?: string }) => {
    if (cmd === "git_status") return Promise.resolve({ staged, unstaged, untracked, has_remote, is_repo: true });
    if (cmd === "git_file_statuses") return Promise.resolve(fileList);
    if (cmd === "git_unpushed_commits") return Promise.resolve(unpushedCommits);
    if (cmd === "git_change_stats") return Promise.resolve(changeStats[args?.scope ?? ""] ?? []);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "list_dir") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

describe("STATUS_COLOR", () => {
  it("untracked is red (#f85149)", () => {
    expect(STATUS_COLOR.untracked).toBe("#f85149");
  });

  it("modified is red (#f85149)", () => {
    expect(STATUS_COLOR.modified).toBe("#f85149");
  });

  it("staged is orange (#d29922)", () => {
    expect(STATUS_COLOR.staged).toBe("#d29922");
  });

  it("unpushed is green (#3fb950)", () => {
    expect(STATUS_COLOR.unpushed).toBe("#3fb950");
  });

  it("ignored is dim gray (#6e7681)", () => {
    expect(STATUS_COLOR.ignored).toBe("#6e7681");
  });
});

describe("git action button bars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectsStore.mockReturnValue({ projects: [ACTIVE_PROJECT], activeId: "proj-1" } as ReturnType<typeof useProjectsStore>);
  });

  async function renderOpenPanel() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<RightPanel open={true} />);
    });
    return result!;
  }

  it("Add button has red status bar", async () => {
    setupInvoke({ untracked: 1 });
    await renderOpenPanel();
    const bar = await screen.findByTestId("add-bar");
    expect(bar.style.background).toBe("rgb(248, 81, 73)");
  });

  it("Commit button has yellow status bar", async () => {
    setupInvoke({ staged: 1 });
    await renderOpenPanel();
    const bar = await screen.findByTestId("commit-bar");
    expect(bar.style.background).toBe("rgb(227, 179, 65)");
  });

  it("Push button has green status bar when remote present and commits ahead", async () => {
    setupInvoke({ has_remote: true, unpushedCommits: ["abc123"] });
    await renderOpenPanel();
    const bar = await screen.findByTestId("push-bar");
    expect(bar.style.background).toBe("rgb(63, 185, 80)");
  });

  it("Push button is absent when no remote", async () => {
    setupInvoke({ has_remote: false });
    await renderOpenPanel();
    expect(screen.queryByTestId("push-bar")).toBeNull();
  });

  it("Add button is hidden when nothing to stage", async () => {
    setupInvoke({ unstaged: 0, untracked: 0 });
    await renderOpenPanel();
    expect(screen.queryByTestId("add-bar")).toBeNull();
  });

  it("Commit button is hidden when nothing staged", async () => {
    setupInvoke({ staged: 0 });
    await renderOpenPanel();
    expect(screen.queryByTestId("commit-bar")).toBeNull();
  });

  it("Push button is hidden when remote present but no commits ahead", async () => {
    setupInvoke({ has_remote: true, unpushedCommits: [] });
    await renderOpenPanel();
    expect(screen.queryByTestId("push-bar")).toBeNull();
  });
});

describe("git change tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectsStore.mockReturnValue({ projects: [ACTIVE_PROJECT], activeId: "proj-1" } as ReturnType<typeof useProjectsStore>);
  });

  async function renderOpenPanel() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<RightPanel open={true} />);
    });
    return result!;
  }

  it("the tree is closed until its caret is clicked", async () => {
    setupInvoke({ untracked: 1, changeStats: { unstaged: [{ path: "new.ts", added: 3, deleted: 0, binary: false }] } });
    await renderOpenPanel();
    await screen.findByTitle(/Stage all changes/);
    expect(screen.queryByTestId("git-change-tree")).toBeNull();
  });

  it("opening Add shows the changed files with +/- stats", async () => {
    const user = userEvent.setup();
    setupInvoke({
      untracked: 1,
      unstaged: 1,
      changeStats: {
        unstaged: [
          { path: "src/changed.ts", added: 12, deleted: 5, binary: false },
          { path: "new.ts", added: 3, deleted: 0, binary: false },
        ],
      },
    });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show changed files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("changed.ts");
    expect(tree.textContent).toContain("new.ts");
    expect(tree.textContent).toContain("+12");
    expect(tree.textContent).toContain("-5");
    // The directory is rendered as a navigable node above its file.
    expect(tree.textContent).toContain("src");
  });

  it("opening Commit requests the staged scope", async () => {
    const user = userEvent.setup();
    setupInvoke({
      staged: 1,
      changeStats: { staged: [{ path: "staged.ts", added: 7, deleted: 1, binary: false }] },
    });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("staged.ts");
    expect(tree.textContent).toContain("+7");
    expect(mockInvoke).toHaveBeenCalledWith("git_change_stats", { projectDir: expect.any(String), scope: "staged" });
  });

  it("clicking the caret again closes the tree", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, changeStats: { staged: [{ path: "staged.ts", added: 1, deleted: 0, binary: false }] } });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    await screen.findByTestId("git-change-tree");
    await user.click(toggle);
    expect(screen.queryByTestId("git-change-tree")).toBeNull();
  });

  it("shows 'No changes' when the scope is empty", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, changeStats: { staged: [] } });
    await renderOpenPanel();
    const toggle = await screen.findByLabelText("Show staged files");
    await user.click(toggle);
    const tree = await screen.findByTestId("git-change-tree");
    expect(tree.textContent).toContain("No changes");
  });
});
