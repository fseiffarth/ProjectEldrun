/**
 * Regression: the project switcher must render one pill per active project.
 * A crash or bad filter in the pill strip made the pills vanish entirely — a
 * severe bug, since the switcher is the primary way to move between projects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { ProjectSwitcher } from "../components/layout/ProjectSwitcher";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";
import type { ProjectEntry } from "../types";

function proj(id: string, position: number, extra: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id,
    name: `Project ${id}`,
    status: "active",
    position,
    local_file: `/tmp/${id}/project.json`,
    directory: `/tmp/${id}`,
    ...extra,
  };
}

describe("project switcher pill rendering", () => {
  beforeEach(() => {
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });

  it("renders one pill per active project", async () => {
    useProjectsStore.setState({
      projects: [proj("a", 0), proj("b", 1), proj("c", 2)],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    const pills = container!.querySelectorAll(".project-pill");
    expect(pills.length).toBe(3);
  });

  it("renders a pill for a remote project (matches real on-disk shape)", async () => {
    useProjectsStore.setState({
      projects: [
        proj("a", 0),
        proj("ssh", 1, {
          name: "SSH Git Test",
          git_type: "local",
          remote: {
            auto_connect: true,
            host: "example.host",
            key_auth: false,
            openvpn: { config: "/x/y.ovpn", username: "u" },
            remote_path: "/home/u/proj",
            user: "u",
          },
        } as Partial<ProjectEntry>),
      ],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    expect(container!.querySelectorAll(".project-pill").length).toBe(2);
  });

  it("hides inactive projects but keeps the active ones", async () => {
    useProjectsStore.setState({
      projects: [proj("a", 0), proj("b", 1, { status: "inactive" }), proj("c", 2)],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    expect(container!.querySelectorAll(".project-pill").length).toBe(2);
  });
});
