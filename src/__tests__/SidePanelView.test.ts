/**
 * The side panel's per-scope view memory (`lib/sidePanelView`): the panel and
 * the edge rail must name the same entry — a project by id, root/box scopes by
 * scope name — and a switch writes both the scope's own entry and the global
 * seed a scope with no entry opens on, without losing the other scopes' entries.
 */
import { describe, expect, it } from "vitest";
import { sidePanelViewKey, sidePanelViewPatch } from "../lib/sidePanelView";
import type { Settings } from "../types";

describe("sidePanelViewKey", () => {
  it("keys a project by its id and root/box scopes by their scope name", () => {
    expect(sidePanelViewKey("p-uuid", "p-uuid")).toBe("p-uuid");
    expect(sidePanelViewKey(null, "root")).toBe("root");
    expect(sidePanelViewKey(null, "box:b1")).toBe("box:b1");
  });
});

describe("sidePanelViewPatch", () => {
  it("writes the scope's entry and the global seed, keeping the other scopes", () => {
    const current: Settings = {
      side_panel_view: "files",
      side_panel_view_by_project: { root: "git", "box:b1": "files" },
    };
    const patch = sidePanelViewPatch("agents", "p1", current);
    expect(patch).toEqual({
      side_panel_view: "agents",
      side_panel_view_by_project: { root: "git", "box:b1": "files", p1: "agents" },
    });
    // A patch, never an in-place edit of the loaded settings.
    expect(current.side_panel_view_by_project).toEqual({ root: "git", "box:b1": "files" });
  });

  it("overrides the scope's previous entry and copes with no settings at all", () => {
    expect(sidePanelViewPatch("git", "root", { side_panel_view_by_project: { root: "files" } })).toEqual({
      side_panel_view: "git",
      side_panel_view_by_project: { root: "git" },
    });
    expect(sidePanelViewPatch("files", "p1", null)).toEqual({
      side_panel_view: "files",
      side_panel_view_by_project: { p1: "files" },
    });
  });
});
