import { useEffect, useMemo, useRef } from "react";

import type { CalendarTask, TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar";
import { useTodoStore } from "../../stores/todo";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { toStamp, todayStr } from "../../lib/calendarTime";
import {
  autoscrollDelta,
  bucketByColumn,
  columnTitle,
  doneColumnId,
  insertionIndex,
  orderedColumn,
  provisionalRank,
} from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { TodoColumn } from "./TodoColumn";

interface Props {
  columns: TaskColumn[];
  /** Already filtered and already carrying the optimistic overlay. */
  tasks: CalendarTask[];
  defaultCalendarId: string;
  /** The project a new card inherits, or null. */
  inheritProjectId: string | null;
  onEditCard: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
}

/** How far the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 5;

/**
 * The board, and the owner of the card-drag gesture.
 *
 * **The commit is bound at pointerdown**, synchronously, before any state change
 * or re-render. That is not a style choice: under WebKitGTK, listeners added
 * *mid-gesture* receive `pointermove` but never the terminal `pointerup`
 * (`TabBar` documents the same trap at its own drag), so an effect keyed on "a
 * drag is in flight" can drive the preview and must never be the committer.
 *
 * Pointer capture goes on `documentElement`, never on the dragged card: the card
 * unmounts mid-gesture as the placeholder re-renders or it crosses a column, and
 * removing a capture *target* drops the capture — which on WebView2 fires a
 * spurious `pointercancel`, i.e. (since `cancelCommits` is true there) a commit
 * at the wrong moment.
 *
 * And because `pointercancel` **commits** on Linux — WebKitGTK fires it instead
 * of `pointerup` when its selection heuristic claims the stream — the commit has
 * to be safe under a target the user never really chose. With no column under the
 * pointer it does nothing and the card stays where it was; "no target" is never
 * mapped to a default column, and never to a delete.
 */
export function TodoBoard({
  columns,
  tasks,
  defaultCalendarId,
  inheritProjectId,
  onEditCard,
  onOpenMail,
}: Props) {
  const t = useT();
  const storedColumns = useCalendarStore((s) => s.taskColumns);
  const cardDrag = useTodoStore((s) => s.cardDrag);
  const boardRef = useRef<HTMLDivElement>(null);
  /** Latest pointer position, read by the autoscroll loop without re-rendering. */
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  const today = todayStr();
  const buckets = useMemo(
    () => bucketByColumn(tasks, columns, today),
    [tasks, columns, today],
  );

  // ── Drag ────────────────────────────────────────────────────────────────

  /** Hit-test the pointer against the columns and update the drop target. */
  const retarget = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const columnEl = el?.closest<HTMLElement>(".todo-column");
    const columnId = columnEl?.dataset.columnId ?? null;
    if (!columnId) {
      useTodoStore.getState().setCardTarget(null, null);
      return;
    }
    const drag = useTodoStore.getState().cardDrag;
    const rects = Array.from(
      columnEl!.querySelectorAll<HTMLElement>(".todo-card"),
    )
      // The dragged card is still mounted (faded) so the column does not jump;
      // it must not be one of the slots the drop is measured against.
      .filter((node) => node.dataset.taskId !== drag?.taskId)
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });
    useTodoStore.getState().setCardTarget(columnId, insertionIndex(rects, y));
  };

  const startAutoscroll = () => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const { x, y } = pointerRef.current;
      const board = boardRef.current;
      if (board) {
        const r = board.getBoundingClientRect();
        const dx = autoscrollDelta(r.left, r.right, x);
        if (dx) board.scrollLeft += dx;
        const columnEl = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>(".todo-column")
          ?.querySelector<HTMLElement>(".todo-column-body");
        let dy = 0;
        if (columnEl) {
          const cr = columnEl.getBoundingClientRect();
          dy = autoscrollDelta(cr.top, cr.bottom, y);
          if (dy) columnEl.scrollTop += dy;
        }
        // Re-hit-test after scrolling, or the placeholder lags behind the cards
        // the scroll just revealed.
        if (dx || dy) retarget(x, y);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopAutoscroll = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  useEffect(() => stopAutoscroll, []);

  const commitMove = async (task: CalendarTask, columnId: string, index: number) => {
    const todo = useTodoStore.getState();
    const siblings = orderedColumn(buckets.get(columnId) ?? [], today).filter(
      (t) => t.id !== task.id,
    );
    const before = index > 0 ? (siblings[index - 1]?.rank ?? null) : null;
    const after = siblings[index]?.rank ?? null;

    // Optimistic, in the same tick as the pointerup: the card is in its new slot
    // on the very next paint, so the write-through never shows as a snap-back.
    // The rank here is display-only — `todo_move_tasks` recomputes it from the
    // index, which is what keeps a replayed placement a no-op.
    todo.stageMove(task.id, columnId, provisionalRank(before, after));
    try {
      await useCalendarStore.getState().moveTasks([
        {
          id: task.id,
          column: columnId,
          index,
          // The frontend owns the clock: the backend has no local-time source,
          // so a move that completes a card is stamped from here.
          completed_stamp: toStamp(new Date()),
        },
      ]);
    } catch (err) {
      todo.setError(String(err));
    } finally {
      // Dropped only after the store has the backend's answer, so the card does
      // not move a pixel between the two.
      todo.settleMove(task.id);
    }
  };

  const onCardPointerDown = (
    e: React.PointerEvent,
    task: CalendarTask,
    el: HTMLElement,
  ) => {
    if (e.button !== 0) return;
    // Suppress WebKitGTK's native selection gesture, which otherwise hijacks the
    // pointer stream and ends it with a cancel mid-drag.
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const rect = el.getBoundingClientRect();
    const captureEl = document.documentElement;
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is an optimization; the gesture works without it */
          }
        }
        useTodoStore.getState().startCardDrag({
          taskId: task.id,
          fromColumn: task.column || columns[0]?.id || "",
          title: task.title,
          width: rect.width,
          height: rect.height,
          grabDx: startX - rect.left,
          grabDy: startY - rect.top,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          overColumn: null,
          overIndex: null,
        });
        startAutoscroll();
      }
      useTodoStore.getState().moveCardDrag(ev.clientX, ev.clientY);
      retarget(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      stopAutoscroll();
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
      }
    };

    const onCommit = () => {
      cleanup();
      const drag = useTodoStore.getState().cardDrag;
      if (!drag) return; // never crossed the threshold, or already ended
      useTodoStore.getState().endCardDrag();
      // No target — including every `pointercancel` WebKitGTK turned into a
      // commit — leaves the card exactly where it was.
      if (!drag.overColumn || drag.overIndex === null) return;
      void commitMove(task, drag.overColumn, drag.overIndex);
    };

    const onAbort = () => {
      cleanup();
      useTodoStore.getState().endCardDrag();
    };

    window.addEventListener("pointermove", onMove);
    // Synchronously, before any render: see the component doc.
    bindDragRelease({ onCommit, onAbort });
  };

  // ── Column edits ────────────────────────────────────────────────────────

  const addCard = async (columnId: string, title: string) => {
    const column = buckets.get(columnId) ?? [];
    const top = orderedColumn(column, today)[0]?.rank ?? null;
    await useCalendarStore.getState().createTask({
      calendar_id: defaultCalendarId,
      title,
      due: null,
      priority: 0,
      percent: 0,
      column: columnId,
      rank: provisionalRank(null, top),
      created: toStamp(new Date()),
      // A card created under a project filter inherits it — otherwise it
      // vanishes the instant it is created, which reads as a broken button.
      ...(inheritProjectId ? { project_id: inheritProjectId } : {}),
    });
  };

  const setColumns = (next: TaskColumn[], fallback?: string | null) =>
    useCalendarStore
      .getState()
      .setColumns(next, fallback ?? null)
      .catch((err) => useTodoStore.getState().setError(String(err)));

  const renameColumn = (columnId: string, name: string) =>
    void setColumns(columns.map((c) => (c.id === columnId ? { ...c, name } : c)));

  const deleteColumn = (column: TaskColumn, count: number) => {
    if (columns.length <= 1) return;
    const ok = window.confirm(
      t("todoBoard.deleteColumnConfirm", { name: column.name, count }),
    );
    if (!ok) return;
    void setColumns(columns.filter((c) => c.id !== column.id));
  };

  const moveColumn = (columnId: string, delta: -1 | 1) => {
    const index = columns.findIndex((c) => c.id === columnId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    void setColumns(next.map((c, i) => ({ ...c, position: i })));
  };

  const addColumn = () => {
    const name = window.prompt(t("todoBoard.columnNamePlaceholder"));
    if (!name?.trim()) return;
    void setColumns([
      ...columns,
      {
        id: "",
        name: name.trim(),
        position: columns.length,
        done: false,
      },
      // The backend mints the id for an entry that carries none.
    ].map((c, i) => ({ ...c, position: i })));
  };

  // The done column keeps its place at the right; nothing enforces that, it is
  // simply where `position` puts it.
  const doneId = doneColumnId(columns);

  return (
    <div
      className={"todo-board" + (cardDrag ? " dragging" : "")}
      ref={boardRef}
    >
      {columns.map((column, i) => (
        <TodoColumn
          key={column.id}
          column={column}
          columns={columns}
          title={columnTitle(column, t, storedColumns)}
          cards={buckets.get(column.id) ?? []}
          placeholderIndex={
            cardDrag?.overColumn === column.id ? cardDrag.overIndex : null
          }
          placeholderHeight={cardDrag?.height ?? 0}
          draggingId={cardDrag?.taskId ?? null}
          onCardPointerDown={onCardPointerDown}
          onEditCard={onEditCard}
          onOpenMail={onOpenMail}
          onAddCard={addCard}
          onRename={renameColumn}
          onDelete={deleteColumn}
          onMove={moveColumn}
          canMoveLeft={i > 0}
          canMoveRight={i < columns.length - 1 && column.id !== doneId}
        />
      ))}

      <div className="todo-column todo-column-add">
        <button type="button" className="todo-add-column" onClick={addColumn}>
          + {t("todoBoard.addColumn")}
        </button>
      </div>

      {cardDrag && (
        /* `position: fixed` + left/top, the shape `.tab-drag-ghost` already
           proved fast under WebKitGTK — and `pointer-events: none`, or the ghost
           becomes `elementFromPoint`'s answer and the drop targets itself. */
        <div
          className="todo-drag-ghost"
          style={{
            left: cardDrag.pointerX - cardDrag.grabDx,
            top: cardDrag.pointerY - cardDrag.grabDy,
            width: cardDrag.width,
          }}
        >
          {cardDrag.title}
        </div>
      )}
    </div>
  );
}
