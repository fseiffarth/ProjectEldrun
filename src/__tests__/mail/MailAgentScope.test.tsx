/**
 * The account dialog's agent-access switch is three-state (`docs/mail_mcp_plan.md`
 * §1): Off, marked messages only, the whole account. What has to hold is the
 * mapping onto the two prefs fields the backend reads — `agent_access` as the
 * gate, `agent_scope` as the width — and the direction of the defaults:
 * turning it on lands on the narrower consent, and an account the two-state
 * build switched on (no scope stored) reads as marked-only, never as the whole
 * account.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { MailAccountDialog } from "../../components/mail/MailAccountDialog";
import { translate, type TranslationKey } from "../../lib/i18n";
import type { MailAccount } from "../../types/mail";

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

function savedAccount(): MailAccount | undefined {
  const call = invokeMock.mock.calls.find(([cmd]) => cmd === "mail_account_upsert");
  return (call?.[1] as { account?: MailAccount } | undefined)?.account;
}

function open(acc: MailAccount | null) {
  render(<MailAccountDialog account={acc} onClose={() => {}} onSaved={() => {}} onDelete={() => {}} />);
}

const radio = (key: string) => screen.getByRole("radio", { name: t(key) }) as HTMLInputElement;
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: t("mail.saveAccount") }));

describe("the agent-access switch has three states", () => {
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

  it("is off by default and stores nothing while off", async () => {
    const user = userEvent.setup();
    open(account());
    expect(radio("mail.agentScopeOff").checked).toBe(true);
    await save(user);
    expect(savedAccount()?.ai?.agent_access ?? null).toBeNull();
    expect(savedAccount()?.ai?.agent_scope ?? null).toBeNull();
  });

  it("turning it on lands on marked-only, and 'all' is a second step", async () => {
    const user = userEvent.setup();
    open(account());
    await user.click(radio("mail.agentScopeMarked"));
    await save(user);
    expect(savedAccount()?.ai).toMatchObject({ agent_access: true, agent_scope: "marked" });

    invokeMock.mockClear();
    await user.click(radio("mail.agentScopeAll"));
    await save(user);
    expect(savedAccount()?.ai).toMatchObject({ agent_access: true, agent_scope: "all" });
  });

  it("an account switched on before the scope existed reads as marked-only", () => {
    // The two-state build wrote `agent_access: true` and no scope. Narrowing is
    // the safe reading, and the dialog must show that reading rather than "all".
    open(account({ ai: { agent_access: true } }));
    expect(radio("mail.agentScopeMarked").checked).toBe(true);
    expect(radio("mail.agentScopeAll").checked).toBe(false);
  });

  it("switching off drops both fields and keeps the other AI switches", async () => {
    const user = userEvent.setup();
    open(account({ ai: { summarize: true, agent_access: true, agent_scope: "all" } }));
    expect(radio("mail.agentScopeAll").checked).toBe(true);
    await user.click(radio("mail.agentScopeOff"));
    await save(user);
    expect(savedAccount()?.ai).toEqual({ summarize: true });
  });
});
