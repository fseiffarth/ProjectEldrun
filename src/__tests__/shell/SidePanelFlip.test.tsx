import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../../components/layout/SidePanel";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";

const invokeMock = vi.mocked(invoke);

const project: ProjectEntry = {
  id: "flip-project",
  name: "Flip project",
  status: "active",
  position: 1,
  local_file: "/projects/flip-project/project.json",
};

describe("Side panel switch-sides control", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_status") return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
      if (command === "git_repo_root") return Promise.resolve(null);
      if (command === "project_scaffold_missing") return Promise.resolve(false);
      if (command === "mobile_host_status") return Promise.resolve({ running: false });
      return Promise.resolve([]);
    });
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({ scope: project.id, tabsByScope: {} });
  });

  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("names the edge it moves to and draws the panel on the edge it is on", async () => {
    const user = userEvent.setup();
    const onToggleSide = vi.fn();
    const { container, rerender } = render(<SidePanel open side="right" onToggleSide={onToggleSide} />);

    const toLeft = await screen.findByRole("button", { name: "Move panel to the left edge" });
    // A picture, not a ⇄ glyph: a frame with the panel filled in and an arrow.
    const icon = toLeft.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.querySelectorAll("rect")).toHaveLength(2);
    // On the right edge the picture is drawn as-is …
    expect(icon!.querySelector("g[transform]")).toBeNull();

    await user.click(toLeft);
    expect(onToggleSide).toHaveBeenCalledTimes(1);

    // … and on the left edge it is the same picture mirrored, with the label flipped.
    rerender(<SidePanel open side="left" onToggleSide={onToggleSide} />);
    const toRight = await screen.findByRole("button", { name: "Move panel to the right edge" });
    expect(toRight.querySelector("g[transform]")!.getAttribute("transform")).toMatch(/^matrix\(-1/);
    expect(container.querySelector(".side-panel-flip")).toBe(toRight);
  });
});
