/**
 * Regression: the project switcher must render one pill per active project.
 * A crash or bad filter in the pill strip made the pills vanish entirely — a
 * severe bug, since the switcher is the primary way to move between projects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

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

  it("gives the built-in Trash project a scope-chip row, not a pill", async () => {
    // Trash was a pinned pill at the head of the row; it now lives in the scope
    // chip's dropdown beside root and the boxes, so it costs the header no
    // width at all.
    useProjectsStore.setState({
      projects: [proj("eldrun-trash", 0, { name: "Trash" })],
      activeId: "eldrun-trash",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    expect(container!.querySelector(".trash-project-pill")).toBeNull();
    expect(container!.querySelector(".root-pill")).toBeNull();

    const main = container!.querySelector(".box-chip-main") as HTMLElement;
    await act(async () => {
      fireEvent.click(main);
    });
    const menu = document.querySelector(".box-chip-menu") as HTMLElement;
    const row = [...menu.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Trash"),
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.querySelector(".box-chip-menu-trash-icon")).toBeTruthy();
    // Not a box, so a pill drag can never drop into it.
    expect(row.hasAttribute("data-box-id")).toBe(false);
  });

  it("keeps Trash out of the scrolling strip", async () => {
    useProjectsStore.setState({
      projects: [proj("eldrun-trash", 0, { name: "Trash" }), proj("a", 1), proj("b", 2)],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    // The strip holds the two real projects, and Trash wears no pill anywhere.
    const strip = container!.querySelector(".project-pills-scroll") as HTMLElement;
    expect(strip.querySelectorAll(".project-pill").length).toBe(2);
    expect(container!.querySelector(".trash-project-pill")).toBeNull();
  });

  it("no longer carries the settings gear — it lives in the header cluster", async () => {
    useProjectsStore.setState({ projects: [proj("a", 0)], activeId: "a", loaded: true });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    // The switcher's own controls are all on ONE side of the strip now: the
    // gear moved to `header/SettingsMenu`, leaving + and the search.
    expect(container!.querySelector('[data-hint-anchor="settings"]')).toBeNull();
    expect(container!.querySelector('[data-hint-anchor="add-project"]')).toBeTruthy();
  });
});
