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
import { usePillDragStore } from "../stores/pillDrag";
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

  it("renders the built-in Trash project as an icon-only pill", async () => {
    useProjectsStore.setState({
      projects: [proj("eldrun-trash", 0, { name: "Trash" })],
      activeId: "eldrun-trash",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    const pill = container!.querySelector(".trash-project-pill") as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.querySelector(".trash-project-icon")).toBeTruthy();
    expect(pill.querySelector(".project-pill-label")).toBeNull();
    expect(pill.querySelector(".pill-close-btn")).toBeNull();
    // The pill's own label is the descriptive tooltip, not the bare project
    // name — the Trash pill shows no name and gets no hover card.
    const main = pill.querySelector(".pill-main") as HTMLElement;
    expect(main.getAttribute("aria-label")).toMatch(/^Trash project —/);
  });

  it("pins the Trash pill outside the scrolling strip", async () => {
    // Trash is always present and cannot be closed, so it belongs in the row's
    // FIXED leading segment (beside ★ and the box chip) rather than as the
    // first pill of a strip that scrolls it out of reach.
    useProjectsStore.setState({
      projects: [proj("eldrun-trash", 0, { name: "Trash" }), proj("a", 1), proj("b", 2)],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    const strip = container!.querySelector(".project-pills-scroll") as HTMLElement;
    expect(strip.querySelector(".trash-project-pill")).toBeNull();
    // …and the strip holds the two real projects, not three.
    expect(strip.querySelectorAll(".project-pill").length).toBe(2);
    // It is still in the pills region, right of the pinned root pill.
    const region = container!.querySelector(".project-pills-region") as HTMLElement;
    expect(region.querySelector(":scope > .trash-project-pill")).toBeTruthy();
  });

  it("does not let the pinned Trash pill start a drag", async () => {
    // Nothing to drag it into: it lives outside the strip and the backend
    // rewrites its position before every save.
    useProjectsStore.setState({
      projects: [proj("eldrun-trash", 0, { name: "Trash" }), proj("a", 1)],
      activeId: "a",
      loaded: true,
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectSwitcher open />));
    });

    const pill = container!.querySelector(".trash-project-pill") as HTMLElement;
    for (const [type, target] of [
      ["pointerdown", pill],
      ["pointermove", window],
      ["pointerup", window],
    ] as const) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, { clientX: type === "pointerdown" ? 10 : 400, clientY: 10, button: 0, pointerId: 1 });
      act(() => {
        (target as EventTarget).dispatchEvent(ev);
      });
    }
    expect(usePillDragStore.getState().drag).toBeNull();
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
