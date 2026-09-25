import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { MailContact, MailContactList, MailContactsView, MailHeader } from "../../types/mail";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  contactLabel,
  contactMatches,
  fieldAddresses,
  findContactByEmail,
  replaceToken,
  suggestRecipients,
  tokenAt,
} from "../../lib/mailContacts";
import { MAIL_CONTACTS_TAB, MAIL_INBOX_TAB, useMailStore } from "../../stores/mail";
import { MailRecipientField } from "../../components/mail/MailRecipientField";
import { MailAddressBook } from "../../components/mail/MailAddressBook";
import { MailMessageView } from "../../components/mail/MailMessageView";

function contact(over: Partial<MailContact>): MailContact {
  return {
    id: "c", book: "personal", display_name: "", first_name: "", last_name: "", nickname: "",
    emails: [], phones: [], organization: "", job_title: "", address: "", website: "",
    birthday: "", notes: "", popularity: 0, last_used: 0, created: 0, updated: 0, ...over,
  };
}

const ann = contact({ id: "ann", display_name: "Ann Archer", first_name: "Ann", last_name: "Archer", emails: ["ann@x.test", "a.archer@work.test"], popularity: 1 });
const andy = contact({ id: "andy", display_name: "Andy Brook", emails: ["andy@x.test"], popularity: 9 });
const bo = contact({ id: "bo", display_name: "Bo", nickname: "an", emails: ["bo@x.test"] });
const collected = contact({ id: "col", book: "collected", emails: ["stranger@y.test"] });
const team: MailContactList = { id: "l1", name: "Analysis team", nickname: "", description: "", members: ["ann@x.test", "bo@x.test"] };

function view(over: Partial<MailContactsView> = {}): MailContactsView {
  return { contacts: [ann, andy, bo, collected], lists: [team], collect_outgoing: true, ...over };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "mail_contacts_get" ? view() : []));
  useMailStore.setState({
    contacts: [],
    contactLists: [],
    contactsLoaded: false,
    contactsError: null,
    collectOutgoing: true,
    mailTabs: [],
    activeMailTab: MAIL_INBOX_TAB,
    accounts: [],
    selectedAccountId: "a1",
  });
});
afterEach(cleanup);

describe("address book logic", () => {
  it("ranks a nickname first, then name prefixes by popularity, then address prefixes", () => {
    const s = suggestRecipients("an", [ann, andy, bo, collected], [team]);
    // Bo's nickname is exactly "an"; Andy outranks Ann on popularity; the list
    // name also starts with "an"; "stranger@" holds it only as a substring,
    // which ranks last.
    expect(s.map((x) => (x.kind === "contact" ? x.address : x.name))).toEqual([
      "bo@x.test",
      "andy@x.test",
      "ann@x.test",
      "a.archer@work.test",
      "Analysis team",
      "stranger@y.test",
    ]);
  });

  it("matches an address prefix and skips what is already in the field", () => {
    expect(suggestRecipients("stran", [collected], []).map((s) => s.key)).toEqual(["c:col:stranger@y.test"]);
    expect(suggestRecipients("ann", [ann], [], ["ANN@x.test"]).map((s) => s.kind === "contact" && s.address)).toEqual([
      "a.archer@work.test",
    ]);
  });

  it("needs two characters before a substring counts, and an empty query suggests nothing", () => {
    expect(suggestRecipients("r", [ann], [])).toEqual([]);
    expect(suggestRecipients("rch", [ann], []).length).toBe(2);
    expect(suggestRecipients("  ", [ann], [])).toEqual([]);
  });

  it("finds the word being typed and replaces it with bare addresses", () => {
    const value = "bo@x.test, an";
    const tok = tokenAt(value, value.length);
    expect(tok).toEqual({ start: 11, end: 13, text: "an" });
    expect(replaceToken(value, tok, ["ann@x.test"])).toEqual({ value: "bo@x.test, ann@x.test, ", caret: 23 });
    // A list inserts every member; a following separator is reused.
    const mid = "an, z@x.test";
    expect(replaceToken(mid, tokenAt(mid, 2), ["a@x.test", "b@x.test"]).value).toBe("a@x.test, b@x.test, z@x.test");
    expect(fieldAddresses("A@x.test\n b@x.test;")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("labels, searches and looks cards up", () => {
    expect(contactLabel(collected)).toBe("stranger@y.test");
    expect(contactLabel(contact({ first_name: "Cy", last_name: "Dee" }))).toBe("Cy Dee");
    expect(contactMatches(ann, "archer work")).toBe(true);
    expect(contactMatches(ann, "archer zzz")).toBe(false);
    expect(findContactByEmail([ann], "A.ARCHER@work.test")?.id).toBe("ann");
  });
});

function Field() {
  const [v, setV] = useState("");
  return <MailRecipientField label="To" value={v} onChange={setV} />;
}

describe("recipient autocomplete", () => {
  it("suggests from the book and inserts the picked address with Enter", async () => {
    render(<Field />);
    await waitFor(() => expect(useMailStore.getState().contactsLoaded).toBe(true));
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "andy", selectionStart: 4 } });
    expect(screen.getByRole("option", { name: /Andy Brook/ })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("andy@x.test, ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("expands a list to its members, and Escape closes only the list", async () => {
    render(<Field />);
    await waitFor(() => expect(useMailStore.getState().contactsLoaded).toBe(true));
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "analy", selectionStart: 5 } });
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(box, { key: "Escape" });
    window.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "analys", selectionStart: 6 } });
    fireEvent.click(screen.getByRole("option", { name: /Analysis team/ }));
    expect(box.value).toBe("ann@x.test, bo@x.test, ");
  });
});

describe("the Address Book tab", () => {
  it("opens once, and a sender request reuses the open tab", () => {
    const s = useMailStore.getState();
    s.openContactsTab();
    s.openContactsTab({ address: "new@z.test", name: "New" });
    const { mailTabs, activeMailTab } = useMailStore.getState();
    expect(mailTabs).toHaveLength(1);
    expect(activeMailTab).toBe(MAIL_CONTACTS_TAB);
    const tab = mailTabs[0];
    expect(tab.kind === "contacts" && tab.request?.address).toBe("new@z.test");
  });

  it("starts a new card for an unknown sender and saves it through the backend", async () => {
    useMailStore.getState().openContactsTab({ address: "new@z.test", name: "Nina New" });
    const tab = useMailStore.getState().mailTabs[0];
    if (tab.kind !== "contacts") throw new Error("expected the contacts tab");
    invoke.mockImplementation((cmd: string, args?: { contact: MailContact }) => {
      if (cmd === "mail_contact_upsert") return Promise.resolve({ ...args!.contact, id: "n1" });
      if (cmd === "mail_contacts_get") return Promise.resolve(view());
      return Promise.resolve([]);
    });
    render(<MailAddressBook tab={tab} />);
    const name = (await screen.findByDisplayValue("Nina New")) as HTMLInputElement;
    expect(name).toBeTruthy();
    expect(screen.getByDisplayValue("new@z.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "mail_contact_upsert",
        expect.objectContaining({
          contact: expect.objectContaining({ display_name: "Nina New", emails: ["new@z.test"], book: "personal" }),
        }),
      ),
    );
  });

  it("selects the existing card for a known sender, with Write per address", async () => {
    useMailStore.setState({ accounts: [{ id: "a1", label: "Me", address: "me@x.test" } as never] });
    useMailStore.getState().openContactsTab({ address: "ANN@x.test" });
    const tab = useMailStore.getState().mailTabs[0];
    if (tab.kind !== "contacts") throw new Error("expected the contacts tab");
    render(<MailAddressBook tab={tab} />);
    expect(await screen.findByRole("heading", { name: "Ann Archer" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Write" })[1]);
    const compose = useMailStore.getState().mailTabs.find((t) => t.kind === "compose");
    expect(compose && compose.kind === "compose" && compose.toAddress).toBe("a.archer@work.test");
  });
});

describe("the sender star", () => {
  const header = (address: string) =>
    ({
      id: "m1", account_id: "a1", folder_id: "f", uid: 1, subject: "Hi", date: 0,
      from: { name: "Zed", address }, to: [], cc: [], seen: true, flagged: false,
      has_attachments: false, size: 1, preview: "",
    }) as unknown as MailHeader;

  it("is hollow for a stranger and opens a new card in the Address Book", async () => {
    render(<MailMessageView header={header("zed@q.test")} body={null} loading={false} onReply={() => {}} onComposeTo={() => {}} />);
    const star = await screen.findByRole("button", { name: "Add to address book" });
    expect(star.textContent).toBe("☆");
    fireEvent.click(star);
    const tab = useMailStore.getState().mailTabs[0];
    expect(tab.kind === "contacts" && tab.request).toMatchObject({ address: "zed@q.test", name: "Zed" });
  });

  it("is filled for a sender the book holds", async () => {
    render(<MailMessageView header={header("bo@x.test")} body={null} loading={false} onReply={() => {}} onComposeTo={() => {}} />);
    const star = await screen.findByRole("button", { name: "In your address book — open the card" });
    expect(star.textContent).toBe("★");
  });
});
