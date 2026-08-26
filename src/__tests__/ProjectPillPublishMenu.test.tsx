/**
 * Regression: a project whose git type says "pushed to GitHub/GitLab" but that
 * has no `origin` must be offered **Publish…**, not the manage-an-existing-repo
 * actions.
 *
 * The git type is only a label, and the new-project dialog writes it from its
 * hosting choice. A project created that way before creation actually published
 * (and any whose publish failed) has no repository on the host — yet the pill
 * menu keyed straight off the label and offered "Make public", "Move to GitLab"
 * and "Unpublish…", all of which fail, with no way to publish it and no Push
 * button either (that one keys off an upstream branch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
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

const PROJECT = {
  id: "p1",
  name: "PyTest CI/CD",
  status: "active" as const,
  position: 0,
  local_file: "/tmp/p1/project.json",
  directory: "/tmp/p1",
  git_type: "remote-private",
};

function stub(hasOrigin: boolean) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "project_has_origin") return Promise.resolve(hasOrigin);
    if (cmd === "list_project_endings") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function openPillMenu() {
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<ProjectSwitcher open />));
  });
  const pill = container!.querySelector(".project-pill") as HTMLElement;
  await act(async () => {
    fireEvent.contextMenu(pill);
  });
}

describe("pill git menu for a project labeled as published", () => {
  beforeEach(() => {
    invoke.mockReset();
    useBoxesStore.setState({ boxes: [] });
    useProjectsStore.setState({ projects: [PROJECT], activeId: "p1", loaded: true });
  });

  it("offers Publish… when the repo has no origin", async () => {
    stub(false);
    await openPillMenu();
    expect(screen.getByText("Publish to GitHub / GitLab…")).toBeTruthy();
    expect(screen.queryByText("Unpublish (keep repo)…")).toBeNull();
  });

  it("offers the manage actions when the repo really is published", async () => {
    stub(true);
    await openPillMenu();
    expect(screen.queryByText("Publish to GitHub / GitLab…")).toBeNull();
    expect(screen.getByText("Unpublish (keep repo)…")).toBeTruthy();
  });
});
