import { useEffect, useMemo, useState } from "react";
import { useCalendarStore } from "../../stores/calendar";
import type { CalendarEvent } from "../../types";

interface Props {
  /** Whether this pane's tab is the visible one in its group. */
  visible?: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local calendar day as "YYYY-MM-DD" (mirrors ActivityCalendar.toDateStr). */
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DayCell {
  date: string;
  day: number;
  inMonth: boolean;
}

/** Six Sunday-aligned weeks covering the given month (stable grid height). */
function monthMatrix(year: number, month: number): DayCell[][] {
  const first = new Date(year, month, 1);
  const cur = new Date(first);
  cur.setDate(1 - first.getDay()); // rewind to the Sunday on/before the 1st
  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({ date: toDateStr(cur), day: cur.getDate(), inMonth: cur.getMonth() === month });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Sort key: all-day (no time) first, then by "HH:MM". */
function byTime(a: CalendarEvent, b: CalendarEvent): number {
  return (a.time || "").localeCompare(b.time || "");
}

function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

interface Draft {
  id: string | null; // null → creating a new event
  title: string;
  time: string;
  notes: string;
}

export function CalendarPane({ visible }: Props) {
  const events = useCalendarStore((s) => s.events);
  const loaded = useCalendarStore((s) => s.loaded);
  const load = useCalendarStore((s) => s.load);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selected, setSelected] = useState(() => toDateStr(new Date()));
  const [draft, setDraft] = useState<Draft | null>(null);

  const todayStr = toDateStr(new Date());
  const weeks = useMemo(() => monthMatrix(view.year, view.month), [view]);

  // date → sorted events, rebuilt when the event list changes.
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const list = map.get(ev.date);
      if (list) list.push(ev);
      else map.set(ev.date, [ev]);
    }
    for (const list of map.values()) list.sort(byTime);
    return map;
  }, [events]);

  const selectedEvents = eventsByDate.get(selected) ?? [];

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function goToday() {
    const now = new Date();
    setView({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(toDateStr(now));
  }

  function pickDay(date: string) {
    setSelected(date);
    setDraft(null);
  }

  function startCreate() {
    setDraft({ id: null, title: "", time: "", notes: "" });
  }

  function startEdit(ev: CalendarEvent) {
    setDraft({ id: ev.id, title: ev.title, time: ev.time, notes: ev.notes ?? "" });
  }

  async function saveDraft() {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) return;
    if (draft.id === null) {
      await createEvent(selected, draft.time, title, draft.notes.trim());
    } else {
      await updateEvent(draft.id, selected, draft.time, title, draft.notes.trim());
    }
    setDraft(null);
  }

  async function removeEvent(id: string) {
    await deleteEvent(id);
    if (draft?.id === id) setDraft(null);
  }

  return (
    <div className="calendar-pane" style={{ display: visible === false ? "none" : undefined }}>
      <div className="calendar-header">
        <div className="calendar-title">
          {MONTHS[view.month]} {view.year}
        </div>
        <div className="calendar-nav">
          <button className="calendar-nav-btn" onClick={() => shiftMonth(-1)} title="Previous month">
            ‹
          </button>
          <button className="calendar-today-btn" onClick={goToday}>
            Today
          </button>
          <button className="calendar-nav-btn" onClick={() => shiftMonth(1)} title="Next month">
            ›
          </button>
        </div>
      </div>

      <div className="calendar-body">
        <div className="calendar-grid">
          <div className="calendar-weekdays">
            {WEEKDAYS.map((w) => (
              <div key={w} className="calendar-weekday">
                {w}
              </div>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <div key={wi} className="calendar-week">
              {week.map((cell) => {
                const dayEvents = eventsByDate.get(cell.date) ?? [];
                const classes = ["calendar-day"];
                if (!cell.inMonth) classes.push("calendar-day-out");
                if (cell.date === todayStr) classes.push("calendar-day-today");
                if (cell.date === selected) classes.push("calendar-day-selected");
                return (
                  <button
                    key={cell.date}
                    className={classes.join(" ")}
                    onClick={() => pickDay(cell.date)}
                  >
                    <span className="calendar-day-num">{cell.day}</span>
                    <span className="calendar-day-events">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <span key={ev.id} className="calendar-chip" title={ev.title}>
                          {ev.time ? <span className="calendar-chip-time">{ev.time}</span> : null}
                          <span className="calendar-chip-title">{ev.title}</span>
                        </span>
                      ))}
                      {dayEvents.length > 3 ? (
                        <span className="calendar-chip-more">+{dayEvents.length - 3} more</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="calendar-side">
          <div className="calendar-side-header">
            <div className="calendar-side-date">{prettyDate(selected)}</div>
            <button className="calendar-add-btn" onClick={startCreate}>
              + Event
            </button>
          </div>

          <div className="calendar-side-list">
            {selectedEvents.length === 0 && !draft ? (
              <div className="calendar-empty">No events. Click “+ Event” to add one.</div>
            ) : null}

            {selectedEvents.map((ev) => (
              <div key={ev.id} className="calendar-event-row">
                <div className="calendar-event-main">
                  <span className="calendar-event-time">{ev.time || "All day"}</span>
                  <span className="calendar-event-title">{ev.title}</span>
                </div>
                {ev.notes ? <div className="calendar-event-notes">{ev.notes}</div> : null}
                <div className="calendar-event-actions">
                  <button className="calendar-link-btn" onClick={() => startEdit(ev)}>
                    Edit
                  </button>
                  <button
                    className="calendar-link-btn calendar-link-danger"
                    onClick={() => removeEvent(ev.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {draft ? (
            <div className="calendar-form">
              <div className="calendar-form-title">{draft.id === null ? "New event" : "Edit event"}</div>
              <input
                className="calendar-input"
                type="text"
                placeholder="Title"
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDraft();
                  if (e.key === "Escape") setDraft(null);
                }}
              />
              <input
                className="calendar-input"
                type="time"
                value={draft.time}
                onChange={(e) => setDraft({ ...draft, time: e.target.value })}
              />
              <textarea
                className="calendar-input calendar-textarea"
                placeholder="Notes (optional)"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
              <div className="calendar-form-actions">
                <button
                  className="calendar-save-btn"
                  disabled={!draft.title.trim()}
                  onClick={() => void saveDraft()}
                >
                  Save
                </button>
                <button className="calendar-link-btn" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
