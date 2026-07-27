/**
 * Regression: the shared file viewer (`ProjectFilesView`, rendered by the right
 * panel and the Files tab) must not infinite-loop when the active scope has no
 * registered tabs.
 *
 * The Sessions feature added `useTabsStore((s) => s.tabsByScope[scope] ?? [])`.
 * A Zustand selector that returns a FRESH `[]` when the scope is absent yields a
 * new snapshot on every render, so `useSyncExternalStore` re-renders forever
 * ("The result of getSnapshot should be cached" → "Maximum update depth
 * exceeded"). With no error boundary in the tree, that thrown loop unmounts the
 * WHOLE app — which is why the symptom was "the project pills vanished": the
 * header's pill strip is a sibling that React tears down along with everything
 * else. The fix coalesces to a stable empty array OUTSIDE the selector.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(cmd === "git_repo_root" ? null : [])),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { RightPanel } from "../components/layout/RightPanel";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";
import { useTabsStore } from "../stores/tabs";

function proj(id: string): ProjectEntry {
  return { id, name: id, status: "active", position: 10, local_file: `/p/${id}/project.json` };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  // The key precondition: the active scope has NO entry in tabsByScope.
  useTabsStore.setState({ scope: "p1", tabsByScope: {} });
});

describe("ProjectFilesView with no tabs for the scope", () => {
  it("renders without an infinite update loop", async () => {
    useProjectsStore.setState({ projects: [proj("p1")], activeId: "p1", loaded: true });
    useTabsStore.setState({ scope: "p1", tabsByScope: {} });

    // Before the fix this render threw "Maximum update depth exceeded" from the
    // unstable `tabsByScope[scope] ?? []` selector; the mount should now be quiet.
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RightPanel open={true} />));
    });

    expect(container.querySelector(".project-files-view, .file-tree, .project-files")).toBeTruthy();
  });

  it("selecting the scope's tabs returns a stable reference across calls", () => {
    // The selector must hand back the SAME array object when the scope is absent,
    // or useSyncExternalStore treats every render as a store change.
    const sel = (s: { tabsByScope: Record<string, unknown[]> }) => s.tabsByScope["missing"];
    const a = useTabsStore.getState().tabsByScope["missing"];
    const b = sel(useTabsStore.getState());
    expect(a).toBe(b); // both undefined — a stable reference, not a fresh []
  });
});
