import { useEffect, useState } from "react";

import type { CalendarTask, Subtask, TaskColumn } from "../../types";
import { useCalendarStore } from "../../stores/calendar";
import { useProjectsStore } from "../../stores/projects";
import { useTodoStore } from "../../stores/todo";
import { mailPrioritySet } from "../../lib/mail";
import { useExperimental } from "../../lib/experimental";
import { datePart } from "../../lib/calendarTime";
import { useT } from "../../lib/i18n";

interface Props {
  task: CalendarTask;
  columns: TaskColumn[];
  onClose: () => void;
  onOpenMail: (task: CalendarTask) => void;
}

/**
 * The full card editor — everything the card itself is too small to hold.
 *
 * Rendered on `.modal-backdrop-elevated` so it sits above the board's own
 * backdrop, and every text input's Escape calls `stopPropagation`: the overlay
 * host listens on `window`, where `stopPropagation` does not stop *sibling*
 * listeners, so an unguarded Escape while typing would close the board too.
 *
 * The checklist deliberately does **not** drive `percent`. Deriving it would make
 * the progress control unusable and — since 100% moves a card to Done — ticking
 * the last checkbox would silently relocate the card. The conversion is offered
 * as a button instead.
 */
export function TodoCardDialog({ task, columns, onClose, onOpenMail }: Props) {
  const t = useT();
  const mailClient = useExperimental("mail_client");
  const calendars = useCalendarStore((s) => s.calendars);
  const projects = useProjectsStore((s) => s.projects);

  const [draft, setDraft] = useState<CalendarTask>(task);
  const [tagInput, setTagInput] = useState("");
  const [stepInput, setStepInput] = useState("");
  const [clearMark, setClearMark] = useState(false);

  useEffect(() => setDraft(task), [task]);

  const patch = (changes: Partial<CalendarTask>) =>
    setDraft((d) => ({ ...d, ...changes }));

  const save = async () => {
    try {
      await useCalendarStore.getState().updateTask(draft);
      if (clearMark && draft.mail?.message_id) {
        // Explicit, never implicit: mail may be switched off, and a completion
        // must not silently succeed-or-fail depending on a feature flag.
        await mailPrioritySet(draft.mail.message_id, null).catch(() => {});
      }
      onClose();
    } catch (err) {
      useTodoStore.getState().setError(String(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(t("todoDialog.deleteConfirm"))) return;
    await useCalendarStore
      .getState()
      .deleteTask(task.id)
      .catch((err) => useTodoStore.getState().setError(String(err)));
    onClose();
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (!value) return;
    const tags = draft.tags ?? [];
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      patch({ tags: [...tags, value] });
    }
    setTagInput("");
  };

  const addStep = () => {
    const value = stepInput.trim();
    if (!value) return;
    const subtasks = draft.subtasks ?? [];
    patch({
      subtasks: [...subtasks, { id: `${draft.id}-${subtasks.length}`, title: value, done: false }],
    });
    setStepInput("");
  };

  const setStep = (index: number, changes: Partial<Subtask>) =>
    patch({
      subtasks: (draft.subtasks ?? []).map((s, i) => (i === index ? { ...s, ...changes } : s)),
    });

  const steps = draft.subtasks ?? [];
  const stepsDone = steps.filter((s) => s.done).length;

  const stopEscape = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") e.stopPropagation();
  };

  return (
    <div
      className="modal-backdrop modal-backdrop-elevated"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="project-dialog dialog-framed todo-card-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("todoDialog.title")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="settings-title-row">
          <h2>{t("todoDialog.title")}</h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="todo-card-dialog-body">
          <label className="todo-field">
            <span>{t("todoDialog.titleLabel")}</span>
            <input
              className="cal-input"
              value={draft.title}
              onKeyDown={stopEscape}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>

          <label className="todo-field">
            <span>{t("todoDialog.notes")}</span>
            <textarea
              className="cal-input"
              rows={3}
              value={draft.notes ?? ""}
              onKeyDown={stopEscape}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </label>

          <div className="todo-field-row">
            <label className="todo-field">
              <span>{t("todoDialog.dueDate")}</span>
              <input
                className="cal-input"
                type="date"
                value={draft.due ? datePart(draft.due) : ""}
                onKeyDown={stopEscape}
                onChange={(e) => patch({ due: e.target.value || null })}
              />
            </label>

            <label className="todo-field">
              <span>{t("todoDialog.priority")}</span>
              <select
                className="cal-input"
                value={draft.priority}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
              >
                <option value={0}>{t("todoDialog.priorityNone")}</option>
                <option value={1}>{t("tasksView.priorityHigh")}</option>
                <option value={5}>{t("tasksView.priorityNormal")}</option>
                <option value={9}>{t("tasksView.priorityLow")}</option>
              </select>
            </label>
          </div>

          <div className="todo-field-row">
            <label className="todo-field">
              <span>{t("todoDialog.column")}</span>
              <select
                className="cal-input"
                value={draft.column ?? columns[0]?.id ?? ""}
                onChange={(e) => patch({ column: e.target.value, rank: null })}
              >
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="todo-field">
              <span>{t("todoDialog.calendar")}</span>
              <select
                className="cal-input"
                value={draft.calendar_id}
                onChange={(e) => patch({ calendar_id: e.target.value })}
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="todo-field-row">
            <label className="todo-field">
              <span>{t("todoDialog.project")}</span>
              <select
                className="cal-input"
                value={draft.project_id ?? ""}
                onChange={(e) => patch({ project_id: e.target.value })}
              >
                <option value="">{t("todoDialog.projectNone")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="todo-field">
              <span>
                {t("todoDialog.percent")} — {draft.percent}%
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={draft.percent}
                onChange={(e) => patch({ percent: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="todo-field">
            <span>{t("todoDialog.tags")}</span>
            <div className="todo-tag-editor">
              {(draft.tags ?? []).map((tag) => (
                <span key={tag} className="todo-chip todo-chip-tag">
                  #{tag}
                  <button
                    type="button"
                    className="todo-chip-x"
                    aria-label={t("common.remove")}
                    onClick={() =>
                      patch({ tags: (draft.tags ?? []).filter((x) => x !== tag) })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="cal-input todo-tag-input"
                value={tagInput}
                placeholder={t("todoDialog.tagsPlaceholder")}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  stopEscape(e);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
            </div>
          </div>

          <div className="todo-field">
            <span>
              {t("todoDialog.subtasks")}
              {steps.length > 0 ? ` — ${stepsDone}/${steps.length}` : ""}
            </span>
            <ul className="todo-steps">
              {steps.map((step, i) => (
                <li key={step.id || i} className="todo-step">
                  <input
                    type="checkbox"
                    checked={step.done}
                    onChange={() => setStep(i, { done: !step.done })}
                  />
                  <input
                    className="cal-input"
                    value={step.title}
                    onKeyDown={stopEscape}
                    onChange={(e) => setStep(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    className="cal-link-btn cal-link-danger"
                    onClick={() =>
                      patch({ subtasks: steps.filter((_, x) => x !== i) })
                    }
                  >
                    {t("common.remove")}
                  </button>
                </li>
              ))}
            </ul>
            <div className="todo-step-add">
              <input
                className="cal-input"
                value={stepInput}
                placeholder={t("todoDialog.subtaskPlaceholder")}
                onChange={(e) => setStepInput(e.target.value)}
                onKeyDown={(e) => {
                  stopEscape(e);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addStep();
                  }
                }}
              />
              <button type="button" className="cal-btn" onClick={addStep}>
                {t("todoDialog.addSubtask")}
              </button>
              {steps.length > 0 && (
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() =>
                    patch({ percent: Math.round((stepsDone / steps.length) * 100) })
                  }
                >
                  {t("todoDialog.percentFromChecklist")}
                </button>
              )}
            </div>
          </div>

          {draft.mail && (
            <div className="todo-field todo-mail-link">
              <span>{t("todoDialog.linkedMail")}</span>
              <div className="todo-mail-link-body">
                <div className="todo-mail-link-subject">
                  {draft.mail.subject || t("mail.noSubject")}
                </div>
                <div className="todo-mail-link-from">{draft.mail.from}</div>
                <div className="todo-mail-link-actions">
                  <button
                    type="button"
                    className="cal-link-btn"
                    disabled={!mailClient}
                    title={mailClient ? undefined : t("todoMail.disabled")}
                    onClick={() => onOpenMail(draft)}
                  >
                    {t("todoDialog.linkedMailOpen")}
                  </button>
                  <button
                    type="button"
                    className="cal-link-btn cal-link-danger"
                    onClick={() => patch({ mail: null })}
                  >
                    {t("todoDialog.unlinkMail")}
                  </button>
                </div>
                {mailClient && (
                  <label className="todo-mail-clear">
                    <input
                      type="checkbox"
                      checked={clearMark}
                      onChange={(e) => setClearMark(e.target.checked)}
                    />
                    {t("todoDialog.clearMailMark")}
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="todo-card-dialog-actions">
          <button type="button" className="cal-link-btn cal-link-danger" onClick={() => void remove()}>
            {t("common.delete")}
          </button>
          <span className="todo-spacer" />
          <button type="button" className="cal-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" onClick={() => void save()}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
