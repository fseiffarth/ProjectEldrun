/**
 * The side panel repopulates from a snapshot when it is revealed again.
 *
 * A closed panel doesn't hide its tree, it UNMOUNTS it (`mountTree={open}`), so
 * every reveal used to start from an empty tree and fill in over a `list_dir`, a
 * `git_file_statuses` and one recursive walk per folder. `lib/fileViewSnapshots`
 * keeps the last state of each (project, root, folder) in module scope, so the
 * first frame after a reveal is already populated and the fetches only upgrade
 * it. These tests pin both halves: the seeded frame, and the refresh behind it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

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
import {
  clearFileViewSnapshots,
  fileTreeSnapshotKey,
  readFileTreeSnapshot,
  writeFileTreeSnapshot,
  readGitBarSnapshot,
  writeGitBarSnapshot,
} from "../lib/fileViewSnapshots";

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

function setupInvoke(names: string[] = ["alpha.txt", "beta.txt"]) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") return Promise.resolve(names.map((n) => fileEntry(n)));
    if (cmd === "git_status")
      return Promise.resolve({ staged: 2, unstaged: 0, untracked: 0, has_remote: false, is_repo: true });
    if (cmd === "git_unpushed_commits") return Promise.resolve([]);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "load_project") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

/** Flush the debounced git probes and the one-frame-deferred tree upgrade. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe("side panel reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileViewSnapshots();
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

  it("paints nothing on a cold first frame — there is no snapshot yet", () => {
    render(<SidePanel open={true} />);
    // Synchronously after mount the listing promise hasn't resolved.
    expect(screen.queryByText("alpha.txt")).toBeNull();
  });

  it("repaints the listing on the FIRST frame of a reveal, then refreshes it", async () => {
    const { rerender } = render(<SidePanel open={true} />);
    await act(async () => {});
    expect(screen.getByText("alpha.txt")).toBeTruthy();

    // Close: the tree unmounts (`mountTree={open}`), taking its state with it.
    await act(async () => {
      rerender(<SidePanel open={false} />);
    });
    expect(screen.queryByText("alpha.txt")).toBeNull();

    // Reveal. Deliberately NOT wrapped in an async act: the assertion is about
    // the first committed frame, before any awaited promise can have resolved.
    mockInvoke.mockClear();
    rerender(<SidePanel open={true} />);
    expect(screen.getByText("alpha.txt")).toBeTruthy();
    expect(screen.getByText("beta.txt")).toBeTruthy();

    // The seed is only what's shown in the meantime — the folder is still
    // re-listed behind it (a frame later, so the seeded frame paints first), so
    // a change made while the panel was closed lands.
    await settle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "list_dir")).toBe(true);
  });

  it("upgrades a stale seed to what the folder actually holds now", async () => {
    const { rerender } = render(<SidePanel open={true} />);
    await act(async () => {});
    await act(async () => {
      rerender(<SidePanel open={false} />);
    });

    // The folder changed while the panel was closed.
    setupInvoke(["gamma.txt"]);
    rerender(<SidePanel open={true} />);
    await settle();
    expect(screen.getByText("gamma.txt")).toBeTruthy();
    expect(screen.queryByText("alpha.txt")).toBeNull();
  });

  it("keeps the git bar's counts across a reveal instead of clearing them", async () => {
    const { rerender } = render(<SidePanel open={true} />);
    // The git probes are debounced (bursts of git-affecting actions coalesce).
    await settle();
    expect(readGitBarSnapshot("/tmp/test-project")?.status?.staged).toBe(2);

    await act(async () => {
      rerender(<SidePanel open={false} />);
    });
    // Merely going inactive is not a "we don't know" state: the snapshot stands
    // so the next reveal has something to show at once.
    expect(readGitBarSnapshot("/tmp/test-project")?.status?.staged).toBe(2);
  });

  it("records the folder's entries under its (project, root, folder) key", async () => {
    render(<SidePanel open={true} />);
    await act(async () => {});
    const snap = readFileTreeSnapshot(fileTreeSnapshotKey("proj-1", "/tmp/test-project", ""));
    expect(snap?.entries.map((e) => e.name)).toEqual(["alpha.txt", "beta.txt"]);
  });
});

describe("fileViewSnapshots store", () => {
  beforeEach(() => clearFileViewSnapshots());

  const snap = (name: string) => ({
    entries: [fileEntry(name)],
    gitStatuses: {},
    dirSizes: {},
    dirIgnoredBytes: {},
  });

  it("keys a folder by project, root dir and rel path", () => {
    expect(fileTreeSnapshotKey("p", "/root", "sub")).not.toBe(fileTreeSnapshotKey("p", "/root", ""));
    expect(fileTreeSnapshotKey(null, "/root", "")).not.toBe(fileTreeSnapshotKey("p", "/root", ""));
    expect(fileTreeSnapshotKey("p", "/a", "")).not.toBe(fileTreeSnapshotKey("p", "/b", ""));
  });

  it("evicts the least recently used folder once past the cap", () => {
    for (let i = 0; i < 40; i++) writeFileTreeSnapshot(`k${i}`, snap(`f${i}`));
    expect(readFileTreeSnapshot("k0")).toBeNull();
    expect(readFileTreeSnapshot("k39")?.entries[0].name).toBe("f39");
  });

  it("a read counts as use, so the folder being looked at survives eviction", () => {
    for (let i = 0; i < 32; i++) writeFileTreeSnapshot(`k${i}`, snap(`f${i}`));
    readFileTreeSnapshot("k0"); // touched — no longer the oldest
    for (let i = 32; i < 40; i++) writeFileTreeSnapshot(`k${i}`, snap(`f${i}`));
    expect(readFileTreeSnapshot("k0")?.entries[0].name).toBe("f0");
    expect(readFileTreeSnapshot("k1")).toBeNull();
  });

  it("bounds the git snapshots the same way", () => {
    for (let i = 0; i < 20; i++) {
      writeGitBarSnapshot(`/repo${i}`, {
        status: { staged: i, unstaged: 0, untracked: 0, has_remote: false, is_repo: true },
        unpushed: [],
      });
    }
    expect(readGitBarSnapshot("/repo0")).toBeNull();
    expect(readGitBarSnapshot("/repo19")?.status?.staged).toBe(19);
  });
});
