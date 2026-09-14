import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  buildPromptChart,
  promptChartCardMatches,
  queueOrderTimes,
  type PromptChartCard,
  type PromptChartFilter,
  type PromptChartStrand,
} from "../../lib/agentPromptChart";
import {
  promptTargetColor,
  shiftAnchor,
  timelineDropAction,
  timelineWindow,
  type PromptTimelineDrop,
  type SessionSpan,
  type TimelineView,
  type TimelineZone,
} from "../../lib/agentPromptTimeline";
import { localOccurrenceKey, localWallClock } from "../../lib/agentSchedule";
import { parseTags, tagCounts } from "../../lib/agentPromptTags";
import { formatLongDate, monthName, todayStr } from "../../lib/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { jumpToTab } from "../../lib/tabJump";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type SentAgentPrompt,
} from "../../stores/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import { UntestedTag } from "../common/UntestedTag";
import { AgentScheduleDialog } from "./AgentScheduleDialog";
import { PromptCard } from "./PromptCard";
import { PromptSessionCard } from "./PromptSessionCard";
import { PromptChartLinks } from "./PromptChartLinks";
import { PromptTimeline } from "./PromptTimeline";
import { usePromptChartDrag } from "./usePromptChartDrag";

const EMPTY_PROMPTS: ProjectAgentPrompt[] = [];
const EMPTY_HISTORY: SentAgentPrompt[] = [];
const EMPTY_LINKS: ReturnType<typeof useAgentPromptsStore.getState>["linksByProject"][string] = [];
const EMPTY_FILTER: PromptChartFilter = { text: "", tag: "", agent: "", result: "" };
const VIEWS: TimelineView[] = ["day", "week", "month"];

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
  const [filter, setFilter] = useState<PromptChartFilter>(EMPTY_FILTER);
  const [hideOthers, setHideOthers] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<"related" | "after">("after");
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [dialog, setDialog] = useState<{ tab: TabEntry; message?: string } | null>(null);
  const [error, setError] = useState("");
  const [linksVersion, setLinksVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nowBandRef = useRef<HTMLDivElement>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());

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
    agent: tab.cmd,
    schedules: schedulesByTarget[scheduleCacheKey(scope, tab.scheduleTargetId!)] ?? [],
  })), [scope, schedulesByTarget, tabs]);

  const closedStrands = useMemo<PromptChartStrand[]>(() => {
    const liveSessions = new Set(liveStrands.flatMap((strand) => [strand.sessionId, strand.label]).filter(Boolean));
    const map = new Map<string, PromptChartStrand>();
    for (const row of history) {
      const identity = row.session_id ?? row.tab_label;
      if (liveSessions.has(identity) || map.has(identity)) continue;
      map.set(identity, {
        id: `closed:${identity}`,
        label: row.tab_label || t("promptChart.closed"),
        sessionId: row.session_id,
        agent: row.agent,
        closed: true,
        schedules: [],
      });
    }
    return [...map.values()];
  }, [history, liveStrands, t]);
  const strands = useMemo(() => [...liveStrands, ...closedStrands], [closedStrands, liveStrands]);
  const cards = useMemo(() => buildPromptChart({ prompts, history, strands, links, now }), [history, links, now, prompts, strands]);
  const matched = useMemo(() => new Set(cards.filter((card) => promptChartCardMatches(card, filter)).map((card) => card.key)), [cards, filter]);
  const allTags = useMemo(() => tagCounts(cards.map((card) => ({ tags: [...card.tags, ...card.autoTags] }))), [cards]);
  const allAgents = useMemo(() => [...new Set(cards.flatMap((card) => card.autoTags.filter((tag) => tag.startsWith("agent:")).map((tag) => tag.slice(6))))].sort(), [cards]);
  const visible = (card: PromptChartCard) => !hideOthers || matched.has(card.key);
  const targetIds = useMemo(() => tabs.map((tab) => tab.scheduleTargetId!), [tabs]);
  const targets = useMemo(() => tabs.map((tab) => ({
    id: tab.scheduleTargetId!,
    label: stateOf ? `${tab.label} · ${stateOf(tab)}` : tab.label,
  })), [stateOf, tabs]);

  useEffect(() => setLinksVersion((value) => value + 1), [cards, view, anchor]);

  const tabOf = (targetId?: string) => tabs.find((tab) => tab.scheduleTargetId === targetId);
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
  const pickTab = (card: PromptChartCard, action: "send" | "schedule") => {
    const tab = tabOf(card.targetId) ?? tabs[0];
    if (!tab) return;
    if (action === "send") void send(card, tab).catch((cause) => setError(String(cause)));
    else setDialog({ tab, message: card.message });
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

  const { drag, onCardPointerDown, onPortPointerDown } = usePromptChartDrag({
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
    onDropCard: (card, zone: TimelineZone) => {
      const drop = timelineDropAction(card, zone, targetIds);
      void applyDrop(card, drop).catch((cause) => setError(String(cause)));
    },
    onDropLink: (from, toId) => void linkCards(from.id, toId).catch((cause) => setError(String(cause))),
  });
  useEffect(() => { if (!drag) setLinksVersion((value) => value + 1); }, [drag]);

  const dropLabel = useMemo(() => {
    if (drag?.kind !== "card") return null;
    const drop = timelineDropAction(drag.card, drag.zone, targetIds);
    const keys: Record<PromptTimelineDrop["type"], "promptChart.sendNow" | "promptChart.dropSchedule" | "promptChart.dropRetime" | "promptChart.dropUnschedule" | "promptChart.dropBlocked"> = {
      send: "promptChart.sendNow",
      schedule: "promptChart.dropSchedule",
      retime: "promptChart.dropRetime",
      unschedule: "promptChart.dropUnschedule",
      none: "promptChart.dropBlocked",
    };
    return t(keys[drop.type]);
  }, [drag, t, targetIds]);

  const linkLabel = (id: string) => {
    const card = cards.find((item) => item.id === id);
    const text = card?.message ?? id;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  };

  /** A session's sent prompts as one card, drawn under the newest of them. */
  const renderSession = (latest: PromptChartCard, session: SessionSpan) => {
    if (!session.cards.some(visible)) return null;
    const strand = strands.find((item) => item.id === latest.strandId);
    const ids = session.cards.map((card) => card.id);
    return (
      <PromptSessionCard
        cards={session.cards}
        offsets={session.offsets}
        matchedKeys={matched}
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
    if (!visible(card)) return null;
    const strand = strands.find((item) => item.id === card.strandId);
    return (
      <PromptCard
        key={occurrence ? `${card.key}@${occurrence}` : card.key}
        card={card}
        occurrence={occurrence}
        matched={matched.has(card.key)}
        selected={selected === card.id}
        linking={!!linkFrom && linkFrom !== card.id}
        dragging={drag?.kind === "card" && drag.card.key === card.key}
        linkOver={drag?.kind === "link" && drag.overId === card.id}
        color={colorOf(card)}
        targets={targets}
        targetLabel={card.state === "sent" ? card.history?.tab_label : undefined}
        register={(node) => {
          if (node) cardNodes.current.set(card.id, node);
          else cardNodes.current.delete(card.id);
        }}
        onPointerDown={card.recurring || card.state === "sent" ? undefined : onCardPointerDown(card)}
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
        onGoToTab={strand?.tabKey ? () => jumpToTab(scope, strand.tabKey!) : undefined}
      />
    );
  };

  const stripCards = cards.filter((card) => card.state === "draft" || card.state === "chained");
  const rangeLabel = view === "day"
    ? formatLongDate(anchor, lang)
    : view === "week"
      ? `${formatLongDate(todayStr(win.start), lang)} – ${formatLongDate(todayStr(new Date(win.end.getTime() - 1)), lang)}`
      : `${monthName(lang, win.start.getMonth() + 1)} ${win.start.getFullYear()}`;

  return (
    <section className="agent-prompts-section agent-prompt-chart-section">
      <h3 className="settings-section-title">{t("promptChart.heading")} <UntestedTag /></h3>
      <div className="agent-prompt-chart-toolbar">
        <button className="settings-btn sm primary" type="button" aria-label={t("promptChart.newDraft")} onClick={() => setNewOpen((value) => !value)}>＋</button>
        <input type="search" value={filter.text} placeholder={t("promptChart.search")} aria-label={t("promptChart.search")} onChange={(event) => setFilter((value) => ({ ...value, text: event.target.value }))} />
        <div className="agent-prompt-chart-views" role="group" aria-label={t("promptChart.zoom")}>
          {VIEWS.map((item) => (
            <button key={item} type="button" className={`agent-composer-chip${view === item ? " active" : ""}`} aria-pressed={view === item} onClick={() => setView(item)}>
              {t(`promptChart.view.${item}` as "promptChart.view.day")}
            </button>
          ))}
        </div>
        <div className="agent-prompt-chart-nav">
          <button className="settings-btn sm" type="button" aria-label={t("promptChart.prev")} title={t("promptChart.prev")} onClick={() => setAnchor((value) => shiftAnchor(view, value, -1))}>◀</button>
          <button className="settings-btn sm" type="button" onClick={() => setAnchor(todayStr())}>{t("promptChart.today")}</button>
          <button className="settings-btn sm" type="button" aria-label={t("promptChart.next")} title={t("promptChart.next")} onClick={() => setAnchor((value) => shiftAnchor(view, value, 1))}>▶</button>
          <strong className="agent-prompt-chart-range" data-testid="prompt-chart-range">{rangeLabel}</strong>
        </div>
        <button className={`agent-composer-chip${hideOthers ? " active" : ""}`} type="button" aria-pressed={hideOthers} onClick={() => setHideOthers((value) => !value)}>{t("promptChart.hideOthers")}</button>
      </div>
      <div className="agent-prompt-chart-facets">
        <Dropdown value={filter.agent} title={t("agentPrompts.filterAgent")} options={[{ value: "", label: t("agentPrompts.filterAgentAll") }, ...allAgents.map((agent) => ({ value: agent, label: agent }))]} onChange={(agent) => setFilter((value) => ({ ...value, agent }))} />
        <Dropdown value={filter.result} title={t("agentPrompts.filterResult")} options={[{ value: "", label: t("agentPrompts.filterResultAll") }, ...["delivered", "queued", "missed", "failed"].map((result) => ({ value: result, label: t(`promptChart.result.${result}` as "promptChart.result.delivered") }))]} onChange={(result) => setFilter((value) => ({ ...value, result }))} />
        <div className="agent-prompt-link-kind" role="group" aria-label={t("promptChart.linkKind")}>
          <span>{t("promptChart.linkKind")}</span>
          <button type="button" className={`agent-composer-chip${linkKind === "after" ? " active" : ""}`} aria-pressed={linkKind === "after"} onClick={() => setLinkKind("after")}>{t("promptChart.after")}</button>
          <button type="button" className={`agent-composer-chip${linkKind === "related" ? " active" : ""}`} aria-pressed={linkKind === "related"} onClick={() => setLinkKind("related")}>{t("promptChart.related")}</button>
          {linkFrom && <><span>{t("promptChart.pickLink")}</span><button type="button" className="agent-composer-chip" onClick={() => setLinkFrom(null)}>{t("common.cancel")}</button></>}
        </div>
      </div>
      {allTags.length > 0 && <div className="agent-prompts-tags">{allTags.map(({ tag, count }) => <button key={tag} type="button" className={`agent-composer-chip agent-prompts-tag${filter.tag === tag ? " active" : ""}${tag.includes(":") ? " is-auto" : ""}`} onClick={() => setFilter((value) => ({ ...value, tag: value.tag === tag ? "" : tag }))}>#{tag}<span>{count}</span></button>)}</div>}
      {newOpen && <div className="agent-prompt-new"><MarkdownPromptField rows={4} value={draft} ariaLabel={t("agentPrompts.placeholder")} placeholder={t("agentPrompts.placeholder")} onChange={setDraft} /><input value={draftTags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setDraftTags(event.target.value)} /><button className="settings-btn sm primary" type="button" disabled={!draft.trim()} onClick={() => void upsertPrompt(scope, { id: crypto.randomUUID(), message: draft.trim(), tags: parseTags(draftTags) }).then(() => { setDraft(""); setDraftTags(""); setNewOpen(false); }).catch((cause) => setError(String(cause)))}>{t("agentPrompts.add")}</button></div>}
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="agent-prompt-chart" ref={rootRef}>
        <PromptChartLinks
          rootRef={rootRef}
          cardNodes={cardNodes}
          links={links}
          selectedId={selected}
          version={linksVersion}
          preview={drag?.kind === "link" ? { x1: drag.x1, y1: drag.y1, x2: drag.x, y2: drag.y, kind: linkKind } : null}
        />
        <div
          className={`agent-prompt-drafts-strip${drag?.kind === "card" && drag.zone.kind === "strip" ? " is-drop-over" : ""}`}
          ref={stripRef}
          data-testid="prompt-chart-strip"
        >
          <header><strong>{t("promptChart.drafts")}</strong><span>{stripCards.length}</span><small>{t("promptChart.dropHint")}</small></header>
          <div className="agent-prompt-drafts-row">
            {stripCards.map((card) => renderCard(card))}
            {stripCards.length === 0 && <div className="file-tree-empty">{t("promptChart.noDrafts")}</div>}
          </div>
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
        />
      </div>
      {dialog && <AgentScheduleDialog scope={scope} tab={dialog.tab} initialMessage={dialog.message} onClose={() => setDialog(null)} />}
    </section>
  );
}
