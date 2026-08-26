import { useCallback, useEffect, useState } from "react";
import { api, normalizeTodoBoard, type TodoBoard, type TodoCard, type TodoColumn, type TodoTaskInput } from "../api";

type Editing = TodoCard | "new" | null;

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function inputOf(task: TodoCard): TodoTaskInput {
  const { id: _id, done: _done, ...input } = task;
  return input;
}

function blankTask(board: TodoBoard): TodoTaskInput {
  return {
    title: "", notes: "", due: localDate(), priority: 0, percent: 0,
    column: board.columns.find((column) => !column.done)?.id ?? board.columns[0]?.id ?? "",
    calendar_id: board.calendars[0]?.id ?? "", project_id: null, tags: [], subtasks: [],
  };
}

export function Todo({ back }: { back: () => void }) {
  const [board, setBoard] = useState<TodoBoard | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [hideDone, setHideDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<{ board: TodoBoard }>("/api/v1/todo")
      .then(({ board }) => { setBoard(normalizeTodoBoard(board)); setError(""); })
      .catch((reason) => setError(`Desktop board unavailable: ${String(reason)}`));
  }, []);
  useEffect(load, [load]);

  const mutate = async (body: unknown) => {
    setBusy(true); setError("");
    try {
      const next = await api<{ board: TodoBoard }>("/api/v1/todo", { method: "POST", body: JSON.stringify(body) });
      setBoard(normalizeTodoBoard(next.board));
      return true;
    } catch (reason) { setError(String(reason)); return false; } finally { setBusy(false); }
  };
  const columns = [...(board?.columns ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const move = (task: TodoCard, column: string, index?: number) => void mutate({ type: "move", task_id: task.id, column, index });
  const toggle = (task: TodoCard) => {
    const target = task.done
      ? columns.find((column) => !column.done)?.id
      : columns.find((column) => column.done)?.id;
    if (target) move(task, target);
    else void mutate({ type: "update", task_id: task.id, task: { ...inputOf(task), percent: task.done ? 0 : 100 } });
  };
  const columnAction = (body: unknown) => void mutate(body);
  const tags = [...new Set((board?.tasks ?? []).flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b));
  const shown = (board?.tasks ?? []).filter((task) => {
    const needle = search.trim().toLocaleLowerCase();
    return (!needle || [task.title, task.notes, ...task.tags].join(" ").toLocaleLowerCase().includes(needle))
      && (!projectFilter || (projectFilter === "none" ? !task.project_id : task.project_id === projectFilter))
      && (!tagFilter || task.tags.includes(tagFilter))
      && (!hideDone || !task.done);
  });

  return <main className="screen todo-screen">
    <header><button className="back" onClick={back}>‹</button><h1>To-do board</h1><button onClick={load} disabled={busy}>↻</button></header>
    <p className="notice">Synced through the connected Eldrun desktop. The board is unavailable while the desktop is closed.</p>
    {error && <p className="error">{error}</p>}
    <div className="todo-mobile-filters"><input type="search" value={search} placeholder="Search cards" onChange={(event) => setSearch(event.target.value)} /><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">Any project</option><option value="none">No project</option>{board?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Any tag</option>{tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}</select><label className="todo-inline-check"><input type="checkbox" checked={hideDone} onChange={(event) => setHideDone(event.target.checked)} /> Hide done</label></div>
    <div className="todo-mobile-top-actions"><button className="primary" disabled={busy || !board?.calendars.length} onClick={() => setEditing("new")}>+ Add card</button><button disabled={busy} onClick={() => {
      const name = window.prompt("Column name");
      if (name?.trim()) columnAction({ type: "column_create", name });
    }}>+ Column</button></div>
    <section className="todo-columns">{columns.map((column, index) => <TodoColumnView
      key={column.id} column={column} index={index} columns={columns}
      tasks={shown.filter((task) => task.column === column.id).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title))} busy={busy}
      move={move} toggle={toggle} edit={setEditing} columnAction={columnAction}
    />)}</section>
    {editing && board && <TaskEditor
      board={board} task={editing === "new" ? null : editing} busy={busy}
      close={() => setEditing(null)}
      save={async (task) => {
        const ok = await mutate(editing === "new"
          ? { type: "create", task }
          : { type: "update", task_id: editing.id, task });
        if (ok) setEditing(null);
      }}
      remove={editing === "new" ? undefined : async () => {
        if (!window.confirm(`Delete “${editing.title}”?`)) return;
        if (await mutate({ type: "delete", task_id: editing.id })) setEditing(null);
      }}
    />}
  </main>;
}

function TodoColumnView({ column, index, columns, tasks, busy, move, toggle, edit, columnAction }: {
  column: TodoColumn; index: number; columns: TodoColumn[]; tasks: TodoCard[]; busy: boolean;
  move: (task: TodoCard, column: string, index?: number) => void; toggle: (task: TodoCard) => void;
  edit: (task: TodoCard) => void; columnAction: (body: unknown) => void;
}) {
  const rename = () => {
    const name = window.prompt("Column name", column.name);
    if (name?.trim() && name.trim() !== column.name) columnAction({ type: "column_rename", column_id: column.id, name });
  };
  const remove = () => {
    if (columns.length > 1 && window.confirm(`Delete “${column.name}”? Its ${tasks.length} cards will be refiled.`)) {
      columnAction({ type: "column_delete", column_id: column.id });
    }
  };
  return <section className="todo-mobile-column" style={{ borderTopColor: column.color || "#7c6cff" }}>
    <div className="todo-mobile-column-head"><h2>{column.name} <small>{tasks.length}</small></h2><div>
      <button onClick={rename} disabled={busy} aria-label={`Rename ${column.name}`}>✎</button>
      <button onClick={() => columnAction({ type: "column_move", column_id: column.id, delta: -1 })} disabled={busy || index === 0} aria-label={`Move ${column.name} left`}>‹</button>
      <button onClick={() => columnAction({ type: "column_move", column_id: column.id, delta: 1 })} disabled={busy || index === columns.length - 1} aria-label={`Move ${column.name} right`}>›</button>
      <button className="danger" onClick={remove} disabled={busy || columns.length <= 1} aria-label={`Delete ${column.name}`}>×</button>
    </div></div>
    {tasks.map((task, index) => <article className={task.done ? "todo-mobile-card done" : "todo-mobile-card"} key={task.id}>
      <div className="todo-mobile-card-title"><button className="todo-check" onClick={() => toggle(task)} disabled={busy} aria-label={task.done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}>{task.done ? "✓" : ""}</button><strong>{task.title}</strong></div>
      <TodoMeta task={task} />
      <div className="todo-mobile-actions"><button type="button" onClick={() => edit(task)} disabled={busy}>Edit</button><button type="button" disabled={busy || index === 0} onClick={() => move(task, column.id, index - 1)} aria-label={`Move ${task.title} up`}>↑</button><button type="button" disabled={busy || index === tasks.length - 1} onClick={() => move(task, column.id, index + 1)} aria-label={`Move ${task.title} down`}>↓</button><select aria-label={`Move ${task.title}`} disabled={busy} value={task.column} onChange={(event) => move(task, event.target.value)}>{columns.map((next) => <option key={next.id} value={next.id}>{next.name}</option>)}</select></div>
    </article>)}
  </section>;
}

function TodoMeta({ task }: { task: TodoCard }) {
  return <div className="todo-mobile-meta">
    {task.due && <small>⏰ {task.due.replace("T", " ")}</small>}
    {task.priority > 0 && <small>Priority {task.priority}</small>}
    {task.tags.map((tag) => <small className="todo-mobile-tag" key={tag}>#{tag}</small>)}
    {task.subtasks.length > 0 && <small>☑ {task.subtasks.filter((step) => step.done).length}/{task.subtasks.length}</small>}
  </div>;
}

function TaskEditor({ board, task, busy, close, save, remove }: {
  board: TodoBoard; task: TodoCard | null; busy: boolean; close: () => void;
  save: (task: TodoTaskInput) => Promise<void>; remove?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TodoTaskInput>(() => task ? inputOf(task) : blankTask(board));
  const [tagInput, setTagInput] = useState("");
  const [stepInput, setStepInput] = useState("");
  const [date, setDate] = useState(() => draft.due?.slice(0, 10) ?? "");
  const [time, setTime] = useState(() => draft.due?.includes("T") ? draft.due.slice(11, 16) : "");
  const [withTime, setWithTime] = useState(() => !!draft.due?.includes("T"));
  useEffect(() => {
    const due = date ? (withTime && time ? `${date}T${time}` : date) : null;
    setDraft((current) => current.due === due ? current : { ...current, due });
  }, [date, time, withTime]);
  const patch = (changes: Partial<TodoTaskInput>) => setDraft((current) => ({ ...current, ...changes }));
  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !draft.tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) patch({ tags: [...draft.tags, tag] });
    setTagInput("");
  };
  const addStep = () => {
    const title = stepInput.trim();
    if (title) patch({ subtasks: [...draft.subtasks, { id: "", title, done: false }] });
    setStepInput("");
  };
  const stepPatch = (at: number, changes: Partial<{ title: string; done: boolean }>) => patch({ subtasks: draft.subtasks.map((step, index) => index === at ? { ...step, ...changes } : step) });
  const moveStep = (at: number, delta: -1 | 1) => {
    const target = at + delta;
    if (target < 0 || target >= draft.subtasks.length) return;
    const subtasks = [...draft.subtasks]; [subtasks[at], subtasks[target]] = [subtasks[target], subtasks[at]]; patch({ subtasks });
  };
  return <div className="todo-editor-backdrop" role="presentation"><form className="todo-editor todo-editor-full" onSubmit={(event) => { event.preventDefault(); if (draft.title.trim()) void save({ ...draft, title: draft.title.trim() }); }}>
    <div className="todo-editor-heading"><h2>{task ? "Edit task" : "Add card"}</h2><button type="button" onClick={close} disabled={busy}>×</button></div>
    <label>Title<input value={draft.title} maxLength={300} autoFocus required onChange={(event) => patch({ title: event.target.value })} /></label>
    <label>Notes<textarea value={draft.notes} maxLength={16 * 1024} rows={3} onChange={(event) => patch({ notes: event.target.value })} /></label>
    <fieldset><legend>Due</legend><div className="todo-due-fields"><input type="date" value={date} onChange={(event) => { setDate(event.target.value); if (!event.target.value) setWithTime(false); }} />{withTime && <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />}</div><label className="todo-inline-check"><input type="checkbox" checked={withTime} onChange={(event) => { if (event.target.checked && !date) setDate(localDate()); setWithTime(event.target.checked); }} /> Set a time</label></fieldset>
    <div className="todo-editor-grid"><label>Priority<select value={draft.priority} onChange={(event) => patch({ priority: Number(event.target.value) })}><option value={0}>None</option><option value={1}>High</option><option value={5}>Normal</option><option value={9}>Low</option></select></label><label>Progress <output>{draft.percent}%</output><input type="range" min={0} max={100} step={5} value={draft.percent} onChange={(event) => patch({ percent: Number(event.target.value) })} /></label></div>
    <div className="todo-editor-grid"><label>Column<select value={draft.column} onChange={(event) => patch({ column: event.target.value })}>{board.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label>Calendar<select value={draft.calendar_id} onChange={(event) => patch({ calendar_id: event.target.value })}>{board.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label></div>
    <label>Project<select value={draft.project_id ?? ""} onChange={(event) => patch({ project_id: event.target.value || null })}><option value="">No project</option>{board.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <fieldset><legend>Tags</legend><div className="todo-tag-list">{draft.tags.map((tag) => <button type="button" key={tag} onClick={() => patch({ tags: draft.tags.filter((item) => item !== tag) })}>#{tag} ×</button>)}</div><div className="todo-add-row"><input value={tagInput} maxLength={80} placeholder="Tag" onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} /><button type="button" onClick={addTag}>Add tag</button></div></fieldset>
    <fieldset><legend>Checklist {draft.subtasks.length > 0 && `(${draft.subtasks.filter((step) => step.done).length}/${draft.subtasks.length})`}</legend><div className="todo-step-list">{draft.subtasks.map((step, index) => <div className="todo-step-row" key={step.id || `${step.title}-${index}`}><input type="checkbox" checked={step.done} onChange={() => stepPatch(index, { done: !step.done })} /><input value={step.title} maxLength={300} onChange={(event) => stepPatch(index, { title: event.target.value })} /><button type="button" disabled={index === 0} onClick={() => moveStep(index, -1)}>↑</button><button type="button" disabled={index === draft.subtasks.length - 1} onClick={() => moveStep(index, 1)}>↓</button><button type="button" className="danger" onClick={() => patch({ subtasks: draft.subtasks.filter((_, at) => at !== index) })}>×</button></div>)}</div><div className="todo-add-row"><input value={stepInput} maxLength={300} placeholder="Add a step" onChange={(event) => setStepInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addStep(); } }} /><button type="button" onClick={addStep}>Add step</button></div>{draft.subtasks.length > 0 && <button type="button" onClick={() => patch({ percent: Math.round((draft.subtasks.filter((step) => step.done).length / draft.subtasks.length) * 100) })}>Set progress from checklist</button>}</fieldset>
    <div className="todo-editor-actions">{remove && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Delete</button>}<span /><button type="button" onClick={close} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !draft.title.trim() || !draft.calendar_id}>Save</button></div>
  </form></div>;
}
