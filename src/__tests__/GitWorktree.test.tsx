/**
 * Tests for the Git worktree UI in GitHistory (#23, TODO Group E).
 *
 * The old suite asserted only the happy path *and* only `newBranch: false`,
 * which is why nothing caught that the "new branch" toggle could never succeed
 * (B1): the branch field was a listbox of EXISTING branches, so ticking it sent
 * `git worktree add -b <an existing branch>`, which git always refuses. So the
 * failure paths are what this file is mostly about now — the confirm before a
 * removal that deletes a directory (B2), the force escalation git itself names
 * (B3/B4), and the branch list not offering a checkout that cannot happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  { name: "spare", is_current: false, is_remote: false },
  { name: "origin/main", is_current: false, is_remote: true },
];

function wt(over: Partial<Record<string, unknown>> = {}) {
  return {
    path: "/p-x",
    branch: "x",
    head: "ccc333ccc",
    is_main: false,
    is_locked: false,
    lock_reason: "",
    is_prunable: false,
    prunable_reason: "",
    is_bare: false,
    is_current: false,
    ...over,
  };
}

const WORKTREES = [
  wt({ path: "/p", branch: "main", head: "aaa111aaa", is_main: true, is_current: true }),
  wt({ path: "/p/.eldrun/worktrees/feature", branch: "feature" }),
];

let worktrees: unknown[] = WORKTREES;

function setupInvoke(over: Record<string, unknown> = {}) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd in over) {
      const v = over[cmd];
      return typeof v === "function" ? (v as () => unknown)() : Promise.resolve(v);
    }
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_worktree_list") return Promise.resolve(worktrees);
    if (cmd === "git_commit_message") return Promise.resolve("feat: add widget");
    return Promise.resolve(null);
  });
}

/** The worktree *pill* for a path. The per-button titles embed the path too, so
 *  a title query alone matches several nodes; the pill is the span among them. */
async function pillFor(path: string): Promise<HTMLElement> {
  const all = await screen.findAllByTitle(new RegExp(path.replace(/[/\\]/g, "\\$&")));
  const pill = all.find((el) => el.tagName === "SPAN");
  if (!pill) throw new Error(`no worktree pill for ${path}`);
  return pill as HTMLElement;
}

async function renderHistory() {
  await act(async () => {
    render(<GitHistory projectDir="/p" />);
  });
}

describe("#23 git worktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worktrees = WORKTREES;
    setupInvoke();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the worktrees", async () => {
    await renderHistory();
    expect(await screen.findByText("Worktrees")).toBeTruthy();
    // main worktree (branch "main") and the linked "feature" worktree.
    // Scope to the worktree pill: "feature" also appears as a branch pill.
    const featurePill = (await screen.findByTitle("/p/.eldrun/worktrees/feature")) as HTMLElement;
    expect(featurePill.textContent).toContain("feature");
  });

  it("create form sends git_worktree_add with camelCase args", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await screen.findByText("Worktrees");

    await user.click(screen.getByRole("button", { name: "+ Worktree" }));
    // Branch picker is the themed Dropdown (title "Branch"): open it, pick "spare".
    await user.click(screen.getByTitle("Branch"));
    await user.click(screen.getByRole("option", { name: "spare" }));
    await user.type(screen.getByLabelText("Worktree name"), "wt-spare");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_add", {
      projectDir: "/p",
      site: "host",
      path: "wt-spare",
      branch: "spare",
      newBranch: false,
      startPoint: null,
    });
  });

  it("a branch already checked out in a worktree is not offered", async () => {
    // `git worktree add <path> feature` → "'feature' is already used by worktree
    // at '…'". Offering it was a guaranteed failure one click away.
    const user = userEvent.setup();
    await renderHistory();
    await screen.findByText("Worktrees");
    await user.click(screen.getByRole("button", { name: "+ Worktree" }));
    await user.click(screen.getByTitle("Branch"));
    expect(screen.queryByRole("option", { name: "feature" })).toBeNull();
    expect(screen.getByRole("option", { name: "spare" })).toBeTruthy();
    // "main" is the main worktree's branch — checked out too.
    expect(screen.queryByRole("option", { name: "main" })).toBeNull();
  });

  it("the new-branch toggle sends a NEW name plus a start point", async () => {
    // B1: the one assertion that would have caught a dead half-feature.
    const user = userEvent.setup();
    await renderHistory();
    await screen.findByText("Worktrees");
    await user.click(screen.getByRole("button", { name: "+ Worktree" }));
    await user.click(screen.getByLabelText("new branch"));
    await user.type(screen.getByLabelText("New branch name"), "brand-new");
    await user.click(screen.getByTitle("Start point"));
    await user.click(screen.getByRole("option", { name: "main" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_add", {
      projectDir: "/p",
      site: "host",
      // No name typed → the branch name is the worktree name.
      path: "brand-new",
      branch: "brand-new",
      newBranch: true,
      startPoint: "main",
    });
  });

  it("removing a worktree confirms first and sends force: 0", async () => {
    // B2: one unconfirmed click used to delete a whole directory — including the
    // ignored files (node_modules, .venv, .env) git does NOT protect.
    const user = userEvent.setup();
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirm);
    await renderHistory();
    const pill = await pillFor("worktrees/feature");
    await user.click(within(pill).getByRole("button", { name: /Remove worktree/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain("/p/.eldrun/worktrees/feature");
    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_remove", {
      projectDir: "/p",
      path: "/p/.eldrun/worktrees/feature",
      force: 0,
      site: "host",
    });
  });

  it("a declined confirmation removes nothing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("confirm", vi.fn(() => false));
    await renderHistory();
    const pill = await pillFor("worktrees/feature");
    await user.click(within(pill).getByRole("button", { name: /Remove worktree/ }));
    expect(mockInvoke).not.toHaveBeenCalledWith("git_worktree_remove", expect.anything());
  });

  it("a dirty worktree is re-offered with force: 1", async () => {
    // B3: `force` had exactly one call site, which never passed it — so a
    // worktree with one modified file yielded a raw "use --force" string and no
    // control anywhere in the app could supply it.
    const user = userEvent.setup();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const calls: number[] = [];
    setupInvoke({
      git_worktree_remove: () => {
        calls.push(calls.length);
        return calls.length === 1
          ? Promise.reject("fatal: '…' contains modified or untracked files, use --force to delete it")
          : Promise.resolve(null);
      },
    });
    await renderHistory();
    const pill = await pillFor("worktrees/feature");
    await user.click(within(pill).getByRole("button", { name: /Remove worktree/ }));
    const forces = mockInvoke.mock.calls
      .filter((c) => c[0] === "git_worktree_remove")
      .map((c) => (c[1] as { force: number }).force);
    expect(forces).toEqual([0, 1]);
  });

  it("a locked worktree escalates straight to force: 2", async () => {
    // B4: git answers a locked worktree with "use 'remove -f -f' to override or
    // unlock first" and exits 128 for a single --force. Eldrun could pass at most
    // one, so a locked worktree was permanently unremovable from the app.
    const user = userEvent.setup();
    vi.stubGlobal("confirm", vi.fn(() => true));
    worktrees = [
      WORKTREES[0],
      wt({ path: "/p/.eldrun/worktrees/wip", branch: "wip", is_locked: true, lock_reason: "on a removable drive" }),
    ];
    let n = 0;
    setupInvoke({
      git_worktree_remove: () => {
        n += 1;
        return n === 1
          ? Promise.reject(
              "fatal: cannot remove a locked working tree, lock reason: on a removable drive\nuse 'remove -f -f' to override or unlock first",
            )
          : Promise.resolve(null);
      },
    });
    await renderHistory();
    const pill = await pillFor("worktrees/wip");
    await user.click(within(pill).getByRole("button", { name: /Remove worktree/ }));
    const forces = mockInvoke.mock.calls
      .filter((c) => c[0] === "git_worktree_remove")
      .map((c) => (c[1] as { force: number }).force);
    expect(forces).toEqual([0, 2]);
  });

  it("a locked worktree can be unlocked from the list", async () => {
    const user = userEvent.setup();
    worktrees = [
      WORKTREES[0],
      wt({ path: "/p/.eldrun/worktrees/wip", branch: "wip", is_locked: true, lock_reason: "on a removable drive" }),
    ];
    setupInvoke();
    await renderHistory();
    const pill = await pillFor("worktrees/wip");
    expect(pill.getAttribute("title")).toContain("on a removable drive");
    await user.click(within(pill).getByRole("button", { name: /Unlock/ }));
    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_unlock", {
      projectDir: "/p",
      path: "/p/.eldrun/worktrees/wip",
      site: "host",
    });
  });

  it("a prunable worktree is marked and offers Prune", async () => {
    // The parser used to discard `prunable`, the one signal git gives that a
    // listed worktree is dead — so it rendered as healthy, and the already-
    // implemented `git_worktree_prune` was never invoked from anywhere in src/.
    const user = userEvent.setup();
    worktrees = [
      WORKTREES[0],
      wt({
        path: "/p/.eldrun/worktrees/gone",
        branch: "old",
        is_prunable: true,
        prunable_reason: "gitdir file points to non-existent location",
      }),
    ];
    setupInvoke();
    await renderHistory();
    const pill = await pillFor("worktrees/gone");
    expect(pill.className).toContain("prunable");
    expect(pill.getAttribute("title")).toContain("non-existent location");
    await user.click(screen.getByRole("button", { name: "Prune" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_prune", { projectDir: "/p", site: "host" });
  });

  it("the main worktree has no remove control", async () => {
    await renderHistory();
    const mainPill = (await screen.findByTitle("/p")) as HTMLElement;
    expect(within(mainPill).queryByRole("button", { name: /Remove worktree/ })).toBeNull();
  });

  it("the worktree we are standing in has no remove control", async () => {
    // D4: `is_main` answers a different question. git does not protect the
    // current worktree — `remove --force` on it exits 0 and deletes the tree.
    worktrees = [
      wt({ path: "/p", branch: "main", is_main: true }),
      wt({ path: "/p/.eldrun/worktrees/here", branch: "here", is_current: true }),
    ];
    setupInvoke();
    await renderHistory();
    const pill = await pillFor("worktrees/here");
    expect(within(pill).queryByRole("button", { name: /Remove worktree/ })).toBeNull();
  });

  it("a remote project can manage the mirror's worktrees too", async () => {
    // I2: `projectDir` for a remote project is the LOCAL MIRROR, but the commands
    // resolved remoteness from it and ran on the host — so a path picked from a
    // local file tree was created on the login node, and the mirror's own repo
    // could never have its worktrees managed at all. There is no side switch for
    // a local project, where there is only one side to be on.
    const user = userEvent.setup();
    await act(async () => {
      render(<GitHistory projectDir="/p" projectId="pid" remote />);
    });
    await screen.findByText("Worktrees");
    mockInvoke.mockClear();
    await user.click(screen.getByTitle("Side"));
    await user.click(screen.getByRole("option", { name: "Mirror" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_worktree_list", {
      projectDir: "/p",
      site: "mirror",
    });
  });

  it("a local project is offered no side switch", async () => {
    await renderHistory();
    await screen.findByText("Worktrees");
    expect(screen.queryByTitle("Side")).toBeNull();
  });

  it("a failing worktree probe does not blank the commit list", async () => {
    // The three reads used to share one `Promise.all`, so any one rejection
    // rejected the batch and the whole git view went empty.
    setupInvoke({ git_worktree_list: () => Promise.reject("boom") });
    await renderHistory();
    expect(await screen.findByText("feat: add widget")).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
  });
});
