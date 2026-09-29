/**
 * The folder a popout's "+" menu opens a tab in (`detachedNewTabCwd`) is the
 * one the main window's `newTabCwd` resolves — box folder, else project
 * directory — never the active tab's cwd. A viewer tab's cwd is its FILE's
 * folder, so a Claude tab opened beside `talk/main.pdf` used to start in
 * `talk/` from a popout and in the project root from the main window.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { detachedNewTabCwd } from "../../stores/detached";
import type { ProjectBox, ProjectEntry } from "../../types";

const project = {
  id: "p1",
  name: "Paper",
  local_file: "/work/Paper/project.json",
  directory: "/work/Paper",
} as ProjectEntry;

describe("detachedNewTabCwd", () => {
  it("uses the project directory, not the active viewer tab's folder", () => {
    expect(detachedNewTabCwd("p1", { project }, ["/work/Paper/talk", "/work/Paper"])).toBe(
      "/work/Paper",
    );
  });

  it("derives the directory from project.json when the entry has none", () => {
    const legacy = { ...project, directory: undefined } as unknown as ProjectEntry;
    expect(detachedNewTabCwd("p1", { project: legacy }, ["/work/Paper/talk"])).toBe("/work/Paper");
  });

  it("uses the box folder for a box scope", () => {
    const box = { id: "b1", name: "Box", folder: "/work/Box", member_ids: [] } as unknown as ProjectBox;
    expect(detachedNewTabCwd("box:b1", { box, boxMembers: [] }, ["/work/Box/sub"])).toBe("/work/Box");
  });

  it("falls back to the first tab cwd only without project context", () => {
    expect(detachedNewTabCwd("root", undefined, [undefined, "/somewhere"])).toBe("/somewhere");
    expect(detachedNewTabCwd("root", undefined, [])).toBe("");
  });
});
