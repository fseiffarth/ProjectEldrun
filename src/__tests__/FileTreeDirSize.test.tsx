/**
 * Regression test for the folder-size holes in the right-panel file tree.
 *
 * `load()` sets rawEntries, which fires the size-fetch effects, and only THEN
 * awaits `git_file_statuses` — whose result changes `sections`' identity. When
 * the effects cancelled on that (a `cancelled` flag in their cleanup), every
 * size call still walking at that moment had its bytes thrown away, while the
 * `requestedSizes` guard kept the folder from ever being re-requested. Small
 * folders won the race and showed a size; a big one — `results/` in a training
 * project, exactly what the feature is for — never did.
 *
 * So: resolve `dir_size_breakdown` only AFTER `git_file_statuses` has landed,
 * and assert the size still renders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

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
  name: "demoproj",
  status: "active",
  position: 0,
  local_file: "/tmp/demoproj/project.json",
};

function dirEntry(name: string) {
  return {
    name,
    path: `/tmp/demoproj/${name}`,
    is_dir: true,
    size: 0,
    extension: null,
    mime: null,
  };
}

describe("file tree folder sizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const state = {
      projects: [ACTIVE_PROJECT],
      activeId: "proj-1",
      rightPanelFolderByProject: {},
      setRightPanelFolder: vi.fn(),
    } as unknown as ReturnType<typeof useProjectsStore>;
    mockUseProjectsStore.mockImplementation(((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as typeof useProjectsStore);
  });

  it("shows a folder's size even when the walk outlives the git-status round-trip", async () => {
    // Two round-trips held open by hand. They must land in this order, and each
    // in its OWN render — that is the whole bug. Resolving them both eagerly lets
    // React batch `setRawEntries` and `setGitStatuses` into one render, the size
    // effect never sees the intermediate state, and the race can't happen at all.
    const deferred = <T,>() => {
      let release!: (v: T) => void;
      const promise = new Promise<T>((res) => { release = res; });
      return { promise, release };
    };
    const statuses = deferred<Record<string, string>>();
    const size = deferred<{ total: number; ignored: number }>();

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_dir") return Promise.resolve([dirEntry("results")]);
      // New object identity when it lands → `sections` recomputes → the effects'
      // old cleanup fired and cancelled the size call still in flight.
      if (cmd === "git_file_statuses") return statuses.promise;
      if (cmd === "dir_size_breakdown") return size.promise; // the slow walk
      if (cmd === "dir_size") return Promise.resolve(0);
      if (cmd === "git_status")
        return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
      if (cmd === "git_unpushed_commits") return Promise.resolve([]);
      if (cmd === "load_project") return Promise.resolve({});
      if (cmd === "list_project_endings") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    // 1. The listing lands and renders; the size effect dispatches the walk.
    await act(async () => {
      render(<RightPanel open={true} />);
    });
    expect(await screen.findByText("results")).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith(
      "dir_size_breakdown",
      expect.objectContaining({ relPath: "results" }),
    );

    // 2. Git statuses land while the walk is still running.
    await act(async () => {
      statuses.release({});
      await statuses.promise;
    });

    // 3. Only now does the walk finish: 2 GiB.
    await act(async () => {
      size.release({ total: 2 * 1024 * 1024 * 1024, ignored: 0 });
      await size.promise;
    });

    // Scoped to the row: the section-total line shows the same figure.
    const row = screen.getByText("results").closest(".file-entry");
    expect(row?.querySelector(".file-size")?.textContent).toBe("2.0 GB");
  });

  it("never walks a folder excluded from scans", async () => {
    // The point of the feature is the *absence* of the call: a 50 GB virtualenv
    // is not made cheap by discarding its result, only by never descending it.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_dir") return Promise.resolve([dirEntry("venv"), dirEntry("src")]);
      if (cmd === "git_file_statuses") return Promise.resolve({});
      if (cmd === "dir_size_breakdown") return Promise.resolve({ total: 10, ignored: 0 });
      if (cmd === "dir_size") return Promise.resolve(10);
      if (cmd === "git_status")
        return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
      if (cmd === "git_unpushed_commits") return Promise.resolve([]);
      // The project's saved exclusion list — `venv` is out, `src` is not.
      if (cmd === "load_project") return Promise.resolve({ scan_excluded_paths: ["venv"] });
      if (cmd === "list_project_endings") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    await act(async () => {
      render(<RightPanel open={true} />);
    });
    expect(await screen.findByText("venv")).toBeTruthy();

    const walked = (relPath: string) =>
      mockInvoke.mock.calls.some(
        ([cmd, args]) =>
          (cmd === "dir_size" || cmd === "dir_size_breakdown") &&
          (args as { relPath?: string } | undefined)?.relPath === relPath,
      );
    expect(walked("venv")).toBe(false);
    expect(walked("src")).toBe(true);

    // The row still lists — the exclusion has to stay reversible from the row it
    // applies to — but says so instead of showing a stale or absent size.
    const row = screen.getByText("venv").closest(".file-entry");
    expect(row?.querySelector(".file-size")?.textContent).toBe("not scanned");
  });
});
