import { describe, expect, it } from "vitest";

import {
  DEFAULT_COLUMNS,
  addSubtask,
  applyPending,
  bucketByColumn,
  columnOf,
  filterTasks,
  mintSubtaskId,
  moveSubtask,
  priorityBucket,
  removeSubtask,
  setSubtask,
  stepDropSlot,
  subtaskProgress,
  toggleSubtask,
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

describe("the checklist ops", () => {
  it("appends a step and trims it", () => {
    const out = addSubtask(task(), "  buy the tickets  ");
    expect(out.subtasks).toEqual([
      { id: "t1-s0", title: "buy the tickets", done: false },
    ]);
  });

  it("ignores a blank title rather than adding a nameless row", () => {
    const before = task({ subtasks: [{ id: "a", title: "one", done: false }] });
    expect(addSubtask(before, "   ")).toBe(before);
  });

  it("never reuses the id of a deleted step", () => {
    // The bug this exists to pin: minting `${task.id}-${length}` hands the new
    // step the id the deleted one had, and the two rows then tick each other.
    let card = addSubtask(addSubtask(task(), "one"), "two");
    card = removeSubtask(card, card.subtasks![1].id);
    card = addSubtask(card, "three");
    const ids = card.subtasks!.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(card.subtasks!.map((s) => s.title)).toEqual(["one", "three"]);
  });

  it("mints around ids the backend backfilled", () => {
    const card = task({ subtasks: [{ id: "t1-s0", title: "kept", done: false }] });
    expect(mintSubtaskId(card)).not.toBe("t1-s0");
  });

  it("ticks and unticks one step by id", () => {
    const card = addSubtask(addSubtask(task(), "one"), "two");
    const ticked = toggleSubtask(card, card.subtasks![0].id);
    expect(ticked.subtasks!.map((s) => s.done)).toEqual([true, false]);
    expect(toggleSubtask(ticked, card.subtasks![0].id).subtasks![0].done).toBe(false);
  });

  it("leaves the card alone for an id it does not know", () => {
    const card = addSubtask(task(), "one");
    expect(toggleSubtask(card, "nope").subtasks).toEqual(card.subtasks);
    expect(removeSubtask(card, "nope").subtasks).toEqual(card.subtasks);
    expect(setSubtask(card, "nope", { title: "x" }).subtasks).toEqual(card.subtasks);
  });

  it("never touches percent — 100% would relocate the card to Done", () => {
    let card = addSubtask(addSubtask(task({ percent: 0 }), "one"), "two");
    card = toggleSubtask(card, card.subtasks![0].id);
    card = toggleSubtask(card, card.subtasks![1].id);
    expect(subtaskProgress(card)).toEqual({ done: 2, total: 2 });
    expect(card.percent).toBe(0);
    expect(columnOf(card, COLUMNS)).toBe("backlog");
  });
});

describe("reordering a step", () => {
  const listed = (card: CalendarTask) => (card.subtasks ?? []).map((s) => s.title);
  const three = () => addSubtask(addSubtask(addSubtask(task(), "a"), "b"), "c");

  it("moves a step to an index in the list WITHOUT it", () => {
    const card = three();
    const first = card.subtasks![0].id;
    // "a" pulled out leaves [b, c]; slot 1 is between them.
    expect(listed(moveSubtask(card, first, 1))).toEqual(["b", "a", "c"]);
    expect(listed(moveSubtask(card, first, 2))).toEqual(["b", "c", "a"]);
  });

  it("moves a step upwards", () => {
    const card = three();
    expect(listed(moveSubtask(card, card.subtasks![2].id, 0))).toEqual(["c", "a", "b"]);
  });

  it("clamps a drag that left the list, and never drops a step", () => {
    const card = three();
    const id = card.subtasks![1].id;
    expect(listed(moveSubtask(card, id, -4))).toEqual(["b", "a", "c"]);
    expect(listed(moveSubtask(card, id, 99))).toEqual(["a", "c", "b"]);
  });

  it("is a no-op for a move that changes nothing, and for an unknown id", () => {
    const card = three();
    expect(moveSubtask(card, card.subtasks![1].id, 1)).toBe(card);
    expect(moveSubtask(card, "nope", 0)).toBe(card);
  });

  it("carries the step's own done state and id with it", () => {
    let card = three();
    card = toggleSubtask(card, card.subtasks![2].id);
    const moved = moveSubtask(card, card.subtasks![2].id, 0);
    expect(moved.subtasks![0]).toEqual(card.subtasks![2]);
  });

  it("never touches percent — reordering is not progress", () => {
    const card = three();
    expect(moveSubtask(card, card.subtasks![0].id, 2).percent).toBe(0);
  });
});

describe("stepDropSlot", () => {
  // Three 20px rows starting at y=0, the middle one being dragged.
  const rects = [
    { id: "a", top: 0, height: 20 },
    { id: "b", top: 20, height: 20 },
    { id: "c", top: 40, height: 20 },
  ];

  it("counts the OTHER rows whose midpoint the pointer has passed", () => {
    expect(stepDropSlot(rects, "b", 5)).toBe(0);
    expect(stepDropSlot(rects, "b", 15)).toBe(1);
    expect(stepDropSlot(rects, "b", 55)).toBe(2);
  });

  it("ignores the dragged row's own midpoint", () => {
    // Crossing y=30 is crossing the dragged row itself, which must not count.
    expect(stepDropSlot(rects, "b", 25)).toBe(1);
    expect(stepDropSlot(rects, "b", 35)).toBe(1);
  });
});
