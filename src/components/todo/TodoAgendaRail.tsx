import { useEffect, useMemo, useState } from "react";

import type { Occurrence } from "../../types";
import { useCalendarStore } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { timePart } from "../../lib/calendarTime";
import { agendaWindow, occurrencePast } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";

/** The clock half of the rail. Nothing in the store changes when 15:00 passes. */
const TICK_MS = 60_000;

/**
 * Today's and tomorrow's appointments.
 *
 * **Past occurrences are dimmed, not hidden.** Hiding them would make this rail
 * disagree with the header's calendar badge, which counts what has not yet
 * *ended* — and "what did I already do today" is half of what a morning glance
 * at a board is for.
 */
export function TodoAgendaRail() {
  const t = useT();
  const events = useCalendarStore((s) => s.events);
  const calendars = useCalendarStore((s) => s.calendars);
  const calendarApp = useSettingsStore((s) => s.settings?.calendar_global_app ?? false);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!overlayOpen) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [overlayOpen]);

  const now = useMemo(() => new Date(), [tick]);
  const window_ = useMemo(
    () => agendaWindow(events, calendars, now),
    [events, calendars, now],
  );

  const row = (occ: Occurrence) => (
    <li
      key={`${occ.eventId}-${occ.occurrenceStart}`}
      className={"todo-agenda-row" + (occurrencePast(occ, now) ? " todo-agenda-past" : "")}
    >
      <span className="todo-agenda-time">
        {occ.allDay ? t("todoAgenda.allDay") : timePart(occ.start)}
      </span>
      <span className="todo-agenda-title">{occ.title || t("calendar.untitled")}</span>
    </li>
  );

  const section = (label: string, occurrences: Occurrence[]) => (
    <>
      <h4 className="todo-agenda-day">{label}</h4>
      {occurrences.length === 0 ? (
        <p className="todo-rail-muted">{t("calendar.nothingScheduled")}</p>
      ) : (
        <ul className="todo-rail-list">{occurrences.map(row)}</ul>
      )}
    </>
  );

  return (
    <section className="todo-rail">
      <h3 className="todo-rail-title">{t("todoAgenda.title")}</h3>
      {section(t("todoAgenda.today"), window_.today)}
      {section(t("todoAgenda.tomorrow"), window_.tomorrow)}

      {/* Only when the calendar overlay can actually open — `CalendarOverlayHost`
          computes `live = enabled && open`, so without the setting this button
          would be one that visibly does nothing. */}
      {calendarApp && (
        <button
          type="button"
          className="cal-link-btn todo-agenda-open"
          onClick={() => {
            useTodoStore.getState().closeOverlay();
            useCalendarStore.getState().openOverlay();
          }}
        >
          {t("todoAgenda.openCalendar")}
        </button>
      )}
    </section>
  );
}
