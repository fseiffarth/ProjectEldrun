import { useMemo, useState } from "react";
import type { Calendar } from "../../types";
import { addMonths, datePart, monthGrid, todayStr } from "../../lib/calendarTime";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** The palette a new calendar picks from. */
const CALENDAR_COLORS = [
  "#4aa3df", "#e8663d", "#59b96a", "#c164d6",
  "#e2b93b", "#d9556b", "#4fc3c3", "#8d8fd6",
];

interface Props {
  calendars: Calendar[];
  /** The date the mini-month highlights and navigates from. */
  selected: string;
  onSelect: (date: string) => void;
  onToggleVisible: (id: string) => void;
  onCreateCalendar: (name: string, color: string) => void;
  onUpdateCalendar: (calendar: Calendar) => void;
  onDeleteCalendar: (id: string) => void;
  weekStart: 0 | 1;
}

/**
 * The left rail: a mini-month for jumping around, and the calendar list.
 *
 * Unchecking a calendar hides its events everywhere (the checkbox writes through
 * to `visible` on disk, so the choice survives a restart — same as Thunderbird).
 */
export function CalendarSidebar({
  calendars,
  selected,
  onSelect,
  onToggleVisible,
  onCreateCalendar,
  onUpdateCalendar,
  onDeleteCalendar,
  weekStart,
}: Props) {
  // The mini-month browses independently of the main view's anchor, so you can
  // look ahead without moving what you are working on until you click a day.
  const [browse, setBrowse] = useState(() => datePart(selected));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const today = todayStr();
  const year = Number(browse.slice(0, 4));
  const month = Number(browse.slice(5, 7));

  const weeks = useMemo(
    () => monthGrid(year, month, weekStart, 6),
    [year, month, weekStart],
  );

  const labels = useMemo(
    () => [...WEEKDAY_INITIALS.slice(weekStart), ...WEEKDAY_INITIALS.slice(0, weekStart)],
    [weekStart],
  );

  function submitNew() {
    const name = newName.trim();
    if (!name) return;
    // Cycle the palette so a fresh calendar never collides with the last one.
    onCreateCalendar(name, CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length]);
    setNewName("");
    setAdding(false);
  }

  return (
    <div className="cal-sidebar">
      <div className="cal-mini">
        <div className="cal-mini-head">
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, -1))}
            title="Previous month"
          >
            ‹
          </button>
          <span className="cal-mini-title">{MONTHS[month - 1]} {year}</span>
          <button
            className="cal-nav-btn"
            onClick={() => setBrowse(addMonths(browse, 1))}
            title="Next month"
          >
            ›
          </button>
        </div>

        <div className="cal-mini-weekdays">
          {labels.map((w, i) => (
            <span key={i} className="cal-mini-weekday">{w}</span>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className="cal-mini-week">
            {week.map((date) => {
              const inMonth = Number(date.slice(5, 7)) === month;
              const classes = ["cal-mini-day"];
              if (!inMonth) classes.push("cal-mini-day-out");
              if (date === today) classes.push("cal-mini-day-today");
              if (date === datePart(selected)) classes.push("cal-mini-day-selected");
              return (
                <button
                  key={date}
                  className={classes.join(" ")}
                  onClick={() => onSelect(date)}
                >
                  {Number(date.slice(8, 10))}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-list">
        <div className="cal-list-head">
          <span className="cal-list-title">Calendars</span>
          <button className="cal-link-btn" onClick={() => setAdding((a) => !a)}>
            + New
          </button>
        </div>

        {adding ? (
          <div className="cal-list-add">
            <input
              className="cal-input"
              type="text"
              placeholder="Calendar name"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
            />
            <button className="cal-btn cal-btn-primary" disabled={!newName.trim()} onClick={submitNew}>
              Add
            </button>
          </div>
        ) : null}

        {calendars.map((cal) => (
          <div key={cal.id} className="cal-list-row">
            <input
              type="checkbox"
              checked={cal.visible}
              onChange={() => onToggleVisible(cal.id)}
              title={cal.visible ? "Hide this calendar" : "Show this calendar"}
            />

            <input
              type="color"
              className="cal-color-dot"
              value={cal.color}
              title="Calendar color"
              onChange={(e) => onUpdateCalendar({ ...cal, color: e.target.value })}
            />

            {editing === cal.id ? (
              <input
                className="cal-input cal-list-rename"
                type="text"
                autoFocus
                defaultValue={cal.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== cal.name) onUpdateCalendar({ ...cal, name });
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                className={`cal-list-name${cal.visible ? "" : " cal-list-name-off"}`}
                onDoubleClick={() => setEditing(cal.id)}
                title="Double-click to rename"
              >
                {cal.name}
              </span>
            )}

            {/* The last calendar cannot be deleted — the store always keeps one. */}
            {calendars.length > 1 ? (
              <button
                className="cal-link-btn cal-link-danger cal-list-del"
                title="Delete this calendar and everything on it"
                onClick={() => onDeleteCalendar(cal.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
