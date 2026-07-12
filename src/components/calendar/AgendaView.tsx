import { useMemo } from "react";
import type { Calendar, Occurrence } from "../../types";
import { datePart, formatLongDate, formatTime, spanDates, todayStr } from "../../lib/calendarTime";
import { eventColor } from "../../lib/calendarCategories";
import { calendarColor } from "../../stores/calendar";

interface Props {
  occurrences: Occurrence[];
  calendars: Calendar[];
  use24h: boolean;
  onOpen: (occurrence: Occurrence) => void;
  /** What the list is showing, for the empty state (e.g. a search with no hits). */
  emptyLabel?: string;
}

/**
 * A flat, chronological list of everything in the window, grouped by day.
 *
 * This is also the view a search falls back to: filtering in a month grid hides
 * the matches among empty cells, whereas a list shows exactly the hits.
 */
export function AgendaView({ occurrences, calendars, use24h, onOpen, emptyLabel }: Props) {
  const today = todayStr();

  /**
   * Group by day. A multi-day event appears under each day it covers — the same
   * event listed on each of its days is what a reader scanning "what's on
   * Thursday" actually wants, even if it started on Tuesday.
   */
  const days = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const occ of occurrences) {
      for (const date of spanDates({ start: occ.start, end: occ.end, allDay: occ.allDay })) {
        const list = map.get(date);
        if (list) list.push(occ);
        else map.set(date, [occ]);
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [occurrences]);

  if (days.length === 0) {
    return <div className="cal-empty">{emptyLabel ?? "Nothing scheduled."}</div>;
  }

  return (
    <div className="cal-agenda">
      {days.map(([date, list]) => (
        <div key={date} className="cal-agenda-day">
          <div
            className={`cal-agenda-date${date === today ? " cal-agenda-date-today" : ""}`}
          >
            {formatLongDate(date)}
            {date === today ? <span className="cal-agenda-today-tag">Today</span> : null}
          </div>

          {list.map((occ) => {
            const color = eventColor(occ.category, calendarColor(calendars, occ.calendarId));
            // A multi-day event shows "all day" on the days it merely passes through.
            const startsHere = datePart(occ.start) === date;
            return (
              <div
                key={`${occ.eventId}:${occ.occurrenceStart}:${date}`}
                className={
                  "cal-agenda-row" +
                  (occ.status === "cancelled" ? " cal-block-cancelled" : "")
                }
                onDoubleClick={() => onOpen(occ)}
              >
                <span className="cal-agenda-swatch" style={{ color }}>●</span>
                <span className="cal-agenda-time">
                  {occ.allDay
                    ? "All day"
                    : startsHere
                      ? formatTime(occ.start.split("T")[1] ?? "", use24h)
                      : "continues"}
                </span>
                <span className="cal-agenda-title">{occ.title || "(untitled)"}</span>
                {occ.location ? (
                  <span className="cal-agenda-location">{occ.location}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
