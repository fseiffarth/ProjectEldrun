import { useEffect, useMemo, useRef, useState } from "react";

import type { CalendarTask } from "../../types";
import { calendarColor, useCalendarStore } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import {
  daysLate,
  priorityBucket,
  todosDueCount,
  todosOverdue,
  urgentTodos,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** How often the badge re-reads the clock. Cards fall due at midnight. */
const TICK_MS = 60_000;

/** How many rows a section shows before it says how many it is holding back. */
const SECTION_ROWS = 6;

/**
 * The header's ☑ button — `CalendarIndicator`'s twin, and badged the same way:
 * **derived, never acknowledged**.
 *
 * The number is what is *actionable today* — open cards, on a visible calendar,
 * due today or already overdue. Not "every open card": that is a figure in the
 * hundreds which never falls, and a badge that never falls is one the user learns
 * to ignore. Undated cards are excluded for the same reason — an undated card is
 * a someday, not something today demands.
 *
 * Because it is derived, it needs no dismissal: it drops as the day's cards are
 * ticked and rises again at midnight, which is also why the clock has to be
 * ticked separately (nothing in the store changes when a date rolls over).
 * Whether any of those cards is *overdue* is emphasis on the same badge, never a
 * second number to reconcile against the first.
 *
 * **Hovering reads the cards out** — the calendar button's hover shape, and
 * affordable for its reason: the tasks are already in memory behind one local
 * file, so a pointer crossing the header touches no network and starts no work.
 * Three sections, in the order the day asks about them: **Overdue**, **Today**,
 * **Tomorrow**. Overdue is separate because the badge's own emphasis has to be
 * explainable by something on screen, and tomorrow is separate because a date
 * that is not today, mixed into today's rows, reads as an ordering bug —
 * `CalendarIndicator`'s rule for the same list. Badge and list share ONE
 * selection (`urgentTodos`, which the badge's `todosDueCount` filters the same
 * way) and one `now`, since two `new Date()`s a few lines apart can straddle a
 * midnight, which is exactly the pairing where that would show.
 *
 * A row opens **its own card** (`openCard`), not just the board: a list that has
 * already named the card you want and then drops you at a board of forty is the
 * one place this could still cost a search.
 */
export function TodoIndicator() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const tasks = useCalendarStore((s) => s.tasks);
  const calendars = useCalendarStore((s) => s.calendars);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  // The hover menu's grace period, so crossing the gap between the button and
  // the list below it does not shut the list you are reaching for.
  const closeTimer = useRef<number | undefined>(undefined);
  // Only ever bumped — the value exists to force the recompute, not to be read.
  const [tick, setTick] = useState(0);

  // One local file and an idempotent load, so unlike mail there is no
  // "don't reach out on mount" rule to respect: the badge needs the tasks before
  // the overlay has ever been opened.
  useEffect(() => {
    if (!enabled) return;
    void useCalendarStore.getState().load();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Escape, for the list opened by keyboard focus, which has no mouse-leave
  // coming to close it. Capture + `stopPropagation` because the board overlay's
  // own Escape handler is window-level too, and while this list is up, closing
  // it is what the key meant.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // The setting switched off with the list open would otherwise leave it painted
  // over a button that is gone.
  useEffect(() => {
    if (!enabled) setMenuOpen(false);
  }, [enabled]);

  // One `now` for the badge and the list, re-taken on the same tick.
  const now = useMemo(() => new Date(), [tick]);
  const urgent = useMemo(
    () =>
      enabled
        ? urgentTodos(tasks, calendars, now)
        : { overdue: [], today: [], tomorrow: [] },
    [enabled, tasks, calendars, now],
  );

  if (!enabled) return null;

  const count = todosDueCount(tasks, calendars, now);
  const overdue = todosOverdue(tasks, calendars, now);
  const label =
    count > 0
      ? `${t("todo.indicatorDue", { count })}${overdue ? ` — ${t("todo.indicatorOverdue")}` : ""}`
      : t("todo.indicator");

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 250);
  };

  const section = (
    key: "todo.menuOverdue" | "todo.menuToday" | "todo.menuTomorrow",
    rows: CalendarTask[],
    late: boolean,
  ) => (
    <div className="todo-menu-section">
      {/* A section label inside the scroll region rather than pinned — the menu's
          rule: only the *first* group label is the header. Today and tomorrow
          render even when empty, because "nothing due tomorrow" is an answer and
          a section that disappears reads as a list that failed to load; Overdue
          is the one exception (below), since an absent overdue heading says
          exactly what an empty one would, without the alarm word. */}
      <div className="tab-new-menu-group-label">{t(key)}</div>
      {rows.length === 0 ? (
        <div className="tab-new-menu-hint">{t("todo.menuNothingDue")}</div>
      ) : (
        <>
          {rows.slice(0, SECTION_ROWS).map((task) => {
            const bucket = priorityBucket(task.priority);
            return (
              <button
                key={task.id}
                type="button"
                role="menuitem"
                className={"tab-new-menu-item todo-menu-row" + (late ? " late" : "")}
                title={task.notes || undefined}
                onClick={() => {
                  setMenuOpen(false);
                  window.clearTimeout(closeTimer.current);
                  useTodoStore.getState().openCard(task.id);
                }}
              >
                {/* The card's calendar colour, so a row is recognisable as the
                    same to-do the board and the calendar's Tasks view paint. */}
                <span
                  className="todo-menu-dot"
                  aria-hidden="true"
                  style={{ background: calendarColor(calendars, task.calendar_id) }}
                />
                <span className="todo-menu-title">
                  {task.title || t("calendar.untitled")}
                </span>
                {/* How late, in days — the one thing a heading reading "Overdue"
                    cannot say, and the difference between yesterday and a card
                    that has been rotting for three weeks. */}
                {late && (
                  <span className="todo-menu-late">
                    {t("todo.menuLate", { count: daysLate(task, now) })}
                  </span>
                )}
                {bucket === "high" && (
                  <span className="todo-menu-prio" title={t("tasksView.priorityHigh")}>
                    !
                  </span>
                )}
              </button>
            );
          })}
          {rows.length > SECTION_ROWS && (
            <div className="tab-new-menu-hint">
              {t("todo.menuMore", { count: rows.length - SECTION_ROWS })}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    /* The wrapper the brain, mail and calendar buttons share: `.header-center`
       stretches its children to the full header height, so a bare 32px button
       would sit at the top of the frame instead of centered. The hover handlers
       are the WRAPPER's, not the button's — the list is a child of this element,
       so `mouseleave` holds off while the pointer is anywhere inside it, which is
       what makes a menu hanging below the button walkable into at all. */
    <div
      className="global-apps-menu todo-indicator no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn todo-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          // The button keeps its one job — open (or close) the board. The list
          // goes with the click rather than staying up over the overlay it just
          // raised.
          setMenuOpen(false);
          window.clearTimeout(closeTimer.current);
          const store = useTodoStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
        // Keyboard reach: tabbing to the button is the one way in no pointer will
        // ever open, and Escape is its way back out.
        onFocus={reveal}
      >
        <span className="todo-indicator-icon" aria-hidden="true">
          ☑
        </span>
        {count > 0 && (
          <span
            className={"todo-indicator-badge" + (overdue ? " overdue" : "")}
            aria-hidden="true"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          className="tab-new-menu todo-indicator-menu"
          role="menu"
          aria-label={t("todo.menuUrgent")}
        >
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the wash live on this element, so it must not be the thing
              that scrolls). */}
          <div className="tab-new-menu-group-label">
            {t("todo.menuUrgent")} <UntestedTag />
          </div>
          <div className="menu-scroll-region">
            {/* Only when there is one: a standing "Overdue — nothing due" is the
                word "overdue" in the header every time the pointer passes, for a
                state that is the normal one. */}
            {urgent.overdue.length > 0 && section("todo.menuOverdue", urgent.overdue, true)}
            {section("todo.menuToday", urgent.today, false)}
            {section("todo.menuTomorrow", urgent.tomorrow, false)}
          </div>
        </div>
      )}
    </div>
  );
}
