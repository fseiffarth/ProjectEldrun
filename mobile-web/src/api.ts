/** One row of the phone's list. `kind` says whether it is a project or a box
 * (#31aa) — a box is a scope of its own on the desktop, always "active" here,
 * and a host older than the field sends none, which reads as a project. */
export interface ProjectRow { id: string; label: string; status: string; kind?: "project" | "box"; live_sessions: number; last_activity?: number }
export type AgentStatus = "working" | "question" | "done";
/** The desktop's own one-line summary of a tab's scheduled prompts: what the
 * Agents view prints under an agent tab, so the project overview says the same
 * thing without opening the sheet. `next` is desktop-local wall clock. */
export interface TabSchedules { total: number; enabled: number; next?: string }
/** `agent_model` is the model the tab's session is showing, as the desktop
 * reads it off the pane's own status line — the same words, and the same
 * parse, as the model chip in Focus (`terminal/statusLine`); for a tab whose
 * pane the desktop window does not hold it falls back to the model the tab
 * last answered with, shortened from the transcript's id. `working_at`/
 * `done_at` are desktop wall-clock ms of the tab's last working output and
 * last finished turn. All three are the desktop's own readings and absent
 * while it is closed or before the tab has done either. */
/** One prompt an agent tab was given, as the desktop read it off the agent's
 * own transcript — typed into the terminal, pasted, sent from here or by a
 * schedule alike. `at` is the transcript record's ISO instant, which the phone
 * formats in its own zone; a record that carried none arrives without one, and
 * so does the one line a transcript-less agent leaves on its own screen. */
export interface TabPrompt { text: string; at?: string }
export interface TabRow { id: string; label: string; kind: "shell" | "agent"; agent_label?: string; agent_status?: AgentStatus; agent_model?: string; working_at?: number; done_at?: number; schedules?: TabSchedules; prompts?: TabPrompt[]; available: boolean; viewer_busy: boolean; last_activity?: number; /** The tab's colour as a palette id (see `tabColors.ts`); absent when it has none. */ color?: string }
export interface AgentRow { id: string; label: string; modes: ("plan" | "auto")[] }
/** One agent tab in the cross-project activity list: an ordinary tab row plus
 * the project it lives in, because that list is flat and a tab label on its own
 * does not say where the session is. */
export interface ActivityTab extends TabRow { project_id: string; project_label: string }
export interface ActivityList { tabs: ActivityTab[]; desktop_available: boolean }

/** `GET /api/v1/activity` — every agent tab the desktop reports as working,
 * waiting on a decision, or done, across every project this phone may reach.
 * The desktop classifies; with none open the list is empty rather than wrong. */
export function getActivity(signal?: AbortSignal): Promise<ActivityList> {
  return api<ActivityList>("/api/v1/activity", { signal });
}
export type ScheduleRule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekdays"; weekdays: number[]; time: string };
export interface ScheduledPrompt {
  id: string;
  enabled: boolean;
  message: string;
  rule: ScheduleRule;
  last?: { occurrence: string; result: "delivered" | "missed" | "failed"; at: string };
}
export interface ScheduledPromptInput { enabled: boolean; message: string; rule: ScheduleRule }
export interface ScheduledPromptList { schedules: ScheduledPrompt[]; time_zone: string; next_runs: Record<string, string> }
/** A prompt collected for a project without a tab. Ids and timestamps are the
 * desktop's; the phone only ever sends the text. */
export interface ProjectPrompt { id: string; message: string; created_at: string; updated_at: string }
export interface ProjectPromptList { prompts: ProjectPrompt[] }
export interface ProjectDetail { project: ProjectRow; tabs: TabRow[]; desktop_available: boolean; agents: AgentRow[] }
export interface TodoColumn { id: string; name: string; position: number; done: boolean; archived: boolean; intake: boolean; overdue: boolean; due_today: boolean; color?: string }
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
    columns: (board.columns ?? []).map((column) => ({
      ...column,
      archived: column.archived ?? false,
      // `intake` is newer still, and a desktop that does not send one had the
      // board laid out so that the leftmost open column *was* the intake — which
      // is what the callers fall back to when no column carries the flag.
      intake: column.intake ?? false,
      // The date-governed pair. False from an older desktop is the honest
      // reading again: a board that flags neither has no column a deadline
      // decides, so no move into one needs refusing.
      overdue: column.overdue ?? false,
      due_today: column.due_today ?? false,
    })),
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
/** A bounded snapshot of the desktop Alerts feed. Source ids never cross the
 * mobile boundary: the only two handles a row carries are opaque and named by
 * the desktop — the board card behind a task row, and the row itself, which is
 * what `resolveAlert` presses the ✓ on. What that ✓ *does* stays desktop-side. */
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
  /** The row's opaque handle, the one thing `resolveAlert` needs to press its ✓.
   * It names a row of this feed and nothing behind it — a row the desktop could
   * not mint a handle for simply carries no ✓. */
  alert_id?: string;
}
export interface MobileAlerts { enabled: boolean; items: MobileAlertItem[] }

/** `POST /api/v1/alerts` — the desktop strip's ✓, pressed from the phone.
 *
 * What Done means is the desktop's and stays there: a card is completed into
 * the board's Done column, a mail's local priority mark is cleared, a meeting is
 * muted in the strip. None of the three deletes anything, and the phone names
 * only the row. The answer is the feed as it stands afterwards, so the list the
 * ✓ came from is replaced rather than patched by guesswork. */
export function resolveAlert(alertId: string): Promise<{ alerts: MobileAlerts }> {
  return api("/api/v1/alerts", { method: "POST", body: JSON.stringify({ alert_id: alertId }) });
}
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
export interface MobileMailHeader { id: string; subject: string; sender: { name?: string; address: string }; date: string; seen: boolean; flagged?: boolean; answered?: boolean; has_attachments: boolean; preview: string }
export interface MobileMailAttachment { filename: string; mime: string; size: number }
/** The only flag writes the phone may ask for. Delete and move do not exist here. */
export type MailMarkAction = "seen" | "unseen" | "flag" | "unflag";
/** What the connected desktop lets this phone *do* to mail, beyond reading.
 * Both are desktop settings, default off; the phone hides the controls rather
 * than discovering a refusal. Absent from an older desktop means off. */
export interface MobileMailWrites { actions?: boolean; reply?: boolean }
export type MobileMailView =
  | ({ view: "overview"; accounts: MobileMailAccount[] } & MobileMailWrites)
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

function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
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

/** `timeoutMs` overrides the default deadline for the one route that needs a
 * longer one (see `getAgentStatus`); everything else keeps `REQUEST_TIMEOUT`,
 * because a screen with no way back is worse than a failed request. */
export async function api<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: withTimeout(init?.signal, timeoutMs),
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

/** Mirrors the desktop's `protocol::MAX_TAB_LABEL`: the catalog truncates a
 * label to this many characters when it publishes one, so a longer rename would
 * come back as different text than was typed. */
export const MAX_TAB_LABEL = 120;

/** `PUT /api/v1/tabs/{id}` — rename one agent tab. The desktop owns the tab
 * layout, so this is a bridge call and needs desktop Eldrun to be open. */
export function renameTab(tabId: string, label: string): Promise<{ tab?: TabRow; label?: string }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}`, { method: "PUT", body: JSON.stringify({ label }) });
}

/** `PUT /api/v1/tabs/{id}/color` — paint one tab, agent or shell, with a colour
 * from the palette, or clear it by passing `null`. Only the palette id crosses;
 * both surfaces resolve it to the same hex (see `tabColors.ts`). Its own route
 * rather than a field on the rename above, because the rename is agent-only
 * while a colour is for any tab the phone lists. A bridge call, so it needs
 * desktop Eldrun open. */
export function setTabColor(tabId: string, color: string | null): Promise<{ tab?: TabRow; color?: string | null }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/color`, { method: "PUT", body: JSON.stringify({ color }) });
}

/** `POST /api/v1/tabs/{id}/prompt` — tell the desktop what the composer just
 * sent to this agent tab, for its prompt history: the words went to tmux over
 * the terminal socket, where the desktop never sees them. Fire-and-forget —
 * the prompt is already on its way, and a lost report costs a list row. */
export function reportSentPrompt(tabId: string, message: string): Promise<unknown> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
}

/** Which side of the anchor tab a dragged row lands on — the desktop's own
 * `reorderTabInScope` vocabulary, so both surfaces mean one thing by a drop. */
export type TabPlace = "before" | "after";

/** `PUT /api/v1/tabs/{id}/order` — move one tab next to another inside the same
 * project, the phone's half of the desktop Agents view's drag reorder. Both
 * tabs are named by their opaque ids; the answer is the project's tab ids in
 * the order the desktop now holds them, which is what the list reconciles
 * against after having rearranged itself on the drop. A bridge call, so it
 * needs desktop Eldrun open. */
export function reorderTab(tabId: string, anchorId: string, place: TabPlace): Promise<{ tabs?: string[] }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/order`, {
    method: "PUT",
    body: JSON.stringify({ anchor: anchorId, place }),
  });
}

/** `DELETE /api/v1/tabs/{id}` — close one tab, agent or shell. Closing is the
 * desktop's own ×: the tab leaves the Eldrun window, and the session behind it
 * keeps running and stays reattachable from the desktop's Sessions view. Like
 * the rename above it is a bridge call, so it needs desktop Eldrun open. */
export function closeTab(tabId: string): Promise<{ closed: boolean }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
}

const schedulePath = (tabId: string) => `/api/v1/tabs/${encodeURIComponent(tabId)}/schedules`;

export function getSchedules(tabId: string): Promise<ScheduledPromptList> {
  return api(schedulePath(tabId));
}

export function createSchedule(tabId: string, schedule: ScheduledPromptInput): Promise<ScheduledPromptList> {
  return api(schedulePath(tabId), { method: "POST", body: JSON.stringify(schedule) });
}

export function updateSchedule(tabId: string, scheduleId: string, schedule: ScheduledPromptInput): Promise<ScheduledPromptList> {
  return api(`${schedulePath(tabId)}/${encodeURIComponent(scheduleId)}`, {
    method: "PUT",
    body: JSON.stringify(schedule),
  });
}

export function deleteSchedule(tabId: string, scheduleId: string): Promise<ScheduledPromptList> {
  return api(`${schedulePath(tabId)}/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}

/** What one agent CLI answered when asked about its own quota. `raw` is the
 * panel as the CLI printed it — the sheet's Terminal half shows exactly that,
 * and `shared/usageReport.ts` is the only thing that parses it. */
export interface AgentUsagePanel { label: string; supported: boolean; raw?: string; error?: string; cached: boolean }
/** Today's counters for the tab's project, at the grain the desktop records
 * them: `prompts` is this agent's, the other three are the project's — every
 * agent tab in it — which is what the sheet's wording says. */
export interface AgentTally { prompts: number; worked_s: number; decisions: number; done: number }
export interface AgentStatusReport {
  state: "working" | "question" | "done" | "idle";
  label: string;
  agent?: string;
  project: string;
  today: AgentTally;
  usage: AgentUsagePanel;
}

/** Reading the usage panel may run the agent's CLI once on the desktop, which
 * is slower than any other control call — its own deadline, above the desktop's
 * (20s) and the CLI's (15s), so a slow answer arrives rather than being cut. */
const STATUS_TIMEOUT = 30_000;

/** `GET /api/v1/tabs/{id}/status` — the composer's status chip. `refresh` asks
 * the desktop to run the CLI again instead of answering from its short-lived
 * cache; the desktop applies its own floor to that, so holding the button down
 * cannot spawn a process per tap. */
export async function getAgentStatus(tabId: string, refresh = false): Promise<AgentStatusReport> {
  const query = refresh ? "?refresh=1" : "";
  const { report } = await api<{ report: AgentStatusReport }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/status${query}`,
    undefined,
    STATUS_TIMEOUT,
  );
  return report;
}

/** One turn of an agent tab's stored conversation, as the desktop reads it
 * off the CLI's own transcript (`services::agent_transcript`). */
export interface TranscriptEntry { kind: "prompt" | "answer"; text: string; at?: string; cut?: boolean }
export interface SessionTranscript {
  available: boolean;
  /** Why not, when unavailable: `unsupported`, `no_session`, `no_transcript`, `read_failed`. */
  reason?: string;
  /** Hand back on the next read to be answered `unchanged`. */
  version?: string;
  unchanged?: boolean;
  entries: TranscriptEntry[];
  /** Earlier turns exist that this answer does not carry. */
  truncated: boolean;
  /** The session's own usage figures, where its transcript records them
   *  (Codex's rollout does; Claude's does not). */
  usage?: SessionUsage;
}

/** One rate-limit window of a stored session: percent used, and the reset in
 *  Unix seconds. */
export interface SessionUsageWindow { used: number; resetsAt?: number }
export interface SessionUsage {
  /** Percent of the context window left. */
  contextLeft?: number;
  session?: SessionUsageWindow;
  week?: SessionUsageWindow;
}

/** `GET /api/v1/tabs/{id}/transcript` — the Focus view's stored-session feed.
 * `version` is what the last answer carried: while the transcript file has
 * not moved the desktop answers `unchanged` and no turns cross the link, which
 * is what makes polling it while the agent works affordable on cellular. */
export async function getTranscript(tabId: string, version?: string, limit?: number, signal?: AbortSignal): Promise<SessionTranscript> {
  const query = new URLSearchParams();
  if (version) query.set("version", version);
  if (limit) query.set("limit", String(limit));
  const suffix = query.size > 0 ? `?${query}` : "";
  const { transcript } = await api<{ transcript: SessionTranscript }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/transcript${suffix}`,
    { signal },
  );
  return transcript;
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
const promptsPath = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/prompts`;

export function getPrompts(projectId: string): Promise<ProjectPromptList> {
  return api(promptsPath(projectId));
}

export function createPrompt(projectId: string, message: string): Promise<ProjectPromptList> {
  return api(promptsPath(projectId), { method: "POST", body: JSON.stringify({ message }) });
}

export function updatePrompt(projectId: string, promptId: string, message: string): Promise<ProjectPromptList> {
  return api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}`, { method: "PUT", body: JSON.stringify({ message }) });
}

export function deletePrompt(projectId: string, promptId: string): Promise<ProjectPromptList> {
  return api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}`, { method: "DELETE" });
}

/** Send-now: the desktop turns the prompt into a one-time schedule at its own
 * current minute for `tabId`, delivered at that tab's next safe idle point. */
export function sendPrompt(projectId: string, promptId: string, tabId: string): Promise<ProjectPromptList> {
  return api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}/send`, { method: "POST", body: JSON.stringify({ tab_id: tabId }) });
}

/** One image the desktop offers the composer: the clipboard's image or a
 * recent file of its screenshot/picture folders. `id` is opaque and `source`
 * a folder *label* — the desktop keeps every path. */
export interface DesktopImage {
  id: string;
  name: string;
  source: string;
  size?: number;
  age_secs?: number;
  width?: number;
  height?: number;
}

/** `GET /api/v1/tabs/{id}/desktop-images` — what the desktop would copy into
 * this tab's project inbox. The desktop may probe its clipboard for this,
 * which is bounded on its side. */
export async function listDesktopImages(tabId: string): Promise<DesktopImage[]> {
  const { images } = await api<{ images: DesktopImage[] }>(`/api/v1/tabs/${encodeURIComponent(tabId)}/desktop-images`);
  return images;
}

/** `POST /api/v1/tabs/{id}/desktop-images` — copy one listed image into the
 * project inbox; answers like the phone's own upload, with the reference. */
export async function attachDesktopImage(tabId: string, imageId: string): Promise<InboxAttachment> {
  const { attachment } = await api<{ attachment: InboxAttachment }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/desktop-images`,
    { method: "POST", body: JSON.stringify({ image_id: imageId }) },
    30_000,
  );
  return attachment;
}

/** One picture the agent left for the phone in the project's `.eldrun/outbox/`
 * (`outbox.rs`) — the mirror of the inbox. `name` is the leaf the desktop
 * validated and the only thing the phone hands back; `kind` is what the
 * bytes say, not the extension; `modified` is unix seconds. */
export interface OutboxFile { name: string; kind: string; size: number; modified: number }

/** Which door onto one project's outbox a read goes through: the session the
 * files were sent from (the Focus screen), or the project itself (the project
 * screen's shelf, which has no tab to name and outlives every closed one).
 * Both answer the same directory — the outbox belongs to the project. */
export type OutboxScope = { tab: string } | { project: string };

function outboxBase(scope: OutboxScope): string {
  return "tab" in scope
    ? `/api/v1/tabs/${encodeURIComponent(scope.tab)}/outbox`
    : `/api/v1/projects/${encodeURIComponent(scope.project)}/outbox`;
}

/** `GET …/outbox` — the files the desktop put out for the phone, newest
 * first. Read from disk by the sidecar, so it answers with the desktop closed
 * too. */
export async function listOutbox(scope: OutboxScope, signal?: AbortSignal): Promise<OutboxFile[]> {
  const { files } = await api<{ files: OutboxFile[] }>(outboxBase(scope), { signal });
  return files;
}

/** The URL an `<img>` loads one outbox image from — same origin, so the
 * session cookie rides along and the CSP's `img-src 'self'` lets it render. */
export function outboxFileUrl(scope: OutboxScope, name: string, download = false): string {
  return `${outboxBase(scope)}/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;
}

/** `DELETE …/outbox/{name}` — drop one of those files. The sidecar deletes
 * only a leaf its own listing handed out, and the route carries the
 * exact-origin check every mutating one does; the caller drops the row it
 * asked about rather than waiting for the next poll. */
export async function deleteOutboxFile(scope: OutboxScope, name: string): Promise<void> {
  await api<{ removed: boolean }>(`${outboxBase(scope)}/${encodeURIComponent(name)}`, { method: "DELETE" });
}

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
