/**
 * Store-level tests for project boxes (#13). assignToBox keeps the box's
 * authoritative member_ids and the project's denormalized box_id in sync and
 * persists BOTH state files (save_boxes + save_projects). deleteBox is required
 * to clear box_id on every former member. createBox/renameBox round-trip the
 * command result into the store. load() derives box_id from member_ids in
 * memory WITHOUT writing on load (B2).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectBox, ProjectEntry } from "../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useBoxesStore, deriveBoxIds } from "../stores/boxes";
import { useProjectsStore } from "../stores/projects";

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

function box(id: string, members: string[], position = 10): ProjectBox {
  return { id, name: id, member_ids: members, position };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useBoxesStore.setState({ boxes: [], loaded: false });
  useProjectsStore.setState({ projects: [] });
});

describe("deriveBoxIds (B2: member_ids wins, no write on load)", () => {
  it("derives box_id from member_ids and overrides a stale box_id", () => {
    const projects = [proj("p1", "stale"), proj("p2"), proj("p3")];
    const boxes = [box("boxA", ["p1", "p2"])];
    const out = deriveBoxIds(projects, boxes);
    expect(out.find((p) => p.id === "p1")?.box_id).toBe("boxA");
    expect(out.find((p) => p.id === "p2")?.box_id).toBe("boxA");
    // p3 is in no box → no box_id.
    expect(out.find((p) => p.id === "p3")?.box_id).toBeUndefined();
  });
});

describe("boxes store — load", () => {
  it("loads boxes and derives box_id in memory without persisting", async () => {
    useProjectsStore.setState({ projects: [proj("p1"), proj("p2")] });
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_boxes" ? Promise.resolve([box("boxA", ["p1"])]) : Promise.resolve(undefined),
    );
    await useBoxesStore.getState().load();
    expect(useProjectsStore.getState().projects.find((p) => p.id === "p1")?.box_id).toBe("boxA");
    // No save on load.
    expect(invoke).not.toHaveBeenCalledWith("save_projects", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("save_boxes", expect.anything());
  });
});

describe("boxes store — assignToBox", () => {
  it("sets box_id, adds to member_ids, and persists save_boxes + save_projects", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1")] });

    await useBoxesStore.getState().assignToBox("p1", "boxA");

    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual(["p1"]);
    expect(useProjectsStore.getState().projects[0].box_id).toBe("boxA");

    expect(invoke).toHaveBeenCalledWith("save_boxes", {
      boxes: [expect.objectContaining({ id: "boxA", member_ids: ["p1"] })],
    });
    expect(invoke).toHaveBeenCalledWith("save_projects", {
      projects: [expect.objectContaining({ id: "p1", box_id: "boxA" })],
    });
  });

  it("assignToBox(null) removes the project from its box and clears box_id", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"])] });
    useProjectsStore.setState({ projects: [proj("p1", "boxA")] });

    await useBoxesStore.getState().assignToBox("p1", null);

    expect(useBoxesStore.getState().boxes[0].member_ids).toEqual([]);
    expect(useProjectsStore.getState().projects[0].box_id).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("save_projects", {
      projects: [expect.not.objectContaining({ box_id: expect.anything() })],
    });
  });

  it("moving a pill between boxes drops it from the old and adds to the new", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", "boxA")] });

    await useBoxesStore.getState().assignToBox("p1", "boxB");

    const boxes = useBoxesStore.getState().boxes;
    expect(boxes.find((b) => b.id === "boxA")?.member_ids).toEqual([]);
    expect(boxes.find((b) => b.id === "boxB")?.member_ids).toEqual(["p1"]);
    expect(useProjectsStore.getState().projects[0].box_id).toBe("boxB");
  });
});

describe("boxes store — assignToBox refreshes box agent docs", () => {
  it("refreshes the agent docs of an affected box that already has a folder", async () => {
    useBoxesStore.setState({ boxes: [{ ...box("boxA", []), folder: "/b/boxA" }] });
    useProjectsStore.setState({ projects: [proj("p1")] });

    await useBoxesStore.getState().assignToBox("p1", "boxA");

    expect(invoke).toHaveBeenCalledWith("refresh_box_agent_docs", { boxId: "boxA" });
  });

  it("does NOT refresh docs for a box that has no folder yet", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    useProjectsStore.setState({ projects: [proj("p1")] });

    await useBoxesStore.getState().assignToBox("p1", "boxA");

    expect(invoke).not.toHaveBeenCalledWith("refresh_box_agent_docs", expect.anything());
  });
});

describe("boxes store — singleton dissolve (a box never keeps 1 member)", () => {
  it("dragging a project out of a 2-member box ejects the lone survivor and drops the box", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({ projects: [proj("p1", "boxA"), proj("p2", "boxA")] });

    // p1 leaves the box (drag-out → assignToBox(null)).
    await useBoxesStore.getState().assignToBox("p1", null);

    // boxA had 2, drops to 1, so it dissolves entirely; both end ungrouped.
    expect(useBoxesStore.getState().boxes).toEqual([]);
    expect(useProjectsStore.getState().projects.every((p) => p.box_id === undefined)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_boxes", { boxes: [] });
  });

  it("moving one out of a 2-member box dissolves the old box but fills the new one", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"]), box("boxB", [])] });
    useProjectsStore.setState({ projects: [proj("p1", "boxA"), proj("p2", "boxA")] });

    await useBoxesStore.getState().assignToBox("p1", "boxB");

    const boxes = useBoxesStore.getState().boxes;
    // boxA dissolved (was 2 → 1 after p1 left), boxB is the assignment target.
    expect(boxes.map((b) => b.id)).toEqual(["boxB"]);
    expect(boxes[0].member_ids).toEqual(["p1"]);
    const projects = useProjectsStore.getState().projects;
    expect(projects.find((p) => p.id === "p1")?.box_id).toBe("boxB");
    // p2 was the ejected survivor of the dissolved box.
    expect(projects.find((p) => p.id === "p2")?.box_id).toBeUndefined();
  });
});

describe("boxes store — deleteBox", () => {
  it("clears box_id on all former members and persists save_projects", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({ projects: [proj("p1", "boxA"), proj("p2", "boxA")] });

    await useBoxesStore.getState().deleteBox("boxA");

    expect(useBoxesStore.getState().boxes).toEqual([]);
    expect(useProjectsStore.getState().projects.every((p) => p.box_id === undefined)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("delete_box", { boxId: "boxA" });
    expect(invoke).toHaveBeenCalledWith("save_projects", {
      projects: [
        expect.not.objectContaining({ box_id: expect.anything() }),
        expect.not.objectContaining({ box_id: expect.anything() }),
      ],
    });
  });
});

describe("boxes store — createBox / renameBox", () => {
  it("createBox appends the command's box to the store", async () => {
    invoke.mockResolvedValueOnce(box("boxNew", [], 20));
    const created = await useBoxesStore.getState().createBox("New Box");
    expect(created.id).toBe("boxNew");
    expect(useBoxesStore.getState().boxes).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("create_box", { name: "New Box" });
  });

  it("renameBox updates the store from the command result and persists", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", [])] });
    invoke.mockResolvedValueOnce({ ...box("boxA", []), name: "Renamed" });
    await useBoxesStore.getState().renameBox("boxA", "Renamed");
    expect(useBoxesStore.getState().boxes[0].name).toBe("Renamed");
    expect(invoke).toHaveBeenCalledWith("rename_box", { boxId: "boxA", name: "Renamed" });
  });
});
