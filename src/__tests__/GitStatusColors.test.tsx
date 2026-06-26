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

function setupInvoke({
  staged = 0,
  unstaged = 0,
  untracked = 0,
  has_remote = true,
  fileList = {} as Record<string, string>,
  unpushedCommits = [] as string[],
} = {}) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_status") return Promise.resolve({ staged, unstaged, untracked, has_remote, is_repo: true });
    if (cmd === "git_file_statuses") return Promise.resolve(fileList);
    if (cmd === "git_unpushed_commits") return Promise.resolve(unpushedCommits);
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

describe("git button hover lists", () => {
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

  it("hovering Add shows untracked and modified files", async () => {
    const user = userEvent.setup();
    setupInvoke({
      untracked: 1,
      unstaged: 1,
      fileList: { "new.ts": "untracked", "changed.ts": "modified", "staged.ts": "staged" },
    });
    await renderOpenPanel();
    const addBtn = await screen.findByTitle(/Stage all changes/);
    await user.hover(addBtn);
    const list = await screen.findByTestId("git-hover-list");
    expect(list.textContent).toContain("new.ts");
    expect(list.textContent).toContain("changed.ts");
    expect(list.textContent).not.toContain("staged.ts");
  });

  it("hovering Commit shows staged files", async () => {
    const user = userEvent.setup();
    setupInvoke({
      staged: 2,
      fileList: { "staged.ts": "staged", "other.ts": "staged", "untracked.ts": "untracked" },
    });
    await renderOpenPanel();
    const commitBtn = await screen.findByTitle(/Commit 2 staged/);
    await user.hover(commitBtn);
    const list = await screen.findByTestId("git-hover-list");
    expect(list.textContent).toContain("staged.ts");
    expect(list.textContent).toContain("other.ts");
    expect(list.textContent).not.toContain("untracked.ts");
  });

  it("hovering Push shows unpushed commit messages", async () => {
    const user = userEvent.setup();
    setupInvoke({
      has_remote: true,
      unpushedCommits: ["abc1234 feat: add widget", "def5678 fix: correct typo"],
    });
    await renderOpenPanel();
    const pushBtn = await screen.findByTitle(/Push 2 commits to remote/);
    await user.hover(pushBtn);
    const list = await screen.findByTestId("git-hover-list");
    expect(list.textContent).toContain("feat: add widget");
    expect(list.textContent).toContain("fix: correct typo");
  });

  it("hover list is absent when there are no items", async () => {
    const user = userEvent.setup();
    setupInvoke({ staged: 1, fileList: {} });
    await renderOpenPanel();
    const commitBtn = await screen.findByTitle(/Commit 1 staged/);
    await user.hover(commitBtn);
    expect(screen.queryByTestId("git-hover-list")).toBeNull();
  });
});
