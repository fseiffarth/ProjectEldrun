import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  buildPromptChart,
  promptChartCardMatches,
  promptChartInWindow,
  queueOrderTimes,
  rowOnStrand,
  type PromptChartCard,
  type PromptChartFilter,
  type PromptChartStrand,
  type PromptChartWindow,
} from "../../lib/agentPromptChart";
import { agentModelsFor, prefaceCommandsFor } from "../../lib/agentPrefaces";
import { agentItemFor, newAgentTabForDraft, promptChartNewTabAgent } from "../../lib/agentPromptNewTab";
import { useUse24h } from "../../lib/timeFormat";
import {
  formatTimelineInstant,
  hourAnchor,
  promptTargetColor,
  sessionGroupKey,
  shiftAnchor,
  timelineDropAction,
  timelineWindow,
  zoomTimelineView,
  type PromptTimelineDrop,
  type SessionSpan,
  type TimelineView,
  type TimelineZone,
} from "../../lib/agentPromptTimeline";
import { localOccurrenceKey, localWallClock } from "../../lib/agentSchedule";
import { parseTags, tagCounts } from "../../lib/agentPromptTags";
import { formatLongDate, monthName, toDateStr, todayStr } from "../../lib/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { jumpToTab } from "../../lib/tabJump";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type PromptLink,
  type SentAgentPrompt,
} from "../../stores/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";
import { Dropdown } from "../common/Dropdown";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import { UntestedTag } from "../common/UntestedTag";
import { AgentScheduleDialog } from "./AgentScheduleDialog";
import { PromptCard } from "./PromptCard";
import { PromptSessionCard } from "./PromptSessionCard";
import { PromptChartFilterBar } from "./PromptChartFilterBar";
import { PromptChartLinks } from "./PromptChartLinks";
import { PromptLinkEditor } from "./PromptLinkEditor";
import { PromptTimeline } from "./PromptTimeline";
import { usePromptChartDrag } from "./usePromptChartDrag";
import { usePromptChartUsage } from "./usePromptChartUsage";
import { PromptDraftBoard, type DraftBoardHandle } from "./PromptDraftBoard";
import { draftChainAnchors, draftSequence } from "../../lib/agentPromptDrafts";
import { AGENT_ITEMS, EMPTY_CUSTOM_AGENTS } from "../tabs/newTabItems";
import { useAddTabMenuData } from "../tabs/useAddTabMenuData";

const EMPTY_PROMPTS: ProjectAgentPrompt[] = [];
const EMPTY_HISTORY: SentAgentPrompt[] = [];
const EMPTY_LINKS: ReturnType<typeof useAgentPromptsStore.getState>["linksByProject"][string] = [];
const EMPTY_FILTER: PromptChartFilter = { text: "", tag: "", agent: "", result: "" };
const VIEWS: TimelineView[] = ["hour", "day", "week", "month"];
/** Whether the timeline is shown: a reader's convenience, remembered per
 *  window like the Agents view's sort. The filters are not — a filter that
 *  survives a relaunch is how a card goes missing. */
const TIMELINE_STORAGE_KEY = "eldrun.promptChart.timeline";

function readShowTimeline(): boolean {
  try { return localStorage.getItem(TIMELINE_STORAGE_KEY) !== "hidden"; } catch { return true; }
}

function isStripCard(card: PromptChartCard): boolean {
  return card.state === "draft" || card.state === "chained";
}

function agentsOf(cards: PromptChartCard[]): string[] {
  return [...new Set(cards.flatMap((card) => card.autoTags.filter((tag) => tag.startsWith("agent:")).map((tag) => tag.slice(6))))].sort();
}

interface Props {
  scope: string;
  active: boolean;
  tabs: TabEntry[];
  stateOf?: (tab: TabEntry) => string;
}

function target(tab: TabEntry) {
  return {
    scheduleTargetId: tab.scheduleTargetId!,
    label: tab.label,
    sessionId: tab.sessionId,
    agent: tab.cmd,
  };
}

function rectOf(node: Element | null) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * One horizontal time axis for every prompt of the scope — sent, queued,
 * scheduled — with the timeless drafts on a strip above it. The chart owns
 * the data and every write; the axis (`PromptTimeline`) owns only geometry,
 * and the gesture (`usePromptChartDrag`) owns only the pointer. A drop is
 * turned into exactly one write by `timelineDropAction`, and which tab a
 * card is aimed at is the card's own, picked on its face.
 */
export function PromptChart({ scope, active, tabs, stateOf }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const weekStart = useSettingsStore((s) => (s.settings?.calendar_week_start ?? 0) as 0 | 1);
  const prompts = useAgentPromptsStore((state) => state.byProject[scope] ?? EMPTY_PROMPTS);
  const history = useAgentPromptsStore((state) => state.historyByProject[scope] ?? EMPTY_HISTORY);
  const links = useAgentPromptsStore((state) => state.linksByProject[scope] ?? EMPTY_LINKS);
  const loadPrompts = useAgentPromptsStore((state) => state.load);
  const loadHistory = useAgentPromptsStore((state) => state.loadHistory);
  const loadLinks = useAgentPromptsStore((state) => state.loadLinks);
  const upsertPrompt = useAgentPromptsStore((state) => state.upsert);
  const removePrompt = useAgentPromptsStore((state) => state.remove);
  const clearHistory = useAgentPromptsStore((state) => state.clearHistory);
  const upsertLink = useAgentPromptsStore((state) => state.link);
  const removeLink = useAgentPromptsStore((state) => state.unlink);
  const schedulesByTarget = useAgentSchedulesStore((state) => state.byTarget);
  const schedules = useAgentSchedulesStore();
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<TimelineView>("day");
  const [anchor, setAnchor] = useState(() => todayStr());
  const [draftFilter, setDraftFilter] = useState<PromptChartFilter>(EMPTY_FILTER);
  const [draftHide, setDraftHide] = useState(false);
  const [chartFilter, setChartFilter] = useState<PromptChartFilter>(EMPTY_FILTER);
  const [chartHide, setChartHide] = useState(false);
  const [when, setWhen] = useState<PromptChartWindow>("any");
  const [showTimeline, setShowTimeline] = useState(readShowTimeline);
  const [selected, setSelected] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<"related" | "after">("after");
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [dialog, setDialog] = useState<{ tab: TabEntry; message?: string; promptId?: string } | null>(null);
  const [error, setError] = useState("");
  const [linksVersion, setLinksVersion] = useState(0);
  /** The edge whose editor is open, and where. */
  const [edgeEdit, setEdgeEdit] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Sent cards the reader dragged up or down out of the way, per view (the
   *  lanes pack differently in each): px off their lane, by timeline item key.
   *  A way of reading the axis, so it is not persisted — like the filters. */
  const [lifts, setLifts] = useState<Partial<Record<TimelineView, Record<string, number>>>>({});
  const prefaceOverrides = useSettingsStore((s) => s.settings?.agent_preface_commands);
  // What a draft's "New agent tab" opens: the chart's own agent and model
  // picks, one pair for every chart (`lib/agentPromptNewTab`).
  const newTabAgent = useSettingsStore((s) => promptChartNewTabAgent(s.settings));
  const newTabModel = useSettingsStore((s) => s.settings?.prompt_chart_model?.trim() ?? "");
  const modelOverrides = useSettingsStore((s) => s.settings?.agent_models);
  const customAgents = useSettingsStore((s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { enabledAgents, installedCustom } = useAddTabMenuData(scope);
  const addTabToScope = useTabsStore((s) => s.addTabToScope);
  const project = useProjectsStore((s) => s.projects.find((item) => item.id === scope));
  const use24h = useUse24h();
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nowBandRef = useRef<HTMLDivElement>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const draftBoard = useRef<DraftBoardHandle>(null);
  const refreshLinks = useCallback(() => setLinksVersion((value) => value + 1), []);

  useEffect(() => {
    void Promise.all([
      loadPrompts(scope),
      loadHistory(scope),
      loadLinks(scope).catch(() => []),
    ]).catch((cause) => setError(String(cause)));
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("agent-prompts-changed", () => {
      void loadPrompts(scope).catch(() => []);
      void loadHistory(scope).catch(() => []);
      void loadLinks(scope).catch(() => []);
    }).then((unlisten) => disposed ? unlisten() : (stop = unlisten));
    return () => { disposed = true; stop?.(); };
  }, [loadHistory, loadLinks, loadPrompts, scope]);

  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  const win = useMemo(() => timelineWindow(view, anchor, weekStart), [anchor, view, weekStart]);

  const liveStrands = useMemo<PromptChartStrand[]>(() => tabs.map((tab) => ({
    id: `strand:${tab.scheduleTargetId}`,
    label: tab.label,
    scheduleTargetId: tab.scheduleTargetId,
    tabKey: tab.key,
    sessionId: tab.sessionId,
    tabId: tab.sessionId,
    agent: tab.cmd,
    schedules: schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId!)] ?? [],
  })), [scope, schedulesByTarget, tabs]);

  // One closed strand per gone TAB, not per session: a tab's rows after a
  // `/clear` carry a new session id but the same tab id, and they stay on
  // its strand — as separate session cards, joined by the edge the history
  // drew when the id rolled.
  const closedStrands = useMemo<PromptChartStrand[]>(() => {
    const map = new Map<string, PromptChartStrand>();
    for (const row of history) {
      if (liveStrands.some((strand) => rowOnStrand(strand, row))) continue;
      const identity = row.tab_id ?? row.session_id ?? row.tab_label;
      if (map.has(identity)) continue;
      map.set(identity, {
        id: `closed:${identity}`,
        label: row.tab_label || t("promptChart.closed"),
        sessionId: row.session_id,
        tabId: row.tab_id,
        agent: row.agent,
        closed: true,
        schedules: [],
      });
    }
    return [...map.values()];
  }, [history, liveStrands, t]);
  const strands = useMemo(() => [...liveStrands, ...closedStrands], [closedStrands, liveStrands]);
  const cards = useMemo(() => buildPromptChart({ prompts, history, strands, links, now, newTabAgent }), [history, links, newTabAgent, now, prompts, strands]);
  const chainAnchors = useMemo(() => draftChainAnchors(cards, now), [cards, now]);
  const stripCards = useMemo(() => cards.filter((card) => isStripCard(card) && !chainAnchors.has(card.id)), [cards, chainAnchors]);
  const stripIds = useMemo(() => new Set(stripCards.map((card) => card.id)), [stripCards]);
  const timeCards = useMemo(() => cards.filter((card) => !stripIds.has(card.id)), [cards, stripIds]);
  const draftMatched = useMemo(() => new Set(stripCards.filter((card) => promptChartCardMatches(card, draftFilter)).map((card) => card.key)), [draftFilter, stripCards]);
  // The timeline's text/tag/agent/outcome match, by key; the "When" window is
  // asked per drawn instant, since a recurring rule's occurrences share a key.
  const chartMatched = useMemo(() => new Set(timeCards.filter((card) => promptChartCardMatches(card, chartFilter)).map((card) => card.key)), [chartFilter, timeCards]);
  const draftTagCounts = useMemo(() => tagCounts(stripCards.map((card) => ({ tags: [...card.tags, ...card.autoTags] }))), [stripCards]);
  const chartTagCounts = useMemo(() => tagCounts(timeCards.map((card) => ({ tags: [...card.tags, ...card.autoTags] }))), [timeCards]);
  const draftAgents = useMemo(() => agentsOf(stripCards), [stripCards]);
  const chartAgents = useMemo(() => agentsOf(timeCards), [timeCards]);
  const tabAgents = useMemo(() => tabs.map((tab) => tab.cmd), [tabs]);
  const usageResets = usePromptChartUsage(tabAgents, active && showTimeline, now, win.start, win.end, chartFilter.agent);
  const matches = (card: PromptChartCard, occurrence?: string): boolean => {
    if (stripIds.has(card.id)) return draftMatched.has(card.key);
    const at = occurrence ? localWallClock(occurrence) : card.at ?? chainAnchors.get(card.id) ?? null;
    return chartMatched.has(card.key) && promptChartInWindow(card, at, when, now);
  };
  const visible = (card: PromptChartCard, occurrence?: string) =>
    !(stripIds.has(card.id) ? draftHide : chartHide) || matches(card, occurrence);
  const sessionMatched = useMemo(
    () => new Set(timeCards.filter((card) => chartMatched.has(card.key) && promptChartInWindow(card, card.at, when, now)).map((card) => card.key)),
    [chartMatched, now, timeCards, when],
  );
  const targetIds = useMemo(() => tabs.map((tab) => tab.scheduleTargetId!), [tabs]);
  const targets = useMemo(() => tabs.map((tab) => ({
    id: tab.scheduleTargetId!,
    label: stateOf ? `${tab.label} · ${stateOf(tab)}` : tab.label,
  })), [stateOf, tabs]);

  useEffect(() => setLinksVersion((value) => value + 1), [cards, view, anchor]);

  const tabOf = (targetId?: string) => tabs.find((tab) => tab.scheduleTargetId === targetId);
  const newTabItem = agentItemFor(newTabAgent, customAgents);
  const newTabLabel = t("promptChart.newAgentTab", { agent: newTabItem.label });
  // The agents the toolbar offers: the "+" menu's own set (installed built-ins
  // the user has not turned off, custom agents that probe present), plus the
  // one already picked, so the pick never reads blank while a probe is out or
  // after its CLI went missing.
  const newTabAgentOptions = useMemo(() => {
    const options = [
      ...AGENT_ITEMS.filter((item) => enabledAgents?.has(item.cmd)).map((item) => ({ value: item.cmd, label: item.label })),
      ...customAgents.filter((agent) => installedCustom === null || installedCustom.has(agent.cmd)).map((agent) => ({ value: agent.cmd, label: agent.label })),
    ];
    if (!options.some((option) => option.value === newTabAgent)) options.unshift({ value: newTabAgent, label: newTabItem.label });
    return options;
  }, [customAgents, enabledAgents, installedCustom, newTabAgent, newTabItem.label]);
  const newTabModels = useMemo(() => agentModelsFor(newTabAgent, modelOverrides), [modelOverrides, newTabAgent]);
  /** A draft with no tab of its own: Send opens a new agent tab running the
   *  chart's agent and queues the prompt at it, with the model pick typed
   *  ahead as the agent's own `/model`; Schedule opens the tab and then the
   *  rule dialog on it. The tab opens on the project root — the "+" menu's
   *  worktree question is not asked here. */
  const openNewTab = (): { tab: TabEntry; preface: string[] } => {
    const spec = newAgentTabForDraft({
      agent: newTabAgent,
      model: newTabModel,
      customAgents,
      cwd: project ? resolveProjectDirectory(project) : "",
      projectName: project?.name ?? "",
      t,
    });
    return { tab: addTabToScope(scope, spec.tab), preface: spec.preface };
  };
  const sendToNewTab = async (card: PromptChartCard) => {
    if (!card.prompt) return;
    const { tab, preface } = openNewTab();
    await sendCollectedPrompt(scope, target(tab), card.prompt, preface);
  };
  const colorOf = (card: PromptChartCard) => {
    const strand = strands.find((item) => item.id === card.strandId);
    if (strand?.closed) return promptTargetColor(-1);
    const targetId = card.targetId ?? strand?.scheduleTargetId;
    return promptTargetColor(targetId ? targetIds.indexOf(targetId) : 0);
  };

  const send = async (card: PromptChartCard, tab: TabEntry) => {
    if (card.prompt && !card.schedule) {
      await sendCollectedPrompt(scope, target(tab), card.prompt);
    } else {
      if (card.schedule && card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
      await queuePromptForTab(scope, tab.scheduleTargetId!, card.message, {
        id: card.id,
        preface: card.schedule?.preface ?? card.history?.preface,
      });
    }
  };
  const pickTab = (picked: PromptChartCard, action: "send" | "schedule") => {
    const card = isStripCard(picked) ? draftSequence(picked.id, cards, links)?.[0] : picked;
    if (!card) { setError(t("promptChart.sequenceBlocked")); return; }
    if (card.state === "draft" && !card.targetId) {
      if (action === "send") void sendToNewTab(card).catch((cause) => setError(String(cause)));
      else setDialog({ tab: openNewTab().tab, message: card.message, promptId: card.prompt?.id });
      return;
    }
    const tab = tabOf(card.targetId) ?? tabs[0];
    if (!tab) return;
    if (action === "send") void send(card, tab).catch((cause) => setError(String(cause)));
    else setDialog({ tab, message: card.message, promptId: card.prompt?.id });
  };
  /** Write the rule to its (new) tab first, then drop the old copy: the
   *  order that cannot lose the rule, and the one whose upsert persists the
   *  tab binding. */
  const moveRule = async (card: PromptChartCard, targetId: string, at?: Date) => {
    if (!card.schedule) return;
    const rule = at ? { type: "once" as const, at: localOccurrenceKey(at) } : card.schedule.rule;
    if (targetId === card.targetId && !at) return;
    await schedules.upsert(scope, targetId, { ...card.schedule, last: undefined, rule });
    if (card.targetId && targetId !== card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
  };
  const retime = async (card: PromptChartCard, at: Date, targetId = card.targetId) => {
    if (!card.schedule || !targetId || card.recurring) return;
    await moveRule(card, targetId, at);
  };
  const reorderQueue = async (card: PromptChartCard, step: -1 | 1) => {
    if (!card.schedule || !card.targetId) return;
    const queue = cards.filter((item) => item.targetId === card.targetId && item.state === "queued" && item.schedule);
    const from = queue.findIndex((item) => item.schedule?.id === card.schedule?.id);
    const to = Math.max(0, Math.min(queue.length - 1, from + step));
    if (from < 0 || from === to) return;
    const ordered = [...queue];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    const times = queueOrderTimes(ordered.map((item) => item.schedule!.id), now);
    for (const item of ordered) {
      await schedules.upsert(scope, card.targetId, {
        ...item.schedule!,
        last: undefined,
        rule: { type: "once", at: times[item.schedule!.id] },
      });
    }
  };
  const collect = async (card: PromptChartCard) => {
    await upsertPrompt(scope, { id: crypto.randomUUID(), message: card.message, tags: card.tags });
  };
  const remove = async (card: PromptChartCard) => {
    if (card.schedule && card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
    if (card.prompt) await removePrompt(scope, card.prompt.id);
    if (card.history && card.state === "sent") await clearHistory(scope, card.history.id);
  };
  const unschedule = async (card: PromptChartCard) => {
    if (!card.prompt) await upsertPrompt(scope, { id: crypto.randomUUID(), message: card.message, tags: card.tags });
    if (card.schedule && card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
  };
  const save = async (card: PromptChartCard, message: string, tags: string[]) => {
    if (card.prompt) await upsertPrompt(scope, { id: card.prompt.id, message, tags });
    if (card.schedule && card.targetId) await schedules.upsert(scope, card.targetId, { ...card.schedule, message });
  };
  /** The agent picker on a card: what "aim this at that tab" writes per state. */
  const setAgent = async (card: PromptChartCard, targetId: string) => {
    if (card.state === "draft" && card.prompt) {
      await upsertPrompt(scope, { id: card.prompt.id, message: card.message, tags: card.tags, target: targetId || "" });
    } else if (card.state === "chained" && card.chainLink) {
      await upsertLink(scope, { ...card.chainLink, target: targetId || undefined });
    } else if (card.schedule && targetId) {
      await moveRule(card, targetId);
    }
  };

  const ensureLinkEndpoint = async (card: PromptChartCard) => {
    if (card.prompt || card.history) return;
    await upsertPrompt(scope, { id: card.id, message: card.message, tags: card.tags });
  };
  const beginLink = async (card: PromptChartCard) => {
    await ensureLinkEndpoint(card);
    setLinkFrom(card.id);
    setSelected(card.id);
  };
  const targetOf = (card?: PromptChartCard) =>
    card?.targetId ?? strands.find((strand) => strand.id === card?.strandId)?.scheduleTargetId;
  const linkCards = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const source = cards.find((card) => card.id === fromId);
    const to = cards.find((card) => card.id === toId);
    if (!source || !to) return;
    await ensureLinkEndpoint(source);
    await ensureLinkEndpoint(to);
    await upsertLink(scope, {
      id: crypto.randomUUID(), from: fromId, to: toId, kind: linkKind,
      target: linkKind === "after" ? targetOf(to) ?? targetOf(source) : undefined,
    });
  };
  const linkTo = async (to: PromptChartCard) => {
    const from = linkFrom;
    setLinkFrom(null);
    if (from) await linkCards(from, to.id);
  };
  /** The tab an edge queues its target on: its own, else the target's, else the source's. */
  const edgeTarget = (link: PromptLink) =>
    link.target ?? targetOf(cards.find((card) => card.id === link.to)) ?? targetOf(cards.find((card) => card.id === link.from));
  const editEdge = async (link: PromptLink, patch: Pick<PromptLink, "kind" | "preface">) => {
    await upsertLink(scope, {
      ...link,
      ...patch,
      target: patch.kind === "after" ? edgeTarget(link) : undefined,
    });
  };
  const openEdgeEditor = (link: PromptLink, x: number, y: number) => setEdgeEdit({ id: link.id, x, y });

  const applyDrop = async (card: PromptChartCard, drop: PromptTimelineDrop) => {
    if (drop.type === "send") {
      const tab = tabOf(drop.targetId);
      if (tab) await send(card, tab);
    } else if (drop.type === "retime") {
      const at = localWallClock(drop.at);
      if (at) await retime(card, at, drop.targetId);
    } else if (drop.type === "schedule") {
      await schedules.upsert(scope, drop.targetId, { id: card.id, enabled: true, message: card.message, rule: { type: "once", at: drop.at } });
    } else if (drop.type === "unschedule") {
      await unschedule(card);
    }
  };

  // Pulling any unscheduled member carries its sequence's start. The remaining
  // prompts keep their dependency edges; only the start acquires a schedule.
  const dropSource = (card: PromptChartCard) => isStripCard(card) ? draftSequence(card.id, cards, links)?.[0] : card;
  const { drag, onCardPointerDown, onLiftPointerDown, onPortPointerDown } = usePromptChartDrag({
    win,
    now,
    measure: () => {
      const body = bodyRef.current;
      const bodyRect = rectOf(body);
      return {
        rects: { strip: rectOf(stripRef.current), body: bodyRect, nowBand: rectOf(nowBandRef.current) },
        width: bodyRect?.width ?? 0,
        scrollLeft: body?.scrollLeft ?? 0,
      };
    },
    measureCards: () => [...cardNodes.current.entries()].map(([id, node]) => ({ id, rect: rectOf(node)! })),
    onDropCard: (card, zone: TimelineZone, carried) => {
      if (zone.kind === "strip" && stripIds.has(card.id)) {
        draftBoard.current?.place(card.id, carried.x - carried.grabDx, carried.y - carried.grabDy);
        return;
      }
      const source = dropSource(card);
      if (!source) { setError(t("promptChart.sequenceBlocked")); return; }
      const drop = timelineDropAction(source, zone, targetIds);
      void applyDrop(source, drop).catch((cause) => setError(String(cause)));
    },
    onDropLink: (from, toId) => void linkCards(from.id, toId).catch((cause) => setError(String(cause))),
    onLift: (key, lift) => setLifts((all) => ({ ...all, [view]: { ...all[view], [key]: lift } })),
  });
  // A lifted card moves under the pointer, so its links follow every step.
  useEffect(refreshLinks, [drag, refreshLinks]);

  const dropLabel = (() => {
    if (drag?.kind !== "card") return null;
    if (drag.zone.kind === "strip" && stripIds.has(drag.card.id)) return t("promptChart.freeLayout");
    const source = dropSource(drag.card);
    const drop = source ? timelineDropAction(source, drag.zone, targetIds) : { type: "none" as const };
    const keys: Record<PromptTimelineDrop["type"], "promptChart.sendNow" | "promptChart.dropSchedule" | "promptChart.dropRetime" | "promptChart.dropUnschedule" | "promptChart.dropBlocked"> = {
      send: "promptChart.sendNow",
      schedule: "promptChart.dropSchedule",
      retime: "promptChart.dropRetime",
      unschedule: "promptChart.dropUnschedule",
      none: "promptChart.dropBlocked",
    };
    const sequence = draftSequence(drag.card.id, cards, links);
    return sequence && sequence.length > 1 && (drop.type === "send" || drop.type === "schedule")
      ? t("promptChart.dropSequence", { action: t(keys[drop.type]), count: sequence.length }) : t(keys[drop.type]);
  })();

  const linkLabel = (id: string) => {
    const card = cards.find((item) => item.id === id);
    const text = card?.message ?? id;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  };

  /** A session's sent prompts as one card, drawn under the newest of them. */
  const renderSession = (latest: PromptChartCard, session: SessionSpan) => {
    if (!session.cards.some((card) => visible(card))) return null;
    const strand = strands.find((item) => item.id === latest.strandId);
    const ids = session.cards.map((card) => card.id);
    return (
      <PromptSessionCard
        cards={session.cards}
        offsets={session.offsets}
        matchedKeys={sessionMatched}
        selected={!!selected && ids.includes(selected)}
        linking={!!linkFrom && !ids.includes(linkFrom)}
        linkOver={drag?.kind === "link" && !!drag.overId && ids.includes(drag.overId)}
        color={colorOf(latest)}
        register={(node) => {
          for (const id of ids) {
            if (node) cardNodes.current.set(id, node);
            else cardNodes.current.delete(id);
          }
        }}
        onPointerDown={onLiftPointerDown(sessionGroupKey(latest) ?? latest.key)}
        onPortPointerDown={onPortPointerDown(latest)}
        onSelect={() => {
          if (linkFrom && !ids.includes(linkFrom)) void linkTo(latest).catch((cause) => setError(String(cause)));
          setSelected(latest.id);
        }}
        onLink={() => void beginLink(latest).catch((cause) => setError(String(cause)))}
        onCollect={(card) => collect(card)}
        onDelete={(card) => remove(card)}
        onGoToTab={strand?.tabKey ? () => jumpToTab(scope, strand.tabKey!) : undefined}
      />
    );
  };

  const renderCard = (card: PromptChartCard, occurrence?: string, session?: SessionSpan) => {
    if (session) return renderSession(card, session);
    if (!visible(card, occurrence)) return null;
    const strand = strands.find((item) => item.id === card.strandId);
    return (
      <PromptCard
        key={occurrence ? `${card.key}@${occurrence}` : card.key}
        card={card}
        occurrence={occurrence}
        matched={matches(card, occurrence)}
        selected={selected === card.id}
        linking={!!linkFrom && linkFrom !== card.id}
        dragging={drag?.kind === "card" && drag.card.key === card.key}
        linkOver={drag?.kind === "link" && drag.overId === card.id}
        color={colorOf(card)}
        targets={targets}
        targetLabel={card.state === "sent" ? card.history?.tab_label : undefined}
        newTabLabel={newTabLabel}
        register={(node) => {
          if (node) cardNodes.current.set(card.id, node);
          else cardNodes.current.delete(card.id);
        }}
        // A sent card keeps its instant; it only lifts up or down its lane.
        onPointerDown={card.state === "sent" ? onLiftPointerDown(card.key) : card.recurring ? undefined : onCardPointerDown(card)}
        onPortPointerDown={onPortPointerDown(card)}
        onSelect={() => {
          if (linkFrom && linkFrom !== card.id) void linkTo(card).catch((cause) => setError(String(cause)));
          setSelected(card.id);
        }}
        onAgent={(targetId) => setAgent(card, targetId).catch((cause) => setError(String(cause)))}
        onSave={(message, tags) => save(card, message, tags)}
        onDelete={() => remove(card)}
        onSend={() => pickTab(card, "send")}
        onSchedule={() => pickTab(card, "schedule")}
        onUnschedule={() => unschedule(card)}
        onCollect={() => collect(card)}
        onRetime={(minutes) => retime(card, new Date((card.at ?? now).getTime() + minutes * 60_000))}
        onQueueMove={(step) => reorderQueue(card, step)}
        onLink={() => void beginLink(card).catch((cause) => setError(String(cause)))}
        onUnlink={(linkId) => removeLink(scope, linkId).then(() => undefined)}
        links={links}
        linkLabel={linkLabel}
        onEditLink={openEdgeEditor}
        onGoToTab={strand?.tabKey ? () => jumpToTab(scope, strand.tabKey!) : undefined}
      />
    );
  };

  /** Ctrl + wheel: the next view in, or out, keeping the pointed-at day. */
  const zoom = (direction: "in" | "out", at: Date) => {
    const next = zoomTimelineView(view, direction);
    if (!next) return;
    setAnchor(next === "hour" ? hourAnchor(at) : toDateStr(at));
    setView(next);
  };
  /** A view button: the Hour view needs an hour, and takes the clock's. */
  const pickView = (next: TimelineView) => {
    if (next === "hour") setAnchor((value) => value.includes("T") ? value : `${value.slice(0, 10)}${hourAnchor(new Date()).slice(10)}`);
    setView(next);
  };

  const toggleTimeline = () => setShowTimeline((shown) => {
    try { localStorage.setItem(TIMELINE_STORAGE_KEY, shown ? "hidden" : "shown"); } catch { /* the choice lasts the session */ }
    return !shown;
  });
  const rangeLabel = view === "hour"
    ? `${formatLongDate(anchor.slice(0, 10), lang)} · ${formatTimelineInstant(win.start, lang, use24h, false)} – ${formatTimelineInstant(win.end, lang, use24h, false)}`
    : view === "day"
    ? formatLongDate(anchor.slice(0, 10), lang)
    : view === "week"
      ? `${formatLongDate(todayStr(win.start), lang)} – ${formatLongDate(todayStr(new Date(win.end.getTime() - 1)), lang)}`
      : `${monthName(lang, win.start.getMonth() + 1)} ${win.start.getFullYear()}`;

  return (
    <section className="agent-prompts-section agent-prompt-chart-section">
      <h3 className="settings-section-title">{t("promptChart.heading")} <UntestedTag /></h3>
      <div className="agent-prompt-chart-toolbar">
        <button className="settings-btn sm primary" type="button" aria-label={t("promptChart.newDraft")} onClick={() => setNewOpen((value) => !value)}>＋</button>
        <button className={`agent-composer-chip${showTimeline ? " active" : ""}`} type="button" aria-pressed={showTimeline} title={t("promptChart.timelineTitle")} onClick={toggleTimeline}>{t("promptChart.timeline")}</button>
        <div className="agent-prompt-link-kind" role="group" aria-label={t("promptChart.linkKind")}>
          <span>{t("promptChart.linkKind")}</span>
          <button type="button" className={`agent-composer-chip${linkKind === "after" ? " active" : ""}`} aria-pressed={linkKind === "after"} onClick={() => setLinkKind("after")}>{t("promptChart.after")}</button>
          <button type="button" className={`agent-composer-chip${linkKind === "related" ? " active" : ""}`} aria-pressed={linkKind === "related"} onClick={() => setLinkKind("related")}>{t("promptChart.related")}</button>
          {linkFrom && <><span>{t("promptChart.pickLink")}</span><button type="button" className="agent-composer-chip" onClick={() => setLinkFrom(null)}>{t("common.cancel")}</button></>}
        </div>
        <div className="agent-prompt-link-kind agent-prompt-new-tab" role="group" aria-label={t("promptChart.newTabDefaults")} title={t("promptChart.newTabDefaultsTitle")}>
          <span>{t("promptChart.newTabDefaults")}</span>
          <Dropdown
            title={t("promptChart.newTabAgent")}
            value={newTabAgent}
            options={newTabAgentOptions}
            onChange={(value) => void updateSettings({ prompt_chart_agent: value, prompt_chart_model: "" }).catch((cause) => setError(String(cause)))}
          />
          {newTabModels.length > 0 && (
            <Dropdown
              title={t("agentPrompts.modelTitle")}
              value={newTabModel}
              placeholder={t("promptChart.newTabModelDefault")}
              options={[
                { value: "", label: t("promptChart.newTabModelDefault") },
                ...newTabModels.map((name) => ({ value: name, label: name })),
              ]}
              onChange={(value) => void updateSettings({ prompt_chart_model: value }).catch((cause) => setError(String(cause)))}
            />
          )}
        </div>
      </div>
      {newOpen && <div className="agent-prompt-new"><MarkdownPromptField rows={4} value={draft} ariaLabel={t("agentPrompts.placeholder")} placeholder={t("agentPrompts.placeholder")} onChange={setDraft} /><input value={draftTags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setDraftTags(event.target.value)} /><button className="settings-btn sm primary" type="button" disabled={!draft.trim()} onClick={() => void upsertPrompt(scope, { id: crypto.randomUUID(), message: draft.trim(), tags: parseTags(draftTags) }).then(() => { setDraft(""); setDraftTags(""); setNewOpen(false); }).catch((cause) => setError(String(cause)))}>{t("agentPrompts.add")}</button></div>}
      {error && <div className="project-dialog-error">{error}</div>}
      <div className={`agent-prompt-chart${showTimeline ? "" : " is-drafts-only"}`} ref={rootRef}>
        <PromptChartLinks
          rootRef={rootRef}
          cardNodes={cardNodes}
          links={links}
          selectedId={selected}
          version={linksVersion}
          preview={drag?.kind === "link" ? { x1: drag.x1, y1: drag.y1, x2: drag.x, y2: drag.y, kind: linkKind } : null}
          onEdit={openEdgeEditor}
          editLabel={t("promptChart.editLink")}
        />
        <div
          className={`agent-prompt-drafts-strip${drag?.kind === "card" && drag.zone.kind === "strip" ? " is-drop-over" : ""}`}
          ref={stripRef}
          data-testid="prompt-chart-strip"
        >
          <header><strong>{t("promptChart.drafts")}</strong><span>{stripCards.length}</span>{showTimeline && <small>{t("promptChart.dropHint")}</small>}</header>
          <PromptChartFilterBar
            testId="prompt-chart-draft-filter"
            filter={draftFilter}
            onChange={setDraftFilter}
            placeholder={t("promptChart.draftSearch")}
            agents={draftAgents}
            tags={draftTagCounts}
            hideOthers={draftHide}
            onHideOthers={() => setDraftHide((value) => !value)}
          />
          <PromptDraftBoard key={scope} ref={draftBoard} scope={scope} cards={stripCards} drag={drag} renderCard={renderCard} onLayout={refreshLinks} />
        </div>
        {showTimeline && (
          <>
            <div className="agent-prompt-chart-timeline-bar">
              <div className="agent-prompt-chart-toolbar">
                <div className="agent-prompt-chart-views" role="group" aria-label={t("promptChart.zoom")} title={t("promptChart.zoomHint")}>
                  {VIEWS.map((item) => (
                    <button key={item} type="button" className={`agent-composer-chip${view === item ? " active" : ""}`} aria-pressed={view === item} onClick={() => pickView(item)}>
                      {t(`promptChart.view.${item}` as "promptChart.view.day")}
                    </button>
                  ))}
                </div>
                <div className="agent-prompt-chart-nav">
                  <button className="settings-btn sm" type="button" aria-label={t("promptChart.prev")} title={t("promptChart.prev")} onClick={() => setAnchor((value) => shiftAnchor(view, value, -1))}>◀</button>
                  <button className="settings-btn sm" type="button" onClick={() => setAnchor(view === "hour" ? hourAnchor(new Date()) : todayStr())}>{t("promptChart.today")}</button>
                  <button className="settings-btn sm" type="button" aria-label={t("promptChart.next")} title={t("promptChart.next")} onClick={() => setAnchor((value) => shiftAnchor(view, value, 1))}>▶</button>
                  <strong className="agent-prompt-chart-range" data-testid="prompt-chart-range">{rangeLabel}</strong>
                </div>
              </div>
              <PromptChartFilterBar
                testId="prompt-chart-timeline-filter"
                filter={chartFilter}
                onChange={setChartFilter}
                placeholder={t("promptChart.timelineSearch")}
                agents={chartAgents}
                tags={chartTagCounts}
                hideOthers={chartHide}
                onHideOthers={() => setChartHide((value) => !value)}
                results
                window={when}
                onWindow={setWhen}
              />
            </div>
            <PromptTimeline
              win={win}
              cards={cards}
              now={now}
              drag={drag}
              bodyRef={bodyRef}
              nowBandRef={nowBandRef}
              renderCard={renderCard}
              onRefine={(date) => { setAnchor(date); setView("day"); }}
              dropLabel={dropLabel}
              onZoom={zoom}
              lifts={lifts[view]}
              resets={usageResets}
            />
          </>
        )}
      </div>
      {(() => {
        const link = edgeEdit && links.find((item) => item.id === edgeEdit.id);
        if (!edgeEdit || !link) return null;
        const tab = tabOf(edgeTarget(link));
        return (
          <PromptLinkEditor
            link={link}
            fromLabel={linkLabel(link.from)}
            toLabel={linkLabel(link.to)}
            tabLabel={tab?.label}
            offered={tab ? prefaceCommandsFor(tab.cmd, prefaceOverrides) : []}
            x={edgeEdit.x}
            y={edgeEdit.y}
            onChange={(patch) => editEdge(link, patch)}
            onRemove={() => removeLink(scope, link.id).then(() => setEdgeEdit(null))}
            onClose={() => setEdgeEdit(null)}
          />
        );
      })()}
      {dialog && <AgentScheduleDialog scope={scope} tab={dialog.tab} initialMessage={dialog.message} initialPromptId={dialog.promptId} onClose={() => setDialog(null)} />}
    </section>
  );
}
