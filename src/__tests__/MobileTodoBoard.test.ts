import { describe, expect, it } from "vitest";
import { normalizeTodoBoard } from "../../mobile-web/src/api";

describe("mobile todo board payloads", () => {
  it("normalizes empty collections omitted by an older desktop bridge", () => {
    const board = normalizeTodoBoard({
      columns: [],
      tasks: [{
        id: "task", title: "Untitled", column: "today", done: false,
        priority: 0, percent: 0, calendar_id: "calendar",
      }] as never,
    } as never);

    expect(board.calendars).toEqual([]);
    expect(board.projects).toEqual([]);
    expect(board.tasks[0]).toMatchObject({ notes: "", tags: [], subtasks: [] });
  });
});
