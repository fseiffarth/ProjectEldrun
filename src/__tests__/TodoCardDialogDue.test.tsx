/**
 * The card dialog's **deadline** as the user builds it: a date, the "Set a time"
 * switch, and the calendar's own clock field — proving the three fold back into
 * one `due` on save, exactly as the calendar folds a date + hour into `start`.
 *
 * This exists because the field is the one the user kept reporting broken, and a
 * component test of `TimeField` alone could never see it: the breakage, if any,
 * is in how the dialog wires the field's value back into `due`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TodoCardDialog } from "../components/todo/TodoCardDialog";
import { useSettingsStore } from "../stores/settings";
import { useCalendarStore } from "../stores/calendar";
import { useProjectsStore } from "../stores/projects";
import type { CalendarTask, TaskColumn } from "../types";

const COLUMNS: TaskColumn[] = [{ id: "todo", name: "To do", position: 0, done: false }];

function newTask(): CalendarTask {
  return { id: "", calendar_id: "cal1", title: "", priority: 0, percent: 0 };
}

function mount(
  task: CalendarTask,
  createTask = vi.fn(async (t: Omit<CalendarTask, "id">) => ({ ...t, id: "new" })),
) {
  useSettingsStore.setState({
    settings: { time_format_24h: true, calendar_global_app: false },
    loaded: true,
  });
  useCalendarStore.setState({
    calendars: [{ id: "cal1", name: "Cal", color: "#888", visible: true, readonly: false }],
    createTask,
    updateTask: vi.fn(async () => {}),
  });
  useProjectsStore.setState({ projects: [] });
  const r = render(
    <TodoCardDialog task={task} columns={COLUMNS} onClose={vi.fn()} onOpenMail={vi.fn()} />,
  );
  return { r, createTask };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TodoCardDialog due date + time", () => {
  it("saves a whole-day deadline (date only) when the time switch is off", async () => {
    const user = userEvent.setup();
    const { r, createTask } = mount(newTask());
    await user.type(r.getByLabelText(/title/i), "Pay rent");
    const date = r.container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2026-08-01" } });
    // No time set: the deadline is the bare date, overdue at midnight.
    await user.click(r.getByRole("button", { name: /^add$/i }));
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0].due).toBe("2026-08-01");
  });

  it("reveals the clock field only when the switch is on, and saves the hour", async () => {
    const user = userEvent.setup();
    const { r, createTask } = mount(newTask());
    await user.type(r.getByLabelText(/title/i), "Standup");

    // The switch is always usable; the clock is hidden until it is on.
    const toggle = r.getByRole("checkbox", { name: /set a time/i }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(r.queryByLabelText(/due time \(h\)/i)).toBeNull();

    const date = r.container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2026-08-01" } });
    await user.click(toggle);

    const hour = r.getByLabelText(/due time \(h\)/i);
    await user.click(hour);
    await user.keyboard("0915");

    await user.click(r.getByRole("button", { name: /^add$/i }));
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0].due).toBe("2026-08-01T09:15");
  });

  it("lands on today when the switch is flipped on with no date picked", async () => {
    const user = userEvent.setup();
    const { r, createTask } = mount(newTask());
    await user.type(r.getByLabelText(/title/i), "Call");

    // No date, straight to the switch — it fills today so the hour has a day.
    await user.click(r.getByRole("checkbox", { name: /set a time/i }));
    const date = r.container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const hour = r.getByLabelText(/due time \(h\)/i);
    await user.click(hour);
    await user.keyboard("0915");

    await user.click(r.getByRole("button", { name: /^add$/i }));
    expect(createTask.mock.calls[0][0].due).toBe(`${date.value}T09:15`);
  });

  it("opens an hour-deadline card with the switch on and the clock filled", () => {
    const task: CalendarTask = { ...newTask(), id: "t1", title: "X", due: "2026-08-01T17:30" };
    const { r } = mount(task);
    const toggle = r.getByRole("checkbox", { name: /set a time/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect((r.getByLabelText(/due time \(h\)/i) as HTMLInputElement).value).toBe("17");
    expect((r.getByLabelText(/due time \(min\)/i) as HTMLInputElement).value).toBe("30");
  });
});
