import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailHeader } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MailMessageView } from "../../components/mail/MailMessageView";
import { useMailStore } from "../../stores/mail";

function header(overrides: Partial<MailHeader> = {}): MailHeader {
  return {
    id: "inbox-1", account_id: "a1", folder_id: "inbox", uid: 1, subject: "Question",
    from: { address: "bob@friends.example" }, to: [{ address: "me@home.example" }], cc: [],
    date: "2026-09-01T09:00:00Z", seen: true, flagged: false, answered: true,
    has_attachments: false, size: 10, preview: "Can you come?", ...overrides,
  } as MailHeader;
}
const reply = header({
  id: "sent-7", folder_id: "sent", uid: 7, subject: "Re: Question",
  from: { address: "me@home.example" }, to: [{ address: "bob@friends.example" }],
  date: "2026-09-02T09:00:00Z", preview: "Yes, I will be there.",
});

function view(h: MailHeader) {
  return <MailMessageView header={h} body={null} loading={false} onReply={() => {}} onComposeTo={() => {}} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  useMailStore.setState({ sync: {} });
});
afterEach(cleanup);

describe("replies already written to the open message", () => {
  it("lists them and unfolds a reply's plain text in place", async () => {
    invoke.mockImplementation((cmd: string, args: { messageId: string }) => {
      if (cmd === "mail_replies") return Promise.resolve(args.messageId === "inbox-1" ? [reply] : []);
      if (cmd === "mail_body")
        return Promise.resolve({ id: args.messageId, text: "Yes, I will be there.\nSee you.", remote_refs: 0, links: [], attachments: [] });
      return Promise.resolve([]);
    });
    render(view(header()));
    await screen.findByText("You replied (1)");
    expect(screen.getByText("Yes, I will be there.")).toBeTruthy();
    expect(screen.getByText(/to bob@friends\.example/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_body", { messageId: "sent-7", allowRemote: false }));
    await screen.findByText(/See you\./);
  });

  it("shows nothing for a message nobody answered, and asks again after a check", async () => {
    let found: MailHeader[] = [];
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "mail_replies" ? found : []));
    render(view(header({ answered: false })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mail_replies", { messageId: "inbox-1" }));
    expect(screen.queryByText(/You replied/)).toBeNull();

    found = [reply];
    act(() => useMailStore.setState({ sync: { a1: { phase: "done" } } }));
    await screen.findByText("You replied (1)");
  });
});
