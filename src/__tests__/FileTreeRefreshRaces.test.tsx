/**
 * Two ordering races in the file tree's listing pipeline, both of which showed
 * up as the project root "flickering" in the side panel:
 *
 * - A failed `git_file_statuses` probe used to be applied as an EMPTY map, which
 *   moved every gitignored folder out of the (collapsed) gitignored section into
 *   the regular list for a frame — `.idea` popping in and out of the tree. A
 *   failed probe is a transient (git holding `.git/index.lock`, a spawn hiccup),
 *   so the last good letters stay put.
 * - A listing/status result for folder A that lands after the tree has moved on
 *   to folder B must not paint A's rows (or re-announce A) under B's breadcrumb.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../stores/projects", () => ({ useProjectsStore: vi.fn() }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: () => ({ windows: [], refresh: vi.fn(), untrack: vi.fn(), closeApp: vi.fn() }),
}));
vi.mock("../stores/settings", () => {
  // Selector-aware, not a fixed `null`: the side panel reads its stored view off
  // `settings` and writes it back through the `updateSettings` action when the
  // view switcher moves, so a mock that ignored the selector handed the panel a
  // null where an action belongs.
  const state = { settings: null, updateSettings: async () => {} };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

import { useProjectsStore } from "../stores/projects";
import { SidePanel } from "../components/layout/SidePanel";
import { clearFileViewSnapshots } from "../lib/fileViewSnapshots";

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

const ROOT = [fileEntry(".idea", true), fileEntry("sub", true), fileEntry("main.tex")];
const SUB = [fileEntry("deep.txt")];

/** Per-command answer hooks the tests swap mid-flight. */
const answers: {
  listDir: (rel: string) => Promise<unknown>;
  statuses: (rel: string) => Promise<unknown>;
} = {
  listDir: async (rel) => (rel === "sub" ? SUB : ROOT),
  statuses: async () => ({ ".idea": "ignored" }),
};

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string, args?: { relPath?: string }) => {
    if (cmd === "list_dir") return answers.listDir(args?.relPath ?? "");
    if (cmd === "git_file_statuses") return answers.statuses(args?.relPath ?? "");
    if (cmd === "git_status")
      return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

/** `.idea` is git-ignored: with the gitignored section collapsed (the default)
 *  it is folded under the section divider and renders no row of its own. */
function ideaRow() {
  return screen.queryByText(".idea", { selector: ".file-name" });
}

describe("file tree refresh races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileViewSnapshots();
    localStorage.clear();
    answers.listDir = async (rel) => (rel === "sub" ? SUB : ROOT);
    answers.statuses = async () => ({ ".idea": "ignored" });
    setupInvoke();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      sidePanelFolderByProject: {},
      setSidePanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("keeps the gitignored letters when a re-list's status probe fails", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    await screen.findByText("main.tex");
    expect(ideaRow()).toBeNull();

    // git is busy for this one probe (e.g. another git holds `.git/index.lock`).
    answers.statuses = async () => {
      throw new Error("index.lock held");
    };
    await user.click(screen.getByLabelText("Refresh"));
    await settle();

    // Still folded under the gitignored divider — not promoted into the regular
    // list because one probe came back empty-handed.
    expect(screen.getByText("main.tex")).toBeTruthy();
    expect(ideaRow()).toBeNull();
  });

  it("keeps the letters across a seeded reveal whose status probe fails", async () => {
    const { rerender } = render(<SidePanel open={true} />);
    await screen.findByText("main.tex");
    await act(async () => {
      rerender(<SidePanel open={false} />);
    });
    answers.statuses = async () => {
      throw new Error("index.lock held");
    };
    rerender(<SidePanel open={true} />);
    await settle();
    expect(screen.getByText("main.tex")).toBeTruthy();
    expect(ideaRow()).toBeNull();
  });

  it("discards a root listing that lands after navigating into a subfolder", async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<SidePanel open={true} />);
    });
    await screen.findByText("main.tex");

    // The next root listing hangs until we release it…
    let releaseRoot: (() => void) | null = null;
    answers.listDir = (rel) =>
      rel === "sub"
        ? Promise.resolve(SUB)
        : new Promise((resolve) => {
            releaseRoot = () => resolve(ROOT);
          });
    await user.click(screen.getByLabelText("Refresh"));
    expect(releaseRoot).not.toBeNull();

    // …while the user has already moved into `sub`.
    await user.click(screen.getByText("sub"));
    await screen.findByText("deep.txt");
    expect(screen.getByText("sub", { selector: ".file-tree-crumb" })).toBeTruthy();

    // The slow root result arrives: it belongs to a folder that is no longer on
    // screen, so neither its rows nor its breadcrumb may come back.
    await act(async () => {
      releaseRoot!();
    });
    await settle();
    expect(screen.getByText("deep.txt")).toBeTruthy();
    expect(screen.queryByText("main.tex")).toBeNull();
    expect(document.querySelector(".file-tree-crumb.current")?.textContent).toBe("sub");
  });
});
