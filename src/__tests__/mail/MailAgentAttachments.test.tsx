// Files a root agent attached by project and path, and recipients it only
// suggested (docs/mail_mcp_attachments_plan.md): the composer is the gate the
// user holds, so what it shows must be what Send is bound to.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailAccount, MailDraft, StagedAttachment } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailComposeDialog } from "../../components/mail/MailComposeDialog";
import { MailAgentDraftList } from "../../components/mail/MailAgentDraftList";

const account = { id: "a1", label: "Me", address: "me@home.example" } as MailAccount;
const agentFile: StagedAttachment = {
  staged_id: "s1",
  filename: "paper.pdf",
  mime: "application/pdf",
  size: 2048,
  origin: "agent",
  source: "Thesis/out/paper.pdf",
};
const userFile: StagedAttachment = { staged_id: "u1", filename: "notes.txt", mime: "text/plain", size: 10 };

function draft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    id: "d1", account_id: "a1", to: [], cc: [], bcc: [], subject: "Paper", body_text: "Attached.",
    staged: [agentFile], origin: "agent", ...overrides,
  };
}

/** The backend: a save answers with `staged` (the store's set). */
function backend(savedStaged: StagedAttachment[]) {
  invoke.mockImplementation((cmd: string, args: { draft?: MailDraft }) => {
    if (cmd === "mail_draft_save") return Promise.resolve({ ...args.draft, staged: savedStaged });
    if (cmd === "mail_draft_send") return Promise.resolve({ sent_id: "d1" });
    if (cmd === "mail_staged_preview") return Promise.resolve({ mime: "text/plain", bytes_b64: btoa("hello"), truncated: false });
    return Promise.resolve(false);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(false);
});
afterEach(cleanup);

describe("an agent's attachments in the composer", () => {
  it("renders agent chips from the draft with their source, beside the user's own", () => {
    render(
      <MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft({ staged: [agentFile, userFile] })} onClose={() => {}} />,
    );
    const chip = screen.getByText("Thesis/out/paper.pdf").closest(".mail-staged-chip")!;
    expect(chip.className).toContain("agent");
    expect(chip.textContent).toContain("from agent");
    const mine = screen.getByText("notes.txt").closest(".mail-staged-chip")!;
    expect(mine.className).not.toContain("agent");
    expect(mine.textContent).not.toContain("from agent");
  });

  it("previews the staged copy through the backend", async () => {
    backend([agentFile]);
    render(<MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_staged_preview", { draftId: "d1", stagedId: "s1" }));
    expect(await screen.findByText("hello")).toBeTruthy();
  });

  it("aborts Send when the saved set differs from the one shown", async () => {
    const onClose = vi.fn();
    const sneaked: StagedAttachment = { ...agentFile, staged_id: "s2", source: "Thesis/secret.pdf" };
    backend([agentFile, sneaked]);
    render(
      <MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft({ to: ["bob@example.com"] })} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText("The attachments changed while the draft was saved. They are shown again now: check them, then press Send again."),
    ).toBeTruthy();
    expect(invoke.mock.calls.some((c) => c[0] === "mail_draft_send")).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    // The set the store holds is now what is on screen.
    expect(screen.getByText("Thesis/secret.pdf")).toBeTruthy();
  });

  it("sends with the ids it showed when nothing changed", async () => {
    const onClose = vi.fn();
    backend([agentFile]);
    render(
      <MailComposeDialog accounts={[account]} accountId="a1" mode="new" draft={draft({ to: ["bob@example.com"] })} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const send = invoke.mock.calls.find((c) => c[0] === "mail_draft_send")!;
    expect(send[1]).toMatchObject({ draftId: "d1", stagedIds: ["s1"] });
  });
});

describe("a recipient an agent suggested", () => {
  it("is a pill, never in To until the user adds it", () => {
    render(
      <MailComposeDialog
        accounts={[account]}
        accountId="a1"
        mode="new"
        draft={draft({ suggested_to: ["bob@example.com"] })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Agent suggests: bob@example.com")).toBeTruthy();
    expect(screen.queryByDisplayValue("bob@example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByDisplayValue("bob@example.com")).toBeTruthy();
    // Added, so no longer offered.
    expect(screen.queryByText("Agent suggests: bob@example.com")).toBeNull();
  });
});

describe("the agent-draft row", () => {
  it("carries the attachment and suggestion counts", () => {
    render(
      <MailAgentDraftList
        drafts={[draft({ staged: [agentFile, { ...agentFile, staged_id: "s2" }], suggested_to: ["bob@example.com"] })]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("2 attached · suggests 1 recipients")).toBeTruthy();
    cleanup();
    render(<MailAgentDraftList drafts={[draft({ staged: [] })]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/attached/)).toBeNull();
  });
});
