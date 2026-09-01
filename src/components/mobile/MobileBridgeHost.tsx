import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import {
  RESUMABLE_AGENTS,
  useTabsStore,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { calendarColor, useCalendarStore, visibleCalendarIds } from "../../stores/calendar";
import { useActivityStore } from "../../stores/activity";
import { isTrashProject } from "../../lib/trashProject";
import { resolveProjectDirectory } from "../../types";
import type { CalendarEvent, CalendarTask, Subtask, TaskColumn } from "../../types";
import type { MailFolder, MailHeader } from "../../types/mail";
import { addSubtask, boardColumns, columnOf, provisionalRank } from "../../lib/todoBoard";
import { addDays, monthGrid, toStamp } from "../../lib/calendarTime";
import { eventColor } from "../../lib/calendarCategories";
import { expandEvents } from "../../lib/recurrence";
import { mailAccountsList, mailBody, mailFolders, mailHeaders } from "../../lib/mail";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  buildStaticTabSpec,
  customAgentToItem,
  type StaticMenuItem,
} from "../tabs/newTabItems";
import { useT } from "../../lib/i18n";
import { useAlertsFeed, type AlertsFeed } from "../files/useAlertsFeed";

const MOBILE_DESKTOP_EVENT = "eldrun-mobile-desktop-request";

interface AgentInfo { bin: string; installed: boolean }
interface CatalogAgent { id: string; label: string; modes: string[] }
interface AgentTabStatus { tmux_session: string; status: "working" | "question" | "done" }
interface CreateRequest {
  project_id: string;
  kind: "shell" | "agent";
  agent_id?: string;
  mode?: string;
  idempotency_key: string;
}
interface TodoColumn { id: string; name: string; position: number; done: boolean; archived: boolean; color?: string }
interface TodoSubtask { id: string; title: string; done: boolean }
interface TodoTaskInput {
  title: string;
  notes: string;
  due?: string | null;
  priority: number;
  percent: number;
  column: string;
  calendar_id: string;
  project_id?: string | null;
  tags: string[];
  subtasks: TodoSubtask[];
}
interface TodoCard extends TodoTaskInput { id: string; done: boolean; rank?: number }
interface TodoCalendar { id: string; name: string }
interface TodoProject { id: string; name: string }
interface TodoBoard { columns: TodoColumn[]; tasks: TodoCard[]; calendars: TodoCalendar[]; projects: TodoProject[] }
interface MobileAlertItem {
  kind: "mail" | "event" | "task";
  severity: "overdue" | "now" | "soon" | "upcoming";
  title: string;
  detail: string;
  at?: string;
  all_day: boolean;
  minutes_away?: number;
  days_away?: number;
  task_id?: string;
}
interface MobileAlerts { enabled: boolean; items: MobileAlertItem[] }
interface MobileCalendarEvent {
  id: string;
  calendar_id: string;
  occurrence_start: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location?: string;
  notes?: string;
  conference?: string;
  category?: string;
  color: string;
  status?: string;
  recurring: boolean;
}
interface MobileCalendarInfo { id: string; name: string; color: string; visible: boolean; readonly: boolean; source_url?: string; caldav: boolean }
interface MobileCalendar { month: string; week_start: 0 | 1; calendars: MobileCalendarInfo[]; events: MobileCalendarEvent[]; truncated: boolean }
interface MobileCalendarEventInput { calendar_id: string; start: string; end: string; all_day: boolean; title: string; location: string; notes: string; conference: string; category: string; status: string }
type CalendarAction =
  | { type: "create_event"; event: MobileCalendarEventInput }
  | { type: "update_event"; event_id: string; event: MobileCalendarEventInput }
  | { type: "delete_event"; event_id: string }
  | { type: "create_calendar"; name: string; color: string }
  | { type: "update_calendar"; calendar_id: string; name: string; color: string; visible: boolean }
  | { type: "delete_calendar"; calendar_id: string };
interface MobileMailFolder { id: string; name: string; kind: string; unread: number; total: number }
interface MobileMailAccount { id: string; label: string; address: string; folders: MobileMailFolder[] }
interface MobileMailHeader { id: string; subject: string; sender: { name?: string; address: string }; date: string; seen: boolean; has_attachments: boolean; preview: string }
interface MobileMailAttachment { filename: string; mime: string; size: number }
type MobileMailView =
  | { view: "overview"; accounts: MobileMailAccount[] }
  | { view: "folder"; folder: MobileMailFolder; messages: MobileMailHeader[]; total: number; offset: number }
  | { view: "message"; message: MobileMailHeader; body: string; truncated: boolean; attachments: MobileMailAttachment[] };
type TodoAction =
  | { type: "create"; task: TodoTaskInput }
| { type: "move"; task_id: string; column: string; index?: number }
  | { type: "update"; task_id: string; task: TodoTaskInput }
  | { type: "delete"; task_id: string }
  | { type: "column_create"; name: string }
  | { type: "column_rename"; column_id: string; name: string }
  | { type: "column_move"; column_id: string; delta: -1 | 1 }
  | { type: "column_delete"; column_id: string };
type DesktopRequest =
| { type: "catalog"; request_id: string; project_id?: string }
  | { type: "activate"; request_id: string; project_id: string }
  | { type: "create"; request_id: string; request: CreateRequest }
  | { type: "todo"; request_id: string }
  | { type: "alerts"; request_id: string }
  | { type: "calendar"; request_id: string; month: string }
  | { type: "calendar_mutate"; request_id: string; month: string; action: CalendarAction }
  | { type: "todo_mutate"; request_id: string; action: TodoAction }
  | { type: "mail_overview"; request_id: string }
  | { type: "mail_folder"; request_id: string; folder_id: string; offset: number }
  | { type: "mail_message"; request_id: string; folder_id: string; message_id: string; offset: number };
type DesktopResponse =
| { status: "catalog"; agents: CatalogAgent[]; statuses: AgentTabStatus[] }
  | { status: "activated" }
  | { status: "created"; tmux_session: string }
  | { status: "todo"; board: TodoBoard }
  | { status: "alerts"; alerts: MobileAlerts }
  | { status: "calendar"; calendar: MobileCalendar }
  | { status: "mail"; mail: MobileMailView }
  | { status: "error"; code: string; message: string };

interface CatalogChoice { public: CatalogAgent; item: StaticMenuItem }

async function agentChoices(): Promise<CatalogChoice[]> {
  const settings = useSettingsStore.getState().settings;
  const installed = new Set(
    (await invoke<AgentInfo[]>("list_agents"))
      .filter((entry) => entry.installed)
      .map((entry) => entry.bin),
  );
  const disabled = new Set(settings?.disabled_agents ?? []);
  const builtins = AGENT_ITEMS.filter(
    (item) =>
      installed.has(item.cmd) &&
      !disabled.has(item.cmd) &&
      item.cmd in RESUMABLE_AGENTS,
  );
  const custom = (settings?.custom_agents ?? [])
    .filter((item) => item.resumeArgs?.length)
    .map(customAgentToItem);
  const customFound = custom.length
    ? new Set(await invoke<string[]>("probe_binaries", { bins: custom.map((item) => item.cmd) }))
    : new Set<string>();
  const items = [...builtins, ...custom.filter((item) => customFound.has(item.cmd))];
  return Promise.all(
    items.map(async (item) => ({
      item,
      public: {
        id: await invoke<string>("mobile_opaque_id", { domain: "agent", value: item.cmd }),
        label: item.label,
        // Always empty: Eldrun no longer launches an agent into a permission
        // mode, so there is no launch mode for the phone to pick. The phone can
        // still change the mode of a *running* session, which it does the way a
        // person would — pressing Shift+Tab and reading the TUI's own status
        // line back (`mobile-web/src/terminal/agentModes.ts`).
        modes: [] as string[],
      },
    })),
  );
}

/** The phone receives these already-derived activity facts only. The desktop
 * owns terminal output and prompt classification, while the sidecar maps the
 * tmux names back to opaque phone-visible tab ids. */
function agentStatuses(projectId?: string): AgentTabStatus[] {
  if (!projectId) return [];
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId);
  if (!project || project.remote || (project.sandbox?.enabled && !isTrashProject(project)) || project.vm?.enabled || !project.eldrun_mobile_access) {
    return [];
  }
  const activity = useActivityStore.getState();
  return (useTabsStore.getState().tabsByScope[projectId] ?? []).flatMap((tab) => {
    if (tab.kind !== "agent" || !tab.tmuxSession) return [];
    const ptyId = `${projectId}:${tab.key}`;
    const status: AgentTabStatus["status"] | null = activity.busyByTab[ptyId]
      ? "working"
      : activity.attentionByTab[ptyId] === "decision"
        ? "question"
        : activity.attentionByTab[ptyId] === "done"
          ? "done"
          : null;
    return status ? [{ tmux_session: tab.tmuxSession, status }] : [];
  });
}

async function create(request: CreateRequest, t: ReturnType<typeof useT>): Promise<DesktopResponse> {
  const projects = useProjectsStore.getState();
  const project = projects.projects.find((entry) => entry.id === request.project_id);
  if (!project || project.remote || (project.sandbox?.enabled && !isTrashProject(project)) || project.vm?.enabled || !project.eldrun_mobile_access) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const cwd = resolveProjectDirectory(project);
  if (!cwd) return { status: "error", code: "project_ineligible", message: "Project folder is unavailable" };
  await projects.activateProject(project.id);
  const requestHash = await invoke<string>("mobile_opaque_id", {
    domain: "request",
    value: request.idempotency_key,
  });

  let spec: Omit<TabEntry, "key">;
  if (request.kind === "shell") {
    if (isTrashProject(project)) {
      return { status: "error", code: "invalid_request", message: "Trash accepts agent tabs only" };
    }
    if (request.agent_id || request.mode) {
      return { status: "error", code: "invalid_request", message: "Shell requests cannot name an agent or mode" };
    }
    spec = buildStaticTabSpec(SHELL_ITEMS[0], cwd, project.name, t);
  } else {
    const choices = await agentChoices();
    const choice = choices.find((entry) => entry.public.id === request.agent_id);
    if (!choice) return { status: "error", code: "unknown_agent", message: "Agent is unavailable" };
    if (isTrashProject(project) && !AGENT_ITEMS.some((item) => item.cmd === choice.item.cmd)) {
      return { status: "error", code: "unknown_agent", message: "Trash accepts built-in agent CLIs only" };
    }
    if (request.mode && !choice.public.modes.includes(request.mode)) {
      return { status: "error", code: "unsupported_mode", message: "Agent mode is unavailable" };
    }
    spec = buildStaticTabSpec(choice.item, cwd, project.name, t);
  }
  let created: TabEntry;
  try {
    created = await useTabsStore.getState().hydrateThenCreateInScope({
      scope: project.id,
      cwd,
      localFile: project.local_file,
      requestHash,
      spec,
    });
  } catch (error) {
    return { status: "error", code: "persist_failed", message: String(error) };
  }
  if (!created.tmuxSession) {
    return { status: "error", code: "launch_failed", message: "Persistent terminal session was not created" };
  }
  return { status: "created", tmux_session: created.tmuxSession };
}

async function activate(projectId: string): Promise<DesktopResponse> {
  const projects = useProjectsStore.getState();
  const project = projects.projects.find((entry) => entry.id === projectId);
  if (!project || project.remote || (project.sandbox?.enabled && !isTrashProject(project)) || project.vm?.enabled || !project.eldrun_mobile_access) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  await projects.activateProject(project.id);
  return { status: "activated" };
}

async function taskId(task: CalendarTask) {
  return invoke<string>("mobile_opaque_id", { domain: "task", value: task.id });
}

async function opaqueId(domain: string, value: string) {
  return invoke<string>("mobile_opaque_id", { domain, value });
}

async function resolveOpaqueId<T extends { id: string }>(
  domain: string,
  publicId: string | null | undefined,
  entries: T[],
): Promise<string | null> {
  if (!publicId) return null;
  const pairs = await Promise.all(entries.map(async (entry) => [await opaqueId(domain, entry.id), entry.id] as const));
  return pairs.find(([id]) => id === publicId)?.[1] ?? null;
}

async function todoSnapshot(): Promise<TodoBoard> {
  // Never make the desktop-control response wait on a whole-calendar IPC read.
  // A calendar can contain large event notes that are irrelevant to this compact
  // board, and the sidecar has a deliberately short desktop-response timeout.
  // The normal desktop store is already kept current by its calendar surfaces;
  // if it has not loaded yet, begin that read in the background and return the
  // safe empty/default board for this refresh instead of reporting the open
  // desktop as unavailable.
  const calendar = useCalendarStore.getState();
  if (!calendar.loaded) void calendar.load();
  const columns = boardColumns(calendar.taskColumns);
  const projects = useProjectsStore.getState().projects;
  const [calendars, publicProjects] = await Promise.all([
    Promise.all(calendar.calendars.map(async (entry) => ({
      id: await opaqueId("calendar", entry.id),
      name: entry.name,
    }))),
    Promise.all(projects.map(async (entry) => ({
      id: await opaqueId("project", entry.id),
      name: entry.name,
    }))),
  ]);
  return {
    columns: columns.map((column) => ({
      id: column.id,
      name: column.name,
      position: column.position,
      done: column.done,
      // The phone filters archived cards on the flag, not on the column's name:
      // a rename must not change what its "hide archived" switch hides.
      archived: column.archived ?? false,
      color: column.color || undefined,
    })),
    tasks: await Promise.all(calendar.tasks.map(async (task) => ({
      id: await taskId(task),
      title: task.title,
      column: columnOf(task, columns),
      done: task.percent >= 100,
      due: task.due || undefined,
      notes: task.notes ?? "",
      priority: task.priority,
      percent: task.percent,
      rank: task.rank ?? undefined,
      calendar_id: await opaqueId("calendar", task.calendar_id),
      project_id: task.project_id ? await opaqueId("project", task.project_id) : undefined,
      tags: task.tags ?? [],
      subtasks: await Promise.all((task.subtasks ?? []).map(async (step) => ({
        id: await opaqueId("subtask", step.id),
        title: step.title,
        done: step.done,
      }))),
    }))),
    calendars,
    projects: publicProjects,
  };
}

async function subtasksFromInput(input: TodoTaskInput, task: CalendarTask): Promise<Subtask[]> {
  const current = task.subtasks ?? [];
  const pairs = await Promise.all(current.map(async (step) => [await opaqueId("subtask", step.id), step] as const));
  let draft: CalendarTask = { ...task, subtasks: [] };
  for (const step of input.subtasks) {
    const existing = pairs.find(([id]) => id === step.id)?.[1];
    if (existing) {
      draft = { ...draft, subtasks: [...(draft.subtasks ?? []), { ...existing, title: step.title.trim(), done: step.done }] };
    } else {
      draft = addSubtask(draft, step.title.trim());
      const last = draft.subtasks?.[draft.subtasks.length - 1];
      if (last) {
        draft = { ...draft, subtasks: [...(draft.subtasks ?? []).slice(0, -1), { ...last, done: step.done }] };
      }
    }
  }
  return draft.subtasks ?? [];
}

async function taskFromInput(
  input: TodoTaskInput,
  task: CalendarTask,
  columns: TaskColumn[],
  calendarIds: { id: string }[],
  projectIds: { id: string }[],
): Promise<CalendarTask | null> {
  const [calendarId, projectId] = await Promise.all([
    resolveOpaqueId("calendar", input.calendar_id, calendarIds),
    resolveOpaqueId("project", input.project_id, projectIds),
  ]);
  const column = columns.find((entry) => entry.id === input.column);
  if (!calendarId || !column || (input.project_id && !projectId)) return null;
  return {
    ...task,
    title: input.title.trim(),
    notes: input.notes || undefined,
    due: input.due?.trim() || null,
    priority: input.priority,
    percent: input.percent,
    column: column.id,
    // A column selection in the full desktop editor intentionally discards its
    // old rank; it then lands by the normal board ordering rather than carrying
    // neighbours from a different column with it.
    rank: task.column === column.id ? task.rank : null,
    calendar_id: calendarId,
    project_id: projectId || undefined,
    tags: input.tags.map((tag) => tag.trim()),
    subtasks: await subtasksFromInput(input, task),
  };
}

async function todoMutate(action: TodoAction): Promise<DesktopResponse> {
  let calendar = useCalendarStore.getState();
  if (!calendar.loaded) {
    await calendar.load();
    calendar = useCalendarStore.getState();
  }
  const columns = boardColumns(calendar.taskColumns);
  if (action.type === "create") {
    const task = await taskFromInput(action.task, {
      id: "",
      calendar_id: "",
      title: "",
      priority: 0,
      percent: 0,
      subtasks: [],
    }, columns, calendar.calendars, useProjectsStore.getState().projects);
    if (!task) return { status: "error", code: "invalid_task", message: "Task details are unavailable" };
    const ranks = calendar.tasks
      .filter((entry) => columnOf(entry, columns) === task.column)
      .map((entry) => entry.rank)
      .filter((rank): rank is number => typeof rank === "number");
    const top = ranks.length ? Math.min(...ranks) : null;
    await calendar.createTask({ ...task, rank: provisionalRank(null, top), created: toStamp(new Date()) });
  } else if (action.type === "column_create") {
    await calendar.setColumns([...columns, { id: "", name: action.name.trim(), position: columns.length, done: false }]);
  } else if (action.type === "column_rename") {
    if (!columns.some((column) => column.id === action.column_id)) return { status: "error", code: "invalid_column", message: "Board column is unavailable" };
    await calendar.setColumns(columns.map((column) => column.id === action.column_id ? { ...column, name: action.name.trim() } : column));
  } else if (action.type === "column_move") {
    const index = columns.findIndex((column) => column.id === action.column_id);
    const target = index + action.delta;
    if (index < 0 || target < 0 || target >= columns.length) return { status: "error", code: "invalid_column", message: "Board column is unavailable" };
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    await calendar.setColumns(next.map((column, position) => ({ ...column, position })));
  } else if (action.type === "column_delete") {
    if (columns.length <= 1 || !columns.some((column) => column.id === action.column_id)) return { status: "error", code: "invalid_column", message: "Board column cannot be removed" };
    await calendar.setColumns(columns.filter((column) => column.id !== action.column_id));
  } else {
    const pairs = await Promise.all(calendar.tasks.map(async (task) => [await taskId(task), task] as const));
    const task = pairs.find(([id]) => id === action.task_id)?.[1];
    if (!task) return { status: "error", code: "task_not_found", message: "Task is unavailable" };
    if (action.type === "move") {
      const target = columns.find((column) => column.id === action.column);
      if (!target) return { status: "error", code: "invalid_column", message: "Board column is unavailable" };
      const count = calendar.tasks.filter((entry) => entry.id !== task.id && columnOf(entry, columns) === target.id).length;
      const index = Math.max(0, Math.min(action.index ?? count, count));
      await calendar.moveTasks([{
        id: task.id,
        column: target.id,
        index,
        completed_stamp: target.done ? toStamp(new Date()) : null,
      }]);
    } else if (action.type === "delete") {
      await calendar.deleteTask(task.id);
    } else {
      const next = await taskFromInput(action.task, task, columns, calendar.calendars, useProjectsStore.getState().projects);
      if (!next) return { status: "error", code: "invalid_task", message: "Task details are unavailable" };
      await calendar.updateTask(next);
    }
  }
  return { status: "todo", board: await todoSnapshot() };
}

async function alertsSnapshot(feed: AlertsFeed): Promise<MobileAlerts> {
  return {
    enabled: feed.enabled,
    // Keep source ids and action metadata inside the desktop process. The
    // mobile home needs a timeline, not a second control surface. The one
    // exception is a card row's `task_id`, and it is not a widening of the
    // boundary: it is the *same* opaque id `todoSnapshot` already hands this
    // device for that card, so tapping the alert can open the card it names —
    // the header's own to-do list has routed to the card rather than the board
    // since it existed, for the reason it exists at all.
    items: await Promise.all(feed.items.map(async (item) => ({
      kind: item.kind,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      at: item.at ?? undefined,
      all_day: item.allDay,
      minutes_away: item.minutesAway ?? undefined,
      days_away: item.daysAway ?? undefined,
      task_id: item.kind === "task" && item.source.taskId
        ? await opaqueId("task", item.source.taskId)
        : undefined,
    }))),
  };
}

const MOBILE_CALENDAR_EVENTS = 80;

/** The mobile view is materialized by the desktop, so it uses exactly the same
 * recurrence expansion, checked calendars, colors and local wall-clock rules
 * as the full Calendar tab. */
async function calendarSnapshot(month: string): Promise<MobileCalendar> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("invalid_month");
  }
  let calendar = useCalendarStore.getState();
  if (!calendar.loaded) {
    await calendar.load();
    calendar = useCalendarStore.getState();
  }
  const weekStart: 0 | 1 = useSettingsStore.getState().settings?.calendar_week_start === 1 ? 1 : 0;
  const grid = monthGrid(Number(month.slice(0, 4)), Number(month.slice(5, 7)), weekStart, 6);
  const windowStart = grid[0][0];
  const windowEnd = addDays(grid[5][6], 1);
  const occurrences = expandEvents(
    calendar.events,
    windowStart,
    windowEnd,
    visibleCalendarIds(calendar.calendars),
  );
  const shown = occurrences.slice(0, MOBILE_CALENDAR_EVENTS);
  return {
    month,
    week_start: weekStart,
    calendars: await Promise.all(calendar.calendars.map(async (entry) => ({
      id: await opaqueId("calendar", entry.id),
      name: boundedText(entry.name, 160).value,
      color: boundedText(entry.color, 64).value,
      visible: entry.visible,
      readonly: entry.readonly,
      source_url: entry.source_url ? boundedText(entry.source_url, 2_000).value : undefined,
      caldav: !!entry.caldav_account_id,
    }))),
    truncated: occurrences.length > shown.length,
    events: await Promise.all(shown.map(async (occurrence) => ({
      id: await opaqueId("event", occurrence.eventId),
      calendar_id: await opaqueId("calendar", occurrence.calendarId),
      occurrence_start: boundedText(occurrence.occurrenceStart, 32).value,
      start: boundedText(occurrence.start, 32).value,
      end: boundedText(occurrence.end, 32).value,
      all_day: occurrence.allDay,
      title: boundedText(occurrence.title, 240).value,
      location: occurrence.location ? boundedText(occurrence.location, 160).value : undefined,
      notes: occurrence.notes ? boundedText(occurrence.notes, 16 * 1024).value : undefined,
      conference: occurrence.conference ? boundedText(occurrence.conference, 2_000).value : undefined,
      category: occurrence.category ? boundedText(occurrence.category, 80).value : undefined,
      color: boundedText(eventColor(occurrence.category, calendarColor(calendar.calendars, occurrence.calendarId)), 32).value || "#7c6cff",
      status: occurrence.status === "cancelled" ? "cancelled" : undefined,
      recurring: occurrence.recurring,
    }))),
  };
}

async function calendarMutate(month: string, action: CalendarAction): Promise<DesktopResponse> {
  let state = useCalendarStore.getState();
  if (!state.loaded) {
    await state.load();
    state = useCalendarStore.getState();
  }
  const calendars = state.calendars;
  const resolveCalendar = (id: string) => resolveOpaqueId("calendar", id, calendars);
  const resolveEvent = (id: string) => resolveOpaqueId("event", id, state.events);
  if (action.type === "create_calendar") {
    await state.createCalendar({ name: action.name.trim(), color: action.color, visible: true, readonly: false });
  } else if (action.type === "update_calendar") {
    const id = await resolveCalendar(action.calendar_id);
    const calendar = calendars.find((entry) => entry.id === id);
    if (!calendar || calendar.readonly) return { status: "error", code: "calendar_unavailable", message: "Calendar is unavailable or read-only" };
    await state.updateCalendar({ ...calendar, name: action.name.trim(), color: action.color, visible: action.visible });
  } else if (action.type === "delete_calendar") {
    const id = await resolveCalendar(action.calendar_id);
    const calendar = calendars.find((entry) => entry.id === id);
    if (!calendar || calendar.readonly) return { status: "error", code: "calendar_unavailable", message: "Calendar is unavailable or read-only" };
    if (!id) return { status: "error", code: "calendar_unavailable", message: "Calendar is unavailable" };
    await state.deleteCalendar(id);
  } else {
    const toEvent = async (input: MobileCalendarEventInput, current?: CalendarEvent): Promise<CalendarEvent | null> => {
      const calendarId = await resolveCalendar(input.calendar_id);
      const calendar = calendars.find((entry) => entry.id === calendarId);
      if (!calendarId || !calendar || calendar.readonly || !input.title.trim() || !input.start || !input.end || input.end <= input.start) return null;
      return {
        ...(current ?? { id: "", rrule: null, exdates: [], overrides: [], alarms: [] }),
        calendar_id: calendarId, title: input.title.trim(), start: input.start, end: input.end,
        all_day: input.all_day, location: input.location.trim() || undefined, notes: input.notes.trim() || undefined,
        conference: input.conference.trim() || undefined, category: input.category.trim() || undefined,
        status: (["", "confirmed", "tentative", "cancelled"] as const).includes(input.status as "" | "confirmed" | "tentative" | "cancelled")
          ? input.status as "" | "confirmed" | "tentative" | "cancelled"
          : undefined,
      };
    };
    if (action.type === "create_event") {
      const event = await toEvent(action.event);
      if (!event) return { status: "error", code: "invalid_event", message: "Event details are invalid or calendar is read-only" };
      await state.createEvent(event);
    } else {
      const id = await resolveEvent(action.event_id);
      const current = state.events.find((entry) => entry.id === id);
      if (!current) return { status: "error", code: "event_not_found", message: "Event is unavailable" };
      const calendar = calendars.find((entry) => entry.id === current.calendar_id);
      if (calendar?.readonly) return { status: "error", code: "calendar_unavailable", message: "Calendar is read-only" };
      if (action.type === "delete_event") await state.deleteEvent(current.id);
      else {
        const event = await toEvent(action.event, current);
        if (!event) return { status: "error", code: "invalid_event", message: "Event details are invalid or calendar is read-only" };
        await state.updateEvent(event);
      }
    }
  }
  return { status: "calendar", calendar: await calendarSnapshot(month) };
}

const MAIL_PAGE_SIZE = 25;
const MAIL_BODY_BYTES = 24 * 1024;

function boundedText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  return {
    value: new TextDecoder().decode(bytes.slice(0, maxBytes)),
    truncated: true,
  };
}

function publicMailFolder(folder: MailFolder): MobileMailFolder {
  return {
    id: "",
    name: boundedText(folder.name, 160).value,
    kind: folder.kind,
    unread: folder.unread,
    total: folder.total,
  };
}

async function opaqueMailId(kind: "account" | "folder" | "message", value: string) {
  return invoke<string>("mobile_opaque_id", { domain: "mail", value: `${kind}:${value}` });
}

async function publicMailHeader(header: MailHeader): Promise<MobileMailHeader> {
  return {
    id: await opaqueMailId("message", header.id),
    subject: boundedText(header.subject, 400).value,
    sender: {
      name: header.from.name ? boundedText(header.from.name, 200).value : undefined,
      address: boundedText(header.from.address, 254).value,
    },
    date: header.date,
    seen: header.seen,
    has_attachments: header.has_attachments,
    preview: boundedText(header.preview, 600).value,
  };
}

async function configuredMailAccounts() {
  return (await mailAccountsList()).slice(0, 12);
}

async function mailOverview(): Promise<DesktopResponse> {
  const accounts = await configuredMailAccounts();
  let remainingFolders = 160;
  const rows: MobileMailAccount[] = [];
  for (const account of accounts) {
    const folders = remainingFolders > 0
      ? (await mailFolders(account.id, false)).slice(0, Math.min(remainingFolders, 32))
      : [];
    remainingFolders -= folders.length;
    rows.push({
      id: await opaqueMailId("account", account.id),
      label: boundedText(account.display_name || account.label || account.address, 160).value,
      address: boundedText(account.address, 254).value,
      folders: await Promise.all(folders.map(async (folder) => ({
        ...publicMailFolder(folder),
        id: await opaqueMailId("folder", folder.id),
      }))),
    });
  }
  return { status: "mail", mail: { view: "overview", accounts: rows } };
}

async function resolveMailFolder(folderId: string): Promise<MailFolder | null> {
  for (const account of await configuredMailAccounts()) {
    for (const folder of await mailFolders(account.id, false)) {
      if (await opaqueMailId("folder", folder.id) === folderId) return folder;
    }
  }
  return null;
}

async function mailFolderPage(folderId: string, offset: number): Promise<DesktopResponse> {
  const folder = await resolveMailFolder(folderId);
  if (!folder) return { status: "error", code: "folder_not_found", message: "Mail folder is unavailable" };
  const page = await mailHeaders(folder.id, offset, MAIL_PAGE_SIZE, null);
  return {
    status: "mail",
    mail: {
      view: "folder",
      folder: { ...publicMailFolder(folder), id: folderId },
      messages: await Promise.all(page.items.map(publicMailHeader)),
      total: page.total,
      offset,
    },
  };
}

async function mailMessage(folderId: string, messageId: string, offset: number): Promise<DesktopResponse> {
  const folder = await resolveMailFolder(folderId);
  if (!folder) return { status: "error", code: "folder_not_found", message: "Mail folder is unavailable" };
  // Re-read exactly the page that issued the opaque id. This both resolves it
  // without exposing the store key and refuses a stale/cross-folder capability.
  const page = await mailHeaders(folder.id, offset, MAIL_PAGE_SIZE, null);
  const pairs = await Promise.all(page.items.map(async (header) => ({
    header,
    id: await opaqueMailId("message", header.id),
  })));
  const header = pairs.find((entry) => entry.id === messageId)?.header;
  if (!header) return { status: "error", code: "message_not_found", message: "Mail message is unavailable" };

  const body = await mailBody(header.id, false);
  const source = body.text ?? (body.html
    ? new DOMParser().parseFromString(body.html, "text/html").body.textContent ?? ""
    : "");
  const bounded = boundedText(source, MAIL_BODY_BYTES);
  return {
    status: "mail",
    mail: {
      view: "message",
      message: await publicMailHeader(header),
      body: bounded.value,
      truncated: !!body.truncated || bounded.truncated,
      attachments: body.attachments.slice(0, 40).map((attachment) => ({
        filename: boundedText(attachment.filename, 180).value,
        mime: boundedText(attachment.mime, 100).value,
        size: attachment.size,
      })),
    },
  };
}

async function handleRequest(
  request: DesktopRequest,
  t: ReturnType<typeof useT>,
  alerts: AlertsFeed,
): Promise<DesktopResponse> {
  switch (request.type) {
    case "catalog": return {
      status: "catalog",
      agents: (await agentChoices()).map((entry) => entry.public),
      statuses: agentStatuses(request.project_id),
    };
    case "activate": return activate(request.project_id);
    case "create": return create(request.request, t);
    case "todo": return { status: "todo", board: await todoSnapshot() };
    case "alerts": return { status: "alerts", alerts: await alertsSnapshot(alerts) };
    case "calendar": return { status: "calendar", calendar: await calendarSnapshot(request.month) };
    case "calendar_mutate": return calendarMutate(request.month, request.action);
    case "todo_mutate": return todoMutate(request.action);
    case "mail_overview": return mailOverview();
    case "mail_folder": return mailFolderPage(request.folder_id, request.offset);
    case "mail_message": return mailMessage(request.folder_id, request.message_id, request.offset);
  }
}

let mutationQueue: Promise<unknown> = Promise.resolve();

export function MobileBridgeHost() {
  const t = useT();
  // The phone's Alerts screen is its own surface, so it is read *past* the file
  // viewer's 🔔 key: `files_alerts` is that group's visibility, and closing the
  // strip beside the tree on the laptop must not blank the phone — a control on
  // one surface silently switching off another one that has no way back. What
  // says which alerts exist (the source switches, the lookahead, the mutes) is
  // still shared, so the two surfaces never disagree about the rows themselves.
  // Gated on the Mobile host actually being on: with no phone in the picture the
  // feed stays exactly as opt-in as before, arming no timer and reading no store.
  const mobileHostOn = useSettingsStore((s) => s.settings?.eldrun_mobile_host?.enabled ?? false);
  const alerts = useAlertsFeed({ ignoreVisibility: mobileHostOn });
  const alertsRef = useRef(alerts);
  const tRef = useRef(t);
  alertsRef.current = alerts;
  tRef.current = t;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<DesktopRequest>(MOBILE_DESKTOP_EVENT, (event) => {
      const request = event.payload;
      const run = async () => {
        let response: DesktopResponse;
        try {
          response = await handleRequest(request, tRef.current, alertsRef.current);
        } catch (error) {
          response = { status: "error", code: "desktop_error", message: String(error) };
        }
        if (!disposed) {
          await invoke("mobile_desktop_respond", {
            requestId: request.request_id,
            response,
          }).catch(() => {});
        }
      };
      if (request.type === "create" || request.type === "activate" || request.type === "todo_mutate" || request.type === "calendar_mutate") {
        mutationQueue = mutationQueue.then(run, run);
      } else {
        void run();
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return null;
}
