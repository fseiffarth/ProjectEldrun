import { useEffect, useRef, useState } from "react";

import type { CalendarTask, TaskColumn } from "../../types";
import { useT } from "../../lib/i18n";
import { TodoCard } from "./TodoCard";

interface Props {
  column: TaskColumn;
  columns: TaskColumn[];
  title: string;
  cards: CalendarTask[];
  /** Matching cards, including any hidden by the board's "Hide done" toggle. */
  cardCount: number;
  /**
   * Where the drop placeholder sits in this column, or null when not the target.
   *
   * An index into this column's cards **with the dragged card removed** — the
   * one index space the whole gesture counts in (see `CardDrag.overIndex`), and
   * therefore the space this list has to be rendered in.
   */
  placeholderIndex: number | null;
  placeholderHeight: number;
  /** This column is the one under the pointer — tint it, so the aim is legible. */
  dropTarget: boolean;
  draggingId: string | null;
  onCardPointerDown: (e: React.PointerEvent, task: CalendarTask, el: HTMLElement) => void;
  onEditCard: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
  onAddCard: (columnId: string) => void;
  onRename: (columnId: string, name: string) => void;
  onDelete: (column: TaskColumn, count: number) => void;
  onMove: (columnId: string, delta: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}

/**
 * One column: a header, its cards, and the add-a-card button.
 *
 * **Adding a card opens the full card dialog**, the same editor a card is edited
 * in — not an inline title composer. A title-only composer wrote the card to
 * `calendar.json` before anything else about it was known, which is what made
 * abandoning one impossible: the "cancel" that followed was a *delete* of a row
 * that already existed. The dialog stages the whole card instead, so nothing is
 * written until Save and Cancel costs nothing.
 *
 * Escape in the rename input must `stopPropagation` — the overlay host listens
 * for Escape on `window`, and `stopPropagation` does not stop *other* listeners
 * on the same target, so every text input inside the board carries this guard.
 */
export function TodoColumn({
  column,
  columns,
  title,
  cards,
  cardCount,
  placeholderIndex,
  placeholderHeight,
  dropTarget,
  draggingId,
  onCardPointerDown,
  onEditCard,
  onOpenMail,
  onAddCard,
  onRename,
  onDelete,
  onMove,
  canMoveLeft,
  canMoveRight,
}: Props) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) nameRef.current?.focus();
  }, [renaming]);

  const overLimit = !!column.limit && column.limit > 0 && cardCount > column.limit;

  /**
   * The cards actually rendered: the dragged one is **taken out**, not left in
   * place and faded.
   *
   * It is the placeholder that stands in for it, and that is what keeps the
   * preview honest — `placeholderIndex` is measured against the other cards'
   * rects and committed as an index into exactly this list, so leaving the card
   * in shifted every slot below it by one and the board offered the card's own
   * position as the new one. Nothing jumps when it goes: the drag opens with the
   * placeholder on the slot the card is lifted from, at the height it was
   * measured at.
   */
  const visible = draggingId ? cards.filter((task) => task.id !== draggingId) : cards;

  const placeholder = (
    <div
      key="placeholder"
      className="todo-card-placeholder"
      style={{ height: placeholderHeight }}
    />
  );

  const rows: React.ReactNode[] = [];
  visible.forEach((task, i) => {
    if (placeholderIndex === i) rows.push(placeholder);
    rows.push(
      <TodoCard
        key={task.id}
        task={task}
        columns={columns}
        onPointerDown={onCardPointerDown}
        onEdit={onEditCard}
        onOpenMail={onOpenMail}
      />,
    );
  });
  if (placeholderIndex !== null && placeholderIndex >= visible.length) {
    rows.push(placeholder);
  }

  return (
    <section
      className={"todo-column" + (dropTarget ? " todo-column-drop" : "")}
      data-column-id={column.id}
    >
      <header className="todo-column-head" style={{ borderTopColor: column.color || undefined }}>
        {renaming ? (
          <input
            ref={nameRef}
            className="todo-column-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              const next = nameDraft.trim();
              if (next && next !== column.name) onRename(column.id, next);
              else setNameDraft(column.name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setNameDraft(column.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="todo-column-name"
            onClick={() => {
              setNameDraft(column.name);
              setRenaming(true);
            }}
            title={t("todoBoard.renameColumn")}
          >
            {title}
          </button>
        )}

        <span
          className={"todo-column-count" + (overLimit ? " todo-column-over" : "")}
          title={
            column.limit
              ? t("todoBoard.wipLimit", { count: cardCount, limit: column.limit })
              : t("todoBoard.cardCount", { count: cardCount })
          }
        >
          {column.limit ? `${cardCount}/${column.limit}` : cardCount}
        </span>

        <span className="todo-column-actions">
          <button
            type="button"
            className="todo-column-btn"
            disabled={!canMoveLeft}
            onClick={() => onMove(column.id, -1)}
            title={t("todoBoard.moveLeft")}
            aria-label={t("todoBoard.moveLeft")}
          >
            ‹
          </button>
          <button
            type="button"
            className="todo-column-btn"
            disabled={!canMoveRight}
            onClick={() => onMove(column.id, 1)}
            title={t("todoBoard.moveRight")}
            aria-label={t("todoBoard.moveRight")}
          >
            ›
          </button>
          <button
            type="button"
            className="todo-column-btn todo-column-btn-danger"
            onClick={() => onDelete(column, cardCount)}
            title={t("todoBoard.deleteColumn")}
            aria-label={t("todoBoard.deleteColumn")}
          >
            ×
          </button>
        </span>
      </header>

      <div className="todo-column-body">
        {rows.length === 0 && placeholderIndex === null ? (
          <div className="todo-column-empty">{t("todoBoard.emptyColumn")}</div>
        ) : (
          rows
        )}
      </div>

      <footer className="todo-column-foot">
        <button type="button" className="todo-add-card" onClick={() => onAddCard(column.id)}>
          + {t("todoBoard.addCard")}
        </button>
      </footer>
    </section>
  );
}
