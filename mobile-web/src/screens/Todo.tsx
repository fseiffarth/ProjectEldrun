import { useCallback, useEffect, useRef, useState } from "react";
import { api, normalizeTodoBoard, type TodoBoard, type TodoCard, type TodoColumn, type TodoTaskInput } from "../api";
import { readFlag, writeFlag } from "../prefs";

type Editing = TodoCard | "new" | null;

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, (month || 1) - 1, day || 1) / 86_400_000);
}

// A phone reads a board in glances, and `2026-09-14` is the one form of a
// deadline that has to be worked out every time. The chip says how far off the
// card is instead, and only falls back to a date once "in 5 d" stops meaning
// anything. The tone is the same three-step the desktop's alerts use — overdue,
// today, soon — so a late card is legible without reading the date at all.
function dueInfo(due: string, now = new Date()): { label: string; tone: string } {
  const date = due.slice(0, 10);
  const time = due.includes("T") ? due.slice(11, 16) : "";
  const clock = time ? ` ${time}` : "";
  const days = dayNumber(date) - dayNumber(localDate());
  const nowClock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (days < 0) return { label: `${-days}d late`, tone: "overdue" };
  if (days === 0) {
    return time && time < nowClock
      ? { label: `Overdue ${time}`, tone: "overdue" }
      : { label: `Today${clock}`, tone: "today" };
  }
  if (days === 1) return { label: `Tomorrow${clock}`, tone: "soon" };
  if (days < 7) return { label: `In ${days}d${clock}`, tone: "soon" };
  const [year, month, day] = date.split("-").map(Number);
  const stamp = new Date(year, (month || 1) - 1, day || 1);
  return { label: stamp.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "" };
}

// The editor offers None/High/Normal/Low, so a bare "Priority 1" on a card is
// the one number on the board nobody can read back. iCalendar's own banding
// (1–4 high, 5 normal, 6–9 low) turns it back into the word that was picked.
function priorityChip(priority: number): { label: string; glyph: string; tone: string } | null {
  if (priority <= 0) return null;
  if (priority <= 4) return { label: "High", glyph: "▲", tone: "high" };
  if (priority <= 5) return { label: "Normal", glyph: "▪", tone: "normal" };
  return { label: "Low", glyph: "▼", tone: "low" };
}

// The derived fields have to come off, `rank` included: the desktop's task input
// is `deny_unknown_fields`, so a card that already carries a board placement —
// i.e. every card that has ever been dragged — made the whole update request a
// 400, and editing one from the phone (a rename above all) could never save.
function inputOf(task: TodoCard): TodoTaskInput {
  const { id: _id, done: _done, rank: _rank, ...input } = task;
  return input;
}

function blankTask(board: TodoBoard): TodoTaskInput {
  return {
    title: "", notes: "", due: localDate(), priority: 0, percent: 0,
    column: board.columns.find((column) => !column.done)?.id ?? board.columns[0]?.id ?? "",
    calendar_id: board.calendars[0]?.id ?? "", project_id: null, tags: [], subtasks: [],
  };
}

export function Todo({ card }: { card?: string }) {
  const [board, setBoard] = useState<TodoBoard | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  // The search and the two pickers stay transient (a filter that outlives the
  // visit hides cards nobody chose to hide); "hide done" is a standing way of
  // reading the board, so it is the one that is remembered.
  const [hideDone, setHideDone] = useState(() => readFlag("todoHideDone"));
  const toggleHideDone = (value: boolean) => { setHideDone(value); writeFlag("todoHideDone", value); };
  // Hiding the archive is the default: it is where cards are filed to stop
  // looking at them, and on a phone its column is a full screen of scrolling
  // between the columns that are actually being worked.
  const [hideArchived, setHideArchived] = useState(() => readFlag("todoHideArchived", true));
  const toggleHideArchived = (value: boolean) => { setHideArchived(value); writeFlag("todoHideArchived", value); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<{ board: TodoBoard }>("/api/v1/todo")
      .then(({ board }) => { setBoard(normalizeTodoBoard(board)); setError(""); })
      .catch((reason) => setError(`Desktop board unavailable: ${String(reason)}`));
  }, []);
  useEffect(load, [load]);
  // An alert that named a card opens that card, and does it exactly once: the
  // board is reloaded after every mutation, so re-opening on each arrival would
  // put the editor back on screen the moment the user closed it. A card that is
  // no longer on the board (ticked, deleted, filtered out on the desktop) simply
  // leaves the reader on the board rather than reporting anything.
  const opened = useRef(false);
  useEffect(() => {
    if (!card || opened.current || !board) return;
    opened.current = true;
    const task = board.tasks.find((entry) => entry.id === card);
    if (task) setEditing(task);
  }, [card, board]);

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
  // Keep the column badge based on the matching cards even when "Hide done"
  // removes them from the rendered list.
  const matching = (board?.tasks ?? []).filter((task) => {
    const needle = search.trim().toLocaleLowerCase();
    return (!needle || [task.title, task.notes, ...task.tags].join(" ").toLocaleLowerCase().includes(needle))
      && (!projectFilter || (projectFilter === "none" ? !task.project_id : task.project_id === projectFilter))
      && (!tagFilter || task.tags.includes(tagFilter));
  });
  // Two independent switches over the same list: `done` is a property of the
  // card, an archive is a property of the column it rests in — an abandoned card
  // filed there is not done, and a finished one dragged there is, so neither
  // switch can stand in for the other.
  const archivedColumns = new Set(columns.filter((column) => column.archived).map((column) => column.id));
  const shown = matching.filter((task) =>
    !(hideDone && task.done) && !(hideArchived && archivedColumns.has(task.column)));

  return <main className="screen todo-screen">
    <header><h1>To-do board</h1><button onClick={load} disabled={busy}>↻</button></header>
    {error && <p className="error">{error}</p>}
    {/* The search is the first thing under the header: it is what a board of
        forty cards is opened with, and it used to sit below a standing notice
        that says the same sentence every visit. That notice is now the last
        thing on the screen, where it is still there to explain an empty board
        but costs nothing at the top. */}
    <input className="todo-mobile-search" type="search" value={search} placeholder="Search cards" onChange={(event) => setSearch(event.target.value)} />
    <div className="todo-mobile-filters"><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">Any project</option><option value="none">No project</option>{board?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Any tag</option>{tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}</select><label className="todo-inline-check"><input type="checkbox" checked={hideDone} onChange={(event) => toggleHideDone(event.target.checked)} /> Hide done</label><label className="todo-inline-check"><input type="checkbox" checked={hideArchived} onChange={(event) => toggleHideArchived(event.target.checked)} /> Hide archived</label></div>
    {/* Adding a column is a structural act, and it used to sit in a bar of its
        own between the filters and the board — a full row of top chrome above
        the first thing anyone came here to read. At the foot of the column list
        it is where a new column would appear, and costs the board nothing. */}
    <section className="todo-columns">{columns.map((column, index) => <TodoColumnView
      key={column.id} column={column} index={index} columns={columns}
      tasks={shown.filter((task) => task.column === column.id).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title))}
      cardCount={matching.filter((task) => task.column === column.id).length} busy={busy}
      move={move} toggle={toggle} edit={setEditing} columnAction={columnAction}
    />)}<button className="todo-add-column" disabled={busy} onClick={() => {
      const name = window.prompt("Column name");
      if (name?.trim()) columnAction({ type: "column_create", name });
    }}>+ Column</button></section>
    <button className="primary todo-fab" aria-label="Add card" title="Add card" disabled={busy || !board?.calendars.length} onClick={() => setEditing("new")}>＋</button>
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
    <p className="notice todo-mobile-note">Synced through the connected Eldrun desktop. The board is unavailable while the desktop is closed.</p>
  </main>;
}

function TodoColumnView({ column, index, columns, tasks, cardCount, busy, move, toggle, edit, columnAction }: {
  column: TodoColumn; index: number; columns: TodoColumn[]; tasks: TodoCard[]; busy: boolean;
  cardCount: number;
  move: (task: TodoCard, column: string, index?: number) => void; toggle: (task: TodoCard) => void;
  edit: (task: TodoCard) => void; columnAction: (body: unknown) => void;
}) {
  const rename = () => {
    const name = window.prompt("Column name", column.name);
    if (name?.trim() && name.trim() !== column.name) columnAction({ type: "column_rename", column_id: column.id, name });
  };
  const remove = () => {
    if (columns.length > 1 && window.confirm(`Delete “${column.name}”? Its ${cardCount} cards will be refiled.`)) {
      columnAction({ type: "column_delete", column_id: column.id });
    }
  };
  const accent = column.color || "#7c6cff";
  return <section className="todo-mobile-column" style={{ borderTopColor: accent }}>
    <div className="todo-mobile-column-head"><h2>{column.name} <small className="todo-column-count">{cardCount}</small></h2><div>
      <button onClick={rename} disabled={busy} aria-label={`Rename ${column.name}`}>✎</button>
      <button onClick={() => columnAction({ type: "column_move", column_id: column.id, delta: -1 })} disabled={busy || index === 0} aria-label={`Move ${column.name} left`}>‹</button>
      <button onClick={() => columnAction({ type: "column_move", column_id: column.id, delta: 1 })} disabled={busy || index === columns.length - 1} aria-label={`Move ${column.name} right`}>›</button>
      <button className="danger" onClick={remove} disabled={busy || columns.length <= 1} aria-label={`Delete ${column.name}`}>×</button>
    </div></div>
    {/* An empty column says which kind of empty it is: a column with cards the
        filters are holding back reads as a broken board otherwise. */}
    {tasks.length === 0 && <p className="todo-column-empty">{cardCount > 0 ? "Hidden by the filters above" : "No cards"}</p>}
    {tasks.map((task, index) => <article className={task.done ? "todo-mobile-card done" : "todo-mobile-card"} key={task.id}>
      <div className="todo-mobile-card-title"><button className="todo-check" onClick={() => toggle(task)} disabled={busy} aria-label={task.done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}>{task.done ? "✓" : ""}</button><strong>{task.title}</strong></div>
      {task.notes.trim() && <p className="todo-mobile-notes">{task.notes.trim()}</p>}
      <TodoMeta task={task} />
      {/* Progress is on every card and was on none of them: a bar reads at a
          glance where "40%" among four other chips does not. Only where it says
          something — a done card is already struck through. */}
      {!task.done && task.percent > 0 && <div className="todo-mobile-progress" role="progressbar" aria-valuenow={task.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${task.title} progress`}>
        <span className="todo-progress-track"><span className="todo-progress-fill" style={{ width: `${task.percent}%`, backgroundColor: accent }} /></span>
        <small>{task.percent}%</small>
      </div>}
      <div className="todo-mobile-actions"><button type="button" onClick={() => edit(task)} disabled={busy}>✎ Edit</button><button type="button" disabled={busy || index === 0} onClick={() => move(task, column.id, index - 1)} aria-label={`Move ${task.title} up`}>↑</button><button type="button" disabled={busy || index === tasks.length - 1} onClick={() => move(task, column.id, index + 1)} aria-label={`Move ${task.title} down`}>↓</button><select aria-label={`Move ${task.title}`} disabled={busy} value={task.column} onChange={(event) => move(task, event.target.value)}>{columns.map((next) => <option key={next.id} value={next.id}>{next.name}</option>)}</select></div>
    </article>)}
  </section>;
}

// Ordered by what decides whether the card is today's problem: the deadline,
// then how it was ranked, then the checklist, and the tags last — there can be
// any number of them, and none of them is urgent.
function TodoMeta({ task }: { task: TodoCard }) {
  const due = task.due ? dueInfo(task.due) : null;
  const priority = priorityChip(task.priority);
  const steps = task.subtasks.length;
  if (!due && !priority && !steps && task.tags.length === 0) return null;
  return <div className="todo-mobile-meta">
    {due && <small className={`todo-chip due ${due.tone}`}>⏰ {due.label}</small>}
    {priority && <small className={`todo-chip prio ${priority.tone}`}>{priority.glyph} {priority.label}</small>}
    {steps > 0 && <small className="todo-chip steps">☑ {task.subtasks.filter((step) => step.done).length}/{steps}</small>}
    {task.tags.map((tag) => <small className="todo-chip tag" key={tag}>#{tag}</small>)}
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
