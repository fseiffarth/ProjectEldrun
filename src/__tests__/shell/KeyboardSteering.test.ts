/**
 * Keyboard steering (`stores/keyboardSteering`): the mode is transient and
 * imperative, and `projectStations` is the ONE ring behind project cycling,
 * the steering digits and the pill badges — root leads it, inactive projects
 * are out, and the rest follow pill display order (`position`), never the
 * store's array order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { projectStations, useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectEntry } from "../../types";

function project(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

beforeEach(() => {
  useKeyboardSteeringStore.setState({ active: false });
  useProjectsStore.setState({ projects: [] });
});

describe("mode", () => {
  it("enters and exits without anything else in the store", () => {
    useKeyboardSteeringStore.getState().enter();
    expect(useKeyboardSteeringStore.getState().active).toBe(true);
    useKeyboardSteeringStore.getState().exit();
    expect(useKeyboardSteeringStore.getState().active).toBe(false);
  });
});

describe("projectStations", () => {
  it("leads with the root terminal even when there are no projects", () => {
    expect(projectStations()).toEqual([null]);
  });

  it("orders by pill position and leaves inactive projects out", () => {
    useProjectsStore.setState({
      projects: [project("c", 2), project("z", 5, "inactive"), project("a", 0, "current"), project("b", 1)],
    });
    expect(projectStations()).toEqual([null, "a", "b", "c"]);
  });
});
