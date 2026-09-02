import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { buildSendNowSchedule, schedulesToPruneForSend } from "../lib/agentPromptSend";
import { useAgentSchedulesStore } from "./agentSchedules";

/**
 * A prompt collected for a project without a tab binding. It lives in the
 * state dir's `agent_prompts.json`, keyed by scope, and becomes a schedule only
 * when aimed at an agent tab (`queuePromptForTab`, or the schedule dialog with
 * the text prefilled).
 */
export interface ProjectAgentPrompt {
  id: string;
  message: string;
  created_at: string;
  updated_at: string;
}

/**
 * A collected prompt after it has been aimed at a tab. It leaves the active list
 * at send time and lands here, recording WHERE it went: the tab's label and,
 * when the tab has one, the agent session id — the question the history exists
 * to answer, and the one thing that still identifies the conversation once the
 * tab is closed.
 */
export interface SentAgentPrompt {
  id: string;
  message: string;
  created_at: string;
  sent_at: string;
  tab_label: string;
  session_id?: string;
  preface?: string[];
  /** The agent the tab runs (`claude`, `codex`, …) — what the tab *is*, which
   *  still means something once a tab called "Agent 3" is closed. */
  agent?: string;
  /** How the delivery ended. Absent while the prompt is only queued. */
  result?: "delivered" | "missed" | "failed";
  /** The occurrence it was due at, as a local wall-clock key. */
  scheduled_for?: string;
}

/** Send-time facts a history entry records. */
export interface SentPromptFacts {
  tabLabel: string;
  sessionId?: string;
  preface?: string[];
  agent?: string;
  result?: SentAgentPrompt["result"];
  scheduledFor?: string;
}

function sentPayload(sent: SentPromptFacts) {
  return {
    tab_label: sent.tabLabel,
    session_id: sent.sessionId ?? null,
    preface: sent.preface ?? [],
    agent: sent.agent ?? null,
    result: sent.result ?? null,
    scheduled_for: sent.scheduledFor ?? null,
  };
}

interface AgentPromptsStore {
  byProject: Record<string, ProjectAgentPrompt[]>;
  historyByProject: Record<string, SentAgentPrompt[]>;
  loading: Record<string, boolean>;
  load: (projectId: string) => Promise<ProjectAgentPrompt[]>;
  loadHistory: (projectId: string) => Promise<SentAgentPrompt[]>;
  upsert: (projectId: string, prompt: { id: string; message: string }) => Promise<ProjectAgentPrompt[]>;
  remove: (projectId: string, promptId: string) => Promise<ProjectAgentPrompt[]>;
  archive: (
    projectId: string,
    promptId: string,
    sent: SentPromptFacts,
  ) => Promise<ProjectAgentPrompt[]>;
  record: (
    projectId: string,
    entry: { id: string; message: string; sent: SentPromptFacts },
  ) => Promise<SentAgentPrompt[]>;
  clearHistory: (projectId: string, entryId?: string) => Promise<SentAgentPrompt[]>;
  refreshLoaded: () => Promise<void>;
}

export const useAgentPromptsStore = create<AgentPromptsStore>((set, get) => ({
  byProject: {},
  historyByProject: {},
  loading: {},

  load: async (projectId) => {
    set((state) => ({ loading: { ...state.loading, [projectId]: true } }));
    try {
      const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompts_list", { projectId });
      set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
      return prompts;
    } finally {
      set((state) => ({ loading: { ...state.loading, [projectId]: false } }));
    }
  },

  loadHistory: async (projectId) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_history_list", { projectId });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  upsert: async (projectId, prompt) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_upsert", { projectId, prompt });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    return prompts;
  },

  remove: async (projectId, promptId) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_delete", { projectId, promptId });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    return prompts;
  },

  archive: async (projectId, promptId, sent) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_archive", {
      projectId,
      promptId,
      sent: sentPayload(sent),
    });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    await get().loadHistory(projectId).catch(() => []);
    return prompts;
  },

  record: async (projectId, entry) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_record", {
      projectId,
      entry: { id: entry.id, message: entry.message, created_at: null, sent: sentPayload(entry.sent) },
    });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  clearHistory: async (projectId, entryId) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_history_clear", {
      projectId,
      entryId: entryId ?? null,
    });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  refreshLoaded: async () => {
    await Promise.all(Object.keys(get().byProject).map((projectId) => get().load(projectId).catch(() => [])));
    await Promise.all(
      Object.keys(get().historyByProject).map((projectId) => get().loadHistory(projectId).catch(() => [])),
    );
  },
}));

/**
 * Aim a message at one agent tab now: a one-time schedule at the current
 * minute (see `lib/agentPromptSend`). Finished one-time schedules are pruned
 * first when the tab is at its cap; the count is returned so the caller can say
 * so. The scheduler host hears the change event and delivers at the next idle
 * point.
 */
export async function queuePromptForTab(
  projectId: string,
  scheduleTargetId: string,
  message: string,
  options: { preface?: string[]; now?: Date; id?: string } = {},
): Promise<{ pruned: number }> {
  const now = options.now ?? new Date();
  const schedules = useAgentSchedulesStore.getState();
  const existing = await schedules.load(projectId, scheduleTargetId);
  const prune = schedulesToPruneForSend(existing);
  for (const id of prune) await schedules.remove(projectId, scheduleTargetId, id);
  await schedules.upsert(
    projectId,
    scheduleTargetId,
    buildSendNowSchedule(message, now, options.id ?? crypto.randomUUID(), options.preface),
  );
  return { pruned: prune.length };
}

/**
 * Send a COLLECTED prompt at one tab: queue it, then retire it to the history.
 *
 * One helper rather than two call sites doing it in sequence, because the two
 * halves must not come apart — a prompt delivered but left in the active list is
 * one the user sends twice. The queue is what can fail; the archive is
 * best-effort and never undoes it, since the send has already happened.
 */
export async function sendCollectedPrompt(
  projectId: string,
  target: { scheduleTargetId: string; label: string; sessionId?: string; agent?: string },
  prompt: { id: string; message: string },
  preface?: string[],
): Promise<{ pruned: number }> {
  // The queued schedule carries the PROMPT's id, which is the id its history
  // entry is written under. When the scheduler delivers it, the record it
  // writes lands on that same row and turns "queued" into "delivered" —
  // without the shared id the same prompt would be listed twice.
  const result = await queuePromptForTab(projectId, target.scheduleTargetId, prompt.message, {
    preface,
    id: prompt.id,
  });
  await useAgentPromptsStore
    .getState()
    .archive(projectId, prompt.id, {
      tabLabel: target.label,
      sessionId: target.sessionId,
      preface,
      agent: target.agent,
    })
    .catch(() => []);
  return result;
}

/**
 * Write one scheduled delivery onto the project's history — the record that
 * outlives the rule.
 *
 * It throws rather than swallowing: the caller retires the rule once this
 * succeeds, and a rule deleted after a failed write would take the only
 * account of the delivery with it. A caller that cannot act on the failure
 * ignores it; the scheduler retries on its next tick.
 */
export async function recordScheduledDelivery(
  projectId: string,
  entry: { id: string; message: string; preface?: string[] },
  sent: SentPromptFacts,
): Promise<void> {
  await useAgentPromptsStore.getState().record(projectId, {
    id: entry.id,
    message: entry.message,
    sent: { ...sent, preface: sent.preface ?? entry.preface },
  });
}
