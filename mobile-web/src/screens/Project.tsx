import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SORTS, DEFAULT_AGENT_SORT, isAgentSort, sortAgentTabs, type AgentSort } from "../../../shared/agentSort";
import { promptClock, promptLines, promptsFromTranscript } from "../agentPrompts";
import { ApiError, api, closeTab, reorderTab, type AgentRow, type ProjectDetail, type TabPlace, type TabRow, type TabSchedules } from "../api";
import { readChoice, writeChoice } from "../prefs";
import { applyServerOrder, dropSlot, placeBeside, type RowBox } from "../tabReorder";
import { ColorSheet } from "./ColorSheet";
import { PromptsSheet } from "./PromptsSheet";
import { RenameSheet } from "./RenameSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { AgentStatusPill } from "../components/AgentStatusPill";
import { tabColorCss } from "../tabColors";

/** The orders this list offers, in the words this screen can use for them. The
 * cross-project Agents list calls `native` "Status", because there the arrival
 * order is the sidecar's status ranking; here it is the desktop's own tab
 * order, which is the thing a reader arranges by hand — so here it is
 * "Manual", and it is the only order a drag can be dropped into. */
const SORT_LABEL: Record<AgentSort, string> = {
  lastWorking: "Last working",
  lastDone: "Last done",
  native: "Manual (tab order)",
};

/** How close to the top or bottom edge a dragged row must come before the
 * screen starts scrolling under it, and how far it scrolls per frame. Without
 * this a list longer than the screen could only be rearranged within the part
 * of it the finger could reach. */
const EDGE_MARGIN = 84;
const EDGE_STEP = 12;

/** The line under an agent tab, in the words the desktop's Agents view uses:
 * how many prompts are scheduled and when the first one fires. The desktop
 * computed both against its own clock, so the phone only formats them. */
function scheduleLine(schedules: TabSchedules | undefined): string {
  if (!schedules) return "Schedules need desktop Eldrun";
  if (schedules.total === 0) return "No scheduled prompts";
  const count = schedules.enabled === schedules.total
    ? `${schedules.total} scheduled`
    : `${schedules.enabled} of ${schedules.total} scheduled`;
  // Desktop-local wall clock, year trimmed: the sheet below spells out the
  // time zone this belongs to.
  return `${count} · ${schedules.next ? `next ${schedules.next.slice(5).replace("T", " ")}` : "no next run"}`;
}

/**
 * What this session was last asked, on the card itself.
 *
 * Always open, and never a disclosure: the question a project screen is opened
 * with is "which of these five tabs is the one I set on the docs" — a label
 * like "claude 3" cannot answer it, and an expander answers it one tap at a
 * time. The newest prompt leads and is given room to wrap; the ones behind it
 * are one line each, enough to recognize a session by its recent history
 * without turning the card into a transcript (the Focus view is that).
 */
function PromptLines({ tab }: { tab: TabRow }) {
  const lines = promptLines(tab);
  return <div className="tab-card-prompts">
    <small className="tab-card-prompts-label">Last prompts <span className="untested">Untested</span></small>
    {lines.length === 0
      ? <p className="tab-card-prompt empty">{promptsFromTranscript(tab)
        ? "Nothing read from this session's transcript yet."
        : "OpenCode's own history is not read yet — prompts sent from Eldrun show here."}</p>
      : lines.map((prompt, index) => {
        const when = promptClock(prompt.at);
        return <p className={index === 0 ? "tab-card-prompt latest" : "tab-card-prompt"} key={`${prompt.at ?? ""}-${index}`}>
          {when && <span className="tab-card-prompt-when">{when}</span>}
          <span className="tab-card-prompt-text">{prompt.text}</span>
        </p>;
      })}
  </div>;
}

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow) => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  /** The agent tab whose scheduled prompts are open. Lives on this screen so a
   * schedule can be set without attaching to the session at all. */
  const [scheduleTab, setScheduleTab] = useState<{ tab: TabRow; initialMessage?: string } | null>(null);
  /** The project's collected prompts (no tab); "Schedule…" there hands a
   * prompt to the per-tab sheet above with the text prefilled. */
  const [promptsOpen, setPromptsOpen] = useState(false);
  /** The agent tab being renamed. The desktop owns the tab layout, so the sheet
   * writes through the bridge and the next poll brings the new label back. */
  const [renameTab, setRenameTab] = useState<TabRow | null>(null);
  /** The tab whose colour is being picked (#264), of any kind the phone lists —
   * colouring is how a row of look-alike sessions is told apart, which is as
   * true of five shells as of five agents. */
  const [colorTab, setColorTab] = useState<TabRow | null>(null);
  /** The tab whose ✕ was pressed. The sheet asks before anything is closed: the
   *  button sits a thumb-width from the one that opens the terminal, and the
   *  answer is worth reading — closing leaves the session running. */
  /** The tab whose close is in flight — its ✕ is held until the desktop answers. */
  const [closingId, setClosingId] = useState<string | null>(null);
  /** The reader's order for this project's tabs, kept on the phone. The
   * default is the desktop Agents view's, by the same shared function: a tab
   * asking something, then the ones working now, then the rest by their last
   * finished turn. A shell (or an agent with no turn this session) has no
   * reading and sinks, keeping the tab bar's order among its kind. */
  const [sort, setSort] = useState<AgentSort>(() => readChoice("projectTabsSort", isAgentSort, DEFAULT_AGENT_SORT));
  const chooseSort = (next: AgentSort) => { setSort(next); writeChoice("projectTabsSort", next); };
  const tabs = useMemo(() => sortAgentTabs(detail?.tabs ?? [], sort, (tab) => ({
    decision: tab.agent_status === "question",
    working: tab.agent_status === "working",
    workingAt: tab.working_at,
    doneAt: tab.done_at,
  })), [detail?.tabs, sort]);
  /** Rearranging by hand is offered under the manual order alone. The other two
   * are computed from what the agents did, so a dropped row would spring back
   * the next time one of them worked — the same rule the desktop's own drag
   * follows. */
  const canReorder = sort === "native" && tabs.length > 1;
  const pendingKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  /** A move the desktop has not answered yet. The poll is paused across it: the
   * list is already showing where the row was dropped, and a reply carrying the
   * pre-drop order would yank it back for a second. */
  const moving = useRef(false);
  const load = useCallback(() => {
    if (inFlight.current || moving.current) return Promise.resolve();
    inFlight.current = true;
    return api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`)
      .then((next) => { setDetail(next); setError(""); })
      // Keep the last good view rather than blanking the tab list: on a poll
      // this fast, one dropped packet used to wipe the screen and flash the
      // "Desktop unavailable" notice on every flaky-signal hiccup.
      .catch((reason) => setError(`Host unavailable: ${String(reason)}`))
      .finally(() => { inFlight.current = false; });
  }, [id]);
  useEffect(() => {
    // A 1.5s poll is a full catalog load plus a desktop round trip, 40 times a
    // minute, and it ran while the phone's screen was off.
    let timer = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load();
    };
    void load();
    timer = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);
  const create = async (kind: "shell" | "agent", agent?: AgentRow, mode?: string) => {
    setCreating(true); setError("");
    const action = `${kind}:${agent?.id ?? ""}:${mode ?? ""}`;
    const idempotencyKey = pendingKeys.current.get(action) ?? crypto.randomUUID();
    pendingKeys.current.set(action, idempotencyKey);
    try {
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${encodeURIComponent(id)}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, idempotency_key: idempotencyKey }) });
      pendingKeys.current.delete(action);
      terminal(body.tab);
    } catch (reason) { setError(String(reason)); void load(); } finally { setCreating(false); }
  };
  /** Drop the row here rather than reloading: the desktop persists its tab
   *  layout asynchronously, so the next catalog read can still be carrying the
   *  tab that was just closed, and the row would flicker back. */
  const dropTab = (id: string) => {
    setDetail((prev) => prev ? { ...prev, tabs: prev.tabs.filter((row) => row.id !== id) } : prev);
  };
  /** Close on the tap, as the desktop's × does — no sheet in between. It is the
   *  same act on both surfaces, through the same desktop seam: the tab leaves
   *  the Eldrun window and the local tmux session it minted ends with it (a
   *  session on a remote host keeps running). */
  const close = async (tab: TabRow) => {
    setClosingId(tab.id);
    setError("");
    try {
      await closeTab(tab.id);
      dropTab(tab.id);
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to close a tab."
        : "The tab could not be closed.");
    } finally {
      setClosingId(null);
    }
  };
  /** The cards' rectangles, in the order they are listed — what a drop position
   * is read off. Taken at the moment it is needed rather than kept, because the
   * page scrolls under the finger while the drag is running. */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const rowBoxes = (): RowBox[] => tabs.flatMap((tab) => {
    const rect = rowRefs.current.get(tab.id)?.getBoundingClientRect();
    return rect ? [{ id: tab.id, top: rect.top, bottom: rect.bottom }] : [];
  });
  /** The row under the finger and the slot it would land in, for the moved
   *  card's own styling and the line drawn on the card it is being dropped
   *  beside. */
  const [drag, setDrag] = useState<{ key: string; slot: { anchor: string; place: TabPlace } | null } | null>(null);

  /** Move one tab beside another and tell the desktop, which owns the layout
   *  this order is. The list is rearranged first — a drop that waits for a
   *  round trip before it moves anything reads as a dropped gesture — and then
   *  reconciled with the order the desktop answers with; a refused move puts
   *  the row back where it was and says why. */
  const commitMove = async (key: string, anchorId: string, place: TabPlace) => {
    const before = (detail?.tabs ?? []).map((row) => row.id);
    setDetail((prev) => prev ? { ...prev, tabs: placeBeside(prev.tabs, (row) => row.id, key, anchorId, place) } : prev);
    moving.current = true;
    setError("");
    try {
      const answer = await reorderTab(key, anchorId, place);
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, answer.tabs ?? []) } : prev);
    } catch (cause) {
      setDetail((prev) => prev ? { ...prev, tabs: applyServerOrder(prev.tabs, (row) => row.id, before) } : prev);
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to rearrange tabs."
        : "The tab could not be moved.");
    } finally {
      moving.current = false;
    }
  };

  /** Drag one card by its grip. Pointer-driven and captured to the grip, so the
   *  gesture cannot be stolen by the page's own scrolling (the grip also sets
   *  `touch-action:none`), and the page scrolls itself when the finger reaches
   *  either edge — a list of ten tabs is taller than the phone. */
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (!canReorder || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let pointerY = event.clientY;
    let slot = dropSlot(rowBoxes(), key, pointerY);
    let frame = 0;
    const track = () => { slot = dropSlot(rowBoxes(), key, pointerY); setDrag({ key, slot }); };
    const edgeScroll = () => {
      frame = 0;
      const dy = pointerY < EDGE_MARGIN ? -EDGE_STEP : pointerY > window.innerHeight - EDGE_MARGIN ? EDGE_STEP : 0;
      if (!dy) return;
      window.scrollBy(0, dy);
      track();
      frame = requestAnimationFrame(edgeScroll);
    };
    const onMove = (move: PointerEvent) => {
      pointerY = move.clientY;
      track();
      if (!frame) edgeScroll();
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      if (frame) cancelAnimationFrame(frame);
      setDrag(null);
      if (commit && slot) void commitMove(key, slot.anchor, slot.place);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    setDrag({ key, slot });
  };

  /** The same move, one step at a time, from the grip's arrow keys — a drag is
   *  not reachable by a keyboard or a screen reader, and this list is also read
   *  on a tablet with one attached. */
  const nudge = (key: string, delta: -1 | 1) => {
    const index = tabs.findIndex((row) => row.id === key);
    const target = tabs[index + delta];
    if (index < 0 || !target) return;
    void commitMove(key, target.id, delta < 0 ? "before" : "after");
  };

  const activate = async () => {
    setActivating(true); setError("");
    try {
      await api(`/api/v1/projects/${encodeURIComponent(id)}/activate`, { method: "POST" });
      void load();
    } catch (reason) { setError(String(reason)); void load(); } finally { setActivating(false); }
  };
  return <main className="screen">
    <header><button className="back" onClick={back}>‹</button><h1>{detail?.project.label ?? "Project"}</h1></header>
    {/* Only once the host has answered: `!detail?.desktop_available` was also
        true while the first load was in flight, so every project opened on a
        "Desktop unavailable" notice that vanished a moment later. */}
    {detail && !detail.desktop_available && <p className="notice">Desktop unavailable — existing sessions can still be opened, but activating a project and creating tabs require Eldrun.</p>}
    {error && <p className="error">{error}</p>}
    {/* The same three orders the desktop Agents view offers, remembered per
        phone. "Manual" is this screen's name for the arrival order, because
        here that order is the desktop's own tab order — the one a drag writes
        into. */}
    {tabs.length > 1 && <label className="activity-sort">
      <span>Sort</span>
      <select aria-label="Sort tabs" value={sort} onChange={(event) => { if (isAgentSort(event.target.value)) chooseSort(event.target.value); }}>
        {AGENT_SORTS.map((value) => <option key={value} value={value}>{SORT_LABEL[value]}</option>)}
      </select>
    </label>}
    {canReorder && <p className="reorder-hint">Drag <span aria-hidden="true">⠿</span> to arrange — this is the desktop's own tab order, so the Eldrun window follows. <span className="untested">Untested</span></p>}
    <section className="cards">{tabs.map((tab) => <div
      className={`tab-card${tabColorCss(tab.color) ? " has-tab-color" : ""}${drag?.key === tab.id ? " dragging" : ""}${drag?.slot?.anchor === tab.id ? ` drop-${drag.slot.place}` : ""}`}
      key={tab.id}
      ref={(node) => { if (node) rowRefs.current.set(tab.id, node); else rowRefs.current.delete(tab.id); }}
      // The desktop marks a coloured tab with its bottom rule; a phone card has
      // no such edge to spend, so the colour becomes the card's left border —
      // the same "which of these five is which" job, in the shape this surface
      // has. The id→hex mapping is the desktop's (see `tabColors.ts`), so the
      // two surfaces show one colour rather than two readings of a name.
      style={tabColorCss(tab.color) ? { ["--tab-color" as string]: tabColorCss(tab.color) } : undefined}
    >
      <div className="tab-card-head">
      {/* The colour chooser is the dot in the card's upper-left corner: it
          shows the tab's colour (a hollow ring when it has none) and opens the
          sheet, so the foot keeps its width for the worded actions. */}
      <button className="tab-card-dot" onClick={() => setColorTab(tab)} aria-haspopup="dialog" aria-expanded={colorTab?.id === tab.id} aria-label={`Colour ${tab.label}`}><span aria-hidden="true" /></button>
      {/* The card opens the session; on an agent tab its name renames it.
          A button cannot hold a button, so the opener is a sibling stretched
          over the whole card and the name sits above it. The line under the
          name says which agent runs here — the registry's name for its CLI,
          which a renamed tab's label no longer does. */}
      <div className={`card tab-card-main${tab.available ? "" : " unavailable"}`}>
        <span>
          {tab.kind === "agent"
            ? <button className="tab-card-name" onClick={() => setRenameTab(tab)} aria-haspopup="dialog" aria-expanded={renameTab?.id === tab.id} aria-label={`Rename ${tab.label}`} title="Rename"><strong>{tab.label}</strong></button>
            : <strong>{tab.label}</strong>}
          <small>{tab.kind === "agent" ? tab.agent_label ?? "agent" : tab.kind}{tab.agent_model ? ` · ${tab.agent_model}` : ""}{tab.viewer_busy ? " · open elsewhere" : tab.available ? " · live" : " · gone"}</small>
        </span>
        <span className="card-trailing">{tab.agent_status && <AgentStatusPill status={tab.agent_status} />}<span>›</span></span>
        <button className="tab-card-open" disabled={!tab.available} onClick={() => terminal(tab)} aria-label={`Open ${tab.label}`} />
      </div>
      {/* Close is the card's top-right ✕, where a phone looks for it; every tab
          the phone lists offers it, shell included. */}
      <button className="tab-card-icon tab-card-close" disabled={closingId !== null} onClick={() => void close(tab)} aria-label={`Close ${tab.label}`} title="Close"><span aria-hidden="true">✕</span></button>
      {/* The grip, under the manual order only. It is also the keyboard's way
          in: the arrows move the tab one place, which a drag cannot be asked
          for without a finger. */}
      {canReorder && <button
        className="tab-card-grip"
        aria-label={`Move ${tab.label}`}
        title="Drag to move this tab, or use the arrow keys"
        onPointerDown={(event) => startDrag(event, tab.id)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          nudge(tab.id, event.key === "ArrowUp" ? -1 : 1);
        }}
      ><span aria-hidden="true">⠿</span></button>}
      </div>
      {tab.kind === "agent" && <PromptLines tab={tab} />}
      {/* Scheduling lives out here beside the tab, not inside the session:
          reaching a schedule must not mean attaching a terminal, and this is
          the same place — and the same summary line — the desktop puts it.
          The ◷ leading the line opens the tab's schedules; agent tabs only. */}
      {tab.kind === "agent" && <div className="tab-card-foot">
        <button className="tab-card-icon accent" onClick={() => setScheduleTab({ tab })} aria-haspopup="dialog" aria-expanded={scheduleTab?.tab.id === tab.id} aria-label={`Scheduled prompts for ${tab.label}`} title="Scheduled prompts"><span aria-hidden="true">◷</span></button>
        <small className="tab-card-when" title={tab.schedules?.next ? `Next run ${tab.schedules.next.replace("T", " ")} (desktop time)` : undefined}>{scheduleLine(tab.schedules)}</small>
      </div>}
    </div>)}</section>
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating || !detail.desktop_available} onClick={() => void activate()}>Activate project</button></section>}
    <section className="create"><button disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ Collected prompts</button></section>
    <section className="create"><button className="primary" disabled={creating || !detail?.desktop_available} onClick={() => void create("shell")}>New shell</button>
      {detail?.agents.map((agent) => <div className="agent-create" key={agent.id}><button disabled={creating || !detail.desktop_available} onClick={() => void create("agent", agent)}>{agent.label}</button>{agent.modes.map((mode) => <button className="mode" disabled={creating || !detail.desktop_available} key={mode} onClick={() => void create("agent", agent, mode)}>{mode}</button>)}</div>)}
    </section>
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={(tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); }} />}
    {colorTab && <ColorSheet
      tab={colorTab}
      onClose={() => setColorTab(null)}
      onColored={(color) => {
        // Patch the row in place rather than reloading. The desktop persists its
        // tab layout asynchronously, so the next catalog read can still carry
        // the old colour and the card would flicker back — the same reason
        // `dropTab` above patches instead of reloading after a close.
        setColorTab((prev) => prev ? { ...prev, color } : prev);
        setDetail((prev) => prev
          ? { ...prev, tabs: prev.tabs.map((row) => row.id === colorTab.id ? { ...row, color } : row) }
          : prev);
      }}
    />}
    {renameTab && <RenameSheet tab={renameTab} onClose={() => setRenameTab(null)} onRenamed={() => { setRenameTab(null); void load(); }} />}
    {scheduleTab && <ScheduleSheet tabId={scheduleTab.tab.id} label={scheduleTab.tab.label} initialMessage={scheduleTab.initialMessage} onClose={() => setScheduleTab(null)} />}
  </main>;
}
