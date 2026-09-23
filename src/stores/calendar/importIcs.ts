/**
 * The `.ics` import itself, once it is going ahead — shared by the calendar's
 * Import button and by a file a root agent staged for review
 * (`calendar_import_ics`, `services::root_mcp_import`), so the two cannot drift.
 *
 * Imported items land in their own calendar: an import is undone by deleting
 * that one calendar, and can never silently mix into "Personal". The calendar
 * is marked `imported`, which is what lets the root agent's read tools show its
 * text as someone else's (`root_mcp::event_view`).
 */
import { parseIcs } from "../../lib/calendar/ics";
import { useCalendarStore } from "./calendar";

export interface IcsImportResult {
  events: number;
  tasks: number;
  skipped: number;
  calendarName: string;
}

export async function importIcsText(text: string, calendarName: string): Promise<IcsImportResult> {
  const parsed = parseIcs(text);
  const { createCalendar, createEvent, createTask, deleteCalendar } = useCalendarStore.getState();
  const target = await createCalendar({
    name: calendarName,
    color: "#8d8fd6",
    visible: true,
    readonly: false,
    imported: true,
  });
  try {
    for (const e of parsed.events) {
      await createEvent({ ...e, calendar_id: target.id });
    }
    for (const tk of parsed.tasks) {
      await createTask({ ...tk, calendar_id: target.id });
    }
  } catch (error) {
    // A row that could not be written leaves no partial calendar behind: the
    // one just created goes with whatever landed in it, and the failure is
    // reported with the calendar's name so the user knows what was undone.
    // Should the delete itself fail, the name still says where to look.
    const cleaned = await deleteCalendar(target.id).then(() => true, () => false);
    throw new Error(`${String(error)} (${cleaned ? "removed the partial calendar" : "a partial calendar remains"} "${target.name}")`);
  }
  return {
    events: parsed.events.length,
    tasks: parsed.tasks.length,
    skipped: parsed.skipped,
    calendarName: target.name,
  };
}
