import { useEffect, useRef, useState } from "react";

import type { CalendarTask, TaskColumn } from "../../types";
import { useTodoStore } from "../../stores/todo";
import { useT } from "../../lib/i18n";
import { TodoCard } from "./TodoCard";

interface Props {
  column: TaskColumn;
  columns: TaskColumn[];
  title: string;
  cards: CalendarTask[];
  /** Where the drop placeholder sits in this column, or null when not the target. */
  placeholderIndex: number | null;
  placeholderHeight: number;
  draggingId: string | null;
  onCardPointerDown: (e: React.PointerEvent, task: CalendarTask, el: HTMLElement) => void;
  onEditCard: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
  onAddCard: (columnId: string, title: string) => Promise<void>;
  onRename: (columnId: string, name: string) => void;
  onDelete: (column: TaskColumn, count: number) => void;
  onMove: (columnId: string, delta: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}

/**
 * One column: a header, its cards, and the composer.
 *
 * The composer is Trello's: **Enter creates and leaves it open**, because adding
 * five cards in a row is the gesture a board exists for, and re-clicking "Add a
 * card" four times is what makes people stop using one. Escape closes it and must
 * `stopPropagation` — the overlay host listens for Escape on `window`, and
 * `stopPropagation` does not stop *other* listeners on the same target, so every
 * text input inside the board carries this guard.
 */
export function TodoColumn({
  column,
  columns,
  title,
  cards,
  placeholderIndex,
  placeholderHeight,
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
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (composing) composerRef.current?.focus();
  }, [composing]);
  useEffect(() => {
    if (renaming) nameRef.current?.focus();
  }, [renaming]);

  const submit = async () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    await onAddCard(column.id, value).catch((err) =>
      useTodoStore.getState().setError(String(err)),
    );
    composerRef.current?.focus();
  };

  const overLimit = !!column.limit && column.limit > 0 && cards.length > column.limit;

  const rows: React.ReactNode[] = [];
  cards.forEach((task, i) => {
    if (placeholderIndex === i) {
      rows.push(
        <div
          key="placeholder"
          className="todo-card-placeholder"
          style={{ height: placeholderHeight }}
        />,
      );
    }
    rows.push(
      <TodoCard
        key={task.id}
        task={task}
        columns={columns}
        dragging={draggingId === task.id}
        onPointerDown={onCardPointerDown}
        onEdit={onEditCard}
        onOpenMail={onOpenMail}
      />,
    );
  });
  if (placeholderIndex !== null && placeholderIndex >= cards.length) {
    rows.push(
      <div
        key="placeholder"
        className="todo-card-placeholder"
        style={{ height: placeholderHeight }}
      />,
    );
  }

  return (
    <section className="todo-column" data-column-id={column.id}>
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
              ? t("todoBoard.wipLimit", { count: cards.length, limit: column.limit })
              : t("todoBoard.cardCount", { count: cards.length })
          }
        >
          {column.limit ? `${cards.length}/${column.limit}` : cards.length}
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
            onClick={() => onDelete(column, cards.length)}
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
        {composing ? (
          <div className="todo-composer">
            <textarea
              ref={composerRef}
              className="todo-composer-input"
              rows={2}
              value={draft}
              placeholder={t("todoBoard.addCardPlaceholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft("");
                  setComposing(false);
                }
              }}
              onBlur={() => {
                if (!draft.trim()) setComposing(false);
              }}
            />
            <div className="todo-composer-actions">
              <button
                type="button"
                className="cal-btn cal-btn-primary"
                disabled={!draft.trim()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void submit()}
              >
                {t("common.add")}
              </button>
              <button
                type="button"
                className="cal-link-btn"
                onClick={() => {
                  setDraft("");
                  setComposing(false);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="todo-add-card" onClick={() => setComposing(true)}>
            + {t("todoBoard.addCard")}
          </button>
        )}
      </footer>
    </section>
  );
}
