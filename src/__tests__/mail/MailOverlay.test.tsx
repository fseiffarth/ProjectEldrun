// The mail window (`mail/MailOverlay`): a composer tab's text outlives closing
// the window, its × asks only when there is something to lose, and opening a
// composer is not an edit — not even under StrictMode's double mount.
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailAccount, MailHeader } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../lib/experimental", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/experimental")>()),
  useExperimental: () => true,
}));
// The Inbox pane is its own subject (and a heavy one); only the tabs are under test.
vi.mock("../../components/mail/MailPane", () => ({
  MailPane: ({ visible }: { visible?: boolean }) => (
    <div data-testid="mail-pane" data-visible={String(visible)} />
  ),
}));
vi.mock("../../components/layout/OverlayApprovals", () => ({ OverlayApprovals: () => null }));

import { MailOverlayHost } from "../../components/mail/MailOverlay";
import { MAIL_INBOX_TAB, useMailStore } from "../../stores/mail";

const account = { id: "a1", label: "Me", address: "me@home.example" } as MailAccount;
const source = {
  id: "m1",
  account_id: "a1",
  subject: "Lunch",
  date: 0,
  from: { name: "Bob", address: "bob@friends.example" },
  to: [],
  cc: [],
} as unknown as MailHeader;

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  useMailStore.setState({
    accounts: [account],
    selectedAccountId: "a1",
    mailTabs: [],
    activeMailTab: MAIL_INBOX_TAB,
    overlayOpen: false,
    accountDialog: null,
  });
});
afterEach(cleanup);

const body = () => document.querySelector<HTMLTextAreaElement>(".mail-compose-body")!;
const closeX = () => screen.getByRole("button", { name: "Close tab" });

function openComposer(mode: "new" | "reply" = "new") {
  act(() => {
    useMailStore.getState().openOverlay();
    useMailStore
      .getState()
      .openComposeTab(mode === "new" ? { mode, accountId: "a1" } : { mode, accountId: "a1", source: { header: source, body: null } });
  });
}

describe("the mail window", () => {
  it("keeps a composer's text across closing and reopening the window", () => {
    render(<MailOverlayHost />);
    openComposer();
    fireEvent.change(body(), { target: { value: "Half a thought" } });
    act(() => useMailStore.getState().closeOverlay());
    // Hidden, not unmounted.
    expect(body()).toBeTruthy();
    act(() => useMailStore.getState().openOverlay());
    expect(body().value).toBe("Half a thought");
    expect(useMailStore.getState().mailTabs).toHaveLength(1);
  });

  it("asks before × throws away an edited composer, and not for a clean one", async () => {
    render(<MailOverlayHost />);
    openComposer();
    fireEvent.click(closeX());
    await waitFor(() => expect(useMailStore.getState().mailTabs).toHaveLength(0));
    expect(screen.queryByText("Close this unsent mail?")).toBeNull();

    openComposer();
    fireEvent.change(body(), { target: { value: "Something" } });
    fireEvent.click(closeX());
    await screen.findByText("Close this unsent mail?");
    expect(useMailStore.getState().mailTabs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close without sending" }));
    await waitFor(() => expect(useMailStore.getState().mailTabs).toHaveLength(0));
  });

  it("routes the composer's Cancel through the same question", async () => {
    render(<MailOverlayHost />);
    openComposer();
    fireEvent.change(body(), { target: { value: "Something" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Close this unsent mail?");
    expect(useMailStore.getState().mailTabs).toHaveLength(1);
  });

  it("does not count opening a new mail or a reply as an edit under StrictMode", () => {
    render(
      <StrictMode>
        <MailOverlayHost />
      </StrictMode>,
    );
    openComposer("new");
    openComposer("reply");
    const tabs = useMailStore.getState().mailTabs;
    expect(tabs).toHaveLength(2);
    expect(tabs.every((tab) => tab.kind === "compose" && !tab.dirty)).toBe(true);
    // The reply's tab is labelled with the subject its composer opened with.
    expect(screen.getByRole("tab", { name: /Re: Lunch/ })).toBeTruthy();
  });

  it("is clean again after Save draft, and dirty on the next edit", async () => {
    invoke.mockImplementation((cmd: string, args: { draft: object }) =>
      Promise.resolve(cmd === "mail_draft_save" ? { ...args.draft, id: "d1", staged: [] } : []),
    );
    render(<MailOverlayHost />);
    openComposer();
    fireEvent.change(body(), { target: { value: "Keep this" } });
    const dirty = () => {
      const tab = useMailStore.getState().mailTabs[0];
      return tab.kind === "compose" && tab.dirty;
    };
    expect(dirty()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(dirty()).toBe(false));
    fireEvent.change(body(), { target: { value: "Keep this, and more" } });
    expect(dirty()).toBe(true);
  });

  it("hides on Escape and keeps its tabs", () => {
    render(<MailOverlayHost />);
    openComposer();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useMailStore.getState().overlayOpen).toBe(false);
    expect(useMailStore.getState().mailTabs).toHaveLength(1);
    expect(body()).toBeTruthy();
  });

  it("tells the Inbox pane it is visible whenever the window is, on any tab", () => {
    render(<MailOverlayHost />);
    openComposer();
    expect(screen.getByTestId("mail-pane").dataset.visible).toBe("true");
  });

  it("names the account right of the ✉, as a dropdown", () => {
    act(() => useMailStore.getState().openOverlay());
    render(<MailOverlayHost />);
    const mark = document.querySelector(".mail-overlay-mark")!;
    const trigger = mark.querySelector<HTMLButtonElement>(".mail-account-trigger")!;
    expect(mark.querySelector(".mail-overlay-glyph")?.nextElementSibling).toBe(trigger);
    expect(trigger.textContent).toContain("Me");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists every account with a ✎ each, and Add account last", () => {
    const work = { id: "a2", label: "Work", address: "me@work.example" } as MailAccount;
    act(() => {
      useMailStore.setState({ accounts: [account, work] });
      useMailStore.getState().openOverlay();
    });
    render(<MailOverlayHost />);
    fireEvent.click(document.querySelector(".mail-account-trigger")!);
    const menu = document.querySelector(".mail-account-menu")!;
    const rows = [...menu.querySelectorAll(".mail-account-menu-row")];
    expect(rows.map((r) => r.querySelector(".mail-menu-name")?.textContent)).toEqual(["Me", "Work"]);
    const items = [...menu.querySelectorAll("button.tab-new-menu-item")];
    expect(items[items.length - 1]?.textContent).toBe("Add account");

    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    expect(useMailStore.getState().accountDialog).toEqual({ account: work });
    expect(document.querySelector(".mail-account-menu")).toBeNull();

    fireEvent.click(document.querySelector(".mail-account-trigger")!);
    fireEvent.click(screen.getByText("Add account"));
    expect(useMailStore.getState().accountDialog).toEqual({ account: null });
  });

  it("a row opens that account's inbox", () => {
    const work = { id: "a2", label: "Work", address: "me@work.example" } as MailAccount;
    act(() => {
      useMailStore.setState({ accounts: [account, work] });
      useMailStore.getState().openOverlay();
    });
    render(<MailOverlayHost />);
    fireEvent.click(document.querySelector(".mail-account-trigger")!);
    fireEvent.click(screen.getByTitle("Open me@work.example"));
    expect(useMailStore.getState().selectedAccountId).toBe("a2");
    expect(useMailStore.getState().activeMailTab).toBe(MAIL_INBOX_TAB);
  });
});
