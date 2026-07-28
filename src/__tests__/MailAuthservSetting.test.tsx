/**
 * The trusted `authserv-id` setting must actually reach the backend.
 *
 * This is the field the whole `Authentication-Results` feature is gated on: while
 * it is unset the UI shows **no** SPF/DKIM/DMARC verdict at all, by design. So a
 * field that silently fails to persist does not look like a broken setting — it
 * looks like a broken *feature*, and the "not shown, no trusted server name"
 * message is indistinguishable from the correct default state.
 *
 * Live QA hit exactly that confusion, and it had no coverage: the parser, the
 * trust rule and the display rules were all tested, while "does the value get
 * from the input box to `mail_account_upsert`" was not.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { MailAccountDialog } from "../components/mail/MailAccountDialog";
import { translate, type TranslationKey } from "../lib/i18n";
import type { MailAccount } from "../types/mail";

const invokeMock = vi.mocked(invoke);
const t = (key: string) => translate("en", key as TranslationKey);

const account = (over: Partial<MailAccount> = {}): MailAccount =>
  ({
    id: "acc1",
    label: "Personal",
    address: "me@example.com",
    imap: { host: "imap.example.com", port: 993, user: "me@example.com", security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, user: "me@example.com", security: "tls" },
    auth: "password",
    save_password: false,
    ...over,
  }) as MailAccount;

/** The account object the dialog handed to `mail_account_upsert`. */
function savedAccount(): MailAccount | undefined {
  const call = invokeMock.mock.calls.find(([cmd]) => cmd === "mail_account_upsert");
  return (call?.[1] as { account?: MailAccount } | undefined)?.account;
}

function open(acc: MailAccount | null) {
  render(
    <MailAccountDialog
      account={acc}
      onClose={() => {}}
      onSaved={() => {}}
      onDelete={() => {}}
    />,
  );
}

describe("the trusted authserv-id reaches the backend", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mail_password_state") {
        return Promise.resolve({ has_saved: false, keyring: "available" });
      }
      if (cmd === "mail_account_upsert") {
        return Promise.resolve({ account: account(), saved: false });
      }
      return Promise.resolve(null);
    });
  });

  it("sends what was typed", async () => {
    const user = userEvent.setup();
    open(account());

    await user.type(
      screen.getByPlaceholderText(t("mail.authservIdPlaceholder")),
      "mx.google.com",
    );
    await user.click(screen.getByRole("button", { name: t("mail.saveAccount") }));

    expect(savedAccount()?.authserv_id).toBe("mx.google.com");
  });

  it("sends a *different* value on a later edit, rather than the first one", async () => {
    // The live-QA sequence: configure it, then change it to something else to
    // check the forged-header warning. The second save is the one that failed.
    const user = userEvent.setup();
    open(account({ authserv_id: "mx.google.com" }));

    const field = screen.getByPlaceholderText(
      t("mail.authservIdPlaceholder"),
    ) as HTMLInputElement;
    expect(field.value).toBe("mx.google.com");
    await user.clear(field);
    await user.type(field, "mx.not-my-provider.example");
    await user.click(screen.getByRole("button", { name: t("mail.saveAccount") }));

    expect(savedAccount()?.authserv_id).toBe("mx.not-my-provider.example");
  });

  it("clears the setting rather than sending an empty string", async () => {
    // An empty string is *configured but unmatched*, which would warn about
    // every message. Clearing must mean unset.
    const user = userEvent.setup();
    open(account({ authserv_id: "mx.google.com" }));

    await user.clear(screen.getByPlaceholderText(t("mail.authservIdPlaceholder")));
    await user.click(screen.getByRole("button", { name: t("mail.saveAccount") }));

    expect(savedAccount()?.authserv_id ?? null).toBeNull();
  });

  it("leaves an untouched field alone on an unrelated edit", async () => {
    const user = userEvent.setup();
    open(account({ authserv_id: "mx.google.com" }));

    await user.type(screen.getByDisplayValue("Personal"), " (work)");
    await user.click(screen.getByRole("button", { name: t("mail.saveAccount") }));

    expect(savedAccount()?.authserv_id).toBe("mx.google.com");
    expect(savedAccount()?.label).toBe("Personal (work)");
  });
});
