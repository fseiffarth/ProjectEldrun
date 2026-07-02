/**
 * Tests for git-aware local↔remote lockstep sync UI (#28n, Phase 1) in GitHistory:
 * - a remote project with lockstep enabled routes branch checkout through
 *   `git_peer_checkout` (host-initiated), not the bare `git_checkout`;
 * - the status pill reflects the backend `GitPeerState`;
 * - with lockstep disabled the checkout falls back to `git_checkout`;
 * - a local project (no projectId/remote) never shows the lockstep bar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { GitHistory } from "../components/files/GitHistory";

const COMMITS = [
  { hash: "aaa111", short: "aaa111", subject: "feat", author: "me", date: "2d", refs: "HEAD -> main", is_head: true, parents: [] },
];
const BRANCHES = [
  { name: "main", is_current: true, is_remote: false },
  { name: "feature", is_current: false, is_remote: false },
];

function setup(peerState: unknown) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_worktree_list") return Promise.resolve([]);
    if (cmd === "git_peer_status") return Promise.resolve(peerState);
    if (cmd === "git_peer_checkout") return Promise.resolve(peerState);
    if (cmd === "git_checkout") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

const ENABLED = {
  enabled: true,
  status: "synchronized",
  detail: null,
  localHead: { kind: "branch", name: "main", sha: "a" },
  remoteHead: { kind: "branch", name: "main", sha: "a" },
  lastSyncTs: 1,
};
const DISABLED = { ...ENABLED, enabled: false };

async function renderRemote(peerState: unknown) {
  await act(async () => {
    render(<GitHistory projectDir="/p" projectId="proj1" remote />);
  });
  void peerState;
}

describe("#28n git lockstep UI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the status pill and routes checkout through git_peer_checkout when enabled", async () => {
    setup(ENABLED);
    const user = userEvent.setup();
    await renderRemote(ENABLED);

    // Pill reflects backend status.
    expect(await screen.findByText("synchronized")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_checkout", {
      projectId: "proj1",
      target: "feature",
      initiatingSide: "remote",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("git_checkout", expect.anything());
  });

  it("falls back to git_checkout when lockstep is disabled", async () => {
    setup(DISABLED);
    const user = userEvent.setup();
    await renderRemote(DISABLED);

    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "feature" });
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_checkout", expect.anything());
  });

  it("does not render the lockstep bar for a local project", async () => {
    setup(null);
    await act(async () => {
      render(<GitHistory projectDir="/p" />);
    });
    expect(screen.queryByText(/Lockstep/)).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_status", expect.anything());
  });
});
