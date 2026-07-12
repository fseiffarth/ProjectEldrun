import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCalendarStore, visibleCalendarIds } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import type {
  CalendarEvent,
  CalendarViewKind,
  Occurrence,
} from "../../types";
import {
  addDays,
  addMonths,
  datePart,
  dateRange,
  formatLongDate,
  minutesBetween,
  monthGrid,
  startOfWeek,
  todayStr,
  weekDates,
} from "../../lib/calendarTime";
import { expandEvents } from "../../lib/recurrence";
import { parseIcs, serializeIcs } from "../../lib/ics";
import { MonthView } from "./MonthView";
import { TimeGrid } from "./TimeGrid";
import { AgendaView } from "./AgendaView";
import { TasksView } from "./TasksView";
import { CalendarSidebar } from "./CalendarSidebar";
import { EventDialog, type EditScope, type EventDialogTarget } from "./EventDialog";

interface Props {
  /** Whether this pane's tab is the visible one in its group. */
  visible?: boolean;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Weeks the multiweek view shows. */
const MULTIWEEK_WEEKS = 4;

const VIEWS: { kind: CalendarViewKind; label: string; key: string }[] = [
  { kind: "day", label: "Day", key: "1" },
  { kind: "week", label: "Week", key: "2" },
  { kind: "multiweek", label: "Multiweek", key: "3" },
  { kind: "month", label: "Month", key: "4" },
  { kind: "agenda", label: "Agenda", key: "5" },
  { kind: "tasks", label: "Tasks", key: "6" },
];

/**
 * The native calendar tab.
 *
 * A shell around the views: a toolbar (view switcher, navigation, search,
 * import/export), the sidebar (mini-month + calendar list), and whichever view is
 * active. The event store is global — every calendar tab, in any project scope,
 * shows the same events and sees the others' edits live.
 *
 * Views never read raw events. They consume *occurrences* — the result of
 * expanding recurrence over the visible window (`expandEvents`) — so a repeating
 * event is just many occurrences and no view has to know about rules.
 */
export function CalendarPane({ visible }: Props) {
  const calendars = useCalendarStore((s) => s.calendars);
  const events = useCalendarStore((s) => s.events);
  const tasks = useCalendarStore((s) => s.tasks);
  const loaded = useCalendarStore((s) => s.loaded);
  const load = useCalendarStore((s) => s.load);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const deleteOccurrence = useCalendarStore((s) => s.deleteOccurrence);
  const updateOccurrence = useCalendarStore((s) => s.updateOccurrence);
  const createTask = useCalendarStore((s) => s.createTask);
  const updateTask = useCalendarStore((s) => s.updateTask);
  const deleteTask = useCalendarStore((s) => s.deleteTask);
  const createCalendar = useCalendarStore((s) => s.createCalendar);
  const updateCalendar = useCalendarStore((s) => s.updateCalendar);
  const deleteCalendar = useCalendarStore((s) => s.deleteCalendar);
  const toggleCalendarVisible = useCalendarStore((s) => s.toggleCalendarVisible);

  const settings = useSettingsStore((s) => s.settings);

  const weekStart = (settings?.calendar_week_start ?? 0) as 0 | 1;
  const use24h = settings?.calendar_time_format_24h ?? false;
  const dayStartHour = settings?.calendar_day_start_hour ?? 8;
  const defaultReminder = settings?.calendar_default_reminder_minutes ?? 0;

  // Null until the user picks a view, so the configured default still applies when
  // settings load *after* this pane mounts (a calendar tab restored at startup
  // does exactly that). Snapshotting it into useState would silently ignore it.
  const [picked, setPicked] = useState<CalendarViewKind | null>(null);
  const view = picked ?? settings?.calendar_default_view ?? "month";
  const setView = setPicked;

  const [anchor, setAnchor] = useState(() => todayStr());
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<EventDialogTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const visibleIds = useMemo(() => visibleCalendarIds(calendars), [calendars]);
  const defaultCalendarId = calendars[0]?.id ?? "default";

  // ── The visible window ────────────────────────────────────────────────────

  /** The dates the active view covers — and thus the expansion window. */
  const windowDates = useMemo((): string[] => {
    switch (view) {
      case "day":
        return [datePart(anchor)];
      case "week":
        return weekDates(anchor, weekStart);
      case "multiweek":
        return dateRange(startOfWeek(anchor, weekStart), MULTIWEEK_WEEKS * 7);
      case "month":
        return monthGrid(
          Number(anchor.slice(0, 4)),
          Number(anchor.slice(5, 7)),
          weekStart,
          6,
        ).flat();
      case "agenda":
        // The agenda looks forward a month from the anchor, like a "what's next" list.
        return dateRange(datePart(anchor), 31);
      case "tasks":
        return [];
    }
  }, [view, anchor, weekStart]);

  const windowStart = windowDates[0] ?? todayStr();
  const windowEnd = windowDates.length
    ? addDays(windowDates[windowDates.length - 1], 1)
    : addDays(windowStart, 1);

  /** Everything visible in the window, with recurrence expanded. */
  const occurrences = useMemo(
    () => expandEvents(events, windowStart, windowEnd, visibleIds),
    [events, windowStart, windowEnd, visibleIds],
  );

  /** Search filters what the views draw, across title, location and notes. */
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return occurrences;
    return occurrences.filter((o) =>
      `${o.title} ${o.location} ${o.notes}`.toLowerCase().includes(q),
    );
  }, [occurrences, search]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const shift = useCallback(
    (dir: -1 | 1) => {
      setAnchor((a) => {
        switch (view) {
          case "day":
            return addDays(a, dir);
          case "week":
            return addDays(a, 7 * dir);
          case "multiweek":
            return addDays(a, MULTIWEEK_WEEKS * 7 * dir);
          case "month":
            return addMonths(a, dir);
          case "agenda":
            return addDays(a, 31 * dir);
          case "tasks":
            return a;
        }
      });
    },
    [view],
  );

  /** The heading over the grid — what range you are looking at. */
  const title = useMemo(() => {
    if (view === "tasks") return "Tasks";
    if (view === "day") return formatLongDate(datePart(anchor));
    if (view === "month") {
      return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
    }
    const first = windowDates[0];
    const last = windowDates[windowDates.length - 1];
    if (!first || !last) return "";
    return `${formatLongDate(first)} – ${formatLongDate(last)}`;
  }, [view, anchor, windowDates]);

  // Arrow keys and view digits, scoped to the pane (it must not steal keys from
  // a terminal in another tab, so the handler lives on the pane, not the window).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === "ArrowLeft") {
      shift(-1);
    } else if (e.key === "ArrowRight") {
      shift(1);
    } else if (e.key === "t" || e.key === "T") {
      setAnchor(todayStr());
    } else if (e.key === "n" || e.key === "N") {
      openCreate(datePart(anchor));
    } else {
      const match = VIEWS.find((v) => v.key === e.key);
      if (match) setView(match.kind);
      else return;
    }
    e.preventDefault();
  };

  // ── Event editing ─────────────────────────────────────────────────────────

  /**
   * Open the editor on a new event. A new event is always *timed* (09:00-10:00 by
   * default, or whatever span a grid drag produced) — "All day" is a checkbox the
   * user ticks. The draft must stay internally consistent: an all-day draft
   * carries bare dates and an exclusive end, so handing one a timed end would make
   * the dialog step it back a day and land the end before the start.
   */
  function openCreate(date: string, start?: string, end?: string) {
    setDialog({
      event: null,
      occurrence: null,
      draftStart: start ?? `${datePart(date)}T09:00`,
      draftEnd: end ?? `${datePart(date)}T10:00`,
      draftAllDay: false,
    });
  }

  function openOccurrence(occ: Occurrence) {
    const event = events.find((e) => e.id === occ.eventId);
    if (!event) return;
    setDialog({ event, occurrence: occ });
  }

  async function saveFromDialog(event: CalendarEvent, scope: EditScope) {
    const target = dialog;
    setDialog(null);

    // Creating.
    if (!target?.event) {
      const { id: _id, ...draft } = event;
      await createEvent(draft);
      return;
    }

    // Editing one occurrence of a series → store an override, leave the rest.
    if (scope === "this" && target.occurrence) {
      await updateOccurrence(target.event.id, target.occurrence.occurrenceStart, {
        start: event.start,
        end: event.end,
        title: event.title,
        location: event.location ?? "",
        notes: event.notes ?? "",
      });
      return;
    }

    // Editing the series (or a plain event).
    //
    // When the user edited an *occurrence* and chose "all", the times they see are
    // that occurrence's, not the master's — writing them straight onto the master
    // would drag the whole series onto that one occurrence's date. So only the
    // duration and the time-of-day carry over; the master keeps its own start date.
    let next = event;
    if (target.occurrence && target.occurrence.occurrenceStart !== target.event.start) {
      const masterDate = datePart(target.event.start);
      const durationMin = minutesBetween(event.start, event.end);
      const startTime = event.start.split("T")[1];
      const start = event.all_day ? masterDate : `${masterDate}T${startTime}`;
      const end = event.all_day
        ? addDays(masterDate, Math.max(1, Math.round(minutesBetween(event.start, event.end) / 1440)))
        : shiftBy(start, durationMin);
      next = { ...event, start, end };
    }
    await updateEvent(next);
  }

  async function deleteFromDialog(event: CalendarEvent, scope: EditScope) {
    const target = dialog;
    setDialog(null);
    if (scope === "this" && target?.occurrence) {
      await deleteOccurrence(event.id, target.occurrence.occurrenceStart);
      return;
    }
    await deleteEvent(event.id);
  }

  /** A drag in the time grid created a span. */
  const onCreateSpan = useCallback((start: string, end: string) => {
    setDialog({
      event: null,
      occurrence: null,
      draftStart: start,
      draftEnd: end,
      draftAllDay: false,
    });
  }, []);

  /**
   * A block was dragged to a new time. A single occurrence of a series moves as
   * an override; a plain event moves outright. Either way the duration is kept.
   */
  const onMove = useCallback(
    async (occ: Occurrence, newStart: string) => {
      const event = events.find((e) => e.id === occ.eventId);
      if (!event) return;
      const durationMin = minutesBetween(occ.start, occ.end);
      const newEnd = shiftBy(newStart, durationMin);

      if (occ.recurring) {
        await updateOccurrence(occ.eventId, occ.occurrenceStart, {
          start: newStart,
          end: newEnd,
        });
        return;
      }
      await updateEvent({ ...event, start: newStart, end: newEnd });
    },
    [events, updateEvent, updateOccurrence],
  );

  /** A block's bottom edge was dragged. */
  const onResize = useCallback(
    async (occ: Occurrence, newEnd: string) => {
      const event = events.find((e) => e.id === occ.eventId);
      if (!event) return;
      if (occ.recurring) {
        await updateOccurrence(occ.eventId, occ.occurrenceStart, {
          start: occ.start,
          end: newEnd,
        });
        return;
      }
      await updateEvent({ ...event, end: newEnd });
    },
    [events, updateEvent, updateOccurrence],
  );

  // ── ICS ───────────────────────────────────────────────────────────────────

  async function importIcs() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "iCalendar", extensions: ["ics", "ical", "ifb"] }],
    });
    if (typeof path !== "string") return;

    try {
      // A dedicated, extension-guarded command — the general file-read command is
      // confined to the current project and would refuse a path in ~/Downloads.
      const text = await invoke<string>("calendar_read_ics", { path });
      const parsed = parseIcs(text);

      // Imported items land in their own calendar, so an import is easy to undo by
      // deleting that one calendar — and can never silently mix into "Personal".
      const name = fileStem(path);
      const target = await createCalendar({
        name: name || "Imported",
        color: "#8d8fd6",
        visible: true,
        readonly: false,
      });

      for (const e of parsed.events) {
        await createEvent({ ...e, calendar_id: target.id });
      }
      for (const t of parsed.tasks) {
        await createTask({ ...t, calendar_id: target.id });
      }

      setNotice(
        `Imported ${parsed.events.length} event(s)` +
          (parsed.tasks.length ? ` and ${parsed.tasks.length} task(s)` : "") +
          ` into “${target.name}”` +
          (parsed.skipped ? ` — skipped ${parsed.skipped} unsupported item(s).` : "."),
      );
    } catch (err) {
      setNotice(`Import failed: ${String(err)}`);
    }
  }

  async function exportIcs() {
    const path = await saveDialog({
      defaultPath: "eldrun-calendar.ics",
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (typeof path !== "string") return;

    try {
      // Export what is checked in the sidebar — the same set the views show, so
      // what you see is what you get.
      const text = serializeIcs(
        events.filter((e) => visibleIds.has(e.calendar_id)),
        tasks.filter((t) => visibleIds.has(t.calendar_id)),
      );
      await invoke<void>("calendar_write_ics", { path, content: text });
      setNotice(`Exported to ${path}`);
    } catch (err) {
      setNotice(`Export failed: ${String(err)}`);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const gridPrefs = { use24h, dayStartHour };

  return (
    <div
      className="cal-pane"
      style={{ display: visible === false ? "none" : undefined }}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="cal-toolbar">
        <div className="cal-toolbar-nav">
          <button className="cal-nav-btn" onClick={() => shift(-1)} title="Previous (←)">‹</button>
          <button className="cal-btn" onClick={() => setAnchor(todayStr())} title="Today (T)">
            Today
          </button>
          <button className="cal-nav-btn" onClick={() => shift(1)} title="Next (→)">›</button>
        </div>

        <div className="cal-toolbar-title">{title}</div>

        <div className="cal-toolbar-views">
          {VIEWS.map((v) => (
            <button
              key={v.kind}
              className={`cal-chip${view === v.kind ? " cal-chip-on" : ""}`}
              onClick={() => setView(v.kind)}
              title={`${v.label} (${v.key})`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <input
          className="cal-input cal-search"
          type="search"
          placeholder="Search events…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="cal-toolbar-actions">
          <button
            className="cal-btn cal-btn-primary"
            onClick={() => openCreate(datePart(anchor))}
            title="New event (N)"
          >
            + Event
          </button>
          <button className="cal-btn" onClick={() => void importIcs()} title="Import an .ics file">
            Import
          </button>
          <button className="cal-btn" onClick={() => void exportIcs()} title="Export to an .ics file">
            Export
          </button>
        </div>
      </div>

      {notice ? (
        <div className="cal-notice" onClick={() => setNotice(null)} title="Click to dismiss">
          {notice}
        </div>
      ) : null}

      <div className="cal-body">
        <CalendarSidebar
          calendars={calendars}
          selected={anchor}
          onSelect={(date) => setAnchor(date)}
          onToggleVisible={(id) => void toggleCalendarVisible(id)}
          onCreateCalendar={(name, color) =>
            void createCalendar({ name, color, visible: true, readonly: false })
          }
          onUpdateCalendar={(cal) => void updateCalendar(cal)}
          onDeleteCalendar={(id) => void deleteCalendar(id)}
          weekStart={weekStart}
        />

        <div className="cal-view">
          {view === "tasks" ? (
            <TasksView
              tasks={tasks}
              calendars={calendars}
              visibleCalendars={visibleIds}
              search={search}
              onCreate={createTask}
              onUpdate={updateTask}
              onDelete={deleteTask}
              defaultCalendarId={defaultCalendarId}
            />
          ) : view === "agenda" ? (
            <AgendaView
              occurrences={shown}
              calendars={calendars}
              use24h={use24h}
              onOpen={openOccurrence}
              emptyLabel={
                search.trim() ? `No events match “${search.trim()}”.` : "Nothing scheduled."
              }
            />
          ) : view === "month" || view === "multiweek" ? (
            <MonthView
              weeks={chunk(windowDates, 7)}
              month={view === "month" ? Number(anchor.slice(5, 7)) : null}
              occurrences={shown}
              calendars={calendars}
              use24h={use24h}
              selected={datePart(anchor)}
              onSelect={(date) => setAnchor(date)}
              onCreateOn={(date) => openCreate(date)}
              onOpen={openOccurrence}
              weekStart={weekStart}
            />
          ) : (
            <div className="cal-timeview">
              <AllDayBar
                dates={windowDates}
                occurrences={shown}
                onOpen={openOccurrence}
                selected={datePart(anchor)}
                onSelect={(date) => setAnchor(date)}
              />
              <TimeGrid
                dates={windowDates}
                occurrences={shown}
                calendars={calendars}
                prefs={gridPrefs}
                onOpen={openOccurrence}
                onCreate={onCreateSpan}
                onMove={(occ, start) => void onMove(occ, start)}
                onResize={(occ, end) => void onResize(occ, end)}
              />
            </div>
          )}
        </div>
      </div>

      {dialog ? (
        <EventDialog
          target={dialog}
          calendars={calendars}
          defaultCalendarId={defaultCalendarId}
          defaultReminderMinutes={defaultReminder}
          onClose={() => setDialog(null)}
          onSave={saveFromDialog}
          onDelete={deleteFromDialog}
        />
      ) : null}
    </div>
  );
}

/**
 * The strip above the day/week grid: the date headers, plus the all-day events,
 * which have no place on an hour grid.
 */
function AllDayBar({
  dates,
  occurrences,
  onOpen,
  selected,
  onSelect,
}: {
  dates: string[];
  occurrences: Occurrence[];
  onOpen: (o: Occurrence) => void;
  selected: string;
  onSelect: (date: string) => void;
}) {
  const today = todayStr();
  const allDay = occurrences.filter((o) => o.allDay);

  return (
    <div className="cal-allday">
      <div className="cal-allday-gutter">all-day</div>
      <div className="cal-allday-cols">
        {dates.map((date) => {
          const here = allDay.filter((o) =>
            dateWithin(o, date),
          );
          const d = new Date(`${date}T12:00`);
          return (
            <div
              key={date}
              className={
                "cal-allday-col" +
                (date === today ? " cal-allday-col-today" : "") +
                (date === selected ? " cal-allday-col-selected" : "")
              }
              onClick={() => onSelect(date)}
            >
              <div className="cal-allday-head">
                <span className="cal-allday-dow">
                  {d.toLocaleDateString("en", { weekday: "short" })}
                </span>
                <span className="cal-allday-num">{Number(date.slice(8, 10))}</span>
              </div>
              {here.map((o) => (
                <div
                  key={`${o.eventId}:${o.occurrenceStart}`}
                  className="cal-allday-chip"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpen(o);
                  }}
                  title={o.title}
                >
                  {o.title || "(untitled)"}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function dateWithin(o: Occurrence, date: string): boolean {
  return datePart(o.start) <= date && date < datePart(o.end);
}

/** Split a flat date list into rows of `n`. */
function chunk(dates: string[], n: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < dates.length; i += n) out.push(dates.slice(i, i + n));
  return out;
}

/** A stamp plus a duration in minutes. */
function shiftBy(start: string, minutes: number): string {
  const total = Math.max(15, minutes);
  const [date, time] = start.split("T");
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  const end = h * 60 + m + total;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${addDays(date, Math.floor(end / 1440))}T${p(Math.floor((end % 1440) / 60))}:${p(end % 60)}`;
}

/** The bare filename, for naming an imported calendar. */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(ics|ical|ifb)$/i, "");
}
