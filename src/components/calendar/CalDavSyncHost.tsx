import { useEffect, useRef } from "react";
import { useCalDavStore } from "../../stores/caldav";
import { DEFAULT_CALDAV_SYNC_MIN } from "../../lib/caldav";

/** How often the scheduler wakes up. Each account is still synced on its own
 *  interval; this is only the granularity at which "is it due yet" is asked. */
const TICK_MS = 60_000;

/**
 * The scheduled half of CalDAV sync — `MailIndicator`'s check-interval timer,
 * for calendars (`docs/caldav_plan.md` Phase 2).
 *
 * It renders nothing. It is mounted at the shell rather than inside the
 * calendar pane for the reason the alarm ticker is: a calendar that only
 * refreshed while its overlay happened to be open would be stale exactly when
 * it is looked at, and the surfaces that read a synced calendar (the header
 * badge, the to-do board's agenda rail, the alarms) are not the calendar pane.
 *
 * Three rules, all of them mail's:
 *
 *  1. **It costs nothing when no CalDAV account exists.** The accounts read is
 *     one local file; with none configured, the timer never starts and nothing
 *     here touches the network.
 *  2. **The first tick is a whole interval away.** Checking at mount is
 *     checking at launch, and a restored window must not open a socket by
 *     existing. `lastRun` is seeded with the mount time for exactly that.
 *  3. **An explicit `0` means never.** A stored zero is a choice; only an
 *     absent value is unset, and an unset one gets `DEFAULT_CALDAV_SYNC_MIN`.
 *
 * The ctag check on the backend is what keeps a short interval cheap: a tick
 * against an unchanged collection is one small `PROPFIND`, not a re-download of
 * the calendar.
 */
export function CalDavSyncHost() {
  const accounts = useCalDavStore((s) => s.accounts);
  /** Per account, when it last *attempted* a sync — not when one succeeded.
   *  A failing server must not be retried every tick. */
  const lastRun = useRef<Record<string, number>>({});
  const inFlight = useRef(false);

  // A purely local read: it is what tells the timer whether there is anything
  // to schedule at all.
  useEffect(() => {
    void useCalDavStore.getState().load();
  }, []);

  const scheduled = accounts.filter(
    (a) => a.calendars.length > 0 && (a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN) > 0,
  );
  // A stable key, so adding an unrelated account (or a sync writing a ctag back)
  // does not restart the timer and push every account's next check out.
  const key = scheduled
    .map((a) => `${a.id}:${a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN}:${a.calendars.length}`)
    .join("|");

  useEffect(() => {
    if (!key) return;
    const now = Date.now();
    for (const account of scheduled) {
      if (lastRun.current[account.id] === undefined) lastRun.current[account.id] = now;
    }

    const tick = () => {
      // Serialized across accounts: a slow server plus a short interval could
      // otherwise stack requests, and a burst of authenticated requests is how
      // a client gets rate-limited by an institutional gateway.
      if (inFlight.current) return;
      const at = Date.now();
      const due = useCalDavStore
        .getState()
        .accounts.filter((a) => a.calendars.length > 0)
        .filter((a) => {
          const minutes = a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN;
          if (minutes <= 0) return false;
          const last = lastRun.current[a.id] ?? at;
          return at - last >= minutes * 60_000;
        });
      if (due.length === 0) return;

      inFlight.current = true;
      void (async () => {
        try {
          for (const account of due) {
            lastRun.current[account.id] = Date.now();
            for (const ref of account.calendars) {
              // `force: false` — the ctag check is the whole reason a scheduled
              // sync is affordable. A manual "Sync now" is the forcing one.
              await useCalDavStore.getState().syncCalendar(account.id, ref.href, false);
            }
          }
        } finally {
          inFlight.current = false;
        }
      })();
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
    // `scheduled` is derived from `accounts` and re-created each render; `key`
    // is its identity, which is what the timer actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
