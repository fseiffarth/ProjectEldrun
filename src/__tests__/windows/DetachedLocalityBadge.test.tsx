/**
 * The popout's per-tab Local/Remote badge shows only for a REMOTE project, as
 * the main window's `TabBar` (`isRemoteScope`) does. Since #232 the seed's
 * project context (`remoteInfo`) is streamed for every project scope, so its
 * mere presence stopped meaning "remote" — gating on it put the ⌂ "runs
 * locally" badge on every agent/shell tab of a plain local project's popout.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "popout",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import type { DetachedRemoteInfo } from "../../stores/detached";
import type { GroupNode, TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const tabs: TabEntry[] = [
  { key: "a", label: "Claude", kind: "agent", cmd: "claude", cwd: "/p" },
  { key: "b", label: "shell", kind: "shell", cmd: "bash", cwd: "/p" },
];
const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a", "b"], activeKey: "a" };
const project = { id: "p", name: "P", local_file: "/p/project.json", directory: "/p" } as ProjectEntry;

function badges(remoteInfo: DetachedRemoteInfo | undefined) {
  const { container } = render(
    <DetachedCenterPanel
      scope="p" popoutId="popout" tree={tree} tabs={tabs} remoteInfo={remoteInfo}
      onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
      onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
      onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
    />,
  );
  return container.querySelectorAll(".tab-locality").length;
}

afterEach(() => cleanup());

describe("popout locality badge", () => {
  it("is absent for a local project, though its context is streamed", () => {
    expect(badges({ project })).toBe(0);
  });

  it("is absent with no project context at all", () => {
    expect(badges(undefined)).toBe(0);
  });

  it("shows on the agent and shell tabs of a remote project", () => {
    const remote = {
      ...project,
      remote: { host: "h", user: "u", remote_path: "/r" },
    } as unknown as ProjectEntry;
    expect(badges({ project: remote, primaryHost: "h" })).toBe(2);
  });
});
