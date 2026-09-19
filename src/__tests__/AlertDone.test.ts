/**
 * What the Alerts strip's ✓ does (`lib/alertDone`), the one answer both the
 * side panel and the phone press. Each kind resolves on its own terms and none
 * deletes anything: a card completes through the board coupling, a mail only
 * loses its local priority mark (and the cached list is re-read), an event is
 * muted and the appointment left alone. A row that cannot be resolved throws
 * rather than showing a ✓ that did nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { finishAlert } from "../lib/alertDone";
import type { AlertItem } from "../lib/alerts";
import { useCalendarStore } from "../stores/calendar/calendar";
import { useMailStore } from "../stores/mail";
import { useTodoStore } from "../stores/todo";
import type { CalendarTask } from "../types";

const calls: string[] = [];
const setPriority = vi.fn(async () => {
  calls.push("setPriority");
});
const loadUrgentMail = vi.fn(async () => {
  calls.push("loadUrgentMail");
});
const updateTask = vi.fn(async () => {});
const deleteTask = vi.fn(async () => {});
const deleteEvent = vi.fn(async () => {});

function item(kind: AlertItem["kind"], source: AlertItem["source"]): AlertItem {
  return {
    id: `${kind}:x`,
    kind,
    severity: "soon",
    title: "t",
    detail: "",
    at: null,
    allDay: false,
    minutesAway: null,
    daysAway: null,
    source,
  };
}

const task: CalendarTask = {
  id: "task-1",
  calendar_id: "cal",
  title: "Write tests",
  priority: 0,
  percent: 40,
  column: "doing",
  rank: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  useMailStore.setState({ setPriority });
  useTodoStore.setState({ loadUrgentMail });
  useCalendarStore.setState({ tasks: [task], taskColumns: [], updateTask, deleteTask, deleteEvent });
});

describe("mail", () => {
  it("clears the local priority mark, then re-reads the cached list", async () => {
    await finishAlert(item("mail", { mailId: "m-1" }), vi.fn());
    expect(setPriority).toHaveBeenCalledWith("m-1", null);
    expect(calls).toEqual(["setPriority", "loadUrgentMail"]);
  });

  it("throws on a row without a mail id", async () => {
    await expect(finishAlert(item("mail", {}), vi.fn())).rejects.toThrow("Missing mail id");
    expect(setPriority).not.toHaveBeenCalled();
  });
});

describe("event", () => {
  it("mutes the row and touches no store", async () => {
    const mute = vi.fn();
    await finishAlert(item("event", { eventId: "e-1" }), mute);
    expect(mute).toHaveBeenCalledWith("event:x");
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(setPriority).not.toHaveBeenCalled();
  });
});

describe("task", () => {
  it("completes the card into the board's Done column — the same act as ticking it there", async () => {
    const mute = vi.fn();
    await finishAlert(item("task", { taskId: "task-1" }), mute);
    expect(updateTask).toHaveBeenCalledTimes(1);
    const written = (updateTask.mock.calls[0] as unknown as [CalendarTask])[0];
    expect(written).toMatchObject({ id: "task-1", percent: 100, column: "done", rank: null });
    expect(written.completed).toBeTruthy();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(mute).not.toHaveBeenCalled();
  });

  it("throws for a missing id and for a card that has left the store", async () => {
    await expect(finishAlert(item("task", {}), vi.fn())).rejects.toThrow("Missing task id");
    await expect(finishAlert(item("task", { taskId: "gone" }), vi.fn())).rejects.toThrow("Missing task");
    expect(updateTask).not.toHaveBeenCalled();
  });
});
