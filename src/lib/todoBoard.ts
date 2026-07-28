/**
 * The todo board's pure logic — bucketing, ordering, filtering, drag geometry,
 * the header badge and the two rails' data selection.
 *
 * Everything here is a pure function over already-loaded state, for the reason
 * the calendar's own math lives in `lib/{calendarTime,recurrence}.ts`: it is the
 * half worth unit-testing, and a board that computes nothing in its components
 * can be re-rendered as often as a drag needs without a second thought.
 *
 * Two rules run through the whole file and are worth reading once:
 *
 * **Completion wins over placement.** A card's column is Eldrun's own field; its
 * `percent`/`completed` are the ICS-round-trippable truth that the calendar's
 * Tasks view and `serializeIcs` both read. So wherever the two could disagree —
 * a task ticked in the Tasks view, which knows nothing about columns — the
 * completion is believed and the card is *shown* in the done column. The backend
 * writes that reconciliation to disk on the next save (`CalendarData::normalize`);
 * this is what makes the board show the truth in the meantime.
 *
 * **Nothing here migrates anything.** No render path writes `column` or `rank`
 * onto a task: a card that has never been placed is simply *shown* in the first
 * column, and acquires a real placement the first time it is moved. Writing
 * placement at read time would rewrite `calendar.json` once per launch, for
 * someone who may only ever use the calendar.
 */

import type {
  Calendar,
  CalendarEvent,
  CalendarTask,
  Occurrence,
  TaskColumn,
} from "../types";
import type { MailHeader } from "../types/mail";
import { addDays, datePart, todayStr, toStamp } from "./calendarTime";
import { expandEvents, occurrencesOn, sortOccurrences } from "./recurrence";
import { visibleCalendarIds } from "../stores/calendar";
import type { TranslationKey } from "./i18n";

/** Gap between adjacent ranks. Mirrors the backend's `RANK_GAP`. */
export const RANK_STEP = 1024;

/**
 * The board the frontend draws when `calendar.json` carries no `task_columns`.
 *
 * The backend deliberately does not seed columns on read — that would grow board
 * state in the file of someone who only uses the calendar — so until the first
 * drag or column edit there is nothing on disk to render from. These ids match
 * the backend's `TaskColumn::default_set`, so the moment it *does* seed, every
 * card stays exactly where it was being shown.
 */
export const DEFAULT_COLUMNS: TaskColumn[] = [
  { id: "backlog", name: "Backlog", position: 0, done: false, color: "#8a93a5" },
  { id: "today", name: "Today", position: 1, done: false, color: "#4aa3df" },
  { id: "doing", name: "Doing", position: 2, done: false, color: "#e8a33d" },
  { id: "done", name: "Done", position: 3, done: true, color: "#5cb85c" },
];

/** Translation keys for the seeded columns, so a default board is localized. */
const DEFAULT_COLUMN_LABELS: Record<string, TranslationKey> = {
  backlog: "todoBoard.columnBacklog",
  today: "todoBoard.columnToday",
  doing: "todoBoard.columnDoing",
  done: "todoBoard.columnDone",
};

/** The columns to render: the store's, or the defaults while it has none. */
export function boardColumns(stored: TaskColumn[] | undefined | null): TaskColumn[] {
  const columns = stored && stored.length > 0 ? stored : DEFAULT_COLUMNS;
  return [...columns].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

/**
 * A column's label. A seeded column is translated from its id; a user-named one
 * is shown verbatim — a name someone typed is not ours to reinterpret, and a
 * rename must survive a language switch.
 */
export function columnTitle(
  column: TaskColumn,
  t: (key: TranslationKey) => string,
  stored: TaskColumn[] | undefined | null,
): string {
  const untouched = !stored || stored.length === 0;
  const key = DEFAULT_COLUMN_LABELS[column.id];
  const isSeededName =
    DEFAULT_COLUMNS.find((c) => c.id === column.id)?.name === column.name;
  return key && (untouched || isSeededName) ? t(key) : column.name;
}

/** The done column's id, or null when the board has none (coupling off). */
export function doneColumnId(columns: TaskColumn[]): string | null {
  return columns.find((c) => c.done)?.id ?? null;
}

/** The column an unplaced card is shown in: the leftmost that is not Done. */
export function fallbackColumnId(columns: TaskColumn[]): string {
  return (columns.find((c) => !c.done) ?? columns[0]).id;
}

// ── Bucketing and ordering ──────────────────────────────────────────────────

/**
 * Which column a card is *shown* in, applying the three rules in order:
 * completion wins, then an absent/unknown column falls to the first, then the
 * column the card names.
 */
export function columnOf(task: CalendarTask, columns: TaskColumn[]): string {
  const done = doneColumnId(columns);
  if (task.percent >= 100 && done) return done;
  const named = task.column;
  if (!named || !columns.some((c) => c.id === named)) {
    // A completed card with no done column has nowhere better to go than the
    // fallback — which is exactly what the backend does with the coupling off.
    return fallbackColumnId(columns);
  }
  // A card that is *not* complete cannot sit in Done, however it was filed:
  // otherwise unticking it in the calendar's Tasks view would leave it under a
  // heading that says it is finished.
  if (done && named === done && task.percent < 100) return fallbackColumnId(columns);
  return named;
}

/** Group cards by the column they are shown in, each column already ordered. */
export function bucketByColumn(
  tasks: CalendarTask[],
  columns: TaskColumn[],
  today: string = todayStr(),
): Map<string, CalendarTask[]> {
  const buckets = new Map<string, CalendarTask[]>();
  for (const column of columns) buckets.set(column.id, []);
  for (const task of tasks) {
    const id = columnOf(task, columns);
    (buckets.get(id) ?? buckets.set(id, []).get(id)!).push(task);
  }
  for (const [id, list] of buckets) buckets.set(id, orderedColumn(list, today));
  return buckets;
}

/**
 * One column's cards, top to bottom.
 *
 * Ranked cards first, ascending. Unranked ones — everything created by the
 * calendar's Tasks view or an ICS import, which never place anything — sort
 * after them by the Tasks view's own comparator (overdue, then due date with
 * undated last, then priority), so a task arriving from another surface lands
 * somewhere sensible without anyone having had to write a rank for it. `id`
 * breaks every remaining tie, so the order never depends on array position
 * (which changes whenever a card is deleted).
 */
export function orderedColumn(
  tasks: CalendarTask[],
  today: string = todayStr(),
): CalendarTask[] {
  return [...tasks].sort((a, b) => {
    const ar = a.rank ?? null;
    const br = b.rank ?? null;
    if (ar !== null && br !== null) return ar - br || a.id.localeCompare(b.id);
    if (ar !== null) return -1;
    if (br !== null) return 1;

    const ao = isOverdue(a, today) ? 0 : 1;
    const bo = isOverdue(b, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.due ? datePart(a.due) : "9999";
    const bd = b.due ? datePart(b.due) : "9999";
    if (ad !== bd) return ad.localeCompare(bd);
    const ap = a.priority || 10;
    const bp = b.priority || 10;
    return ap - bp || a.id.localeCompare(b.id);
  });
}

/**
 * A provisional rank for the optimistic overlay, so a dropped card lands in its
 * new slot in the same frame as the pointerup.
 *
 * **Display only.** The authoritative rank is the backend's — the frontend sends
 * an index and `todo_move_tasks` does the algebra, which is what keeps a replayed
 * placement a no-op and a collapsed column reindexed. This exists purely so the
 * board has a number to sort by for the ~1 frame before the write returns.
 */
export function provisionalRank(
  before: number | null,
  after: number | null,
): number {
  if (before === null && after === null) return RANK_STEP;
  if (after === null) return (before as number) + RANK_STEP;
  if (before === null) return after - RANK_STEP;
  return (before + after) / 2;
}

/** Apply the pending optimistic placements over the store's tasks. */
export function applyPending(
  tasks: CalendarTask[],
  pending: Record<string, { column: string; rank: number }>,
): CalendarTask[] {
  if (Object.keys(pending).length === 0) return tasks;
  return tasks.map((task) => {
    const staged = pending[task.id];
    return staged ? { ...task, column: staged.column, rank: staged.rank } : task;
  });
}

// ── Filtering ───────────────────────────────────────────────────────────────

export interface BoardFilter {
  search: string;
  /** A project id, `"none"` for cards with no project, or null for any. */
  project: string | null | "none";
  tag: string | null;
  hideDone: boolean;
  visibleCalendars: Set<string>;
}

export function filterTasks(
  tasks: CalendarTask[],
  filter: BoardFilter,
): CalendarTask[] {
  const q = filter.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (!filter.visibleCalendars.has(task.calendar_id)) return false;
    if (filter.hideDone && task.percent >= 100) return false;
    if (filter.project === "none" && task.project_id) return false;
    if (
      filter.project &&
      filter.project !== "none" &&
      task.project_id !== filter.project
    ) {
      return false;
    }
    if (filter.tag && !(task.tags ?? []).includes(filter.tag)) return false;
    if (q) {
      const hay = `${task.title} ${task.notes ?? ""} ${(task.tags ?? []).join(" ")}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** Every tag in use, deduped and sorted — the filter menu's options. */
export function allTags(tasks: CalendarTask[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) for (const tag of task.tags ?? []) seen.add(tag);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ── Card readouts ───────────────────────────────────────────────────────────

/**
 * iCalendar priority buckets. Deliberately the same thresholds as the calendar's
 * `TasksView` — that component is left untouched, so this is one copy of four
 * numbers rather than a shared import that would mean editing it; a test pins
 * the two together.
 */
export function priorityBucket(p: number): "high" | "normal" | "low" | "none" {
  if (!p) return "none";
  if (p <= 4) return "high";
  if (p === 5) return "normal";
  return "low";
}

/** Overdue: a due date in the past, and not complete. */
export function isOverdue(task: CalendarTask, today: string = todayStr()): boolean {
  if (!task.due || task.percent >= 100) return false;
  return datePart(task.due) < today;
}

export function subtaskProgress(
  task: CalendarTask,
): { done: number; total: number } | null {
  const subs = task.subtasks ?? [];
  if (subs.length === 0) return null;
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

/**
 * Tick or untick a card: completion **and** placement in one edit.
 *
 * Both halves, because they are one fact seen from two surfaces — writing only
 * `percent` would leave the card under a heading that contradicts its checkbox
 * until the next reconcile. Mirrors `TasksView.toggleDone`, which sets the same
 * two completion fields for the same reason.
 */
export function toggleTaskDone(
  task: CalendarTask,
  columns: TaskColumn[],
  now: Date = new Date(),
): CalendarTask {
  const done = task.percent >= 100;
  const target = done ? fallbackColumnId(columns) : doneColumnId(columns);
  return {
    ...task,
    percent: done ? 0 : 100,
    completed: done ? null : toStamp(now),
    column: target ?? task.column,
    // Cleared so the backend files it at the end of its new column rather than
    // wherever its old neighbours happened to sit.
    rank: null,
  };
}

// ── The header badge ────────────────────────────────────────────────────────

/**
 * What the header button counts: cards that are **actionable today** — not done,
 * on a visible calendar, due today or overdue.
 *
 * Derived and recomputed, never acknowledged, for `eventsLeftToday`'s reason:
 * opening the board does not finish anything, so there is nothing a "seen" flag
 * could honestly mean. It falls to zero on its own as the day's cards are ticked
 * and rises again at midnight.
 *
 * **Undated cards are excluded on purpose.** An undated card is a someday, and
 * counting it would pin the badge at a number in the hundreds that never falls —
 * the one failure mode that teaches a user to ignore a badge.
 */
export function todosDueCount(
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: Date = new Date(),
): number {
  const today = todayStr(now);
  const visible = visibleCalendarIds(calendars);
  return tasks.filter(
    (t) =>
      t.percent < 100 &&
      visible.has(t.calendar_id) &&
      !!t.due &&
      datePart(t.due) <= today,
  ).length;
}

/** Whether any counted card is actually *overdue* — emphasis, not a second number. */
export function todosOverdue(
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: Date = new Date(),
): boolean {
  const today = todayStr(now);
  const visible = visibleCalendarIds(calendars);
  return tasks.some((t) => visible.has(t.calendar_id) && isOverdue(t, today));
}

// ── The rails ───────────────────────────────────────────────────────────────

export interface AgendaWindow {
  todayDate: string;
  tomorrowDate: string;
  today: Occurrence[];
  tomorrow: Occurrence[];
}

/**
 * Today's and tomorrow's appointments.
 *
 * `addDays(today, 2)` because `expandEvents`' window is half-open — the same note
 * `eventsLeftToday` carries for its own `+1`. `occurrencesOn` puts a multi-day
 * event under both days, which is what someone scanning "what is tomorrow" wants
 * and what the calendar's own agenda already does.
 */
export function agendaWindow(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date = new Date(),
): AgendaWindow {
  const todayDate = todayStr(now);
  const tomorrowDate = addDays(todayDate, 1);
  const occurrences = expandEvents(
    events,
    todayDate,
    addDays(todayDate, 2),
    visibleCalendarIds(calendars),
  );
  return {
    todayDate,
    tomorrowDate,
    today: sortOccurrences(occurrencesOn(occurrences, todayDate)),
    tomorrow: sortOccurrences(occurrencesOn(occurrences, tomorrowDate)),
  };
}

/** An occurrence that has already ended — dimmed in the rail, never hidden. */
export function occurrencePast(occ: Occurrence, now: Date = new Date()): boolean {
  if (occ.allDay) return false;
  return occ.end <= toStamp(now);
}

/**
 * Which urgent mail the rail shows: the Urgent page first (the backend already
 * sorted it newest-first, and re-sorting here would reorder a *page*), then
 * Important — minus anything already linked to a card that is still open.
 *
 * That subtraction is what makes "make todo" feel like it did something: the row
 * leaves the rail in the same gesture. A message linked only to a *completed*
 * card comes back, because a finished todo is no longer a reason not to be told
 * about the mail again.
 */
export function selectUrgentMail(
  urgent: MailHeader[],
  important: MailHeader[],
  tasks: CalendarTask[],
  limit = 8,
): MailHeader[] {
  const converted = new Set(
    tasks
      .filter((t) => t.percent < 100 && t.mail?.message_id)
      .map((t) => t.mail!.message_id),
  );
  const seen = new Set<string>();
  const out: MailHeader[] = [];
  for (const header of [...urgent, ...important]) {
    if (converted.has(header.id) || seen.has(header.id)) continue;
    seen.add(header.id);
    out.push(header);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Drag geometry ───────────────────────────────────────────────────────────

/**
 * Where a card dropped at `y` should be inserted, given the on-screen rects of
 * the column's other cards.
 *
 * The vertical twin of `CenterPanel`'s inline `computeReorderIndex`, extracted
 * rather than copied inline so it can be tested without a DOM — which matters
 * more here, since the drag gesture itself cannot be tested at all under jsdom.
 */
export function insertionIndex(
  rects: Array<{ top: number; height: number }>,
  y: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    const { top, height } = rects[i];
    if (y < top + height / 2) return i;
  }
  return rects.length;
}

/**
 * How far to scroll when the pointer nears an edge of a scrollable region.
 * Zero in the middle, growing towards the edge and clamped at `max` — so a drag
 * to the far right of the board keeps moving at a readable speed rather than
 * jumping a column per frame.
 */
export function autoscrollDelta(
  near: number,
  far: number,
  pos: number,
  edge = 48,
  max = 18,
): number {
  if (pos < near + edge) {
    const depth = Math.min(edge, near + edge - pos);
    return -Math.ceil((depth / edge) * max);
  }
  if (pos > far - edge) {
    const depth = Math.min(edge, pos - (far - edge));
    return Math.ceil((depth / edge) * max);
  }
  return 0;
}
