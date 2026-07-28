import { useEffect, useRef, useState } from "react";

import type { CalendarTask, TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar";
import { useProjectsStore } from "../../stores/projects";
import { useTodoStore } from "../../stores/todo";
import { datePart, todayStr, addDays } from "../../lib/calendarTime";
import { isOverdue, priorityBucket, subtaskProgress, toggleTaskDone } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";

interface Props {
  task: CalendarTask;
  columns: TaskColumn[];
  /** Draw as the source of the in-flight drag (kept mounted, faded). */
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent, task: CalendarTask, el: HTMLElement) => void;
  onEdit: (task: CalendarTask) => void;
  onOpenMail: (task: CalendarTask) => void;
}

const MAX_TAG_CHIPS = 3;

/**
 * One card.
 *
 * Two rules run through it. **Every inner control stops the pointer**
 * (`onPointerDown` → `stopPropagation`), or clicking a checkbox seeds a drag that
 * the 5px threshold then cancels — the same idiom `TabBar` applies to its own
 * per-tab buttons. And **the title edits inline**, because renaming is the
 * commonest edit on a board; its Escape must `stopPropagation` or the overlay
 * host's window listener tears the whole board down mid-rename.
 */
export function TodoCard({ task, columns, dragging, onPointerDown, onEdit, onOpenMail }: Props) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const today = todayStr();
  const done = task.percent >= 100;
  const overdue = isOverdue(task, today);
  const dueDate = task.due ? datePart(task.due) : null;
  const dueToday = dueDate === today;
  const dueTomorrow = dueDate === addDays(today, 1);
  const priority = priorityBucket(task.priority);
  const steps = subtaskProgress(task);
  const tags = task.tags ?? [];
  const project = task.project_id ? projects.find((p) => p.id === task.project_id) : null;

  const commitTitle = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === task.title) {
      setDraft(task.title);
      return;
    }
    await useCalendarStore
      .getState()
      .updateTask({ ...task, title: next })
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  const toggle = async () => {
    await useCalendarStore
      .getState()
      .updateTask(toggleTaskDone(task, columns))
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={ref}
      className={
        "todo-card" +
        (done ? " todo-card-done" : "") +
        (overdue ? " todo-card-overdue" : "") +
        (dragging ? " todo-card-dragging" : "")
      }
      data-task-id={task.id}
      onPointerDown={(e) => {
        // A card being renamed is an <input>: leave its caret alone.
        if (editing) return;
        if (ref.current) onPointerDown(e, task, ref.current);
      }}
      onDoubleClick={() => onEdit(task)}
    >
      <div className="todo-card-head">
        <input
          type="checkbox"
          className="todo-card-check"
          checked={done}
          onPointerDown={stop}
          onChange={() => void toggle()}
          title={done ? t("todoCard.markNotDone") : t("todoCard.markDone")}
        />

        {editing ? (
          <input
            ref={inputRef}
            className="todo-card-title-input"
            value={draft}
            onPointerDown={stop}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitTitle();
              } else if (e.key === "Escape") {
                // Or the overlay host's window listener closes the board.
                e.stopPropagation();
                setDraft(task.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="todo-card-title"
            onPointerDown={stop}
            onClick={() => {
              setDraft(task.title);
              setEditing(true);
            }}
            title={t("todoCard.renameTitle")}
          >
            {task.title}
          </button>
        )}

        <button
          type="button"
          className="todo-card-edit"
          onPointerDown={stop}
          onClick={() => onEdit(task)}
          title={t("todoCard.edit")}
          aria-label={t("todoCard.edit")}
        >
          ✎
        </button>
      </div>

      {(dueDate || priority !== "none" || tags.length > 0) && (
        <div className="todo-card-chips">
          {dueDate && (
            <span
              className={
                "todo-chip todo-chip-due" +
                (overdue ? " todo-chip-overdue" : dueToday ? " todo-chip-today" : "")
              }
              title={
                overdue
                  ? t("todoCard.overdue")
                  : dueToday
                    ? t("todoCard.dueToday")
                    : dueTomorrow
                      ? t("todoCard.dueTomorrow")
                      : dueDate
              }
            >
              ⏰ {dueDate}
            </span>
          )}
          {priority !== "none" && (
            <span className={`todo-chip todo-chip-prio todo-chip-prio-${priority}`}>
              {priority === "high"
                ? t("tasksView.priorityHigh")
                : priority === "normal"
                  ? t("tasksView.priorityNormal")
                  : t("tasksView.priorityLow")}
            </span>
          )}
          {tags.slice(0, MAX_TAG_CHIPS).map((tag) => (
            <span key={tag} className="todo-chip todo-chip-tag">
              #{tag}
            </span>
          ))}
          {tags.length > MAX_TAG_CHIPS && (
            <span className="todo-chip todo-chip-more">
              {t("todoCard.moreTags", { count: tags.length - MAX_TAG_CHIPS })}
            </span>
          )}
        </div>
      )}

      {steps && (
        <div
          className="todo-card-steps"
          title={t("todoCard.subtaskProgress", { done: steps.done, total: steps.total })}
        >
          <span className="todo-card-steps-bar">
            <span
              className="todo-card-steps-fill"
              style={{ width: `${(steps.done / steps.total) * 100}%` }}
            />
          </span>
          <span className="todo-card-steps-text">
            {steps.done}/{steps.total}
          </span>
        </div>
      )}

      {(task.project_id || task.mail) && (
        <div className="todo-card-foot">
          {task.project_id && (
            <button
              type="button"
              className={"todo-card-project" + (project ? "" : " todo-card-project-unknown")}
              onPointerDown={stop}
              onClick={() => {
                if (project) void useProjectsStore.getState().setActive(project.id);
              }}
              title={project ? t("todoCard.openProject") : t("todoCard.unknownProject")}
              disabled={!project}
            >
              ⬤ {project ? project.name : t("todoCard.unknownProject")}
            </button>
          )}
          {task.mail && (
            <button
              type="button"
              className="todo-card-mail"
              onPointerDown={stop}
              onClick={() => onOpenMail(task)}
              title={task.mail.subject || t("todoCard.openMail")}
              aria-label={t("todoCard.openMail")}
            >
              ✉
            </button>
          )}
        </div>
      )}
    </div>
  );
}
