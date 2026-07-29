import { useCallback, useRef, useState } from "react";

import type { Subtask } from "../../types";
import { stepDropSlot } from "../../lib/todoBoard";

/**
 * Dragging a checklist step into a different position — **once**, for the two
 * surfaces that edit a checklist.
 *
 * A checklist is an ordered list the moment it has more than two entries: the
 * step you have to do first is the one that belongs at the top, and until now the
 * only way to get it there was to delete the other rows and retype them. Both
 * places that render the list (the board card's inline checklist and the full
 * card dialog) get the same gesture from here rather than a copy each — the same
 * bargain `lib/todoBoard`'s ops strike for what an add or a delete means.
 *
 * Three rules are forced by the engines and by where the list sits:
 *
 * - **Pointer events, not HTML5 DnD.** A native drag does not work under
 *   WebKitGTK (`TabBar`, `YamlTree` and `MachinesIndicator` all landed here), and
 *   the dialog's list sits inside a modal, where a drop that misses its target
 *   never fires and would strand a row mid-drag.
 * - **The grip takes the pointer capture**, so `pointerup`/`pointercancel` are
 *   guaranteed to arrive at an element that is still mounted — the rows around it
 *   re-render as the list parts. It is also why the gesture starts on a grip and
 *   not on the row: a row is a checkbox, a title and a delete button, all of
 *   which must stay clickable, and on the board the row additionally sits inside
 *   a card whose own pointerdown starts a *card* drag.
 * - **The DOM order is frozen for the gesture.** Rows are measured once, at
 *   pointerdown, and the others part by `transform` only — which changes no
 *   layout, so the rects stay true. Re-measuring a row that moved against the
 *   cursor that moved it is the feedback loop this avoids.
 *
 * `commit` is handed `(id, to)` where `to` is an index into the list **without**
 * the dragged step — `moveSubtask`'s convention, and what `stepDropSlot` yields.
 */
export interface StepReorder {
  /** The in-flight drag: which step, how far it has been carried, where it would
   *  land. `null` when nothing is being dragged. */
  drag: { id: string; dy: number; to: number } | null;
  /** Register a row element, so the gesture can measure it. */
  rowRef: (id: string) => (el: HTMLElement | null) => void;
  /** Spread onto a row's grip button. */
  gripProps: (id: string) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  };
  /** The transform a row carries this frame: the dragged one follows the
   *  pointer, the others part to open the landing slot. */
  rowStyle: (index: number) => React.CSSProperties | undefined;
  /** Whether this row is the one being dragged (for its own class). */
  isDragging: (id: string) => boolean;
}

export function useStepReorder(
  steps: Subtask[],
  commit: (id: string, to: number) => void,
): StepReorder {
  const [drag, setDrag] = useState<{ id: string; dy: number; to: number } | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const rects = useRef<{ id: string; top: number; height: number }[]>([]);
  const startY = useRef(0);

  const rowRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
    },
    [],
  );

  const gripProps = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      // `preventDefault` keeps the press from selecting the step's text;
      // `stopPropagation` keeps it from reaching the board card underneath,
      // whose pointerdown seeds a card drag.
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      startY.current = e.clientY;
      rects.current = steps.map((s) => {
        const rect = rows.current.get(s.id)?.getBoundingClientRect();
        return { id: s.id, top: rect?.top ?? 0, height: rect?.height ?? 0 };
      });
      setDrag({ id, dy: 0, to: stepDropSlot(rects.current, id, e.clientY) });
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag) return;
      const dy = e.clientY - startY.current;
      const to = stepDropSlot(rects.current, drag.id, e.clientY);
      if (dy !== drag.dy || to !== drag.to) setDrag({ ...drag, dy, to });
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag) return;
      const { id: dragged } = drag;
      setDrag(null);
      commit(dragged, stepDropSlot(rects.current, dragged, e.clientY));
    },
    // A cancelled gesture leaves the list alone. Unlike the *card* drag — where
    // WebKitGTK's `pointercancel` is the terminal event of an ordinary drop, so
    // it has to commit — a step that springs back has cost the user one drag,
    // while a step reordered by a cancel nobody asked for is a silent edit.
    onPointerCancel: () => setDrag(null),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      // A reorder must not be pointer-only: the focused grip nudges by one.
      e.preventDefault();
      e.stopPropagation();
      const from = steps.findIndex((s) => s.id === id);
      if (from < 0) return;
      commit(id, from + (e.key === "ArrowUp" ? -1 : 1));
    },
  });

  const rowStyle = (index: number): React.CSSProperties | undefined => {
    if (!drag) return undefined;
    const from = steps.findIndex((s) => s.id === drag.id);
    if (index === from) return { transform: `translateY(${drag.dy}px)` };
    const height = rects.current.find((r) => r.id === drag.id)?.height ?? 0;
    // `to` is an index into the list without the dragged row, so a row after it
    // compares as `index - 1` and a row before it as `index` — which is what the
    // two asymmetric bounds below say.
    const shift =
      index > from && index <= drag.to ? -height : index < from && index >= drag.to ? height : 0;
    return shift ? { transform: `translateY(${shift}px)` } : undefined;
  };

  return { drag, rowRef, gripProps, rowStyle, isDragging: (id) => drag?.id === id };
}
