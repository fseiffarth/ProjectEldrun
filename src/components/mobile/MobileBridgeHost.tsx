import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { restoreProjectScope, useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import {
  RESUMABLE_AGENTS,
  ROOT_SCOPE,
  useTabsStore,
  type TabEntry,
} from "../../stores/tabs";
import { ensureRootScopeHydrated, useRootOverlayStore } from "../../stores/rootOverlay";
import { closeTabInScope } from "../../lib/remote/closeRemoteTab";
import { useSettingsStore } from "../../stores/settings";
import { calendarColor, useCalendarStore, visibleCalendarIds } from "../../stores/calendar/calendar";
import { lastTabReadAt, noteUserInput, useActivityStore } from "../../stores/activity";
import { agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { persistScopeLayout } from "../../stores/agents/agentSchedules";
import { sendCollectedPrompt, useAgentPromptsStore, type ProjectAgentPrompt, type SentAgentPrompt } from "../../stores/agents/agentPrompts";
import { isSessionCommand } from "../../lib/agents/prompt/chart";
import { isTabColor } from "../../lib/theme/tabColors";
import type { AgentUsageReport } from "../../lib/agents/agentUsage";
import { METRIC, agentLabel, agentPromptLeaf, sub } from "../../lib/usageMetrics";
import { dayKey } from "../../lib/usageRollup";
import { resolveProjectDirectory } from "../../types";
import type { CalendarEvent, CalendarTask, ProjectEntry, Subtask, TaskColumn } from "../../types";
import type { MailFolder, MailHeader } from "../../types/mail";
import { addSubtask, boardColumns, columnOf, dropAccepted, fallbackColumnId, provisionalRank, toggleTaskDone } from "../../lib/todoBoard";
import { addDays, monthGrid, toStamp } from "../../lib/calendar/calendarTime";
import { eventColor } from "../../lib/calendar/calendarCategories";
import { expandEvents } from "../../lib/calendar/recurrence";
import {
  formatAddress,
  formatMailDate,
  mailAccountsList,
  mailBody,
  mailDraftSave,
  mailDraftSend,
  mailFlag,
  mailFolders,
  mailHeaders,
  stripFormatControls,
} from "../../lib/mail";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  buildStaticTabSpec,
  customAgentToItem,
  type StaticMenuItem,
} from "../tabs/newTabItems";
import { useI18nStore, useT } from "../../lib/i18n";
import { resolveUse24h } from "../../lib/timeFormat";
import { finishAlert } from "../../lib/alertDone";
import { useAlertsFeed, type AlertsFeed } from "../files/useAlertsFeed";
import {
  desktopTimeZone,
  localOccurrenceKey,
  nextScheduleOccurrence,
  scheduleSummary,
  type ScheduleRule,
  type ScheduledAgentPrompt,
} from "../../lib/agents/agentSchedule";

const MOBILE_DESKTOP_EVENT = "eldrun-mobile-desktop-request";

interface AgentInfo { bin: string; installed: boolean }
interface CatalogAgent { id: string; label: string; modes: string[] }
interface AgentTabStatus { tmux_session: string; status: "working" | "question" | "done"; model?: string; working_at?: number; done_at?: number }
/** The same readings for an agent tab with no status: a finished turn stays
 * sorted among the finished ones on the phone after it has been read. */
interface AgentTabTiming { tmux_session: string; working_at?: number; done_at?: number }
interface AgentTabSchedules { tmux_session: string; total: number; enabled: number; next?: string }
interface AgentTabPrompt { text: string; at?: string }
interface AgentTabPrompts { tmux_session: string; prompts: AgentTabPrompt[] }
interface CreateRequest {
  project_id: string;
  kind: "shell" | "agent";
  agent_id?: string;
  mode?: string;
  idempotency_key: string;
}
interface TodoColumn { id: string; name: string; position: number; done: boolean; archived: boolean; overdue?: boolean; due_today?: boolean; color?: string }
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
  alert_id?: string;
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
interface MobileCalendarInfo { id: string; name: string; color: string; visible: boolean; readonly: boolean; subscribed: boolean; caldav: boolean }
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
interface MobileMailHeader { id: string; subject: string; sender: { name?: string; address: string }; date: string; seen: boolean; flagged: boolean; answered: boolean; has_attachments: boolean; preview: string }
interface MobileMailAttachment { filename: string; mime: string; size: number }
type MailMarkAction = "seen" | "unseen" | "flag" | "unflag";
type MobileMailView =
  | { view: "overview"; accounts: MobileMailAccount[]; actions: boolean; reply: boolean }
  | { view: "folder"; folder: MobileMailFolder; messages: MobileMailHeader[]; total: number; offset: number }
  | { view: "message"; message: MobileMailHeader; body: string; truncated: boolean; attachments: MobileMailAttachment[] };
type TodoAction =
  | { type: "create"; task: TodoTaskInput }
| { type: "move"; task_id: string; column: string; index?: number }
  | { type: "toggle"; task_id: string }
  | { type: "update"; task_id: string; task: TodoTaskInput }
  | { type: "delete"; task_id: string }
  | { type: "column_create"; name: string }
  | { type: "column_rename"; column_id: string; name: string }
  | { type: "column_move"; column_id: string; delta: -1 | 1 }
  | { type: "column_delete"; column_id: string };
/** `error` is a fixed code (`AgentUsageReport.code`), never the CLI's own
 * words: its stderr names paths on this machine. */
interface MobileAgentUsage { label: string; supported: boolean; raw?: string; error?: string; cached: boolean }
interface MobileAgentTally { prompts: number; worked_s: number; decisions: number; done: number }
interface MobileAgentStatus {
  state: "working" | "question" | "done" | "idle";
  label: string;
  agent?: string;
  project: string;
  today: MobileAgentTally;
  usage: MobileAgentUsage;
}
/** Mirrors `services::agent_transcript::AgentTranscript` on the wire. */
interface MobileAgentTranscript {
  available: boolean;
  reason?: string;
  version?: string;
  unchanged?: boolean;
  entries: { kind: string; text: string; at?: string; cut?: boolean; subagent?: string; role?: string }[];
  truncated: boolean;
  /** Codex's context and rate-limit figures, passed through untouched. */
  usage?: { contextLeft?: number; session?: { used: number; resetsAt?: number }; week?: { used: number; resetsAt?: number } };
}
interface MobileScheduleInput { enabled: boolean; message: string; rule: ScheduleRule }
type ScheduleMutation =
  | { type: "create"; schedule: MobileScheduleInput }
  | { type: "update"; schedule_id: string; schedule: MobileScheduleInput }
  | { type: "delete"; schedule_id: string };
interface MobilePromptInput { message: string }
type PromptMutation =
  | { type: "create"; prompt: MobilePromptInput }
  | { type: "update"; prompt_id: string; prompt: MobilePromptInput }
  | { type: "delete"; prompt_id: string }
  | { type: "send"; prompt_id: string; tmux_session: string };
type DesktopRequest =
| { type: "catalog"; request_id: string; project_id?: string }
  | { type: "activity"; request_id: string }
  | { type: "activate"; request_id: string; project_id: string }
  | { type: "create"; request_id: string; request: CreateRequest }
  | { type: "todo"; request_id: string }
  | { type: "alerts"; request_id: string }
  | { type: "alert_resolve"; request_id: string; alert_id: string }
  | { type: "calendar"; request_id: string; month: string }
  | { type: "calendar_mutate"; request_id: string; month: string; action: CalendarAction }
  | { type: "todo_mutate"; request_id: string; action: TodoAction }
  | { type: "mail_overview"; request_id: string }
  | { type: "mail_folder"; request_id: string; folder_id: string; offset: number }
  | { type: "mail_message"; request_id: string; folder_id: string; message_id: string; offset: number }
  | { type: "mail_mark"; request_id: string; folder_id: string; message_id: string; offset: number; action: MailMarkAction }
  | { type: "mail_reply"; request_id: string; folder_id: string; message_id: string; offset: number; body: string }
  | { type: "schedules"; request_id: string; project_id: string; tmux_session: string }
  | { type: "schedule_mutate"; request_id: string; project_id: string; tmux_session: string; action: ScheduleMutation }
  | { type: "rename_tab"; request_id: string; project_id: string; tmux_session: string; label: string }
  | { type: "color_tab"; request_id: string; project_id: string; tmux_session: string; color?: string | null }
  | { type: "reorder_tab"; request_id: string; project_id: string; tmux_session: string; anchor_tmux_session: string; place: "before" | "after" }
  | { type: "close_tab"; request_id: string; project_id: string; tmux_session: string }
  | { type: "prompts"; request_id: string; project_id: string }
  | { type: "prompt_mutate"; request_id: string; project_id: string; action: PromptMutation }
  | { type: "agent_status"; request_id: string; project_id: string; tmux_session: string; refresh: boolean }
  | { type: "agent_transcript"; request_id: string; project_id: string; tmux_session: string; subagent?: string | null; version?: string | null; limit?: number | null }
  | { type: "tab_seen"; request_id: string; project_id: string; tmux_session: string }
  | { type: "tab_input"; request_id: string; project_id: string; tmux_session: string }
  | { type: "tab_prompt"; request_id: string; project_id: string; tmux_session: string; message: string }
  | { type: "desktop_images"; request_id: string; project_id: string }
  | { type: "attach_desktop_image"; request_id: string; project_id: string; image_id: string };
type DesktopResponse =
| { status: "catalog"; agents: CatalogAgent[]; statuses: AgentTabStatus[]; schedules: AgentTabSchedules[]; prompts: AgentTabPrompts[]; timings: AgentTabTiming[] }
  | { status: "activity"; statuses: AgentTabStatus[]; prompts: AgentTabPrompts[] }
  | { status: "activated" }
  | { status: "created"; tmux_session: string }
  | { status: "todo"; board: TodoBoard }
  | { status: "alerts"; alerts: MobileAlerts }
  | { status: "calendar"; calendar: MobileCalendar }
  | { status: "mail"; mail: MobileMailView }
  | { status: "schedules"; schedules: ScheduledAgentPrompt[]; time_zone: string; next_runs: Record<string, string> }
  | { status: "renamed"; label: string }
  | { status: "colored"; color?: string | null }
  | { status: "reordered" }
  | { status: "closed" }
  | { status: "prompts"; prompts: ProjectAgentPrompt[] }
  | { status: "agent_status"; report: MobileAgentStatus }
  | { status: "agent_transcript"; transcript: MobileAgentTranscript }
  | { status: "seen" }
  | { status: "desktop_images"; images: DesktopImage[] }
  | { status: "attached"; attachment: InboxAttachment }
  | { status: "error"; code: string; message: string };

/** One image the desktop offers the phone's composer — an opaque id and a
 * folder label, never a path (`services::desktop_images`). */
interface DesktopImage { id: string; name: string; source: string; size?: number; age_secs?: number; width?: number; height?: number }
/** A file that landed in the project's `.eldrun/inbox/`: what the phone's own
 * upload gets back, so the two ways of filling the inbox read alike. */
interface InboxAttachment { name: string; reference: string; size: number }

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

/** The one gate every bridge handler applies before it touches a project: the
 * per-project Mobile switch is on, and the project is none of the trust tiers
 * the sidecar deliberately never reaches (remote, sandboxed, VM). */
function mobileProject(projectId: string | undefined) {
  if (!projectId) return undefined;
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId);
  if (
    !project
    || project.remote
    || project.sandbox?.enabled
    || project.vm?.enabled
    || !project.eldrun_mobile_access
  ) {
    return undefined;
  }
  return project;
}

/** A scope the phone may reach, in the four facts a handler needs of it. A
 * project with its Mobile switch on, or — #31aa — a box with its own: the
 * sidecar hands the desktop a `box:<id>` scope id as the "project id", and
 * that is the tab store's key for the box's tabs exactly as a project id is
 * for a project's, so the same handlers serve both once the identity, the
 * home directory and the export target come from here rather than from a
 * `ProjectEntry`. The box's switch is the one consent consulted: its tabs run
 * locally whatever its members are, and a member's own switch stays about the
 * member's own tabs. */
interface MobileScope {
  /** The tab store's scope key: the project id, or `box:<id>`. */
  id: string;
  name: string;
  /** Where a new tab starts and the inbox lives: the project or box folder. */
  cwd: string;
  /** The project.json a persist exports to; "" for a box, whose layout lives
   *  in the state dir only (the tab store's own rule for box scopes). */
  localFile: string;
  /** The project behind a project scope. */
  project?: ProjectEntry;
}

/** The one thing the root gate needs that no store holds: whether a root agent
 * started now would run fenced (`root_mcp_status`'s `review_enforced`). Read
 * when the bridge mounts and again, in the background, each time the gate is
 * asked — `mobileScope` is synchronous, so it answers from the last reading
 * and stays closed until there has been one. */
const rootFacts = { reviewEnforced: false };

function refreshRootFacts(): void {
  void invoke<{ review_enforced?: boolean }>("root_mcp_status")
    .then((status) => { rootFacts.reviewEnforced = status.review_enforced === true; })
    .catch(() => { rootFacts.reviewEnforced = false; });
}

/** The root console as a phone scope (`docs/context/root_console.md`, "On the
 * phone"). The sidecar's `discovery::root_open` is the perimeter; this is the
 * desktop-side repeat of the same rule, because the bridge is reachable without
 * going through it: the switch is on, and either root agents carry no MCP tools
 * or every write of theirs is staged behind a fence they cannot walk around. */
function mobileRootScope(): MobileScope | undefined {
  const settings = useSettingsStore.getState().settings;
  if (settings?.eldrun_mobile_host?.root_access !== true) return undefined;
  refreshRootFacts();
  if (settings.root_mcp !== false) {
    const level = settings.root_mcp_review;
    if (level === "destructive" || level === "off" || !rootFacts.reviewEnforced) return undefined;
  }
  const cwd = useProjectsStore.getState().rootDir;
  if (!cwd) return undefined;
  return { id: ROOT_SCOPE, name: "Root", cwd, localFile: "" };
}

function mobileScope(id: string | undefined): MobileScope | undefined {
  if (!id) return undefined;
  if (id === ROOT_SCOPE) return mobileRootScope();
  if (id.startsWith(BOX_SCOPE_PREFIX)) {
    const box = useBoxesStore.getState().boxes.find((entry) => boxScopeId(entry.id) === id);
    // A box never opened has no folder yet; the switch resolves one on enable,
    // so this only refuses a bit hand-edited onto a folder-less record.
    if (!box?.eldrun_mobile_access || !box.folder) return undefined;
    return { id, name: box.name, cwd: box.folder, localFile: "" };
  }
  const project = mobileProject(id);
  if (!project) return undefined;
  return { id: project.id, name: project.name, cwd: resolveProjectDirectory(project), localFile: project.local_file, project };
}

/** Every scope the phone may reach right now: root behind its gate, the
 * opted-in projects, then the opted-in boxes. Walked from the lists rather
 * than the tab store's scope keys so that each switch and the trust tiers gate
 * its entry: a scope key is not a permission. */
function allMobileScopes(): MobileScope[] {
  const projects = useProjectsStore.getState().projects.flatMap((entry) => mobileScope(entry.id) ?? []);
  const boxes = useBoxesStore.getState().boxes.flatMap((entry) => mobileScope(boxScopeId(entry.id)) ?? []);
  const root = mobileScope(ROOT_SCOPE);
  return [...(root ? [root] : []), ...projects, ...boxes];
}

/** Load a scope's saved tabs when the desktop has not opened it this session.
 * A box needs none here: its tabs restore when it is opened. */
async function restoreScope(scope: MobileScope): Promise<void> {
  if (scope.project) await restoreProjectScope(scope.project).catch(() => {});
  else if (scope.id === ROOT_SCOPE) await ensureRootScopeHydrated();
}

/** The phone receives these already-derived activity facts only. The desktop
 * owns terminal output and prompt classification, while the sidecar maps the
 * tmux names back to opaque phone-visible tab ids. */
function agentStatuses(projectId?: string): AgentTabStatus[] {
  const scope = mobileScope(projectId);
  return scope ? projectAgentStatuses(scope.id) : [];
}

/**
 * What the phone is told one agent tab is doing.
 *
 * The first three answers are the desktop's own lamps, unchanged. The fourth is
 * the one this window cannot read off `attentionByTab`: that flag means UNREAD
 * output and is deliberately never raised for the tab under the user's eyes —
 * but "under the user's eyes" here is only "it is the visible tab of its group",
 * which an unattended desktop satisfies all night. A phone asking "did anything
 * finish?" would then be told no, forever, about precisely the tab its owner
 * left open. So a finished turn nobody has *arrived at* since (`lastTabReadAt`,
 * moved by a tab switch here or by the phone opening the tab) is reported as
 * done on its own evidence.
 */
function mobileAgentState(ptyId: string): "working" | "question" | "done" | "idle" {
  const activity = useActivityStore.getState();
  if (activity.busyByTab[ptyId]) return "working";
  if (activity.attentionByTab[ptyId] === "decision") return "question";
  if (activity.attentionByTab[ptyId] === "done") return "done";
  const doneAt = activity.lastDoneByTab[ptyId];
  if (doneAt !== undefined && doneAt > (lastTabReadAt(ptyId) ?? 0)) return "done";
  return "idle";
}

function projectAgentStatuses(projectId: string): AgentTabStatus[] {
  const activity = useActivityStore.getState();
  const models = useAgentModelsStore.getState();
  return (useTabsStore.getState().tabsByScope[projectId] ?? []).flatMap((tab) => {
    if (tab.kind !== "agent" || !tab.tmuxSession) return [];
    const ptyId = `${projectId}:${tab.key}`;
    const state = mobileAgentState(ptyId);
    if (state === "idle") return [];
    const status: AgentTabStatus["status"] = state;
    // The phone sorts by these and tags the row with the model; the answer is
    // whatever the desktop knows at this poll (the model store throttles its
    // own re-read), so the phone can be one poll behind, never wrong. The
    // model is read off the pane first, which owes nothing to that throttle.
    void models.refresh(projectId, tab);
    const row: AgentTabStatus = { tmux_session: tab.tmuxSession, status };
    const model = agentTabModelTag(projectId, tab, models.byTab);
    if (model) row.model = model;
    const workingAt = status === "working" ? Date.now() : activity.lastWorkingByTab[ptyId];
    if (workingAt !== undefined) row.working_at = workingAt;
    const doneAt = activity.lastDoneByTab[ptyId];
    if (doneAt !== undefined) row.done_at = doneAt;
    return [row];
  });
}

/** Timings of the agent tabs `projectAgentStatuses` leaves out (a quiet or
 * already-read tab), so the phone's "last working" sort keeps a read turn in
 * its place among the finished ones instead of dropping it to its tab-bar spot. */
function projectAgentTimings(projectId: string): AgentTabTiming[] {
  const activity = useActivityStore.getState();
  return (useTabsStore.getState().tabsByScope[projectId] ?? []).flatMap((tab) => {
    if (tab.kind !== "agent" || !tab.tmuxSession) return [];
    const ptyId = `${projectId}:${tab.key}`;
    if (mobileAgentState(ptyId) !== "idle") return [];
    const row: AgentTabTiming = { tmux_session: tab.tmuxSession };
    const workingAt = activity.lastWorkingByTab[ptyId];
    if (workingAt !== undefined) row.working_at = workingAt;
    const doneAt = activity.lastDoneByTab[ptyId];
    if (doneAt !== undefined) row.done_at = doneAt;
    return row.working_at === undefined && row.done_at === undefined ? [] : [row];
  });
}

function agentTimings(projectId?: string): AgentTabTiming[] {
  const scope = mobileScope(projectId);
  return scope ? projectAgentTimings(scope.id) : [];
}

/** The same facts for *every* scope the phone may reach — projects and boxes
 * alike — for its flat activity list. */
function allAgentStatuses(): AgentTabStatus[] {
  return allMobileScopes().flatMap((scope) => projectAgentStatuses(scope.id));
}

/** How many prompts of an agent tab's tail ride with an answer, and how much of
 * each. Both are re-applied at the browser boundary by the sidecar; these are
 * what makes the desktop send a readable list rather than a transcript. */
const MOBILE_PROMPT_TAIL = 5;
const MOBILE_PROMPT_CHARS = 240;

/** The prompt history rows that went to `tab`, newest last, as card lines.
 * Matched by the tab's launch id only: a label ("OpenCode") is shared by every
 * tab of that agent the project ever had. The history is loaded on first use;
 * until it arrives the tab shows what it would have without it. */
function historyPromptsOf(projectId: string, tab: TabEntry): AgentTabPrompt[] {
  if (!tab.sessionId) return [];
  const store = useAgentPromptsStore.getState();
  const history = store.historyByProject[projectId];
  if (!history) {
    if (!historyAsked.has(projectId)) {
      historyAsked.add(projectId);
      void store.loadHistory(projectId).catch(() => historyAsked.delete(projectId));
    }
    return [];
  }
  return history
    .filter((row: SentAgentPrompt) => (row.tab_id ?? row.session_id) === tab.sessionId && row.result !== "missed" && row.result !== "failed")
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
    .slice(-MOBILE_PROMPT_TAIL)
    .map((row) => ({ text: row.message.slice(0, MOBILE_PROMPT_CHARS), at: row.sent_at }));
}
const historyAsked = new Set<string>();

/**
 * The prompt history records a phone send before Codex has written the
 * corresponding rollout item. Keep that timestamp on the card until the
 * rollout catches up, then prefer the transcript's own instant. A close pair
 * with the same text is one prompt; an intentional later repeat remains one
 * row of its own.
 */
function mergePromptRows(recent: readonly { text: string; at: string }[], sent: readonly AgentTabPrompt[]): AgentTabPrompt[] {
  const rows = [
    ...recent.map((prompt) => ({ text: prompt.text.slice(0, MOBILE_PROMPT_CHARS), at: prompt.at, source: "transcript" as const })),
    ...sent.map((prompt) => ({ ...prompt, source: "sent" as const })),
  ].sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
  const merged: AgentTabPrompt[] = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    const sameText = previous?.text === row.text;
    const previousAt = previous?.at ? Date.parse(previous.at) : NaN;
    const rowAt = row.at ? Date.parse(row.at) : NaN;
    const sameSend = sameText && Number.isFinite(previousAt) && Number.isFinite(rowAt)
      && Math.abs(previousAt - rowAt) <= 2 * 60_000;
    if (sameSend) {
      // A rollout timestamp is the CLI's source of truth once it is present.
      if (row.source === "transcript") merged[merged.length - 1] = { text: row.text, at: row.at };
      continue;
    }
    merged.push({ text: row.text, at: row.at });
  }
  return merged.slice(-MOBILE_PROMPT_TAIL);
}

/**
 * What each agent tab of a scope was last asked — the tail the model tag is
 * read with, published so the phone's lists can say it without opening the
 * session.
 *
 * Every agent tab is answered for, not only the ones with a status: a session
 * nobody has prompted since this morning is exactly the one whose last prompt
 * is worth reading, and `projectAgentStatuses` drops it before it ever reaches
 * its own refresh. The store's 10s floor is what keeps a 5s poll honest — one
 * tail read per tab between two polls, the same read the Agents view here
 * already pays for.
 */
function projectAgentPrompts(projectId: string): AgentTabPrompts[] {
  const models = useAgentModelsStore.getState();
  return (useTabsStore.getState().tabsByScope[projectId] ?? []).flatMap((tab) => {
    if (tab.kind !== "agent" || !tab.tmuxSession) return [];
    void models.refresh(projectId, tab);
    const ptyId = `${projectId}:${tab.key}`;
    const recent = models.recentByTab[ptyId] ?? [];
    // An agent whose transcript is not read (OpenCode, Gemini, …) is known to
    // have been asked what Eldrun itself sent it: the composers here and on the
    // phone and the schedules all record into the prompt history.
    const sent = historyPromptsOf(projectId, tab);
    // Last, the prompt off the pane's own screen (`lib/agents/prompt/echo`); it
    // carries no time, and a row without one is honest about that rather than
    // inventing the read's. Not for OpenCode: its full-screen TUI has no prompt
    // echo, and the reader took its panels for prompts.
    const fallback = tab.cmd === "opencode" ? undefined : models.promptByTab[ptyId];
    const promptTail = mergePromptRows(recent, sent);
    const prompts: AgentTabPrompt[] = promptTail.length
      ? promptTail
      : sent.length
        ? sent
        : fallback
          ? [{ text: fallback.slice(0, MOBILE_PROMPT_CHARS) }]
          : [];
    return prompts.length ? [{ tmux_session: tab.tmuxSession, prompts }] : [];
  });
}

function agentPrompts(projectId?: string): AgentTabPrompts[] {
  const scope = mobileScope(projectId);
  return scope ? projectAgentPrompts(scope.id) : [];
}

function allAgentPrompts(): AgentTabPrompts[] {
  return allMobileScopes().flatMap((scope) => projectAgentPrompts(scope.id));
}

/** Each agent tab's scheduled-prompt summary, computed here against the desktop
 * clock the way the Agents view computes the line under a tab. It rides with the
 * catalog because the phone's project overview shows one line per tab: asking
 * per tab would be a desktop round trip per agent on every 5s poll. */
async function agentScheduleSummaries(projectId?: string): Promise<AgentTabSchedules[]> {
  const scope = mobileScope(projectId);
  if (!scope) return [];
  const targets = (useTabsStore.getState().tabsByScope[scope.id] ?? []).flatMap((tab) =>
    tab.kind === "agent" && tab.tmuxSession && tab.scheduleTargetId
      ? [{ tmux: tab.tmuxSession, target: tab.scheduleTargetId }]
      : [],
  );
  const now = new Date();
  return Promise.all(targets.map(async ({ tmux, target }) => {
    const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedules_list", {
      projectId: scope.id,
      scheduleTargetId: target,
    }).catch(() => [] as ScheduledAgentPrompt[]);
    const summary = scheduleSummary(schedules, now);
    return {
      tmux_session: tmux,
      total: summary.total,
      enabled: summary.enabled,
      next: summary.next ? localOccurrenceKey(summary.next) : undefined,
    };
  }));
}

async function create(request: CreateRequest, t: ReturnType<typeof useT>): Promise<DesktopResponse> {
  const scope = mobileScope(request.project_id);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const cwd = scope.cwd;
  if (!cwd) return { status: "error", code: "project_ineligible", message: "Project folder is unavailable" };
  // The new tab must be in the *shown* scope to get a terminal at all, so the
  // desktop goes there first — the project's activation, or the box's open.
  await enterScope(scope);
  const requestHash = await invoke<string>("mobile_opaque_id", {
    domain: "request",
    value: request.idempotency_key,
  });

  let spec: Omit<TabEntry, "key">;
  if (request.kind === "shell") {
    if (request.agent_id || request.mode) {
      return { status: "error", code: "invalid_request", message: "Shell requests cannot name an agent or mode" };
    }
    spec = buildStaticTabSpec(SHELL_ITEMS[0], cwd, scope.name, t);
  } else {
    const choices = await agentChoices();
    const choice = choices.find((entry) => entry.public.id === request.agent_id);
    if (!choice) return { status: "error", code: "unknown_agent", message: "Agent is unavailable" };
    if (request.mode && !choice.public.modes.includes(request.mode)) {
      return { status: "error", code: "unsupported_mode", message: "Agent mode is unavailable" };
    }
    spec = buildStaticTabSpec(choice.item, cwd, scope.name, t);
  }
  let created: TabEntry;
  try {
    created = await useTabsStore.getState().hydrateThenCreateInScope({
      scope: scope.id,
      cwd,
      localFile: scope.localFile,
      requestHash,
      spec,
    });
  } catch (error) {
    return { status: "error", code: "persist_failed", message: String(error) };
  }
  if (!created.tmuxSession) {
    return { status: "error", code: "launch_failed", message: "Persistent terminal session was not created" };
  }
  if (scope.id === ROOT_SCOPE) useTabsStore.getState().revealTabInScope(ROOT_SCOPE, created.key);
  return { status: "created", tmux_session: created.tmuxSession };
}

/** Make `scope` the one the desktop shows: a project is activated, a box is
 * opened (which restores its members' tabs box-locally and enters its scope,
 * exactly as the switcher's box pill does). Root is never switched to — its
 * console is raised over whatever is open, which is what gives its panes a
 * terminal. */
async function enterScope(scope: MobileScope): Promise<void> {
  if (scope.id === ROOT_SCOPE) {
    await ensureRootScopeHydrated();
    useRootOverlayStore.getState().show();
  } else if (scope.project) await useProjectsStore.getState().activateProject(scope.project.id);
  else await useBoxesStore.getState().openBox(scope.id.slice(BOX_SCOPE_PREFIX.length));
}

async function activate(projectId: string): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  await enterScope(scope);
  return { status: "activated" };
}

function scheduleTargetTab(projectId: string, tmuxSession: string) {
  return (useTabsStore.getState().tabsByScope[projectId] ?? []).find((entry) =>
    (entry.kind === "agent" || entry.kind === "local_agent")
      && (entry.tmuxSession === tmuxSession || entry.tmuxAttach === tmuxSession),
  );
}

/** The catalog publishes a tab label truncated to 120 characters, so a longer
 * one would render on the phone as something other than what was stored. The
 * sidecar rejects those already; this is the desktop-side repeat of the same
 * rule, because the bridge is reachable without going through that route. */
const MAX_TAB_LABEL = 120;

function renameAgentTab(projectId: string, tmuxSession: string, label: string): DesktopResponse {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const next = label.trim();
  if (!next || [...next].length > MAX_TAB_LABEL || [...next].some((char) => char < " " || char === "\u007f")) {
    return { status: "error", code: "invalid_label", message: "Tab label is not usable" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
  useTabsStore.getState().renameTabInScope(scope.id, tab.key, next);
  return { status: "renamed", label: next };
}

/** The tab one mobile request names, of any kind the phone lists — the close
 * route serves shell tabs as well as agent ones, so the agent-only lookup above
 * would refuse half the rows. The tmux name is the identity either way: it is
 * what the catalog published this tab from. */
function mobileTargetTab(scope: string, tmuxSession: string) {
  return (useTabsStore.getState().tabsByScope[scope] ?? []).find((entry) =>
    entry.tmuxSession === tmuxSession || entry.tmuxAttach === tmuxSession,
  );
}

/** Close one tab from the phone. Closing means here what it means on the
 * desktop (`lib/remote/closeRemoteTab`'s `closeTabInScope`, the one seam both
 * use): the tab leaves the layout, its viewer dies, and the local tmux session it
 * minted ends with it; a session on a remote host keeps running and stays
 * reattachable from the Sessions view.
 *
 * The scope is restored first when the desktop has not opened that project this
 * session: the phone lists tabs from the saved session file, which outlives the
 * store's knowledge of them, so a row it can plainly see would otherwise answer
 * "tab_not_found". Restoring reads that same file WITHOUT activating the
 * project — the user's window stays where they left it, and an inactive
 * project's panes are not rendered, so nothing spawns a terminal on the way. */
async function closeMobileTab(projectId: string, tmuxSession: string): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  await restoreScope(scope);
  const tab = mobileTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Tab is unavailable" };
  closeTabInScope(scope.id, tab.key);
  // CenterPanel's debounce persists the ACTIVE scope only, and the phone closes
  // a tab in whichever project it is looking at. Without this write the catalog
  // — which reads that same session file — keeps listing the closed tab, and a
  // relaunch brings it back.
  await persistScopeLayout(scope.id);
  return { status: "closed" };
}

/** Paint one tab from the phone, or clear its colour (#264).
 *
 * Scoped, restored and persisted like the close above, and for the same three
 * reasons: the phone colours a tab in whichever project it is LOOKING at (not
 * the one the window shows), a project the desktop has not opened this session
 * has its tabs only in the session file, and `CenterPanel`'s debounce persists
 * the active scope alone — so without the write here the catalog the phone
 * re-reads would keep publishing the old colour, and a relaunch would undo it.
 *
 * The id is validated here as well as at the sidecar route, because this bridge
 * is reachable without going through it. */
async function colorMobileTab(
  projectId: string,
  tmuxSession: string,
  color: string | null | undefined,
): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const next = color == null || color === "" ? undefined : color;
  if (next !== undefined && !isTabColor(next)) {
    return { status: "error", code: "invalid_color", message: "Tab colour is not in the palette" };
  }
  await restoreScope(scope);
  const tab = mobileTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Tab is unavailable" };
  useTabsStore.getState().setTabColorInScope(scope.id, tab.key, next);
  await persistScopeLayout(scope.id);
  return { status: "colored", color: next ?? null };
}

/** Move one tab next to another from the phone, the same permutation the
 * desktop Agents view's own drag performs (`reorderTabInScope`): the flat
 * scope order — which is what the catalog publishes and the phone lists — and,
 * when both tabs share a layout group, that group's tab bar too.
 *
 * The scope is restored first for the reason the close does it: the phone can
 * be looking at a project this desktop session has not opened, and its rows
 * come from the saved session file rather than from the store. The layout is
 * persisted before answering, so the route's read-back is the new order. */
async function reorderMobileTab(
  projectId: string,
  tmuxSession: string,
  anchorTmuxSession: string,
  place: "before" | "after",
): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  await restoreScope(scope);
  const tab = mobileTargetTab(scope.id, tmuxSession);
  const anchor = mobileTargetTab(scope.id, anchorTmuxSession);
  if (!tab || !anchor) return { status: "error", code: "tab_not_found", message: "Tab is unavailable" };
  // A tab dropped on itself is where it already is; the store no-ops on it, and
  // answering "reordered" keeps the phone reconciling against the real order.
  useTabsStore.getState().reorderTabInScope(scope.id, tab.key, anchor.key, place);
  await persistScopeLayout(scope.id);
  return { status: "reordered" };
}

function scheduleTarget(projectId: string, tmuxSession: string): string | null {
  return scheduleTargetTab(projectId, tmuxSession)?.scheduleTargetId ?? null;
}

async function schedulesFor(projectId: string, tmuxSession: string): Promise<DesktopResponse> {
  const target = scheduleTarget(projectId, tmuxSession);
  if (!target) return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
  const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedules_list", {
    projectId,
    scheduleTargetId: target,
  });
  const now = new Date();
  const next_runs = Object.fromEntries(schedules.flatMap((schedule) => {
    const next = nextScheduleOccurrence(schedule, now);
    return next ? [[schedule.id, next.key]] : [];
  }));
  return { status: "schedules", schedules, time_zone: desktopTimeZone(), next_runs };
}

async function mutateSchedule(
  projectId: string,
  tmuxSession: string,
  action: ScheduleMutation,
): Promise<DesktopResponse> {
  const target = scheduleTarget(projectId, tmuxSession);
  if (!target) return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
  if (action.type === "delete") {
    await invoke("agent_schedule_delete", {
      projectId,
      scheduleTargetId: target,
      scheduleId: action.schedule_id,
    });
  } else {
    // The phone edits only these three fields and never shows prefix commands.
    // Keep commands the desktop composer attached to an existing rule; the
    // desktop editor may still deliberately clear them by writing [].
    const existing = action.type === "update"
      ? (await invoke<ScheduledAgentPrompt[]>("agent_schedules_list", {
        projectId,
        scheduleTargetId: target,
      })).find((schedule) => schedule.id === action.schedule_id)
      : undefined;
    if (action.type === "update" && !existing) {
      return { status: "error", code: "schedule_not_found", message: "Schedule is unavailable" };
    }
    await invoke("agent_schedule_upsert", {
      projectId,
      scheduleTargetId: target,
      schedule: {
        id: action.type === "create" ? crypto.randomUUID() : action.schedule_id,
        ...action.schedule,
        ...(existing ? { preface: existing.preface ?? [] } : {}),
      },
    });
    void persistScopeLayout(projectId);
  }
  return schedulesFor(projectId, tmuxSession);
}

// ── Project prompt collection ────────────────────────────────────────────────
// The phone edits the same `agent_prompts.json` rows the Agents view shows;
// ids and timestamps are minted here. `send` is the desktop's send-now — a
// one-time schedule at *this* machine's current minute — so the phone never
// reasons about the desktop clock and delivery keeps the scheduler's idle gate.

async function promptsFor(projectId: string): Promise<DesktopResponse> {
  const prompts = await useAgentPromptsStore.getState().load(projectId);
  return { status: "prompts", prompts };
}

async function mutatePrompt(projectId: string, action: PromptMutation): Promise<DesktopResponse> {
  const store = useAgentPromptsStore.getState();
  if (action.type === "delete") {
    await store.remove(projectId, action.prompt_id);
  } else if (action.type === "send") {
    const prompt = (await store.load(projectId)).find((item) => item.id === action.prompt_id);
    if (!prompt) return { status: "error", code: "prompt_not_found", message: "Prompt no longer exists" };
    const tab = scheduleTargetTab(projectId, action.tmux_session);
    if (!tab?.scheduleTargetId) {
      return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
    }
    // The phone's send retires the prompt to the history exactly as the
    // desktop's does — one collected prompt, one send, one record of where it
    // went, whichever surface aimed it.
    await sendCollectedPrompt(
      projectId,
      {
        scheduleTargetId: tab.scheduleTargetId,
        label: tab.label,
        sessionId: tab.sessionId,
        agent: tab.cmd,
      },
      prompt,
    );
    void persistScopeLayout(projectId);
  } else {
    await store.upsert(projectId, {
      id: action.type === "create" ? crypto.randomUUID() : action.prompt_id,
      message: action.prompt.message,
    });
  }
  return promptsFor(projectId);
}

/** Today's UTC day key — the same bucket the desktop recap calls "today", so
 * the phone and the laptop never disagree about which figures they are showing. */
function todayTally(report: { days: Record<string, Record<string, number>> } | null, leaf: string): MobileAgentTally {
  const day = report?.days?.[dayKey(Date.now())] ?? {};
  return {
    prompts: day[sub(METRIC.AGENT_PROMPT, leaf)] ?? 0,
    // Worked seconds, decisions and finished turns are recorded per *project*,
    // not per agent — one number for every agent tab in it. Passed on at that
    // grain and labelled so on the phone, rather than being silently attributed
    // to the one agent the sheet happens to be about.
    worked_s: day[METRIC.AGENT_WORKED_S] ?? 0,
    decisions: day[METRIC.AGENT_DECISION] ?? 0,
    done: day[METRIC.AGENT_DONE] ?? 0,
  };
}

/**
 * The phone's status button on an agent tab: what the desktop already knows
 * about that session, plus what the agent's own CLI says about the account
 * behind it.
 *
 * The two halves have deliberately different sources. The state and the tally
 * are the desktop's own — the activity store's classification of the tab's
 * output, and the local rolling counters — and cost nothing to read. The usage
 * panel is the CLI's, read by running its print mode once (`agent_usage`);
 * that is why a `refresh` exists at all, and why an agent without a readable
 * panel comes back as `supported: false` rather than as an empty card.
 */
async function agentStatusFor(
  projectId: string,
  tmuxSession: string,
  refresh: boolean,
): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
  const state: MobileAgentStatus["state"] = mobileAgentState(`${scope.id}:${tab.key}`);
  const leaf = agentPromptLeaf(tab) ?? tab.cmd;
  // Neither read may take the sheet down with it: a usage run that fails still
  // leaves a status worth showing, and a stats file that will not load must not
  // hide the quota panel the reader opened this for.
  const [usage, summary] = await Promise.all([
    invoke<AgentUsageReport>("agent_usage", { agent: tab.cmd, refresh }).catch((error): AgentUsageReport => ({
      agent: tab.cmd,
      label: agentLabel(leaf),
      supported: false,
      error: String(error),
      code: "cli_failed",
      cached: false,
    })),
    invoke<{ days: Record<string, Record<string, number>> }>("usage_summary", {
      projectId: scope.id,
    }).catch(() => null),
  ]);
  return {
    status: "agent_status",
    report: {
      state,
      label: tab.label,
      agent: agentLabel(leaf),
      project: scope.name,
      today: todayTally(summary, leaf),
      usage: {
        label: usage.label,
        supported: usage.supported,
        // The panel goes as printed, unless the CLI printed a path of this
        // machine into it — then the phone is told that, not the path.
        raw: usage.raw && !namesLocalPath(usage.raw) ? usage.raw : undefined,
        error: usage.raw && namesLocalPath(usage.raw)
          ? "cli_output_withheld"
          : usage.code ?? (usage.error ? "cli_error" : undefined),
        cached: usage.cached,
      },
    },
  };
}

/** Whether a CLI's text names a place on this machine — a home directory, a
 * temp or system path, a Windows drive — which the phone must not be shown. */
function namesLocalPath(text: string): boolean {
  return /(^|[\s("'`])(?:~\/|\/(?:home|Users|tmp|var|etc|opt|usr|root|mnt|media|private)\/|[A-Za-z]:\\)/.test(text);
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
      // Likewise the intake column, which the phone composes new cards into: it
      // is flagged rather than positional, and the board no longer leads with it.
      intake: column.id === fallbackColumnId(columns),
      // The two date-governed columns, so the phone can grey out a move its own
      // board would refuse instead of offering it and reporting the refusal.
      overdue: column.overdue ?? false,
      due_today: column.due_today ?? false,
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
      // Overdue, Today and the intake column are the card's *deadline* speaking,
      // not a placement anyone owns (`lib/todoBoard`'s `dateColumn`). Accepting a
      // move the next snapshot undoes would look, from the phone, exactly like a
      // board that drops writes — so it is refused, and says why.
      if (!dropAccepted(task, target.id, columns)) {
        return {
          status: "error",
          code: "column_follows_date",
          message: "That column follows the card's date — change the deadline instead",
        };
      }
      const count = calendar.tasks.filter((entry) => entry.id !== task.id && columnOf(entry, columns) === target.id).length;
      const index = Math.max(0, Math.min(action.index ?? count, count));
      await calendar.moveTasks([{
        id: task.id,
        column: target.id,
        index,
        completed_stamp: target.done ? toStamp(new Date()) : null,
      }]);
    } else if (action.type === "toggle") {
      // The phone's checkbox, resolved by the desktop's own helper: completion,
      // the completed stamp and the Done/intake filing are one edit, and an
      // archived card stays in its archive. Deliberately not a `move` — a card
      // at 100% is *shown* in Done whatever its column says, so a move there
      // was a placement the board's own rules refuse (`dropAccepted`), and
      // ticking a card from the phone could only ever fail.
      await calendar.updateTask(toggleTaskDone(task, columns));
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
      // The row's own handle, so the phone can press the strip's ✓ without ever
      // being told what is behind the row. `AlertItem.id` is `"{kind}:{sourceId}"`
      // and stable across refreshes, which is exactly what makes the derived
      // handle resolvable again on the way back.
      alert_id: await opaqueId("alert", item.id),
    }))),
  };
}

/**
 * The phone pressed one alert row's ✓.
 *
 * The row is named by the opaque handle `alertsSnapshot` published, resolved
 * here by re-deriving the same handles over the live feed — the mail routes'
 * rule (an opaque id is resolved by re-reading what issued it), so nothing but
 * a row of the feed the phone was actually shown can be reached. The three
 * resolutions themselves are `lib/alertDone`'s, the very ones the desktop
 * strip's button runs.
 *
 * The answer is the same snapshot **minus the row just resolved**, rather than a
 * re-read: this handler runs outside React, so the feed's own recompute (a
 * cleared mark, a completed card, a new mute) has not reached `alertsRef` yet
 * and re-reading here would hand the phone back the row it just ticked. The
 * dropped row is what every one of the three resolutions produces on the next
 * poll anyway, which is the authority.
 */
async function resolveAlertRow(feed: AlertsFeed, alertId: string): Promise<DesktopResponse> {
  const pairs = await Promise.all(
    feed.items.map(async (item) => [await opaqueId("alert", item.id), item] as const),
  );
  const match = pairs.find(([id]) => id === alertId)?.[1];
  if (!match) {
    return { status: "error", code: "alert_gone", message: "That alert is no longer listed" };
  }
  try {
    await finishAlert(match, feed.mute);
  } catch (error) {
    return { status: "error", code: "alert_resolve_failed", message: String(error) };
  }
  const snapshot = await alertsSnapshot(feed);
  return {
    status: "alerts",
    alerts: { ...snapshot, items: snapshot.items.filter((row) => row.alert_id !== alertId) },
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
  const weekStart: 0 | 1 = useSettingsStore.getState().settings?.calendar_week_start === 0 ? 0 : 1;
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
      // Only the fact: a feed URL routinely embeds a private token, and the
      // phone only ever asked whether there was one.
      subscribed: !!entry.source_url,
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
    flagged: header.flagged,
    answered: header.answered,
    has_attachments: header.has_attachments,
    preview: boundedText(header.preview, 600).value,
  };
}

/** The two phone-side mail writes are desktop settings, read here and nowhere
 * else: the sidecar cannot see mail settings, so it relays the desktop's
 * refusal and the phone hides the controls from the overview's answer. Both
 * default off and are switched separately — a flag write and an outbound
 * mail are different risks. */
function mailWriteGates() {
  const host = useSettingsStore.getState().settings?.eldrun_mobile_host;
  return { actions: host?.mail_actions === true, reply: host?.mail_reply === true };
}

/** Reading is a switch of its own, above both writes. Unlike them it defaults
 * ON — unset is what pairing has always allowed — so turning it off is an
 * explicit `false`. Off, every mail request is refused here, writes included. */
function mailReadAllowed() {
  return useSettingsStore.getState().settings?.eldrun_mobile_host?.mail_read !== false;
}

const MAIL_READ_DISABLED: DesktopResponse = {
  status: "error",
  code: "mail_read_disabled",
  message: "Mail on the phone is switched off in Eldrun",
};

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
  return { status: "mail", mail: { view: "overview", accounts: rows, ...mailWriteGates() } };
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

/** Resolve an opaque message id by re-reading exactly the page that issued it.
 * This both resolves it without exposing the store key and refuses a
 * stale/cross-folder capability. */
async function resolveMailMessage(
  folderId: string,
  messageId: string,
  offset: number,
): Promise<{ folder: MailFolder; header: MailHeader } | Extract<DesktopResponse, { status: "error" }>> {
  const folder = await resolveMailFolder(folderId);
  if (!folder) return { status: "error", code: "folder_not_found", message: "Mail folder is unavailable" };
  const page = await mailHeaders(folder.id, offset, MAIL_PAGE_SIZE, null);
  const pairs = await Promise.all(page.items.map(async (header) => ({
    header,
    id: await opaqueMailId("message", header.id),
  })));
  const header = pairs.find((entry) => entry.id === messageId)?.header;
  if (!header) return { status: "error", code: "message_not_found", message: "Mail message is unavailable" };
  return { folder, header };
}

async function mailMessage(folderId: string, messageId: string, offset: number): Promise<DesktopResponse> {
  const resolved = await resolveMailMessage(folderId, messageId, offset);
  if ("status" in resolved) return resolved;
  const { header } = resolved;

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

/** Set or clear one flag from the phone. The desktop's own `mailFlag` does the
 * work — local index first, then the server, a refusal reported — and the
 * answer is the refreshed page so the phone's list is right without a second
 * round trip. Only the four verbs exist; delete and move never reach here. */
async function mailMark(folderId: string, messageId: string, offset: number, action: MailMarkAction): Promise<DesktopResponse> {
  if (!mailWriteGates().actions) {
    return { status: "error", code: "mail_actions_disabled", message: "Mail actions from the phone are switched off in Eldrun" };
  }
  const resolved = await resolveMailMessage(folderId, messageId, offset);
  if ("status" in resolved) return resolved;
  const flag = action === "seen" || action === "unseen" ? "seen" : "flagged";
  const value = action === "seen" || action === "flag";
  try {
    await mailFlag(resolved.header.id, flag, value);
  } catch (reason) {
    return { status: "error", code: "mail_mark_failed", message: boundedText(String(reason), 400).value };
  }
  return mailFolderPage(folderId, offset);
}

/** A plain-text reply typed on the phone. The phone supplied the text and
 * nothing else: the recipient is the original's `From`, the subject its
 * subject behind the reply prefix, and `In-Reply-To` its RFC `Message-ID` —
 * the same derivation the desktop composer makes, so a phone can only answer
 * someone who already wrote. Sent through the desktop's draft path with sign
 * and encrypt off; a send that fails leaves the draft in Drafts and reports
 * the reason. */
async function mailReply(
  folderId: string,
  messageId: string,
  offset: number,
  text: string,
  t: ReturnType<typeof useT>,
): Promise<DesktopResponse> {
  if (!mailWriteGates().reply) {
    return { status: "error", code: "mail_reply_disabled", message: "Replies from the phone are switched off in Eldrun" };
  }
  if (!text.trim()) return { status: "error", code: "empty_reply", message: "The reply is empty" };
  const resolved = await resolveMailMessage(folderId, messageId, offset);
  if ("status" in resolved) return resolved;
  const { header } = resolved;
  if (!header.from.address) {
    return { status: "error", code: "no_reply_address", message: "The original message carries no sender address" };
  }
  const subjectBase = stripFormatControls(header.subject);
  const subject = (subjectBase.toLowerCase().startsWith("re:") ? subjectBase : `${t("mail.replyPrefix")}${subjectBase}`)
    .replace(/[\r\n]/g, " ");
  const original = await mailBody(header.id, false).catch(() => null);
  const quoted = (original?.text ?? "").split("\n").map((line) => `> ${line}`).join("\n");
  const lang = useI18nStore.getState().lang;
  const settings = useSettingsStore.getState().settings;
  const use24h = resolveUse24h(settings?.time_format_24h, settings?.calendar_time_format_24h, lang);
  const intro = t("mail.quotedIntro", { date: formatMailDate(header.date, lang, use24h), sender: formatAddress(header.from) });
  try {
    const saved = await mailDraftSave({
      id: "",
      account_id: header.account_id,
      to: [header.from.address],
      cc: [],
      bcc: [],
      subject,
      body_text: original?.text ? `${text}\n\n${intro}\n${quoted}` : text,
      ...(header.rfc_message_id ? { in_reply_to: header.rfc_message_id } : {}),
      staged: [],
    });
    const result = await mailDraftSend(saved.id, saved.staged.map((a) => a.staged_id));
    if (result.error) {
      return { status: "error", code: "mail_reply_failed", message: boundedText(result.error, 400).value };
    }
  } catch (reason) {
    return { status: "error", code: "mail_reply_failed", message: boundedText(String(reason), 400).value };
  }
  return mailFolderPage(folderId, offset);
}

/** The phone had this agent tab on its screen. That is the same act the tab bar
 * reports when the tab is switched to, so it goes through the same door: the
 * output counts as read, the `done` lamp retires, and a live decision prompt
 * deliberately survives it — being looked at is not being answered. Silent when
 * the tab is gone; a phone reading a session the desktop no longer lists has
 * nothing to mark. */
function markTabSeen(projectId: string, tmuxSession: string): DesktopResponse {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (tab) useActivityStore.getState().clearAttention(`${scope.id}:${tab.key}`);
  return { status: "seen" };
}

/** The phone's composer sent `message` to this agent tab: recorded in the
 * prompt history as delivered, the way the desktop composer records its own
 * sends — the words never pass through this window, so this is the only way
 * they reach the history. A session command (`/clear`, `/model`) is the CLI's,
 * not a prompt, and is not recorded. A Claude or Codex prompt recorded here is
 * not recorded again when its transcript is adopted (same words, near in time:
 * `lib/agents/prompt/adopt`). */
async function recordTabPrompt(projectId: string, tmuxSession: string, message: string): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Tab not found" };
  const text = message.trim();
  if (!text || isSessionCommand(text)) return { status: "seen" };
  await useAgentPromptsStore.getState().record(scope.id, {
    id: crypto.randomUUID(),
    message: text,
    sent: { tabLabel: tab.label, sessionId: tab.sessionId, agent: tab.cmd, result: "delivered" },
  }).catch(() => []);
  return { status: "seen" };
}

/** The phone typed into this agent tab. It types into a tmux client of its own,
 * so not one byte of it passes through this window — and the classifier only
 * ever calls output "working" or "done" when the session was COMMANDED this
 * session (`noteUserInput`, the guard that stops a restored tab's resume banner
 * from reading as a finished turn). Without this report a tab driven entirely
 * from the phone produced status for nobody: the pills stayed blank on the very
 * surface that asked for the work. Throttled sidecar-side to the leading edge of
 * each burst of typing, so a held key is one report, not forty. */
function markTabInput(projectId: string, tmuxSession: string): DesktopResponse {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (tab) noteUserInput(`${scope.id}:${tab.key}`);
  return { status: "seen" };
}

// ── Composer + → From the desktop ────────────────────────────────────────────
// The phone lists what this desktop would copy into the project inbox and
// names one entry by its opaque id. Both calls need the project to be one the
// phone may reach at all; the backend command does the folder scan, the
// clipboard read and the inbox write, and answers a refusal with a wire code
// the phone maps to a sentence.

async function desktopImagesFor(projectId: string): Promise<DesktopResponse> {
  if (!mobileScope(projectId)) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  return { status: "desktop_images", images: await invoke<DesktopImage[]>("mobile_desktop_images") };
}

async function attachDesktopImage(projectId: string, imageId: string): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  try {
    const attachment = await invoke<InboxAttachment>("mobile_attach_desktop_image", {
      projectDir: scope.cwd,
      imageId,
    });
    return { status: "attached", attachment };
  } catch (error) {
    const code = typeof error === "string" && /^[a-z_]+$/.test(error) ? error : "write_failed";
    return { status: "error", code, message: "The image could not be copied into the project inbox" };
  }
}

/** The agents whose transcript `services::agent_transcript` reads; any other
 * family answers `unsupported` there, and so does the short-circuit below. */
const TRANSCRIPT_AGENTS = new Set(["claude", "codex", "opencode"]);

/**
 * The phone's Focus view on an agent tab: the conversation as the agent's own
 * transcript records it, read by the backend (`agent_tab_transcript`,
 * `services::agent_transcript`) for the tab's launch id — the same resolution
 * the Agents view's model tag and last-prompt line use, live id first. A tab
 * with no session id (an agent Eldrun does not resume) has no transcript to
 * name, and says so rather than answering with somebody else's. `subagent`
 * is the handle on one of its `agent` entries, read instead.
 */
async function agentTranscriptFor(
  projectId: string,
  tmuxSession: string,
  subagent: string | null | undefined,
  version: string | null | undefined,
  limit: number | null | undefined,
): Promise<DesktopResponse> {
  const scope = mobileScope(projectId);
  if (!scope) {
    return { status: "error", code: "project_ineligible", message: "Project is not enabled for Mobile access" };
  }
  const tab = scheduleTargetTab(scope.id, tmuxSession);
  if (!tab) return { status: "error", code: "tab_not_found", message: "Agent tab is unavailable" };
  if (!tab.sessionId) {
    // Two different answers for the phone: a family whose transcript is
    // never read (the backend's `unsupported`, decided by the same list) hands
    // Focus to the terminal; a tab that has no session id *yet* — every tab
    // the phone just created, until the agent's hook records one — keeps
    // Focus reading the screen until the session reads.
    const reason = TRANSCRIPT_AGENTS.has(tab.cmd) ? "no_session" : "unsupported";
    return { status: "agent_transcript", transcript: { available: false, reason, entries: [], truncated: false } };
  }
  const transcript = await invoke<MobileAgentTranscript>("agent_tab_transcript", {
    agent: tab.cmd,
    projectId: scope.id,
    // OpenCode records no session id Eldrun can follow; its session is the
    // newest one of the folder the tab runs in — for a tab opened fresh rather
    // than restored with `--continue`, the newest one begun since it launched,
    // so a new tab is a new chat and not the folder's last conversation.
    tabDir: tab.cwd || scope.cwd,
    since: tab.launchedAt && !tab.args?.includes("--continue") ? tab.launchedAt : null,
    sessionId: tab.sessionId,
    subagent: subagent ?? null,
    version: version ?? null,
    limit: limit ?? null,
  }).catch((): MobileAgentTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
  return { status: "agent_transcript", transcript };
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
      schedules: await agentScheduleSummaries(request.project_id),
      prompts: agentPrompts(request.project_id),
      timings: agentTimings(request.project_id),
    };
    case "activity": return { status: "activity", statuses: allAgentStatuses(), prompts: allAgentPrompts() };
    case "activate": return activate(request.project_id);
    case "create": return create(request.request, t);
    case "todo": return { status: "todo", board: await todoSnapshot() };
    case "alerts": return { status: "alerts", alerts: await alertsSnapshot(alerts) };
    case "alert_resolve": return resolveAlertRow(alerts, request.alert_id);
    case "calendar": return { status: "calendar", calendar: await calendarSnapshot(request.month) };
    case "calendar_mutate": return calendarMutate(request.month, request.action);
    case "todo_mutate": return todoMutate(request.action);
    case "mail_overview": return mailReadAllowed() ? mailOverview() : MAIL_READ_DISABLED;
    case "mail_folder": return mailReadAllowed() ? mailFolderPage(request.folder_id, request.offset) : MAIL_READ_DISABLED;
    case "mail_message": return mailReadAllowed() ? mailMessage(request.folder_id, request.message_id, request.offset) : MAIL_READ_DISABLED;
    case "mail_mark": return mailReadAllowed() ? mailMark(request.folder_id, request.message_id, request.offset, request.action) : MAIL_READ_DISABLED;
    case "mail_reply": return mailReadAllowed() ? mailReply(request.folder_id, request.message_id, request.offset, request.body, t) : MAIL_READ_DISABLED;
    case "rename_tab": return renameAgentTab(request.project_id, request.tmux_session, request.label);
    case "close_tab": return closeMobileTab(request.project_id, request.tmux_session);
    case "color_tab": return colorMobileTab(request.project_id, request.tmux_session, request.color);
    case "reorder_tab": return reorderMobileTab(request.project_id, request.tmux_session, request.anchor_tmux_session, request.place);
    case "schedules": return schedulesFor(request.project_id, request.tmux_session);
    case "schedule_mutate": return mutateSchedule(request.project_id, request.tmux_session, request.action);
    case "prompts": return promptsFor(request.project_id);
    case "prompt_mutate": return mutatePrompt(request.project_id, request.action);
    case "agent_status": return agentStatusFor(request.project_id, request.tmux_session, request.refresh);
    case "agent_transcript": return agentTranscriptFor(request.project_id, request.tmux_session, request.subagent, request.version, request.limit);
    case "tab_seen": return markTabSeen(request.project_id, request.tmux_session);
    case "tab_input": return markTabInput(request.project_id, request.tmux_session);
    case "tab_prompt": return recordTabPrompt(request.project_id, request.tmux_session, request.message);
    case "desktop_images": return desktopImagesFor(request.project_id);
    case "attach_desktop_image": return attachDesktopImage(request.project_id, request.image_id);
  }
}

/** Desktop mutations run one at a time — but per domain, not on one chain.
 * The sidecar starts each request's deadline as it emits it, so a slow mail
 * reply (60 s budget) ahead of a tab create on one shared chain made the phone
 * read "desktop unavailable" for the create and then watch the tab appear
 * anyway. Tabs, the board and calendar, mail, and schedules/prompts each keep
 * their own order; nothing in one waits on another. */
const mutationQueues = new Map<string, Promise<unknown>>();

function mutationDomain(type: DesktopRequest["type"]): string | null {
  switch (type) {
    case "create": case "activate": case "rename_tab": case "close_tab": case "color_tab": case "reorder_tab": return "tabs";
    case "todo_mutate": case "alert_resolve": case "calendar_mutate": return "board";
    case "mail_mark": case "mail_reply": return "mail";
    case "schedule_mutate": case "prompt_mutate": return "schedules";
    default: return null;
  }
}

/** Queue `run` behind the last mutation of its domain (exported for tests). */
export function enqueueMutation(domain: string, run: () => Promise<void>): Promise<void> {
  const next = (mutationQueues.get(domain) ?? Promise.resolve()).then(run, run);
  mutationQueues.set(domain, next);
  return next;
}

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
    refreshRootFacts();
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
      const domain = mutationDomain(request.type);
      if (domain) void enqueueMutation(domain, run);
      else void run();
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
