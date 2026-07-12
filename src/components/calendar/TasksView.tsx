import { useMemo, useState } from "react";
import type { Calendar, CalendarTask } from "../../types";
import { datePart, formatLongDate, todayStr, toStamp } from "../../lib/calendarTime";
import { calendarColor } from "../../stores/calendar";

interface Props {
  tasks: CalendarTask[];
  calendars: Calendar[];
  /** Only tasks on these calendars are listed. */
  visibleCalendars: Set<string>;
  search: string;
  onCreate: (task: Omit<CalendarTask, "id">) => Promise<unknown>;
  onUpdate: (task: CalendarTask) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** The calendar a new task is filed under. */
  defaultCalendarId: string;
}

type Filter = "open" | "all" | "done";

/** iCalendar priority: 1-4 high, 5 normal, 6-9 low, 0 unset. */
function priorityLabel(p: number): string {
  if (p === 0) return "";
  if (p <= 4) return "High";
  if (p === 5) return "Normal";
  return "Low";
}

function priorityClass(p: number): string {
  if (p === 0) return "";
  if (p <= 4) return " cal-task-prio-high";
  if (p === 5) return " cal-task-prio-normal";
  return " cal-task-prio-low";
}

/** A task is overdue when it has a due date in the past and is not complete. */
function isOverdue(task: CalendarTask, today: string): boolean {
  if (!task.due || task.percent >= 100) return false;
  return datePart(task.due) < today;
}

/**
 * The to-do list — Thunderbird's Tasks tab.
 *
 * Tasks are VTODOs: a title, an optional due date, a priority and a completion
 * percentage. Ticking the checkbox sets `percent` to 100 and stamps `completed`,
 * which is what makes a task "done" (the completion stamp, not a separate flag,
 * so it survives an ICS round-trip).
 */
export function TasksView({
  tasks,
  calendars,
  visibleCalendars,
  search,
  onCreate,
  onUpdate,
  onDelete,
  defaultCalendarId,
}: Props) {
  const [filter, setFilter] = useState<Filter>("open");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const today = todayStr();

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => visibleCalendars.has(t.calendar_id))
      .filter((t) => {
        const done = t.percent >= 100;
        if (filter === "open") return !done;
        if (filter === "done") return done;
        return true;
      })
      .filter((t) =>
        q ? `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => {
        // Overdue first, then by due date (undated last), then by priority.
        const ao = isOverdue(a, today) ? 0 : 1;
        const bo = isOverdue(b, today) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const ad = a.due ?? "9999";
        const bd = b.due ?? "9999";
        if (ad !== bd) return ad.localeCompare(bd);
        const ap = a.priority || 10;
        const bp = b.priority || 10;
        return ap - bp;
      });
  }, [tasks, visibleCalendars, filter, search, today]);

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await onCreate({
      calendar_id: defaultCalendarId,
      title: t,
      due: due || null,
      priority: 0,
      percent: 0,
    });
    setTitle("");
    setDue("");
  }

  /** Tick/untick: completion is the `completed` stamp plus percent 100. */
  async function toggleDone(task: CalendarTask) {
    const done = task.percent >= 100;
    await onUpdate({
      ...task,
      percent: done ? 0 : 100,
      completed: done ? null : toStamp(new Date()),
    });
  }

  return (
    <div className="cal-tasks">
      <div className="cal-tasks-add">
        <input
          className="cal-input cal-tasks-add-title"
          type="text"
          placeholder="Add a task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addTask();
          }}
        />
        <input
          className="cal-input cal-tasks-add-due"
          type="date"
          title="Due date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <button className="cal-btn cal-btn-primary" disabled={!title.trim()} onClick={() => void addTask()}>
          Add
        </button>
      </div>

      <div className="cal-tasks-filters">
        {(["open", "all", "done"] as Filter[]).map((f) => (
          <button
            key={f}
            className={`cal-chip${filter === f ? " cal-chip-on" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "open" ? "Open" : f === "all" ? "All" : "Completed"}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="cal-empty">
          {filter === "done" ? "Nothing completed yet." : "No tasks. Add one above."}
        </div>
      ) : (
        <div className="cal-tasks-list">
          {shown.map((task) => {
            const done = task.percent >= 100;
            const overdue = isOverdue(task, today);
            return (
              <div
                key={task.id}
                className={
                  "cal-task-row" +
                  (done ? " cal-task-done" : "") +
                  (overdue ? " cal-task-overdue" : "")
                }
              >
                <input
                  type="checkbox"
                  className="cal-task-check"
                  checked={done}
                  onChange={() => void toggleDone(task)}
                  title={done ? "Mark as not done" : "Mark as done"}
                />

                <span
                  className="cal-task-swatch"
                  style={{ color: calendarColor(calendars, task.calendar_id) }}
                >
                  ●
                </span>

                <span className="cal-task-title">{task.title}</span>

                {task.priority ? (
                  <span className={`cal-task-prio${priorityClass(task.priority)}`}>
                    {priorityLabel(task.priority)}
                  </span>
                ) : null}

                {!done && task.percent > 0 ? (
                  <span className="cal-task-percent" title={`${task.percent}% complete`}>
                    <span className="cal-task-percent-fill" style={{ width: `${task.percent}%` }} />
                  </span>
                ) : null}

                {task.due ? (
                  <span className="cal-task-due" title={formatLongDate(datePart(task.due))}>
                    {overdue ? "Overdue · " : ""}
                    {datePart(task.due)}
                  </span>
                ) : null}

                <select
                  className="cal-task-prio-select"
                  value={task.priority}
                  title="Priority"
                  onChange={(e) => void onUpdate({ ...task, priority: Number(e.target.value) })}
                >
                  <option value={0}>—</option>
                  <option value={1}>High</option>
                  <option value={5}>Normal</option>
                  <option value={9}>Low</option>
                </select>

                <button
                  className="cal-link-btn cal-link-danger"
                  onClick={() => void onDelete(task.id)}
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
