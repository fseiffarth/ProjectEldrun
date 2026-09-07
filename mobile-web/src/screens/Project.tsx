import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentRow, type ProjectDetail, type TabRow, type TabSchedules } from "../api";
import { CloseSheet } from "./CloseSheet";
import { PromptsSheet } from "./PromptsSheet";
import { RenameSheet } from "./RenameSheet";
import { ScheduleSheet } from "./ScheduleSheet";

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
  /** The tab whose ✕ was pressed. The sheet asks before anything is closed: the
   *  button sits a thumb-width from the one that opens the terminal, and the
   *  answer is worth reading — closing leaves the session running. */
  const [closeTab, setCloseTab] = useState<TabRow | null>(null);
  const pendingKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const load = useCallback(() => {
    if (inFlight.current) return Promise.resolve();
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
    setCloseTab(null);
    setDetail((prev) => prev ? { ...prev, tabs: prev.tabs.filter((row) => row.id !== id) } : prev);
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
    <section className="cards">{detail?.tabs.map((tab) => <div className="tab-card" key={tab.id}>
      <button className="card" disabled={!tab.available} onClick={() => terminal(tab)}><span><strong>{tab.label}</strong><small>{tab.kind}{tab.agent_model ? ` · ${tab.agent_model}` : ""}{tab.viewer_busy ? " · open elsewhere" : tab.available ? " · live" : " · gone"}</small></span><span className="card-trailing">{tab.agent_status && <small className={`agent-status ${tab.agent_status}`}>{tab.agent_status}</small>}<span>›</span></span></button>
      {/* Scheduling lives out here beside the tab, not inside the session:
          reaching a schedule must not mean attaching a terminal, and this is
          the same place — and the same summary line — the desktop puts it. */}
      {/* Closing is offered on every tab the phone lists, shell included; the
          schedule line and its two sheets stay agent-only, so a shell card's
          foot is the actions alone (the empty spacer keeps them right-aligned
          under both kinds of card). */}
      <div className="tab-card-foot">
        {tab.kind === "agent"
          ? <small className="tab-card-when" title={tab.schedules?.next ? `Next run ${tab.schedules.next.replace("T", " ")} (desktop time)` : undefined}>◷ {scheduleLine(tab.schedules)}</small>
          : <small className="tab-card-when" aria-hidden="true" />}
        <div className="tab-card-actions">
          {tab.kind === "agent" && <>
            <button className="card-action" onClick={() => setRenameTab(tab)} aria-haspopup="dialog" aria-expanded={renameTab?.id === tab.id} aria-label={`Rename ${tab.label}`}>✎ Rename</button>
            <button className="card-action accent" onClick={() => setScheduleTab({ tab })} aria-haspopup="dialog" aria-expanded={scheduleTab?.tab.id === tab.id} aria-label={`Scheduled prompts for ${tab.label}`}>◷ Schedules</button>
          </>}
          <button className="card-action danger" onClick={() => setCloseTab(tab)} aria-haspopup="dialog" aria-expanded={closeTab?.id === tab.id} aria-label={`Close ${tab.label}`}>✕ Close</button>
        </div>
      </div>
    </div>)}</section>
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating || !detail.desktop_available} onClick={() => void activate()}>Activate project</button></section>}
    <section className="create"><button disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ Collected prompts</button></section>
    <section className="create"><button className="primary" disabled={creating || !detail?.desktop_available} onClick={() => void create("shell")}>New shell</button>
      {detail?.agents.map((agent) => <div className="agent-create" key={agent.id}><button disabled={creating || !detail.desktop_available} onClick={() => void create("agent", agent)}>{agent.label}</button>{agent.modes.map((mode) => <button className="mode" disabled={creating || !detail.desktop_available} key={mode} onClick={() => void create("agent", agent, mode)}>{mode}</button>)}</div>)}
    </section>
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={(tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); }} />}
    {closeTab && <CloseSheet tab={closeTab} onClose={() => setCloseTab(null)} onClosed={() => dropTab(closeTab.id)} />}
    {renameTab && <RenameSheet tab={renameTab} onClose={() => setRenameTab(null)} onRenamed={() => { setRenameTab(null); void load(); }} />}
    {scheduleTab && <ScheduleSheet tabId={scheduleTab.tab.id} label={scheduleTab.tab.label} initialMessage={scheduleTab.initialMessage} onClose={() => setScheduleTab(null)} />}
  </main>;
}
