import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailAccount, MailDraft } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailComposeDialog } from "../../components/mail/MailComposeDialog";
import { RootReviewStrip } from "../../components/layout/RootReviewStrip";
import { useRootReviewStore } from "../../stores/rootReview";
import { useMailStore } from "../../stores/mail";

const account = { id: "a1", label: "Me", address: "me@home.example" } as MailAccount;
function draft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    id: "d1", account_id: "a1", to: [], cc: [], bcc: [], subject: "Offer", body_text: "Dear…",
    staged: [], origin: "agent", ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue([]);
  useRootReviewStore.setState({ proposals: [], count: 0, busy: false, error: null });
  useMailStore.setState({ agentDrafts: [], pendingDraft: null });
});
afterEach(cleanup);

describe("drafts an agent wrote", () => {
  it("opens with the banner, the draft's text, and the type-it-yourself note", () => {
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft()} onClose={() => {}} />);
    expect(screen.getByText("Drafted by an agent.")).toBeTruthy();
    expect(screen.getByText("The agent cannot choose who receives this. Type the recipient yourself.")).toBeTruthy();
    expect(screen.getByDisplayValue("Offer")).toBeTruthy();
    expect(screen.getByDisplayValue("Dear…")).toBeTruthy();
  });

  it("says so when the agent reads mail from outside, and keeps the thread's recipient", () => {
    render(
      <MailComposeDialog
        accounts={[account]}
        accountId="a1"
        mode="new"
        draft={draft({ origin: "reader", to: ["bob@friends.example"], in_reply_to: "<m1@mail.example>", references: ["<m1@mail.example>"] })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Drafted by an agent that reads mail from outside.")).toBeTruthy();
    expect(screen.queryByText("The agent cannot choose who receives this. Type the recipient yourself.")).toBeNull();
    expect(screen.getByDisplayValue("bob@friends.example")).toBeTruthy();
  });

  it("saves the stored draft in place, threading intact, and never as the agent's", async () => {
    const d = draft({ origin: "reader", to: ["bob@friends.example"], in_reply_to: "<m1@mail.example>", references: ["<m1@mail.example>"] });
    invoke.mockImplementation((cmd: string, args: { draft: MailDraft }) =>
      Promise.resolve(cmd === "mail_draft_save" ? args.draft : []));
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={d} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_draft_save", expect.anything()));
    const sent = invoke.mock.calls.find((c) => c[0] === "mail_draft_save")![1].draft as MailDraft;
    expect(sent.id).toBe("d1");
    expect(sent.in_reply_to).toBe("<m1@mail.example>");
    expect(sent.references).toEqual(["<m1@mail.example>"]);
    // The composer never sends an origin; the backend clears the stored one.
    expect(sent.origin).toBeUndefined();
  });

  it("discards through the backend and closes", async () => {
    const onClose = vi.fn();
    invoke.mockResolvedValue(undefined);
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("mail_draft_discard", { draftId: "d1" });
  });

  it("an ordinary compose shows no banner and no discard", () => {
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" onClose={() => {}} />);
    expect(screen.queryByText("Drafted by an agent.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("is a row in the review strip that opens the composer, never an Approve", () => {
    const openAgentDraft = vi.fn().mockResolvedValue(undefined);
    const d = draft({ origin: "reader", subject: "Re: Lunch‮" });
    useMailStore.setState({ agentDrafts: [d], openAgentDraft });
    render(<RootReviewStrip />);
    expect(screen.getByText(/Re: Lunch$/)).toBeTruthy();
    expect(screen.getByText("Drafted by an agent that reads mail from outside.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in composer" }));
    expect(openAgentDraft).toHaveBeenCalledWith(d);
  });

  it("the store lists what the backend returns and treats a locked store as empty", async () => {
    invoke.mockResolvedValueOnce([draft()]);
    await useMailStore.getState().loadAgentDrafts();
    expect(useMailStore.getState().agentDrafts.map((d) => d.id)).toEqual(["d1"]);
    invoke.mockRejectedValueOnce("mail is locked");
    await useMailStore.getState().loadAgentDrafts();
    expect(useMailStore.getState().agentDrafts).toEqual([]);
  });
});
