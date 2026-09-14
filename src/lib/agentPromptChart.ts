import {
  latestScheduleOccurrence,
  localOccurrenceKey,
  nextScheduleOccurrence,
  scheduleStatus,
  type ScheduledAgentPrompt,
} from "./agentSchedule";
import { promptScheduleKey } from "./agentPromptScheduled";
import { agentPromptAutoTags } from "./agentPromptAutoTags";
import { matchesTagsOrText } from "./agentPromptTags";
import type {
  ProjectAgentPrompt,
  PromptLink,
  SentAgentPrompt,
} from "../stores/agentPrompts";

export type PromptCardState = "draft" | "scheduled" | "queued" | "sent" | "chained";

/** One agent tab as the chart knows it: the target a card can be aimed at,
 *  the label and agent it wears, and the rules that live on it. A closed
 *  session is a strand too, so its sent cards keep a name. */
export interface PromptChartStrand {
  id: string;
  label: string;
  scheduleTargetId?: string;
  tabKey?: string;
  sessionId?: string;
  agent?: string;
  closed?: boolean;
  schedules: ScheduledAgentPrompt[];
}

export interface PromptChartCard {
  key: string;
  id: string;
  state: PromptCardState;
  message: string;
  tags: string[];
  autoTags: string[];
  strandId: string;
  at: Date | null;
  prompt?: ProjectAgentPrompt;
  history?: SentAgentPrompt;
  schedule?: ScheduledAgentPrompt;
  targetId?: string;
  recurring: boolean;
  chainStopped?: boolean;
  /** The `after` edge a chained card waits on. */
  chainLink?: PromptLink;
}

export interface PromptChartInput {
  prompts: ProjectAgentPrompt[];
  history: SentAgentPrompt[];
  strands: PromptChartStrand[];
  links: PromptLink[];
  now: Date;
}

/** Lines that steer the session rather than ask it anything, never adopted
 * into the history (and rows an older build stored are not drawn): any bare
 * one-word slash command (`/clear`, `/login`, `/compact`, …), plus the two
 * that take an argument and still only housekeep — the `/rename <name>` Eldrun
 * types into a new agent tab and a `/model <name>` switch. A command that
 * carries words for the agent (`/goal ship the release`) is a prompt. */
const SESSION_COMMANDS_WITH_ARGS = new Set(["/rename", "/model"]);

export function isSessionCommand(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/u);
  const head = words[0].toLowerCase();
  if (!/^\/[\w:-]+$/u.test(head)) return false;
  return words.length === 1 || SESSION_COMMANDS_WITH_ARGS.has(head);
}

/** Join the three persisted sources without manufacturing another state field. */
export function buildPromptChart(input: PromptChartInput): PromptChartCard[] {
  const cards: PromptChartCard[] = [];
  const rulesByPrompt = new Map<string, { strand: PromptChartStrand; schedule: ScheduledAgentPrompt }[]>();
  const historyById = new Map(input.history.map((row) => [row.id, row]));
  const afterTargets = new Map(
    input.links.filter((link) => link.kind === "after").map((link) => [link.to, link]),
  );
  for (const strand of input.strands.filter((item) => !item.closed)) {
    for (const schedule of strand.schedules) {
      if (schedule.rule.type === "once" && schedule.last) continue;
      const key = promptScheduleKey(schedule.message);
      const linked = input.prompts.filter((prompt) =>
        prompt.id === schedule.id || promptScheduleKey(prompt.message) === key,
      );
      for (const prompt of linked) {
        const rows = rulesByPrompt.get(prompt.id) ?? [];
        rows.push({ strand, schedule });
        rulesByPrompt.set(prompt.id, rows);
      }
      const status = scheduleStatus(schedule, input.now);
      const queued = status.kind === "due";
      const history = historyById.get(schedule.id);
      const at = queued
        ? latestScheduleOccurrence(schedule, input.now)?.at ?? status.at ?? null
        : nextScheduleOccurrence(schedule, input.now)?.at ?? status.at ?? null;
      const recurring = schedule.rule.type !== "once";
      cards.push({
        key: `rule:${strand.id}:${schedule.id}`,
        id: linked[0]?.id ?? schedule.id,
        state: queued ? "queued" : "scheduled",
        message: schedule.message,
        tags: history?.tags ?? linked[0]?.tags ?? [],
        autoTags: agentPromptAutoTags({
          message: schedule.message,
          agent: strand.agent,
          preface: schedule.preface,
          recurring,
          queued,
        }),
        strandId: strand.id,
        targetId: strand.scheduleTargetId,
        at,
        prompt: linked[0],
        history,
        schedule,
        recurring,
      });
    }
  }
  for (const prompt of input.prompts) {
    if (rulesByPrompt.has(prompt.id)) continue;
    const link = afterTargets.get(prompt.id);
    const chained = !!link;
    const sourceCard = link ? cards.find((card) => card.id === link.from) : undefined;
    const strand = chained
      ? input.strands.find((item) => item.scheduleTargetId === link.target)
        ?? input.strands.find((item) => item.id === sourceCard?.strandId)
      : undefined;
    const sourceRows = link
      ? input.history.filter((row) => row.id === link.from || row.id.startsWith(`${link.from}@`))
      : [];
    const stoppedResult = sourceRows[sourceRows.length - 1]?.result;
    // A draft's aim is advisory: the tab it names may be gone, and then the
    // card is simply unaimed rather than stuck on a strand nobody can see.
    const aimed = !chained && prompt.target
      ? input.strands.find((item) => !item.closed && item.scheduleTargetId === prompt.target)
      : undefined;
    cards.push({
      key: `prompt:${prompt.id}`,
      id: prompt.id,
      state: chained ? "chained" : "draft",
      message: prompt.message,
      tags: prompt.tags ?? [],
      autoTags: agentPromptAutoTags({ message: prompt.message, chained, agent: strand?.agent ?? aimed?.agent }),
      strandId: strand?.id ?? "drafts",
      targetId: chained ? link?.target : aimed?.scheduleTargetId,
      at: null,
      prompt,
      recurring: false,
      chainStopped: chained && ((!!link?.target && !strand) || stoppedResult === "missed" || stoppedResult === "failed"),
      chainLink: link,
    });
  }
  for (const row of input.history) {
    if (!row.result || isSessionCommand(row.message)) continue;
    const liveStrand = input.strands.find((strand) =>
      !strand.closed && (strand.sessionId === row.session_id || strand.label === row.tab_label),
    );
    const closed = input.strands.find((strand) => strand.closed && (
      strand.sessionId === row.session_id || strand.label === row.tab_label
    ));
    const strandId = liveStrand?.id ?? closed?.id ?? `closed:${row.session_id ?? row.tab_label}`;
    cards.push({
      key: `history:${row.id}`,
      id: row.id,
      state: "sent",
      message: row.message,
      tags: row.tags ?? [],
      autoTags: agentPromptAutoTags({
        message: row.message,
        agent: row.agent,
        preface: row.preface,
        files: row.files,
        result: row.result,
        recurring: row.id.includes("@"),
      }),
      strandId,
      at: new Date(row.sent_at),
      history: row,
      recurring: row.id.includes("@"),
    });
  }
  return cards;
}

export function snapPromptTime(date: Date, minutes = 5): Date {
  const step = minutes * 60_000;
  return new Date(Math.round(date.getTime() / step) * step);
}

export function queueOrderTimes(ids: string[], now: Date): Record<string, string> {
  const first = new Date(now.getTime() - Math.min(59, Math.max(0, ids.length - 1)) * 60_000);
  return Object.fromEntries(ids.map((id, index) => [
    id,
    localOccurrenceKey(new Date(first.getTime() + index * 60_000)),
  ]));
}

export interface PromptChartFilter {
  text: string;
  tag: string;
  agent: string;
  result: string;
}

export function promptChartCardMatches(card: PromptChartCard, filter: PromptChartFilter): boolean {
  const tags = [...card.tags, ...card.autoTags];
  if (filter.tag && !tags.includes(filter.tag)) return false;
  const agent = card.history?.agent ?? card.autoTags.find((tag) => tag.startsWith("agent:"))?.slice(6) ?? "";
  if (filter.agent && agent !== filter.agent) return false;
  const result = card.state === "queued" ? "queued" : card.history?.result ?? "";
  if (filter.result && result !== filter.result) return false;
  const needle = filter.text.trim();
  if (!needle) return true;
  const haystack = [card.message, card.history?.tab_label ?? "", card.history?.session_id ?? "", ...(card.history?.files ?? [])].join("\n");
  return matchesTagsOrText(tags, haystack, needle);
}
