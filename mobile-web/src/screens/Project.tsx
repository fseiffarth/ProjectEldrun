import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentRow, type ProjectDetail, type TabRow } from "../api";

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow) => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
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
    <section className="cards">{detail?.tabs.map((tab) => <button className="card" disabled={!tab.available} key={tab.id} onClick={() => terminal(tab)}><span><strong>{tab.label}</strong><small>{tab.kind}{tab.viewer_busy ? " · open elsewhere" : tab.available ? " · live" : " · gone"}</small></span><span className="card-trailing">{tab.agent_status && <small className={`agent-status ${tab.agent_status}`}>{tab.agent_status}</small>}<span>›</span></span></button>)}</section>
    {detail?.project.status === "inactive" && <section className="create"><button className="primary" disabled={activating || !detail.desktop_available} onClick={() => void activate()}>Activate project</button></section>}
    <section className="create"><button className="primary" disabled={creating || !detail?.desktop_available} onClick={() => void create("shell")}>New shell</button>
      {detail?.agents.map((agent) => <div className="agent-create" key={agent.id}><button disabled={creating || !detail.desktop_available} onClick={() => void create("agent", agent)}>{agent.label}</button>{agent.modes.map((mode) => <button className="mode" disabled={creating || !detail.desktop_available} key={mode} onClick={() => void create("agent", agent, mode)}>{mode}</button>)}</div>)}
    </section>
  </main>;
}
