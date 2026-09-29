import type { MailContact, MailContactList } from "../types/mail";
import { stripFormatControls } from "./textSafety";

/**
 * **The pure half of the address book** — names, search, the recipient
 * autocomplete and the token surgery on a recipient field. No store, no
 * `invoke`, no React.
 *
 * The autocomplete only ever inserts **bare addresses** (a list inserts its
 * members'): the composer's fields are parsed into addr-spec lists and the
 * backend refuses anything else at send, so a `Name <addr>` form here would be
 * a suggestion that cannot be sent.
 */

/** A card's name: display name, else first + last. May be empty. */
export function contactName(c: Pick<MailContact, "display_name" | "first_name" | "last_name">): string {
  const name = c.display_name.trim() || `${c.first_name} ${c.last_name}`.trim();
  return stripFormatControls(name);
}

/** What a row shows: the name, else the primary address, else the company. */
export function contactLabel(c: MailContact): string {
  return contactName(c) || c.emails[0] || stripFormatControls(c.organization) || "";
}

export function sortContacts(list: MailContact[]): MailContact[] {
  return [...list].sort((a, b) =>
    contactLabel(a).localeCompare(contactLabel(b), undefined, { sensitivity: "base" }),
  );
}

/** Address Book search: any word of the query in any field a person would
 *  search by (all words must match somewhere). */
export function contactMatches(c: MailContact, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    c.display_name,
    c.first_name,
    c.last_name,
    c.nickname,
    c.organization,
    c.job_title,
    ...c.emails,
    ...c.phones.map((p) => p.number),
  ]
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The card holding `address`, case-insensitively. */
export function findContactByEmail(contacts: MailContact[], address: string): MailContact | undefined {
  const needle = address.trim().toLowerCase();
  if (!needle) return undefined;
  return contacts.find((c) => c.emails.some((e) => e.toLowerCase() === needle));
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

export type RecipientSuggestion =
  | { kind: "contact"; key: string; name: string; address: string; contactId: string }
  | { kind: "list"; key: string; name: string; members: string[]; listId: string };

/** How well `query` fits: 0 nickname exact, 1 name word prefix, 2 address
 *  prefix, 3 substring; `null` for no match. Lower is better. */
function rank(query: string, names: string[], nickname: string, addresses: string[]): number | null {
  if (nickname && nickname.toLowerCase() === query) return 0;
  const words = names.flatMap((n) => n.toLowerCase().split(/[\s.,'"()-]+/)).filter(Boolean);
  if (words.some((w) => w.startsWith(query)) || names.some((n) => n.toLowerCase().startsWith(query)))
    return 1;
  if (nickname.toLowerCase().startsWith(query)) return 1;
  if (addresses.some((a) => a.toLowerCase().startsWith(query))) return 2;
  if (query.length < 2) return null;
  const all = [...names, nickname, ...addresses].join("\n").toLowerCase();
  return all.includes(query) ? 3 : null;
}

/**
 * Suggestions for what is being typed. Every address of a card is its own
 * suggestion (the second address is a real choice); addresses already in the
 * field are left out. Ties go to the more-written-to card — Thunderbird's
 * popularity index — then the more recent, then the name.
 */
export function suggestRecipients(
  rawQuery: string,
  contacts: MailContact[],
  lists: MailContactList[],
  exclude: Iterable<string> = [],
  limit = 8,
): RecipientSuggestion[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const skip = new Set([...exclude].map((a) => a.toLowerCase()));
  const scored: Array<{ s: RecipientSuggestion; r: number; pop: number; used: number; label: string }> = [];

  for (const c of contacts) {
    const name = contactName(c);
    for (const address of c.emails) {
      if (skip.has(address.toLowerCase())) continue;
      const r = rank(query, [name, c.first_name, c.last_name], c.nickname, [address]);
      if (r === null) continue;
      scored.push({
        s: { kind: "contact", key: `c:${c.id}:${address}`, name, address, contactId: c.id },
        r,
        pop: c.popularity,
        used: c.last_used,
        label: name || address,
      });
    }
  }
  for (const l of lists) {
    if (l.members.length === 0) continue;
    const r = rank(query, [l.name], l.nickname, []);
    if (r === null) continue;
    scored.push({
      s: { kind: "list", key: `l:${l.id}`, name: stripFormatControls(l.name), members: l.members, listId: l.id },
      r,
      pop: 0,
      used: 0,
      label: l.name,
    });
  }
  scored.sort(
    (a, b) =>
      a.r - b.r ||
      b.pop - a.pop ||
      b.used - a.used ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return scored.slice(0, limit).map((x) => x.s);
}

// ── Token surgery on a recipient field ───────────────────────────────────────

const SEPARATOR = /[\n,;]/;

export interface RecipientToken {
  /** Where the typed word starts (after its separator and leading spaces). */
  start: number;
  /** Where it ends (the next separator, or the end of the text). */
  end: number;
  text: string;
}

/** The recipient being typed at `caret`. */
export function tokenAt(value: string, caret: number): RecipientToken {
  let start = caret;
  while (start > 0 && !SEPARATOR.test(value[start - 1])) start--;
  while (start < caret && /\s/.test(value[start])) start++;
  let end = caret;
  while (end < value.length && !SEPARATOR.test(value[end])) end++;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Put `addresses` where `token` was, followed by `", "` so typing carries on
 * with the next recipient. A separator that already follows the token is
 * reused rather than doubled. Returns the new text and where the caret goes.
 */
export function replaceToken(
  value: string,
  token: RecipientToken,
  addresses: string[],
): { value: string; caret: number } {
  const before = value.slice(0, token.start);
  let after = value.slice(token.end);
  const inserted = addresses.join(", ");
  if (SEPARATOR.test(after[0] ?? "")) {
    after = after.slice(1).replace(/^[ \t]*/, "");
  }
  const glue = ", ";
  const next = before + inserted + glue + after;
  return { value: next, caret: (before + inserted + glue).length };
}

/** Every address already in a field, lowercased (for `exclude`). */
export function fieldAddresses(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
