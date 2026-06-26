/**
 * Tests for the Git worktree UI in GitHistory (#23, TODO Group E):
 * - lists worktrees in a "Worktrees" section;
 * - the create form sends git_worktree_add with the right (camelCase) args;
 * - removing a non-main worktree sends git_worktree_remove for that path;
 * - the main worktree has no enabled remove control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { GitHistory } from "../components/files/GitHistory";

const COMMITS = [
  { hash: "aaa111", short: "aaa111", subject: "feat: add widget", author: "me", date: "2d ago", refs: "HEAD -> main", is_head: true, parents: ["bbb222"] },
];

const BRANCHES = [
  { name: "main", is_current: true, is_remote: false },
  { name: "feature", is_current: false, is_remote: false },
  { name: "origin/main", is_current: false, is_remote: true },
];

const WORKTREES = [
  { path: "/p", branch: "main", head: "aaa111aaa", is_main: true, is_locked: false, is_bare: false },
  { path: "/p-feature", branch: "feature", head: "ccc333ccc", is_main: false, is_locked: false, is_bare: false },
];

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_worktree_list") return Promise.resolve(WORKTREES);
    if (cmd === "git_worktree_add") return Promise.resolve(null);
    if (cmd === "git_worktree_remove") return Promise.resolve(null);
    if (cmd === "git_commit_message") return Promise.resolve("feat: add widget");
    return Promise.resolve(null);
  });
}

async function renderHistory() {
  await act(async () => {
    render(<GitHistory projectDir="/p" />);
  });
}

describe("#23 git worktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("lists the worktrees", async () => {
    await renderHistory();
    expect(await screen.findByText("Worktrees")).toBeTruthy();
    // main worktree (branch "main") and the linked "feature" worktree.
    // Scope to the worktree pill: "feature" also appears as a branch pill.
    const featurePill = (await screen.findByTitle("/p-feature")) as HTMLElement;
    expect(featurePill.textContent).toContain("feature");
  });

  it("create form sends git_worktree_add with camelCase args", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await screen.findByText("Worktrees");

    await user.click(screen.getByRole("button", { name: "+ Worktree" }));
    await user.selectOptions(screen.getByLabelText("Branch"), "feature");
    await user.type(screen.getByLabelText("Worktree path"), "/tmp/wt");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_add", {
      projectDir: "/p",
      path: "/tmp/wt",
      branch: "feature",
      newBranch: false,
    });
  });

  it("removing a non-main worktree calls git_worktree_remove for its path", async () => {
    const user = userEvent.setup();
    await renderHistory();
    const pill = (await screen.findByTitle("/p-feature")) as HTMLElement;
    await user.click(within(pill).getByRole("button", { name: /Remove worktree/ }));
    expect(mockInvoke).toHaveBeenCalledWith(
      "git_worktree_remove",
      expect.objectContaining({ projectDir: "/p", path: "/p-feature" }),
    );
  });

  it("the main worktree has no remove control", async () => {
    await renderHistory();
    const mainPill = (await screen.findByTitle("/p")) as HTMLElement;
    expect(within(mainPill).queryByRole("button", { name: /Remove worktree/ })).toBeNull();
  });
});
