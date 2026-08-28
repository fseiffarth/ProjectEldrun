/**
 * When the current tab scope is a box scope (`box:<id>`), the side panel shows
 * a multi-root file view: one collapsible section (`.file-root`) for the box
 * folder plus one per member project root (#41 Phase 3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { ProjectBox, ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  // Listing commands resolve to []; git_repo_root returns a path string or null,
  // so the blanket [] would leak a non-string into ProjectFilesView's norm().
  invoke: vi.fn((cmd: string) => Promise.resolve(cmd === "git_repo_root" ? null : [])),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { SidePanel } from "../components/layout/SidePanel";
import { useProjectsStore } from "../stores/projects";
import { useBoxesStore } from "../stores/boxes";
import { useTabsStore } from "../stores/tabs";
import { useRemoteStatusStore } from "../stores/remoteStatus";
import { useFileSourcePrefStore } from "../stores/fileSourcePref";

function proj(id: string, _boxId?: string): ProjectEntry {
  // Membership is member_ids-only now; the second arg is kept so call sites read
  // as "member of that box" without carrying a stale box_id field.
  return {
    id,
    name: id,
    status: "active",
    position: 10,
    local_file: `/p/${id}/project.json`,
  };
}

function box(id: string, members: string[]): ProjectBox {
  return { id, name: id, member_ids: members, position: 10, folder: `/b/${id}` };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: "root" });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useFileSourcePrefStore.setState({ byProject: {}, byViewer: {} });
});

describe("SidePanel multi-root box view", () => {
  it("renders a file-root section for the box folder + each member root", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    useProjectsStore.setState({
      projects: [proj("p1", "boxA"), proj("p2", "boxA")],
      activeId: null,
      loaded: true,
    });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const headers = [...container.querySelectorAll(".file-root-header .file-root-name")].map(
      (el) => el.textContent,
    );
    // Box folder root + the two member roots.
    expect(headers).toEqual(["boxA", "p1", "p2"]);
  });

  it("gates a disconnected remote member's REMOTE side behind a connect prompt", async () => {
    // p2 is a remote (SSH) member whose pool is down and whose chosen side is
    // Remote: its section must show the connect prompt instead of mounting the
    // SFTP-backed tree (whose synchronous probes would freeze a real window) —
    // but the Remote/Local switch must STAY up, so the mirror remains one click
    // away while offline. p1 stays a local member with a tree.
    useBoxesStore.setState({ boxes: [box("boxA", ["p1", "p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({
      projects: [proj("p1", "boxA"), remoteMember],
      activeId: null,
      loaded: true,
    });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "off", vpn: "off" } } });
    useFileSourcePrefStore.setState({ byProject: { p2: "remote" }, byViewer: {} });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const sections = [...container.querySelectorAll(".file-root")];
    expect(sections).toHaveLength(3);
    // The remote member's section carries the prompt, not a tree body.
    const p2Section = sections.find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).toBeNull();
    expect(p2Section.textContent).toContain("Disconnected");
    expect(p2Section.querySelector(".dialog-connect-btn")).not.toBeNull();
    // The escape hatch out of the prompt: the member's own source switch.
    expect(p2Section.querySelector(".side-panel-source-switch")).not.toBeNull();
    // The local member keeps its ordinary tree body (and, not being remote,
    // gets no source switch).
    const p1Section = sections.find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p1"),
    )!;
    expect(p1Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p1Section.querySelector(".dialog-connect-btn")).toBeNull();
    expect(p1Section.querySelector(".side-panel-source-switch")).toBeNull();
  });

  it("shows a disconnected remote member's LOCAL mirror by default", async () => {
    // With no stored side, a disconnected member auto-latches Local (same rule
    // as the single-project view) and browses the offline mirror — the box view
    // used to have no switch at all, stranding remote members on a dead
    // Connect prompt.
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [remoteMember], activeId: null, loaded: true });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "off", vpn: "off" } } });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const p2Section = [...container.querySelectorAll(".file-root")].find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p2Section.querySelector(".dialog-connect-btn")).toBeNull();
    expect(p2Section.querySelector(".side-panel-source-switch")).not.toBeNull();
  });

  it("mounts a connected remote member's tree", async () => {
    useBoxesStore.setState({ boxes: [box("boxA", ["p2"])] });
    const remoteMember = {
      ...proj("p2", "boxA"),
      remote: { host: "h", user: "u", remote_path: "/srv/p2" },
    } as ProjectEntry;
    useProjectsStore.setState({ projects: [remoteMember], activeId: null, loaded: true });
    useRemoteStatusStore.setState({ byProject: { p2: { ssh: "connected", vpn: "off" } } });
    useTabsStore.setState({ scope: "box:boxA" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    const p2Section = [...container.querySelectorAll(".file-root")].find((el) =>
      el.querySelector(".file-root-name")?.textContent?.includes("p2"),
    )!;
    expect(p2Section.querySelector(".file-root-body")).not.toBeNull();
    expect(p2Section.querySelector(".dialog-connect-btn")).toBeNull();
  });

  it("falls back to the single project tree when no box scope is active", async () => {
    useProjectsStore.setState({
      projects: [proj("p1")],
      activeId: "p1",
      loaded: true,
    });
    useTabsStore.setState({ scope: "p1" });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} />));
    });

    expect(container.querySelector(".file-root")).toBeNull();
  });
});
