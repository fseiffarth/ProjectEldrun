import { describe, expect, it } from "vitest";

import {
  DEFAULT_COLUMNS,
  applyPending,
  bucketByColumn,
  columnOf,
  filterTasks,
  priorityBucket,
  toggleTaskDone,
} from "../lib/todoBoard";
import type { CalendarTask, TaskColumn } from "../types";

/**
 * Which column a card is *shown* in, and the completion coupling around it.
 *
 * The board and the calendar's Tasks view are two views of one set of tasks, and
 * only these rules keep them from contradicting each other — the Tasks view
 * writes `percent` and knows nothing about columns, so "completion wins" is what
 * stops a ticked task sitting under a heading that says it is in progress.
 */

const COLUMNS = DEFAULT_COLUMNS;
const VISIBLE = new Set(["work"]);

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t1",
    calendar_id: "work",
    title: "write it down",
    priority: 0,
    percent: 0,
    ...over,
  };
}

describe("columnOf", () => {
  it("shows a never-placed card in the first column", () => {
    // The backend deliberately does not backfill a column on read, so this is
    // every card created by the calendar's Tasks view or an ICS import.
    expect(columnOf(task(), COLUMNS)).toBe("backlog");
  });

  it("shows a card whose column was deleted in the first column", () => {
    expect(columnOf(task({ column: "gone" }), COLUMNS)).toBe("backlog");
  });

  it("honours a real column", () => {
    expect(columnOf(task({ column: "doing" }), COLUMNS)).toBe("doing");
  });

  it("puts a completed card in Done whatever its column says", () => {
    // The drift case: ticked in the calendar's Tasks view, which never touches
    // `column`.
    expect(columnOf(task({ column: "doing", percent: 100 }), COLUMNS)).toBe("done");
  });

  it("takes an un-completed card back out of Done", () => {
    expect(columnOf(task({ column: "done", percent: 0 }), COLUMNS)).toBe("backlog");
  });

  it("leaves placement alone when the board has no Done column", () => {
    const columns: TaskColumn[] = COLUMNS.filter((c) => !c.done);
    expect(columnOf(task({ column: "doing", percent: 100 }), columns)).toBe("doing");
  });
});

describe("bucketByColumn", () => {
  it("puts every card in exactly one column", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", column: "doing" }),
      task({ id: "c", percent: 100 }),
      task({ id: "d", column: "nonsense" }),
    ];
    const buckets = bucketByColumn(tasks, COLUMNS, "2026-07-08");
    const total = [...buckets.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(4);
    expect(buckets.get("backlog")!.map((t) => t.id)).toEqual(["a", "d"]);
    expect(buckets.get("doing")!.map((t) => t.id)).toEqual(["b"]);
    expect(buckets.get("done")!.map((t) => t.id)).toEqual(["c"]);
  });
});

describe("toggleTaskDone", () => {
  it("sets completion AND moves the card, in one edit", () => {
    const out = toggleTaskDone(task({ column: "doing" }), COLUMNS, new Date("2026-07-08T10:00"));
    expect(out.percent).toBe(100);
    expect(out.completed).toBeTruthy();
    expect(out.column).toBe("done");
  });

  it("clears both halves when unticked", () => {
    const done = task({ column: "done", percent: 100, completed: "2026-07-08T10:00" });
    const out = toggleTaskDone(done, COLUMNS);
    expect(out.percent).toBe(0);
    // Not left behind: the Tasks view reads `percent >= 100`, so a stale stamp
    // would show the card done there and open here.
    expect(out.completed).toBeNull();
    expect(out.column).toBe("backlog");
  });
});

describe("filterTasks", () => {
  const base = {
    search: "",
    project: null,
    tag: null,
    hideDone: false,
    visibleCalendars: VISIBLE,
  } as const;

  it("drops cards on a hidden calendar", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", calendar_id: "hidden" })];
    expect(filterTasks(tasks, { ...base }).map((t) => t.id)).toEqual(["a"]);
  });

  it("hides done cards on request", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", percent: 100 })];
    expect(filterTasks(tasks, { ...base, hideDone: true }).map((t) => t.id)).toEqual(["a"]);
  });

  it("filters by project, including 'no project'", () => {
    const tasks = [task({ id: "a", project_id: "p1" }), task({ id: "b" })];
    expect(filterTasks(tasks, { ...base, project: "p1" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTasks(tasks, { ...base, project: "none" }).map((t) => t.id)).toEqual(["b"]);
  });

  it("filters by tag", () => {
    const tasks = [task({ id: "a", tags: ["docs"] }), task({ id: "b", tags: ["ops"] })];
    expect(filterTasks(tasks, { ...base, tag: "docs" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("searches title, notes and tags", () => {
    const tasks = [
      task({ id: "a", title: "ship the release" }),
      task({ id: "b", title: "x", notes: "release notes" }),
      task({ id: "c", title: "y", tags: ["release"] }),
      task({ id: "d", title: "unrelated" }),
    ];
    expect(filterTasks(tasks, { ...base, search: "release" }).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("composes filters", () => {
    const tasks = [
      task({ id: "a", project_id: "p1", tags: ["docs"], title: "write" }),
      task({ id: "b", project_id: "p1", tags: ["ops"], title: "write" }),
      task({ id: "c", project_id: "p2", tags: ["docs"], title: "write" }),
    ];
    const out = filterTasks(tasks, { ...base, project: "p1", tag: "docs", search: "write" });
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("applyPending", () => {
  it("overlays a staged placement without touching anything else", () => {
    const tasks = [task({ id: "a", column: "backlog", rank: 1024 })];
    const out = applyPending(tasks, { a: { column: "doing", rank: 512 } });
    expect(out[0].column).toBe("doing");
    expect(out[0].rank).toBe(512);
    expect(out[0].title).toBe(tasks[0].title);
  });

  it("returns the same array when nothing is staged", () => {
    const tasks = [task()];
    expect(applyPending(tasks, {})).toBe(tasks);
  });
});

describe("priorityBucket", () => {
  it("uses the calendar Tasks view's own thresholds", () => {
    // Pinned deliberately: `TasksView` is left untouched by this feature, so
    // these four numbers are one copy that must not drift from it.
    expect(priorityBucket(0)).toBe("none");
    expect([1, 2, 3, 4].map(priorityBucket)).toEqual(["high", "high", "high", "high"]);
    expect(priorityBucket(5)).toBe("normal");
    expect([6, 9].map(priorityBucket)).toEqual(["low", "low"]);
  });
});
