import { useEffect, useState } from "react";
import { eventsLeftToday, useCalendarStore } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";

/** How often the badge re-reads the clock. Events tick past on the minute, and a
 *  count that only moved when the store changed would sit on yesterday's number
 *  through a window left open overnight. */
const TICK_MS = 60_000;

/**
 * The header's calendar button — the twin of `MailIndicator`, and built the same
 * way for the same reason: a calendar tab belongs to a scope and is left behind
 * by a project switch, while your calendar is not a property of the project you
 * happen to be looking at. One button in the header, always in the same place,
 * opening the same `CalendarPane` as an overlay (`CalendarOverlayHost`).
 *
 * Off by default (`calendar_global_app`), with **no experimental gate above it**
 * — unlike mail, the calendar is shipped and its store reads one local file, so
 * there is nothing to withdraw and nothing to keep off the network.
 *
 * **The badge is derived, not acknowledged**, which is the one real difference
 * from the mail badge and is `eventsLeftToday`'s doc in one line: mail counts
 * arrivals and clears when you open it, because a delivery has then been seen;
 * an appointment does not stop being at 3 p.m. because you looked at it. So this
 * number is recomputed — from the store on every edit, and from the clock every
 * minute — and reaches zero on its own at the end of the day.
 */
export function CalendarIndicator() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.calendar_global_app ?? false);
  const events = useCalendarStore((s) => s.events);
  const calendars = useCalendarStore((s) => s.calendars);
  const overlayOpen = useCalendarStore((s) => s.overlayOpen);
  // The clock half of the count. Nothing in the store changes when 15:00 simply
  // passes, so the counter exists only to force the re-render that recomputes it
  // — hence the value is never read, only bumped.
  const [, setTick] = useState(0);

  // The calendar is one local file, so unlike mail there is no "don't reach out
  // on mount" rule to respect — the badge needs the events before the overlay is
  // ever opened, and `load` is idempotent.
  useEffect(() => {
    if (!enabled) return;
    void useCalendarStore.getState().load();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  const count = eventsLeftToday(events, calendars);
  const label = count > 0 ? t("calendar.indicatorLeft", { count }) : t("calendar.indicator");

  return (
    /* Same wrapper the brain and mail buttons use: `.header-center` stretches
       its children to the full header height, so a bare 32px button would sit at
       the top of the frame instead of centered. */
    <div className="global-apps-menu calendar-indicator no-drag">
      <button
        type="button"
        className="global-apps-menu-btn calendar-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        onClick={() => {
          const store = useCalendarStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
      >
        <span className="calendar-indicator-icon" aria-hidden="true">
          🗓
        </span>
        {count > 0 && (
          <span className="calendar-indicator-badge" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </div>
  );
}
