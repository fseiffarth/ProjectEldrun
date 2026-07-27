/**
 * When the current tab scope is a box scope (`box:<id>`), the right panel shows
 * a multi-root file view: one collapsible section (`.file-root`) for the box
 * folder plus one per member project root (#41 Phase 3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  // Listing commands resolve to []; git_repo_root returns a path string or null,
  // so the blanket [] would leak a non-string into ProjectFilesView's norm().
  invoke: vi.fn((cmd: string) => Promise.resolve(cmd === "git_repo_root" ? null : [])),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { RightPanel } from "../components/layout/RightPanel";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";
import { useTabsStore } from "../stores/tabs";

function proj(id: string, boxId?: string): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `/p/${id}/project.json`,
    ...(boxId ? { box_id: boxId } : {}),
  };
}

function box(id: string, members: string[]): ProjectBox {
  return { id, name: id, member_ids: members, position: 10, folder: `/b/${id}` };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
});

describe("RightPanel multi-root box view", () => {
  it("renders a file-root section for the box folder + each member root", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({
      projects: [proj("p1", "boxA"), proj("p2", "boxA")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RightPanel open={true} />));
    });

    const headers = [...container.querySelectorAll(".file-root-header .file-root-name")].map(
      (el) => el.textContent,
    );
    // Box folder root + the two member roots.
    expect(headers).toEqual(["boxA", "p1", "p2"]);
  });

  it("falls back to the single project tree when no box scope is active", async () => {
    useProjectsStore.setState({
      projects: [proj("p1")],
      activeId: "p1",
      loaded: true,
    });
    useTabsStore.setState({ scope: "p1" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RightPanel open={true} />));
    });

    expect(container.querySelector(".file-root")).toBeNull();
  });
});
