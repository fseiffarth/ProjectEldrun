/**
 * Tests for drag-and-drop project ordering (#27, Group D.6). Dropping one pill
 * on another calls reorderProjects(fromId, toId), which splices the active-pill
 * order, renumbers every project's `position` with gap-spaced values (active
 * pills first, inactive ones after), and persists via the save_projects command.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectEntry } from "../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useProjectsStore } from "../stores/projects";

function proj(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

describe("projects store — reorderProjects", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("moves a pill, gap-spaces positions, and persists via save_projects", async () => {
    useProjectsStore.setState({
      projects: [proj("a", 10), proj("b", 20), proj("c", 30)],
    });

    await useProjectsStore.getState().reorderProjects("c", "a"); // c jumps before a

    const order = useProjectsStore.getState().projects
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((p) => p.id);
    expect(order).toEqual(["c", "a", "b"]);

    // Positions are renumbered with a stable gap of 10.
    const posById = Object.fromEntries(
      useProjectsStore.getState().projects.map((p) => [p.id, p.position]),
    );
    expect([posById.c, posById.a, posById.b]).toEqual([10, 20, 30]);

    expect(invoke).toHaveBeenCalledWith("save_projects", expect.anything());
  });

  it("keeps inactive projects after the active ones and is a no-op for same id", async () => {
    useProjectsStore.setState({
      projects: [proj("a", 10), proj("b", 20), proj("z", 30, "inactive")],
    });

    await useProjectsStore.getState().reorderProjects("a", "a");
    expect(invoke).not.toHaveBeenCalled();

    await useProjectsStore.getState().reorderProjects("b", "a"); // b before a
    const sorted = useProjectsStore.getState().projects
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((p) => p.id);
    expect(sorted).toEqual(["b", "a", "z"]); // inactive 'z' last regardless
  });
});
