/**
 * Saving an account must re-read the headers it already has.
 *
 * Found in live QA: setting (and clearing) the trusted `authserv-id` appeared to
 * do nothing. The trust state is attached by the **backend**, per read
 * (`commands::mail::serve_auth_state`), so headers fetched before the edit keep
 * the verdicts they were served with. `reloadAccounts` refetched the account
 * list but — when the same account stayed selected — nothing else, so the list
 * in the store kept the old state until the user happened to switch folders.
 *
 * That is at precisely the moment the user is trying to see whether their change
 * took effect, which makes a correct feature look broken.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useMailStore } from "../stores/mail";
import type { MailAccount, MailHeader } from "../types/mail";

const invokeMock = vi.mocked(invoke);

const account = (id: string, authserv?: string): MailAccount =>
  ({
    id,
    label: id,
    address: "me@example.com",
    imap: { host: "imap.example.com", port: 993, user: "me@example.com", security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, user: "me@example.com", security: "tls" },
    auth: "password",
    save_password: false,
    ...(authserv ? { authserv_id: authserv } : {}),
  }) as MailAccount;

/** A header carrying whatever trust state the backend decided this time. */
const header = (state: "verified" | "unconfigured"): MailHeader =>
  ({
    id: "m1",
    account_id: "acc1",
    folder_id: "f1",
    uid: 1,
    subject: "s",
    from: { address: "sender@bank.example" },
    to: [],
    cc: [],
    date: "",
    seen: false,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 0,
    preview: "",
    auth: {
      state,
      authserv_id: "mx.google.com",
      methods:
        state === "verified"
          ? [{ method: "dmarc", result: "pass", identifier: "bank.example", aligned: true }]
          : [],
      header_count: 1,
    },
  }) as MailHeader;

describe("an account edit re-reads the headers already on screen", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useMailStore.setState({
      accounts: [account("acc1")],
      accountsLoaded: true,
      selectedAccountId: "acc1",
      selectedFolderId: "f1",
      selectedMessageId: "m1",
      headers: [header("unconfigured")],
      headerTotal: 1,
      headerOffset: 0,
      query: "",
    });
  });

  it("refetches the current page when the same account stays selected", async () => {
    // The backend now reports the message as verified, because the account
    // gained a trusted authserv-id.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mail_accounts_list") {
        return Promise.resolve([account("acc1", "mx.google.com")]);
      }
      if (cmd === "mail_headers") {
        return Promise.resolve({ items: [header("verified")], total: 1 });
      }
      return Promise.resolve(null);
    });

    await useMailStore.getState().reloadAccounts("acc1");

    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "mail_headers"),
      "saving an account must re-read the headers",
    ).toBe(true);
    expect(useMailStore.getState().headers[0].auth?.state).toBe("verified");
  });

  it("keeps the user's place in a paged folder rather than jumping to the top", async () => {
    useMailStore.setState({ headerOffset: 100 });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mail_accounts_list") return Promise.resolve([account("acc1", "mx.google.com")]);
      if (cmd === "mail_headers") return Promise.resolve({ items: [header("verified")], total: 200 });
      return Promise.resolve(null);
    });

    await useMailStore.getState().reloadAccounts("acc1");

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "mail_headers");
    expect(call?.[1]).toMatchObject({ offset: 100 });
  });

  it("still does not refetch headers when there is no account left", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "mail_accounts_list" ? Promise.resolve([]) : Promise.resolve(null),
    );

    await useMailStore.getState().reloadAccounts();

    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "mail_headers")).toBe(false);
    expect(useMailStore.getState().headers).toEqual([]);
  });
});
