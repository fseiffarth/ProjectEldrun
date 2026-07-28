/**
 * **The** typed invoke surface for CalDAV — one wrapper per `caldav_*` command,
 * and nothing else in the frontend calls `invoke("caldav_*")` directly (the
 * convention `lib/mail.ts` and `lib/slurm.ts` follow).
 *
 * It also owns the one piece of real work this side of the boundary does:
 * [`parseChanges`] runs each fetched resource's iCalendar text through
 * `lib/ics.ts`. That is deliberate and is the whole reason a sync is two
 * commands rather than one — `ics.ts` is the only parser in this codebase that
 * understands folding, escaping, `RRULE` and `VALARM`, and it is the one with
 * tests for all four. A second parser in Rust would be two implementations that
 * can disagree about the same feed.
 *
 * No wrapper takes a filesystem path, because no command does.
 */

import { invoke } from "@tauri-apps/api/core";
import { parseIcs } from "./ics";
import { toStamp } from "./calendarTime";
import type { CalendarData, CalendarEvent, CalendarTask } from "../types";
import type {
  CalDavAccount,
  CalDavAccountSaved,
  CalDavChanges,
  CalDavCollection,
  CalDavParsed,
  CalDavPasswordState,
} from "../types/caldav";

/**
 * Minutes between background syncs when an account has never been given one.
 *
 * A quarter of an hour rather than mail's five minutes: an appointment moved on
 * a server is not time-critical the way a delivery is, and a scheduled sync is
 * a request against a work server that may be someone's institutional
 * groupware. An explicit `0` still means *never — only when I ask*, because a
 * stored 0 is a choice and only an absent value is unset.
 */
export const DEFAULT_CALDAV_SYNC_MIN = 15;

// ── Accounts + credentials ──────────────────────────────────────────────────

/** Every configured account. Never touches the network. */
export function caldavAccountsList(): Promise<CalDavAccount[]> {
  return invoke<CalDavAccount[]>("caldav_accounts_list");
}

/**
 * Create or update an account, applying the opt-in keychain write.
 *
 * `remember` is `true | null` and **never `false`** — `false` means *clear the
 * credential*, and a checkbox seeded by an async keyring read could otherwise
 * delete the password it just authenticated with (`rememberArg`). Clearing is
 * only ever [`caldavForgetPassword`].
 */
export function caldavAccountUpsert(
  account: CalDavAccount,
  password: string | null,
  remember: boolean | null,
): Promise<CalDavAccountSaved> {
  return invoke<CalDavAccountSaved>("caldav_account_upsert", { account, password, remember });
}

/** Remove the account. The keychain entry and the synced calendars stay. */
export function caldavAccountDelete(accountId: string): Promise<void> {
  return invoke<void>("caldav_account_delete", { accountId });
}

export function caldavPasswordState(accountId: string): Promise<CalDavPasswordState> {
  return invoke<CalDavPasswordState>("caldav_password_state", { accountId });
}

/** The only path that deletes a saved CalDAV password. */
export function caldavForgetPassword(accountId: string): Promise<void> {
  return invoke<void>("caldav_forget_password", { accountId });
}

/**
 * Run discovery once and list the collections found. The password passed here
 * is **not persisted by this call** — it is the "Test connection" analogue.
 */
export function caldavDiscover(
  baseUrl: string,
  user: string,
  password: string | null,
  accountId: string | null,
): Promise<CalDavCollection[]> {
  return invoke<CalDavCollection[]>("caldav_discover", { baseUrl, user, password, accountId });
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Fetch one collection. `force` skips the ctag check — a user who clicks *Sync
 * now* after fixing something on the server should not be told "nothing
 * changed" by a token.
 */
export function caldavFetch(
  accountId: string,
  href: string,
  force: boolean,
): Promise<CalDavChanges> {
  return invoke<CalDavChanges>("caldav_fetch", { accountId, href, force });
}

/** Reconcile a parsed collection into `calendar.json`, in one atomic write. */
export function caldavApply(args: {
  accountId: string;
  href: string;
  parsed: CalDavParsed[];
  removed: string[];
  incremental: boolean;
  ctag: string;
  syncToken: string | null;
  lastSync: string;
}): Promise<CalendarData> {
  return invoke<CalendarData>("caldav_apply", args);
}

/**
 * Parse every fetched resource, keeping each one's identity with its rows.
 *
 * Grouping is by **resource**, not by component, because one resource can hold
 * a recurring event's master *and* its `RECURRENCE-ID` overrides — there is no
 * separate occurrence object in CalDAV — and the backend matches rows within an
 * href group. Flattening here would throw that structure away.
 *
 * A resource whose text parses to nothing is still reported (as an empty
 * group), so the backend can see the resource exists rather than treating it as
 * absent-and-therefore-deleted.
 */
export function parseChanges(changes: CalDavChanges): { parsed: CalDavParsed[]; skipped: number } {
  let skipped = 0;
  const parsed: CalDavParsed[] = changes.resources.map((res) => {
    const text = res.data ?? "";
    if (!text.trim()) {
      // An empty body after the multiget pass is a resource the server would
      // not hand over. Counted, never guessed at.
      skipped += 1;
      return { href: res.href, etag: res.etag, events: [], tasks: [] };
    }
    const out = parseIcs(text);
    skipped += out.skipped;
    return {
      href: res.href,
      etag: res.etag,
      // The backend mints ids and fills `calendar_id`; these are the parser's
      // id-less rows cast to the wire shape, exactly as `calendar_replace_events`
      // already sends them.
      events: out.events as CalendarEvent[],
      tasks: out.tasks as CalendarTask[],
    };
  });
  return { parsed, skipped };
}

/** The local wall-clock stamp a sync records — this crate's one clock. */
export function syncStamp(now: Date = new Date()): string {
  return toStamp(now);
}
