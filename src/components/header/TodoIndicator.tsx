import { useEffect, useState } from "react";

import { useCalendarStore } from "../../stores/calendar";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { todosDueCount, todosOverdue } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";

/** How often the badge re-reads the clock. Cards fall due at midnight. */
const TICK_MS = 60_000;

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
 */
export function TodoIndicator() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const tasks = useCalendarStore((s) => s.tasks);
  const calendars = useCalendarStore((s) => s.calendars);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  // Only ever bumped — the value exists to force the recompute, not to be read.
  const [, setTick] = useState(0);

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

  if (!enabled) return null;

  const count = todosDueCount(tasks, calendars);
  const overdue = todosOverdue(tasks, calendars);
  const label =
    count > 0
      ? `${t("todo.indicatorDue", { count })}${overdue ? ` — ${t("todo.indicatorOverdue")}` : ""}`
      : t("todo.indicator");

  return (
    /* The wrapper the brain, mail and calendar buttons share: `.header-center`
       stretches its children to the full header height, so a bare 32px button
       would sit at the top of the frame instead of centered. */
    <div className="global-apps-menu todo-indicator no-drag">
      <button
        type="button"
        className="global-apps-menu-btn todo-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        onClick={() => {
          const store = useTodoStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
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
    </div>
  );
}
