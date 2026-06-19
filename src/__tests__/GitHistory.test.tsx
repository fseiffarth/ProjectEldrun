/**
 * Tests for the right-panel Git history & commit UI:
 * - #7 (Group D.3): the history view shows the current branch, a commit list
 *   (HEAD marked), clickable branch pills that check the branch out.
 * - #8 (Group D.3): clicking HEAD opens an editable commit window with a
 *   "Save (amend)" action (git_reword_head); an older commit is read-only;
 *   "Checkout" checks the commit out (detached).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { GitHistory } from "../components/files/GitHistory";

const COMMITS = [
  { hash: "aaa111", short: "aaa111", subject: "feat: add widget", author: "me", date: "2d ago", refs: "HEAD -> main", is_head: true, parents: ["bbb222"] },
  { hash: "bbb222", short: "bbb222", subject: "fix: earlier bug", author: "me", date: "5d ago", refs: "", is_head: false, parents: [] },
];

const BRANCHES = [
  { name: "main", is_current: true, is_remote: false },
  { name: "feature", is_current: false, is_remote: false },
  { name: "origin/main", is_current: false, is_remote: true },
];

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_commit_message") return Promise.resolve("feat: add widget\n\nbody");
    if (cmd === "git_checkout") return Promise.resolve(null);
    if (cmd === "git_reword_head") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

async function renderHistory() {
  await act(async () => {
    render(<GitHistory projectDir="/p" />);
  });
}

describe("#7 git history view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("shows current branch, commit list with HEAD marked", async () => {
    await renderHistory();
    expect(await screen.findByText(/⎇\s*main/)).toBeTruthy();
    const headRow = (await screen.findByText("feat: add widget")).closest("button")!;
    expect(headRow.className).toContain("head");
    const olderRow = screen.getByText("fix: earlier bug").closest("button")!;
    expect(olderRow.className).not.toContain("head");
  });

  it("clicking a non-current branch pill checks it out", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "feature" });
  });
});

describe("#8 commit-message window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });

  it("HEAD opens editable, Save (amend) calls git_reword_head", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("feat: add widget"));

    const textarea = (await screen.findByDisplayValue(/feat: add widget/)) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save (amend)" }));
    expect(mockInvoke).toHaveBeenCalledWith(
      "git_reword_head",
      expect.objectContaining({ projectDir: "/p" }),
    );
  });

  it("an older commit is read-only with no amend action", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("fix: earlier bug"));

    const textarea = (await screen.findByDisplayValue(/feat: add widget/)) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save (amend)" })).toBeNull();
    expect(screen.getByText(/Only the latest commit/)).toBeTruthy();
  });

  it("Checkout from the window checks out that commit", async () => {
    const user = userEvent.setup();
    await renderHistory();
    await user.click(await screen.findByText("fix: earlier bug"));
    await screen.findByDisplayValue(/feat: add widget/);
    await user.click(screen.getByRole("button", { name: "Checkout" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "bbb222" });
  });
});
