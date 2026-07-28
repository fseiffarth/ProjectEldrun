import { create } from "zustand";
import {
  caldavAccountDelete,
  caldavAccountUpsert,
  caldavAccountsList,
  caldavApply,
  caldavFetch,
  parseChanges,
  syncStamp,
} from "../lib/caldav";
import { useCalendarStore } from "./calendar";
import type { CalDavAccount, CalDavAccountSaved, CalDavCollection } from "../types/caldav";

/**
 * CalDAV accounts, and the sync that keeps their calendars current.
 *
 * Deliberately a **second** store next to `stores/calendar`, mirroring the
 * backend's own split: an account carries a login, a per-collection cursor and
 * a keychain credential, none of which is calendar-display state. What a sync
 * *produces* lands in the calendar store, where every existing surface already
 * reads it — this store never renders an event.
 *
 * The two rules a scheduled sync lives or dies by:
 *
 *  1. **A sync is not a replace.** `syncCalendar` hands the parsed rows to
 *     `caldav_apply`, which merges them by `caldav_href` and leaves the to-do
 *     board's column/rank/tags alone. Routing this through
 *     `calendar_replace_events` would evict every CalDAV-sourced card from
 *     wherever the user dragged it, every time the timer fires.
 *  2. **A failure is visible.** `status` keeps the last outcome per collection,
 *     and an account whose password was never saved (or whose keyring is
 *     locked) fails every unattended sync after a relaunch — exactly as mail's
 *     does. A quietly stale calendar is worse than a visible error, because it
 *     looks exactly like a calendar with nothing new in it.
 */

export type CalDavPhase = "idle" | "syncing" | "ok" | "error";

export interface CalDavSyncStatus {
  phase: CalDavPhase;
  /** Verbatim from the backend. Empty unless `phase === "error"`. */
  error: string;
  /** Local stamp of the last *successful* sync. */
  at: string;
  /** The last sync found nothing to do (the ctag had not moved). */
  unchanged: boolean;
}

const IDLE: CalDavSyncStatus = { phase: "idle", error: "", at: "", unchanged: false };

interface CalDavStore {
  accounts: CalDavAccount[];
  loaded: boolean;
  /** Keyed by collection href. */
  status: Record<string, CalDavSyncStatus>;

  /** Load the accounts once. Touches no network. */
  load: () => Promise<void>;
  reload: () => Promise<void>;

  /**
   * Create or update an account (and apply the opt-in keychain write).
   *
   * Returns the backend's whole answer, not just the account: `saved` and
   * `save_error` are **what the keychain actually did**, and a write that
   * silently failed is how a user loses a password they think is saved.
   */
  upsert: (
    account: CalDavAccount,
    password: string | null,
    remember: boolean | null,
  ) => Promise<CalDavAccountSaved>;
  remove: (accountId: string) => Promise<void>;

  /**
   * Turn discovered collections into subscriptions: one local `Calendar` each,
   * plus the account's own record of which collection feeds it.
   */
  subscribe: (accountId: string, collections: CalDavCollection[]) => Promise<void>;
  /** Stop syncing a collection. The local calendar and its events stay. */
  unsubscribe: (accountId: string, href: string) => Promise<void>;

  /** Sync one collection. `force` skips the cheap ctag check. */
  syncCalendar: (accountId: string, href: string, force: boolean) => Promise<CalDavSyncStatus>;
  /** Sync every subscription of every account — the timer's tick. */
  syncAll: (force: boolean) => Promise<void>;

  /** The account (if any) a local calendar id is synced from. */
  accountForCalendar: (calendarId: string) => { account: CalDavAccount; href: string } | null;
}

/** A subscribed calendar's default color when the server offers none. */
const FALLBACK_COLOR = "#8d8fd6";

/** `#rrggbbaa` → `#rrggbb`; anything unrecognizable → the fallback. */
function calendarColor(raw: string): string {
  const value = (raw || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.slice(0, 7);
  return FALLBACK_COLOR;
}

export const useCalDavStore = create<CalDavStore>((set, get) => ({
  accounts: [],
  loaded: false,
  status: {},

  load: async () => {
    if (get().loaded) return;
    await get().reload();
  },

  reload: async () => {
    const answer = await caldavAccountsList().catch(() => []);
    // A rejected invoke is not the only way this can arrive empty-handed: a
    // bridge that resolves with nothing (an older backend, a stubbed one) hands
    // back `null`, and storing that turns every reader's `.filter` into a
    // crash. "No accounts" is the honest reading of an answer that names none.
    set({ accounts: Array.isArray(answer) ? answer : [], loaded: true });
  },

  upsert: async (account, password, remember) => {
    const result = await caldavAccountUpsert(account, password, remember);
    set((s) => {
      const next = s.accounts.some((a) => a.id === result.account.id)
        ? s.accounts.map((a) => (a.id === result.account.id ? result.account : a))
        : [...s.accounts, result.account];
      return { accounts: next };
    });
    return result;
  },

  remove: async (accountId) => {
    await caldavAccountDelete(accountId);
    set((s) => ({ accounts: s.accounts.filter((a) => a.id !== accountId) }));
  },

  subscribe: async (accountId, collections) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    const calendar = useCalendarStore.getState();

    const refs = [...account.calendars];
    for (const collection of collections) {
      if (refs.some((r) => r.href === collection.href)) continue;
      // A subscribed collection is an ordinary calendar in the sidebar — that
      // is what makes every view, the alarms, the ICS export and the to-do
      // board work with it unchanged. `readonly` because the server is
      // authoritative and there is no push path in this phase.
      const created = await calendar.createCalendar({
        name: collection.display_name || account.label || collection.href,
        color: calendarColor(collection.color),
        visible: true,
        readonly: true,
        caldav_account_id: accountId,
        caldav_href: collection.href,
      });
      refs.push({
        href: collection.href,
        calendar_id: created.id,
        display_name: collection.display_name,
        // **No ctag or sync-token is stored here.** They are cursors meaning
        // "you have already seen everything up to this point", and storing one
        // before the first fetch would make that first sync skip the entire
        // calendar it was supposed to import.
        ctag: "",
        sync_token: null,
        components: collection.components,
        read_only: true,
        last_sync: "",
      });
    }
    await get().upsert({ ...account, calendars: refs }, null, null);
  },

  unsubscribe: async (accountId, href) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    await get().upsert(
      { ...account, calendars: account.calendars.filter((c) => c.href !== href) },
      null,
      null,
    );
    set((s) => {
      const status = { ...s.status };
      delete status[href];
      return { status };
    });
  },

  syncCalendar: async (accountId, href, force) => {
    set((s) => ({
      status: { ...s.status, [href]: { ...(s.status[href] ?? IDLE), phase: "syncing", error: "" } },
    }));

    const fail = (error: string): CalDavSyncStatus => {
      const previous = get().status[href] ?? IDLE;
      const next: CalDavSyncStatus = { ...previous, phase: "error", error, unchanged: false };
      set((s) => ({ status: { ...s.status, [href]: next } }));
      return next;
    };

    try {
      const changes = await caldavFetch(accountId, href, force);
      if (changes.unchanged) {
        const at = get().status[href]?.at ?? "";
        const next: CalDavSyncStatus = { phase: "ok", error: "", at, unchanged: true };
        set((s) => ({ status: { ...s.status, [href]: next } }));
        return next;
      }

      const { parsed } = parseChanges(changes);
      const data = await caldavApply({
        accountId,
        href,
        parsed,
        removed: changes.removed,
        incremental: changes.incremental,
        ctag: changes.ctag,
        syncToken: changes.sync_token ?? null,
        lastSync: syncStamp(),
      });
      // The whole store comes back from one atomic write, so the calendar
      // surfaces see the merge as a single consistent state rather than a
      // sequence of per-row patches.
      useCalendarStore.setState({
        calendars: data.calendars,
        events: data.events,
        tasks: data.tasks,
        taskColumns: data.task_columns ?? [],
        loaded: true,
      });
      // The cursors moved on disk; keep the in-memory account in step so the
      // next tick compares against what was actually stored.
      await get().reload();

      const next: CalDavSyncStatus = {
        phase: "ok",
        error: "",
        at: syncStamp(),
        unchanged: false,
      };
      set((s) => ({ status: { ...s.status, [href]: next } }));
      return next;
    } catch (err) {
      return fail(typeof err === "string" ? err : String(err));
    }
  },

  syncAll: async (force) => {
    for (const account of get().accounts) {
      for (const ref of account.calendars) {
        // Serial, not parallel: several collections on one account mean several
        // authenticated requests to one server, and a burst is how a client
        // ends up rate-limited by an institutional gateway.
        await get().syncCalendar(account.id, ref.href, force);
      }
    }
  },

  accountForCalendar: (calendarId) => {
    for (const account of get().accounts) {
      const ref = account.calendars.find((c) => c.calendar_id === calendarId);
      if (ref) return { account, href: ref.href };
    }
    return null;
  },
}));

/** The status of whichever collection feeds a local calendar, for the sidebar. */
export function calendarSyncStatus(
  status: Record<string, CalDavSyncStatus>,
  accounts: CalDavAccount[],
  calendarId: string,
): CalDavSyncStatus | null {
  for (const account of accounts) {
    const ref = account.calendars.find((c) => c.calendar_id === calendarId);
    if (ref) return status[ref.href] ?? IDLE;
  }
  return null;
}
