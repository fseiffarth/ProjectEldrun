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
}

export interface PromptChartInput {
  prompts: ProjectAgentPrompt[];
  history: SentAgentPrompt[];
  strands: PromptChartStrand[];
  links: PromptLink[];
  now: Date;
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
    cards.push({
      key: `prompt:${prompt.id}`,
      id: prompt.id,
      state: chained ? "chained" : "draft",
      message: prompt.message,
      tags: prompt.tags ?? [],
      autoTags: agentPromptAutoTags({ message: prompt.message, chained, agent: strand?.agent }),
      strandId: strand?.id ?? "drafts",
      targetId: link?.target,
      at: null,
      prompt,
      recurring: false,
      chainStopped: chained && ((!!link?.target && !strand) || stoppedResult === "missed" || stoppedResult === "failed"),
    });
  }
  for (const row of input.history) {
    if (!row.result) continue;
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

export function futureTimeAt(y: number, height: number, now: Date, zoomHours: number): Date {
  const ratio = Math.max(0, Math.min(1, y / Math.max(1, height)));
  return snapPromptTime(new Date(now.getTime() + ratio * zoomHours * 3_600_000));
}

export function futureOffsetPercent(at: Date, now: Date, zoomHours: number): number {
  return Math.max(0, Math.min(100, ((at.getTime() - now.getTime()) / (zoomHours * 3_600_000)) * 100));
}

export type PromptChartDrop =
  | { type: "send"; targetId: string }
  | { type: "schedule"; targetId: string; at: string }
  | { type: "retime"; targetId: string; fromTargetId?: string; at: string }
  | { type: "move"; targetId: string; fromTargetId?: string }
  | { type: "unschedule"; fromTargetId?: string }
  | { type: "collect" }
  | { type: "none" };

export function promptChartDropAction(
  card: PromptChartCard,
  zone: { kind: "shelf" } | { kind: "strand"; targetId: string; at?: Date; now?: boolean },
): PromptChartDrop {
  if (zone.kind === "shelf") {
    if (card.state === "sent") return { type: "collect" };
    if (card.schedule) return { type: "unschedule", fromTargetId: card.targetId };
    return { type: "none" };
  }
  if (card.state === "sent") return { type: "none" };
  if (zone.now) return { type: "send", targetId: zone.targetId };
  if (zone.at) {
    const at = localOccurrenceKey(snapPromptTime(zone.at));
    return card.schedule
      ? { type: "retime", targetId: zone.targetId, fromTargetId: card.targetId, at }
      : { type: "schedule", targetId: zone.targetId, at };
  }
  return card.schedule && card.targetId !== zone.targetId
    ? { type: "move", targetId: zone.targetId, fromTargetId: card.targetId }
    : { type: "none" };
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
  window: "any" | "hour" | "today" | "week" | "month";
}

export function promptChartCardMatches(card: PromptChartCard, filter: PromptChartFilter, now: Date): boolean {
  const tags = [...card.tags, ...card.autoTags];
  if (filter.tag && !tags.includes(filter.tag)) return false;
  const agent = card.history?.agent ?? card.autoTags.find((tag) => tag.startsWith("agent:"))?.slice(6) ?? "";
  if (filter.agent && agent !== filter.agent) return false;
  const result = card.state === "queued" ? "queued" : card.history?.result ?? "";
  if (filter.result && result !== filter.result) return false;
  if (card.state === "sent" && filter.window !== "any" && card.at && Number.isFinite(card.at.getTime())) {
    const starts: Record<string, Date> = {
      hour: new Date(now.getTime() - 3_600_000),
      today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      week: new Date(now.getTime() - 7 * 86_400_000),
      month: new Date(now.getTime() - 30 * 86_400_000),
    };
    if (card.at < starts[filter.window]) return false;
  }
  const needle = filter.text.trim();
  if (!needle) return true;
  const haystack = [card.message, card.history?.tab_label ?? "", card.history?.session_id ?? "", ...(card.history?.files ?? [])].join("\n");
  return matchesTagsOrText(tags, haystack, needle);
}

export interface PromptPastGroup { label: string; cards: PromptChartCard[] }

export function groupPromptPast(cards: PromptChartCard[], now: Date, locale?: string): PromptPastGroup[] {
  const groups = new Map<string, PromptPastGroup>();
  const today = now.toDateString();
  for (const card of [...cards].filter((item) => item.state === "sent").sort((a, b) =>
    (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))) {
    if (!card.at || !Number.isFinite(card.at.getTime())) continue;
    const key = card.at.toDateString() === today
      ? `${card.at.toDateString()} ${card.at.getHours()}`
      : card.at.toDateString();
    const label = card.at.toDateString() === today
      ? card.at.toLocaleTimeString(locale, { hour: "numeric" })
      : card.at.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
    const group = groups.get(key) ?? { label, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.values()];
}
