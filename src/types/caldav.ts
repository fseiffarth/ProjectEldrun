/**
 * CalDAV accounts — the wire contract with `src-tauri/src/schema/caldav.rs`.
 *
 * Same shapes, same names, same optionality. `docs/caldav_plan.md` is the
 * design; the short version of what these types are *for*:
 *
 * An account is the **mail-account shape**, not the `source_url` shape — a
 * user-typed server, a password that is never persisted without an explicit
 * opt-in, a background interval, several accounts. `Calendar.source_url` (an
 * anonymous ICS feed) stays exactly as it was and is still the right tool for
 * a read-only link someone shared with you.
 *
 * The **events and tasks a sync produces are ordinary `CalendarEvent`s and
 * `CalendarTask`s** in `calendar.json`, carrying `caldav_href`/`caldav_etag`.
 * Nothing that renders a calendar knows this feature exists.
 */

import type { CalendarEvent, CalendarTask } from "./index";

/** One subscribed collection on an account. */
export interface CalDavCalendarRef {
  /** The collection's absolute URL — **the** stable key. */
  href: string;
  /** The `Calendar.id` in `calendar.json` this collection syncs into. */
  calendar_id: string;
  display_name: string;
  /** Last-seen `getctag`: the cheap "did anything change at all" check. */
  ctag: string;
  /** Last-seen RFC 6578 token, when the server offers one. */
  sync_token?: string | null;
  /** `VEVENT` / `VTODO`. Empty means the server did not say. */
  components?: string[];
  /** True in this phase, always — there is no push path yet. */
  read_only: boolean;
  /** Local stamp of the last successful sync (`"YYYY-MM-DDTHH:MM"`). */
  last_sync?: string;
}

export interface CalDavAccount {
  id: string;
  label: string;
  /** What discovery resolved, or what the user pasted. Never inferred from
   *  anything — least of all from an email address. */
  base_url: string;
  user: string;
  /** Opt-in, **default false**. */
  save_password: boolean;
  /** Minutes between background syncs; `0`/absent means manual-only. */
  sync_interval_min?: number | null;
  calendars: CalDavCalendarRef[];
}

/** What the keychain actually did — never collapsed to a bare account. */
export interface CalDavAccountSaved {
  account: CalDavAccount;
  saved: boolean;
  save_error?: string | null;
}

export interface CalDavPasswordState {
  has_saved: boolean;
  /** `"unlocked" | "locked" | "unavailable"` — the shared `KeyringState`. */
  keyring: "unlocked" | "locked" | "unavailable";
}

/** One calendar collection discovery found. */
export interface CalDavCollection {
  href: string;
  display_name: string;
  /** `calendar-color` as the server spells it (`#rrggbb` or `#rrggbbaa`). */
  color: string;
  ctag: string;
  sync_token?: string | null;
  components: string[];
  /** The server reported privileges and none was a write privilege. */
  read_only: boolean;
}

/** One resource as the server handed it over — iCalendar text, unparsed. */
export interface CalDavResource {
  href: string;
  etag: string;
  data: string;
}

/** What one fetch found. */
export interface CalDavChanges {
  resources: CalDavResource[];
  /** Hrefs the server reported **gone**. The only signal that deletes a task. */
  removed: string[];
  sync_token?: string | null;
  ctag: string;
  /** A `sync-collection` reply: an absent href means *unchanged*, not deleted. */
  incremental: boolean;
  /** The ctag matched: nothing was fetched, nothing needs applying. */
  unchanged: boolean;
}

/** One resource after `lib/ics.ts` has parsed it — what `caldav_apply` takes. */
export interface CalDavParsed {
  href: string;
  etag: string;
  events: CalendarEvent[];
  tasks: CalendarTask[];
}
