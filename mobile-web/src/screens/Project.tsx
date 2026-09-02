import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentRow, type ProjectDetail, type TabRow } from "../api";
import { PromptsSheet } from "./PromptsSheet";
import { ScheduleSheet } from "./ScheduleSheet";

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
  const pendingKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const load = useCallback(() => {
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    return api<ProjectDetail>(`/api/v1/projects/${id}`)
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
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${id}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, idempotency_key: idempotencyKey }) });
      pendingKeys.current.delete(action);
      terminal(body.tab);
    } catch (reason) { setError(String(reason)); void load(); } finally { setCreating(false); }
  };
  const activate = async () => {
    setActivating(true); setError("");
    try {
      await api(`/api/v1/projects/${id}/activate`, { method: "POST" });
      void load();
    } catch (reason) { setError(String(reason)); void load(); } finally { setActivating(false); }
  };
  return <main className="screen">
    <header><button className="back" onClick={back}>‹</button><h1>{detail?.project.label ?? "Project"}</h1></header>
    {!detail?.desktop_available && <p className="notice">Desktop unavailable — existing sessions can still be opened, but activating a project and creating tabs require Eldrun.</p>}
    {error && <p className="error">{error}</p>}
    <section className="cards">{detail?.tabs.map((tab) => <div className="card-row" key={tab.id}>
      <button className="card" disabled={!tab.available} onClick={() => terminal(tab)}><span><strong>{tab.label}</strong><small>{tab.kind}{tab.viewer_busy ? " · open elsewhere" : tab.available ? " · live" : " · gone"}</small></span><span className="card-trailing">{tab.agent_status && <small className={`agent-status ${tab.agent_status}`}>{tab.agent_status}</small>}<span>›</span></span></button>
      {tab.kind === "agent" && <button className="card-schedule" onClick={() => setScheduleTab({ tab })} aria-haspopup="dialog" aria-expanded={scheduleTab?.tab.id === tab.id} aria-label={`Scheduled prompts for ${tab.label}`} title="Scheduled prompts">◷</button>}
    </div>)}</section>
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating || !detail.desktop_available} onClick={() => void activate()}>Activate project</button></section>}
    <section className="create"><button disabled={!detail} onClick={() => setPromptsOpen(true)} aria-haspopup="dialog" aria-expanded={promptsOpen}>◷ Collected prompts</button></section>
    <section className="create"><button className="primary" disabled={creating || !detail?.desktop_available} onClick={() => void create("shell")}>New shell</button>
      {detail?.agents.map((agent) => <div className="agent-create" key={agent.id}><button disabled={creating || !detail.desktop_available} onClick={() => void create("agent", agent)}>{agent.label}</button>{agent.modes.map((mode) => <button className="mode" disabled={creating || !detail.desktop_available} key={mode} onClick={() => void create("agent", agent, mode)}>{mode}</button>)}</div>)}
    </section>
    {promptsOpen && detail && <PromptsSheet projectId={id} tabs={detail.tabs} onClose={() => setPromptsOpen(false)} onSchedule={(tab, initialMessage) => { setPromptsOpen(false); setScheduleTab({ tab, initialMessage }); }} />}
    {scheduleTab && <ScheduleSheet tabId={scheduleTab.tab.id} label={scheduleTab.tab.label} initialMessage={scheduleTab.initialMessage} onClose={() => setScheduleTab(null)} />}
  </main>;
}
