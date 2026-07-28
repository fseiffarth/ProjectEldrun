import { describe, expect, it } from "vitest";
import { inboxUnread, unreadTotal } from "../stores/mail";
import type { MailFolder, MailFolderKind } from "../types/mail";

/**
 * The header mail button's badge (`stores/mail`'s `inboxUnread`).
 *
 * The number is *derived* from the local folder index rather than accumulated
 * from `mail:new` events — which is the whole point of it, and what every case
 * here is really checking: given whatever the index holds right now, what does
 * the dot say? Nothing marks an arrival "acknowledged", so there is no clock and
 * no session state in any of this; the same folders always give the same number.
 *
 * Its twin `unreadTotal` (the pane's per-account rail badge) is here too, to pin
 * down the one deliberate difference between them: the rail counts every folder,
 * the header counts inboxes only.
 */

function folder(over: Partial<MailFolder> & { kind: MailFolderKind }): MailFolder {
  return {
    id: "f1",
    account_id: "a1",
    path: "INBOX",
    name: "INBOX",
    unread: 0,
    total: 0,
    ...over,
  };
}

describe("inboxUnread", () => {
  it("is zero when nothing has been loaded", () => {
    expect(inboxUnread({})).toBe(0);
  });

  it("counts unread in the inbox", () => {
    expect(inboxUnread({ a1: [folder({ kind: "inbox", unread: 7 })] })).toBe(7);
  });

  it("sums the inboxes of every account", () => {
    expect(
      inboxUnread({
        a1: [folder({ kind: "inbox", unread: 7 })],
        a2: [folder({ id: "f2", account_id: "a2", kind: "inbox", unread: 3 })],
      }),
    ).toBe(10);
  });

  it("ignores folders that are not the inbox", () => {
    // The load-bearing case: a mailing list a filter already sorted away must
    // not hold the dot lit, because the header number cannot say where the mail
    // is and a permanently-lit badge is one the user learns to ignore.
    const folders = [
      folder({ kind: "inbox", unread: 2 }),
      folder({ id: "f2", kind: "other", name: "lists", unread: 400 }),
      folder({ id: "f3", kind: "junk", name: "Spam", unread: 91 }),
      folder({ id: "f4", kind: "archive", name: "Archive", unread: 12 }),
      folder({ id: "f5", kind: "sent", name: "Sent", unread: 1 }),
    ];
    expect(inboxUnread({ a1: folders })).toBe(2);
    // The rail's badge is the other bargain, and still counts all of them.
    expect(unreadTotal(folders)).toBe(506);
  });

  it("survives an account whose folders are absent or empty", () => {
    // Absent is "never loaded", not "no folders" — and at launch, before
    // `refreshUnread` resolves, that is every account.
    expect(inboxUnread({ a1: [], a2: undefined as unknown as MailFolder[] })).toBe(0);
  });

  it("tolerates a missing unread count rather than reporting NaN", () => {
    // A badge that reads "NaN" is worse than one that reads nothing, and the
    // count crosses a serialization boundary to get here.
    const broken = folder({ kind: "inbox", unread: undefined as unknown as number });
    expect(inboxUnread({ a1: [broken, folder({ id: "f2", kind: "inbox", unread: 4 })] })).toBe(4);
  });
});
