/**
 * Component tests for box rendering in the switcher (#13/#41). A box now renders
 * as a single project-style pill (`.project-pill.is-box`) with a member-count
 * badge; its members are hidden from the strip and listed in a hover dropdown.
 * Clicking the pill opens the box; clicking a member switches to that project;
 * dropping a pill on the box assigns it (and does NOT reorder, S3). An orphaned
 * box_id (no matching box) renders the pill inline (S1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));

import { ProjectSwitcher } from "../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";

function proj(id: string, position: number, boxId?: string): ProjectEntry {
  return {
    id,
    name: id,
    status: "active",
    position,
    local_file: `/p/${id}/project.json`,
    ...(boxId ? { box_id: boxId } : {}),
  };
}

function box(id: string, members: string[], position = 5): ProjectBox {
  return { id, name: id, member_ids: members, position };
}

function dt(projectId: string) {
  const data: Record<string, string> = { "application/x-eldrun-project": projectId };
  return {
    types: ["application/x-eldrun-project"],
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => {
      data[t] = v;
    },
    dropEffect: "none",
  };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

async function renderSwitcher() {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open={true} />));
  });
  return container;
}

describe("box pill rendering", () => {
  it("renders a box as a single pill with a member badge and no inline member pills", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA"), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();

    const boxPill = container.querySelector(".project-pill.is-box");
    expect(boxPill).toBeTruthy();
    expect(boxPill!.querySelector(".project-pill-label")?.textContent).toBe("boxA");
    expect(boxPill!.querySelector(".project-box-member-count")?.textContent).toBe("1");

    // The member p1 is NOT an inline pill in the strip (only boxA + p2 are pills,
    // and only p2 is a non-box pill).
    const labels = [...container.querySelectorAll(".project-pill .project-pill-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toContain("boxA");
    expect(labels).toContain("p2");
    expect(labels).not.toContain("p1");
    // No dropdown until hovered.
    expect(document.querySelector(".project-box-dropdown")).toBeNull();
  });

  it("hovering the box pill lists members; clicking one switches to that project", async () => {
    const setActive = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA"), proj("p2", 20)],
      activeId: null,
      loaded: true,
      setActive,
    });

    const container = await renderSwitcher();
    const boxPill = container.querySelector(".project-pill.is-box") as HTMLElement;

    await act(async () => {
      fireEvent.mouseEnter(boxPill);
    });
    const dropdown = document.querySelector(".project-box-dropdown");
    expect(dropdown).toBeTruthy();
    const memberBtn = dropdown!.querySelector(".project-box-member-open") as HTMLElement;
    expect(memberBtn.textContent).toContain("p1");

    await act(async () => {
      fireEvent.click(memberBtn);
    });
    expect(setActive).toHaveBeenCalledWith("p1");
  });

  it("clicking the box pill opens the box", async () => {
    const openBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], openBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA")],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const main = container.querySelector(".project-pill.is-box .pill-main") as HTMLElement;
    await act(async () => {
      fireEvent.click(main);
    });
    expect(openBox).toHaveBeenCalledWith("boxA");
  });

  it("the member remove (×) button ungroups that project", async () => {
    const assignToBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])], assignToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA"), proj("p2", 20, "boxA")],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const boxPill = container.querySelector(".project-pill.is-box") as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(boxPill);
    });
    const removeBtn = document.querySelector(".project-box-member-remove") as HTMLElement;
    await act(async () => {
      fireEvent.click(removeBtn);
    });
    expect(assignToBox).toHaveBeenCalledWith("p1", null);
  });

  it("renders an orphaned box_id (no matching box) inline, not as a box pill", async () => {
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "ghost-box")],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    expect(container.querySelector(".project-pill.is-box")).toBeNull();
    const pill = container.querySelector(".project-pill");
    expect(pill?.querySelector(".project-pill-label")?.textContent).toBe("p1");
  });

  it("dropping a pill onto a box pill calls assignToBox(projectId, boxId) and not a reorder", async () => {
    const assignToBox = vi.fn().mockResolvedValue(undefined);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], assignToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA"), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const boxPill = container.querySelector(".project-pill.is-box") as HTMLElement;
    const dataTransfer = dt("p2");

    await act(async () => {
      fireEvent.dragOver(boxPill, { dataTransfer });
      fireEvent.drop(boxPill, { dataTransfer });
    });

    expect(assignToBox).toHaveBeenCalledWith("p2", "boxA");
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("alt-dropping a pill onto another creates a box holding both projects", async () => {
    const created = box("newBox", []);
    const createBox = vi.fn().mockResolvedValue(created);
    const assignToBox = vi.fn().mockResolvedValue(undefined);
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [], createBox, assignToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p2Pill = [...container.querySelectorAll(".project-pill")].find(
      (el) => el.querySelector(".project-pill-label")?.textContent === "p2",
    ) as HTMLElement;
    expect(p2Pill).toBeTruthy();

    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dt("p1") });
      Object.defineProperty(event, "altKey", { value: true });
      fireEvent(p2Pill, event);
    });

    expect(createBox).toHaveBeenCalledWith("New Box");
    expect(assignToBox).toHaveBeenCalledWith("p2", "newBox");
    expect(assignToBox).toHaveBeenCalledWith("p1", "newBox");
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it("a plain (no-alt) drop onto a pill still reorders, not box", async () => {
    const createBox = vi.fn().mockResolvedValue(box("newBox", []));
    const reorderProjects = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [], createBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10), proj("p2", 20)],
      activeId: null,
      loaded: true,
      reorderProjects,
    });

    const container = await renderSwitcher();
    const p2Pill = [...container.querySelectorAll(".project-pill")].find(
      (el) => el.querySelector(".project-pill-label")?.textContent === "p2",
    ) as HTMLElement;

    await act(async () => {
      fireEvent.drop(p2Pill, { dataTransfer: dt("p1") });
    });

    expect(reorderProjects).toHaveBeenCalledWith("p1", "p2");
    expect(createBox).not.toHaveBeenCalled();
  });

  it("dropping a pill on the ungrouped strip calls assignToBox(id, null)", async () => {
    const assignToBox = vi.fn().mockResolvedValue(undefined);
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])], assignToBox });
    useProjectsStore.setState({
      projects: [proj("p1", 10, "boxA"), proj("p2", 20)],
      activeId: null,
      loaded: true,
    });

    const container = await renderSwitcher();
    const strip = container.querySelector(".project-pills-scroll") as HTMLElement;

    await act(async () => {
      fireEvent.dragOver(strip, { dataTransfer: dt("p1") });
      fireEvent.drop(strip, { dataTransfer: dt("p1") });
    });

    expect(assignToBox).toHaveBeenCalledWith("p1", null);
  });
});
