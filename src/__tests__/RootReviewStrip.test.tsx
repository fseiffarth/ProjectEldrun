import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RootReviewStrip, stripInvisible } from "../components/layout/RootReviewStrip";
import { useRootReviewStore, type RootProposal } from "../stores/rootReview";

const decide = vi.fn();
const applyAll = vi.fn();
function proposal(overrides: Partial<RootProposal> = {}): RootProposal {
  return {
    id: "p", tab: "root:a", tool: "todo_update", args: { id: "task" }, created: "0",
    rows: [{ kind: "task", op: "upsert", pre: { id: "task", title: "Before" }, post: { id: "task", title: "After" }, local: false }],
    calendars: [], tainted: false, status: "pending", undo: false, digest: "digest", closed: false, ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useRootReviewStore.setState({ proposals: [proposal()], count: 1, busy: false, error: null, decide, applyAll });
});
afterEach(cleanup);
describe("root-agent write review", () => {
  it("renders actual field changes and binds approval to the displayed digest", () => {
    render(<RootReviewStrip />);
    expect(screen.getAllByText("Before").length).toBe(2);
    expect(screen.getAllByText("After").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: "p", digest: "digest" }), "apply");
    fireEvent.click(screen.getByRole("button", { name: "Approve all (1)" }));
    expect(applyAll).toHaveBeenCalledWith([expect.objectContaining({ id: "p", digest: "digest" })]);
  });
  it("disables approval for conflicts and offers discard", () => {
    useRootReviewStore.setState({ proposals: [proposal({ status: "conflicted", closed: true })], count: 0 });
    render(<RootReviewStrip />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("From a closed tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(decide).toHaveBeenCalledWith(expect.anything(), "reject");
  });
  it("folds only sibling reindex rows, keeping substantive edits visible", () => {
    const p = proposal({ tool: "todo_move" });
    p.rows.push({ kind: "task", op: "upsert", pre: { id: "sibling", title: "Hidden sibling", rank: 1 }, post: { id: "sibling", title: "Hidden sibling", rank: 2 }, local: true });
    p.rows.push({ kind: "task", op: "upsert", pre: { id: "changed", title: "Old", rank: 1 }, post: { id: "changed", title: "Visible change", rank: 2 }, local: true });
    useRootReviewStore.setState({ proposals: [p] });
    render(<RootReviewStrip />);
    expect(screen.getByText("And 1 cards reordered")).toBeTruthy();
    expect(screen.queryByText("Hidden sibling")).toBeNull();
    expect(screen.getAllByText("Visible change").length).toBeGreaterThan(0);
  });
  it("shows outbound effects and strips invisible text without interpreting HTML", () => {
    const p = proposal({ calendars: [{ id: "work", name: "Work\u202e", caldav_account_id: "account" }] });
    p.rows[0].post.title = "<b>\u200bTitle\u202e\u{E0061}</b>";
    useRootReviewStore.setState({ proposals: [p] });
    render(<RootReviewStrip />);
    expect(screen.getAllByText("<b>Title</b>").length).toBeGreaterThan(0);
    expect(screen.getByText("Will be pushed to Work. The server may notify attendees.")).toBeTruthy();
    expect(stripInvisible("a\u034f\u2066\ufeff\u{E0001}b\n")).toBe("ab\n");
  });
});
