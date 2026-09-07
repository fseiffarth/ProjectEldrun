import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  buildPromptChart,
  futureOffsetPercent,
  futureTimeAt,
  groupPromptPast,
  promptChartCardMatches,
  promptChartDropAction,
  queueOrderTimes,
  type PromptChartCard,
  type PromptChartFilter,
  type PromptChartStrand,
} from "../../lib/agentPromptChart";
import { localOccurrenceKey } from "../../lib/agentSchedule";
import { parseTags, tagCounts } from "../../lib/agentPromptTags";
import { useT } from "../../lib/i18n";
import { jumpToTab } from "../../lib/tabJump";
import {
  queuePromptForTab,
  sendCollectedPrompt,
  useAgentPromptsStore,
  type ProjectAgentPrompt,
  type SentAgentPrompt,
} from "../../stores/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agentSchedules";
import type { TabEntry } from "../../stores/tabs";
import { Dropdown } from "../common/Dropdown";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import { AgentScheduleDialog } from "./AgentScheduleDialog";
import { PromptCard } from "./PromptCard";
import { PromptChartLinks } from "./PromptChartLinks";

const EMPTY_PROMPTS: ProjectAgentPrompt[] = [];
const EMPTY_HISTORY: SentAgentPrompt[] = [];
const EMPTY_LINKS: ReturnType<typeof useAgentPromptsStore.getState>["linksByProject"][string] = [];
const ZOOMS = [1, 6, 24, 48];
const EMPTY_FILTER: PromptChartFilter = { text: "", tag: "", agent: "", result: "", window: "any" };

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

export function PromptChart({ scope, active, tabs, stateOf }: Props) {
  const t = useT();
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
  const [zoom, setZoom] = useState(6);
  const [filter, setFilter] = useState<PromptChartFilter>(EMPTY_FILTER);
  const [hideOthers, setHideOthers] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<"related" | "after">("related");
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [dialog, setDialog] = useState<{ tab: TabEntry; message?: string } | null>(null);
  const [error, setError] = useState("");
  const [closedOpen, setClosedOpen] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const drag = useRef<{ card: PromptChartCard; pointerId: number } | null>(null);

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
  const matched = useMemo(() => new Set(cards.filter((card) => promptChartCardMatches(card, filter, now)).map((card) => card.key)), [cards, filter, now]);
  const allTags = useMemo(() => tagCounts(cards.map((card) => ({ tags: [...card.tags, ...card.autoTags] }))), [cards]);
  const allAgents = useMemo(() => [...new Set(cards.flatMap((card) => card.autoTags.filter((tag) => tag.startsWith("agent:")).map((tag) => tag.slice(6))))].sort(), [cards]);
  const visible = (card: PromptChartCard) => !hideOthers || matched.has(card.key);

  const strandTab = (strand?: PromptChartStrand) => tabs.find((tab) => tab.scheduleTargetId === strand?.scheduleTargetId);
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
  const pickTab = (card: PromptChartCard, action: "send" | "schedule", targetId?: string) => {
    const tab = tabs.find((item) => item.scheduleTargetId === targetId)
      ?? strandTab(strands.find((strand) => strand.id === card.strandId))
      ?? tabs[0];
    if (!tab) return;
    if (action === "send") void send(card, tab).catch((cause) => setError(String(cause)));
    else setDialog({ tab, message: card.message });
  };
  const retime = async (card: PromptChartCard, at: Date, targetId = card.targetId) => {
    if (!card.schedule || !targetId || card.recurring) return;
    if (targetId !== card.targetId && card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
    await schedules.upsert(scope, targetId, { ...card.schedule, last: undefined, rule: { type: "once", at: localOccurrenceKey(at) } });
  };
  const reorderQueue = async (card: PromptChartCard, stepOrTarget: -1 | 1 | string) => {
    if (!card.schedule || !card.targetId) return;
    const strand = strands.find((item) => item.scheduleTargetId === card.targetId);
    const queue = cards.filter((item) => item.strandId === strand?.id && item.state === "queued" && item.schedule);
    const from = queue.findIndex((item) => item.schedule?.id === card.schedule?.id);
    const to = typeof stepOrTarget === "number"
      ? Math.max(0, Math.min(queue.length - 1, from + stepOrTarget))
      : queue.findIndex((item) => item.id === stepOrTarget || item.schedule?.id === stepOrTarget);
    if (from < 0 || to < 0 || from === to) return;
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

  const ensureLinkEndpoint = async (card: PromptChartCard) => {
    if (card.prompt || card.history) return;
    await upsertPrompt(scope, { id: card.id, message: card.message, tags: card.tags });
  };

  const beginLink = async (card: PromptChartCard) => {
    await ensureLinkEndpoint(card);
    setLinkFrom(card.id);
    setSelected(card.id);
  };

  const linkTo = async (to: PromptChartCard) => {
    if (!linkFrom || linkFrom === to.id) { setLinkFrom(null); return; }
    const source = cards.find((card) => card.id === linkFrom);
    if (source) await ensureLinkEndpoint(source);
    await ensureLinkEndpoint(to);
    const sourceStrand = strands.find((strand) => strand.id === source?.strandId);
    const targetStrand = strands.find((strand) => strand.id === to.strandId);
    await upsertLink(scope, {
      id: crypto.randomUUID(), from: linkFrom, to: to.id, kind: linkKind,
      target: linkKind === "after" ? targetStrand?.scheduleTargetId ?? sourceStrand?.scheduleTargetId : undefined,
    });
    setLinkFrom(null);
  };

  const applyDrop = async (card: PromptChartCard, element: Element, clientY: number) => {
    const queue = element.closest<HTMLElement>("[data-drop-queue]");
    const queueCard = element.closest<HTMLElement>("[data-prompt-card]");
    if (queue && queueCard && card.state === "queued") {
      await reorderQueue(card, queueCard.dataset.promptCard ?? "");
      return;
    }
    const shelf = element.closest<HTMLElement>("[data-drop-shelf]");
    const zone = element.closest<HTMLElement>("[data-drop-target]");
    const action = shelf
      ? promptChartDropAction(card, { kind: "shelf" })
      : zone
        ? promptChartDropAction(card, zone.dataset.dropRegion === "future"
          ? { kind: "strand", targetId: zone.dataset.dropTarget!, at: futureTimeAt(clientY - zone.getBoundingClientRect().top, zone.getBoundingClientRect().height, now, zoom) }
          : { kind: "strand", targetId: zone.dataset.dropTarget!, now: true })
        : { type: "none" as const };
    if (action.type === "send") {
      const tab = tabs.find((item) => item.scheduleTargetId === action.targetId);
      if (tab) await send(card, tab);
    } else if (action.type === "schedule" || action.type === "retime") {
      const tab = tabs.find((item) => item.scheduleTargetId === action.targetId);
      if (!tab) return;
      if (card.schedule) await retime(card, new Date(action.at), action.targetId);
      else await schedules.upsert(scope, action.targetId, { id: card.id, enabled: true, message: card.message, rule: { type: "once", at: action.at } });
    } else if (action.type === "unschedule") {
      if (!card.prompt) await upsertPrompt(scope, { id: crypto.randomUUID(), message: card.message, tags: card.tags });
      if (card.schedule && card.targetId) await schedules.remove(scope, card.targetId, card.schedule.id);
    } else if (action.type === "collect") await collect(card);
  };

  const pointerDown = (card: PromptChartCard) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input, textarea, select")) return;
    drag.current = { card, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    document.querySelectorAll(".agent-prompt-card.is-dragging").forEach((node) => node.classList.remove("is-dragging"));
    drag.current = null;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element) void applyDrop(current.card, element, event.clientY).catch((cause) => setError(String(cause)));
  };

  const renderCard = (card: PromptChartCard, strand?: PromptChartStrand) => {
    if (!visible(card)) return null;
    return (
      <PromptCard
        key={card.key}
        card={card}
        strand={strand}
        matched={matched.has(card.key)}
        selected={selected === card.id}
        linking={!!linkFrom && linkFrom !== card.id}
        register={(node) => {
          if (node) cardNodes.current.set(card.id, node);
          else cardNodes.current.delete(card.id);
        }}
        onPointerDown={card.recurring ? undefined : pointerDown(card)}
        onSelect={() => {
          if (linkFrom && linkFrom !== card.id) void linkTo(card).catch((cause) => setError(String(cause)));
          setSelected(card.id);
        }}
        onSave={(message, tags) => save(card, message, tags)}
        onDelete={() => remove(card)}
        onSend={(targetId) => pickTab(card, "send", targetId)}
        onSchedule={(targetId) => pickTab(card, "schedule", targetId)}
        onUnschedule={() => unschedule(card)}
        onCollect={() => collect(card)}
        onRetime={(minutes) => retime(card, new Date((card.at ?? now).getTime() + minutes * 60_000))}
        onQueueMove={(step) => reorderQueue(card, step)}
        onMove={(targetId) => retime(card, card.at ?? new Date(now.getTime() + 5 * 60_000), targetId)}
        onLink={() => void beginLink(card).catch((cause) => setError(String(cause)))}
        onUnlink={(linkId) => removeLink(scope, linkId).then(() => undefined)}
        links={links}
        strands={strands}
        onGoToTab={strand?.tabKey ? () => jumpToTab(scope, strand.tabKey!) : undefined}
      />
    );
  };

  const strandColumn = (strand: PromptChartStrand) => {
    const own = cards.filter((card) => card.strandId === strand.id);
    const past = own.filter((card) => card.state === "sent");
    const queued = own.filter((card) => card.state === "queued");
    const future = own.filter((card) => card.state === "scheduled" && card.at && card.at.getTime() <= now.getTime() + zoom * 3_600_000);
    const later = own.filter((card) => card.state === "scheduled" && (!card.at || card.at.getTime() > now.getTime() + zoom * 3_600_000));
    const chained = own.filter((card) => card.state === "chained");
    const content = (
      <div className={`agent-prompt-strand${strand.closed ? " is-closed" : ""}`} data-strand={strand.id}>
        <header>
          <strong>{strand.label}</strong>
          {strand.closed ? <span>{t("promptChart.closed")}</span> : <span>{stateOf?.(strandTab(strand)!)}</span>}
          <small>{strand.agent}</small>
        </header>
        <div className="agent-prompt-past" data-drop-target={strand.scheduleTargetId} data-drop-region="now">
          {groupPromptPast(past, now).map((group) => (
            <div key={group.label} className="agent-prompt-past-group"><time>{group.label}</time>{group.cards.map((card) => renderCard(card, strand))}</div>
          ))}
        </div>
        {!strand.closed && <div className="agent-prompt-now" data-drop-target={strand.scheduleTargetId} data-drop-region="now"><span>{t("promptChart.now")}</span></div>}
        {!strand.closed && <div className="agent-prompt-queue" data-drop-queue data-drop-target={strand.scheduleTargetId}>{queued.map((card) => renderCard(card, strand))}</div>}
        {!strand.closed && (
          <div className="agent-prompt-future" data-drop-target={strand.scheduleTargetId} data-drop-region="future">
            {[0, .25, .5, .75, 1].map((part) => <span key={part} className="agent-prompt-tick" style={{ top: `${part * 100}%` }}>{new Date(now.getTime() + part * zoom * 3_600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>)}
            {future.map((card) => <div key={card.key} className="agent-prompt-future-card" style={{ top: `${futureOffsetPercent(card.at!, now, zoom)}%` }}>{renderCard(card, strand)}</div>)}
          </div>
        )}
        {!strand.closed && later.length > 0 && <div className="agent-prompt-later"><small>{t("promptChart.later")}</small>{later.map((card) => renderCard(card, strand))}</div>}
        {!strand.closed && chained.map((card) => renderCard(card, strand))}
      </div>
    );
    if (!strand.closed) return content;
    const open = closedOpen.includes(strand.id);
    return <div key={strand.id} className="agent-prompt-closed-wrap"><button type="button" onClick={() => setClosedOpen((ids) => open ? ids.filter((id) => id !== strand.id) : [...ids, strand.id])}>{open ? "▾" : "▸"} {strand.label} · {past.length}</button>{open && content}</div>;
  };

  return (
    <section className="agent-prompts-section agent-prompt-chart-section" onPointerUp={pointerUp}>
      <h3 className="settings-section-title">{t("promptChart.heading")}</h3>
      <div className="agent-prompt-chart-toolbar">
        <button className="settings-btn sm primary" type="button" aria-label={t("promptChart.newDraft")} onClick={() => setNewOpen((value) => !value)}>＋</button>
        <input type="search" value={filter.text} placeholder={t("promptChart.search")} aria-label={t("promptChart.search")} onChange={(event) => setFilter((value) => ({ ...value, text: event.target.value }))} />
        <Dropdown value={String(zoom)} title={t("promptChart.zoom")} options={ZOOMS.map((hours) => ({ value: String(hours), label: t("promptChart.hours", { count: hours }) }))} onChange={(value) => setZoom(Number(value))} />
        <button className={`agent-composer-chip${hideOthers ? " active" : ""}`} type="button" aria-pressed={hideOthers} onClick={() => setHideOthers((value) => !value)}>{t("promptChart.hideOthers")}</button>
      </div>
      <div className="agent-prompt-chart-facets">
        <Dropdown value={filter.agent} title={t("agentPrompts.filterAgent")} options={[{ value: "", label: t("agentPrompts.filterAgentAll") }, ...allAgents.map((agent) => ({ value: agent, label: agent }))]} onChange={(agent) => setFilter((value) => ({ ...value, agent }))} />
        <Dropdown value={filter.result} title={t("agentPrompts.filterResult")} options={[{ value: "", label: t("agentPrompts.filterResultAll") }, ...["delivered", "queued", "missed", "failed"].map((result) => ({ value: result, label: t(`promptChart.result.${result}` as "promptChart.result.delivered") }))]} onChange={(result) => setFilter((value) => ({ ...value, result }))} />
        <Dropdown value={filter.window} title={t("agentPrompts.filterWindow")} options={["any", "today", "week", "month"].map((window) => ({ value: window, label: t(`agentPrompts.window.${window}` as "agentPrompts.window.any") }))} onChange={(window) => setFilter((value) => ({ ...value, window: window as PromptChartFilter["window"] }))} />
        {linkFrom && <div className="agent-prompt-link-mode"><span>{t("promptChart.pickLink")}</span><button type="button" className={`agent-composer-chip${linkKind === "related" ? " active" : ""}`} onClick={() => setLinkKind("related")}>{t("promptChart.related")}</button><button type="button" className={`agent-composer-chip${linkKind === "after" ? " active" : ""}`} onClick={() => setLinkKind("after")}>{t("promptChart.after")}</button><button type="button" className="agent-composer-chip" onClick={() => setLinkFrom(null)}>{t("common.cancel")}</button></div>}
      </div>
      {allTags.length > 0 && <div className="agent-prompts-tags">{allTags.map(({ tag, count }) => <button key={tag} type="button" className={`agent-composer-chip agent-prompts-tag${filter.tag === tag ? " active" : ""}${tag.includes(":") ? " is-auto" : ""}`} onClick={() => setFilter((value) => ({ ...value, tag: value.tag === tag ? "" : tag }))}>#{tag}<span>{count}</span></button>)}</div>}
      {newOpen && <div className="agent-prompt-new"><MarkdownPromptField rows={4} value={draft} ariaLabel={t("agentPrompts.placeholder")} placeholder={t("agentPrompts.placeholder")} onChange={setDraft} /><input value={draftTags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setDraftTags(event.target.value)} /><button className="settings-btn sm primary" type="button" disabled={!draft.trim()} onClick={() => void upsertPrompt(scope, { id: crypto.randomUUID(), message: draft.trim(), tags: parseTags(draftTags) }).then(() => { setDraft(""); setDraftTags(""); setNewOpen(false); }).catch((cause) => setError(String(cause)))}>{t("agentPrompts.add")}</button></div>}
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="agent-prompt-chart-scroll">
        <div className="agent-prompt-chart" ref={rootRef}>
          <PromptChartLinks rootRef={rootRef} cardNodes={cardNodes} links={links} selectedId={selected} />
          <div className="agent-prompt-shelf" data-drop-shelf>
            <header><strong>{t("promptChart.drafts")}</strong><span>{prompts.length}</span></header>
            {cards.filter((card) => card.strandId === "drafts").map((card) => renderCard(card))}
            {cards.filter((card) => card.strandId === "drafts").length === 0 && <div className="file-tree-empty">{t("promptChart.noDrafts")}</div>}
          </div>
          {liveStrands.map((strand) => <div key={strand.id}>{strandColumn(strand)}</div>)}
        </div>
      </div>
      {closedStrands.length > 0 && <div className="agent-prompt-closed">{closedStrands.map(strandColumn)}</div>}
      {dialog && <AgentScheduleDialog scope={scope} tab={dialog.tab} initialMessage={dialog.message} onClose={() => setDialog(null)} />}
    </section>
  );
}
