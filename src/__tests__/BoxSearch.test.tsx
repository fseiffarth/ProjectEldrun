/**
 * Component test for boxes in the project search (#41 Phase 2). A box matching
 * the query appears as a `.project-search-row.is-box` row in the popover; picking
 * it calls the box store's openBox (which ensures the box folder + activates a
 * box scope) rather than activating a project. Members stay independently
 * searchable (opt-in merge).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";

function inactiveProj(id: string): ProjectEntry {
  return { id, name: id, status: "inactive", position: 10, local_file: `/p/${id}/project.json` };
}

function box(id: string, name: string, members: string[]): ProjectBox {
  return { id, name, member_ids: members, position: 5 };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

describe("#41 box search results", () => {
  it("shows a box row with the is-box class and openBox fires on pick", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", "PaperBox", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [inactiveProj("p1")],
      activeId: null,
      loaded: true,
      setActive,
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const input = container.querySelector(".project-search-entry") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "paper" } });
    });

    const boxRow = container.querySelector(".project-search-row.is-box") as HTMLElement;
    expect(boxRow).toBeTruthy();
    expect(boxRow.textContent).toContain("PaperBox");

    await act(async () => {
      fireEvent.click(boxRow);
    });

    expect(openBox).toHaveBeenCalledWith("boxA");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("members remain independently searchable alongside their box", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", "PaperBox", ["paperdraft"])] });
    useProjectsStore.setState({
      projects: [inactiveProj("paperdraft")],
      activeId: null,
      loaded: true,
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open={true} />));
    });

    const input = container.querySelector(".project-search-entry") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "paper" } });
    });

    // Both the box row and the member project row are present.
    expect(container.querySelector(".project-search-row.is-box")).toBeTruthy();
    const rows = [...container.querySelectorAll(".project-search-row")];
    expect(rows.some((r) => !r.classList.contains("is-box") && r.textContent?.includes("paperdraft"))).toBe(true);
  });
});
