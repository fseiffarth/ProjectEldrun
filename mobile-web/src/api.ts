export interface ProjectRow { id: string; label: string; status: string; live_sessions: number; last_activity?: number }
export type AgentStatus = "working" | "question" | "done";
export interface TabRow { id: string; label: string; kind: "shell" | "agent"; agent_label?: string; agent_status?: AgentStatus; available: boolean; viewer_busy: boolean; last_activity?: number }
export interface AgentRow { id: string; label: string; modes: ("plan" | "auto")[] }
export interface ProjectDetail { project: ProjectRow; tabs: TabRow[]; desktop_available: boolean; agents: AgentRow[] }
export interface TodoColumn { id: string; name: string; position: number; done: boolean; archived: boolean; color?: string }
export interface TodoSubtask { id: string; title: string; done: boolean }
export interface TodoTaskInput {
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
export interface TodoCard extends TodoTaskInput { id: string; done: boolean; rank?: number }
export interface TodoCalendar { id: string; name: string }
export interface TodoProject { id: string; name: string }
export interface TodoBoard {
  columns: TodoColumn[];
  tasks: TodoCard[];
  calendars: TodoCalendar[];
  projects: TodoProject[];
}

/**
 * Mobile hosts from an earlier feature revision omitted empty arrays to save a
 * few bytes. The board UI treats those fields as collections, so normalize a
 * response at the boundary rather than allowing one untagged legacy card to
 * take down the whole screen.
 */
export function normalizeTodoBoard(board: TodoBoard): TodoBoard {
  return {
    ...board,
    // `archived` is the newest of these fields, so a desktop older than it sends
    // a column without one; false is the honest reading — a board that has no
    // archive column has nothing for "hide archived" to hide.
    columns: (board.columns ?? []).map((column) => ({ ...column, archived: column.archived ?? false })),
    tasks: (board.tasks ?? []).map((task) => ({
      ...task,
      notes: task.notes ?? "",
      tags: task.tags ?? [],
      subtasks: task.subtasks ?? [],
    })),
    calendars: board.calendars ?? [],
    projects: board.projects ?? [],
  };
}
export type MobileAlertKind = "mail" | "event" | "task";
export type MobileAlertSeverity = "overdue" | "now" | "soon" | "upcoming";
/** A bounded display snapshot of the desktop Alerts feed. Source ids and
 * mutation capabilities deliberately never cross the mobile boundary. */
export interface MobileAlertItem {
  kind: MobileAlertKind;
  severity: MobileAlertSeverity;
  title: string;
  detail: string;
  at?: string;
  all_day: boolean;
  minutes_away?: number;
  days_away?: number;
  /** `kind === "task"` only: the board's own opaque card id, so tapping the row
   * can open that card rather than dropping the reader at the whole board. */
  task_id?: string;
}
export interface MobileAlerts { enabled: boolean; items: MobileAlertItem[] }
/** A bounded, read-only occurrence expanded by the connected desktop. It never
 * carries a calendar/event id, notes, conferencing links, or write capability. */
export interface MobileCalendarEvent {
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
export interface MobileCalendarInfo {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  readonly: boolean;
  source_url?: string;
  caldav: boolean;
}
export interface MobileCalendarEventInput {
  calendar_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location: string;
  notes: string;
  conference: string;
  category: string;
  status: string;
}
export type CalendarAction =
  | { type: "create_event"; event: MobileCalendarEventInput }
  | { type: "update_event"; event_id: string; event: MobileCalendarEventInput }
  | { type: "delete_event"; event_id: string }
  | { type: "create_calendar"; name: string; color: string }
  | { type: "update_calendar"; calendar_id: string; name: string; color: string; visible: boolean }
  | { type: "delete_calendar"; calendar_id: string };
export interface MobileCalendar {
  month: string;
  week_start: 0 | 1;
  calendars: MobileCalendarInfo[];
  events: MobileCalendarEvent[];
  truncated: boolean;
}
export interface MobileMailFolder { id: string; name: string; kind: string; unread: number; total: number }
export interface MobileMailAccount { id: string; label: string; address: string; folders: MobileMailFolder[] }
export interface MobileMailHeader { id: string; subject: string; sender: { name?: string; address: string }; date: string; seen: boolean; has_attachments: boolean; preview: string }
export interface MobileMailAttachment { filename: string; mime: string; size: number }
export type MobileMailView =
  | { view: "overview"; accounts: MobileMailAccount[] }
  | { view: "folder"; folder: MobileMailFolder; messages: MobileMailHeader[]; total: number; offset: number }
  | { view: "message"; message: MobileMailHeader; body: string; truncated: boolean; attachments: MobileMailAttachment[] };

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** Set by the app root. A session can expire (12h) or vanish when the mobile
 * host restarts, and nothing anywhere inspected a mid-session 401 — the app
 * simply showed "Host unavailable" until the phone happened to lock. */
let onUnauthorized: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler;
}

/** A stalled socket on bad signal would otherwise hang a screen forever; the
 * splash in particular had no way back. */
const REQUEST_TIMEOUT = 10_000;

function withTimeout(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  // Pre-Baseline fallback: falling back to the caller's signal alone silently
  // dropped the timeout, reintroducing the forever-hung screen on bad signal.
  const both = new AbortController();
  const abort = () => both.abort();
  if (signal.aborted || timeout.aborted) abort();
  signal.addEventListener("abort", abort);
  timeout.addEventListener("abort", abort);
  return both.signal;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: withTimeout(init?.signal),
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError(0, "timeout");
    throw new ApiError(0, "offline");
  }
  let body: { error?: string } | undefined;
  try {
    body = await response.json() as { error?: string };
  } catch {
    body = undefined;
  }
  if (response.status === 401 && !path.startsWith("/api/v1/auth/") && path !== "/api/v1/pair") {
    onUnauthorized?.();
  }
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed");
  // A truncated body on a 200 used to become `{}` and reach callers as `T`,
  // which then read `undefined.map` and white-screened the whole app.
  if (body === undefined) throw new ApiError(response.status, "malformed_response");
  return body as T;
}

/** A file the phone dropped into the tab's project inbox. `reference` is
 * project-relative (`.eldrun/inbox/<file>`) — the one path shape that crosses
 * this boundary, because it carries no host component and is exactly what the
 * agent needs after an `@`. */
export interface InboxAttachment { name: string; reference: string; size: number }
/** Mirrors the desktop's `inbox::MAX_INBOX_FILE`; checked here first so an
 * oversized pick fails before any bytes leave the phone. */
export const MAX_INBOX_FILE = 24 * 1024 * 1024;
/** A photo over a cellular link is not a 10-second request. */
const UPLOAD_TIMEOUT = 120_000;

/** `POST /api/v1/tabs/{id}/inbox` — the raw file as the body, its name in the
 * query (a header cannot carry a non-Latin-1 photo-library name). */
export async function uploadToInbox(tabId: string, file: Blob, name: string): Promise<InboxAttachment> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/tabs/${encodeURIComponent(tabId)}/inbox?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: file,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError(0, "timeout");
    throw new ApiError(0, "offline");
  }
  let body: { error?: string; attachment?: InboxAttachment } | undefined;
  try {
    body = await response.json() as typeof body;
  } catch {
    body = undefined;
  }
  if (response.status === 401) onUnauthorized?.();
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed");
  if (!body?.attachment?.reference) throw new ApiError(response.status, "malformed_response");
  return body.attachment;
}
