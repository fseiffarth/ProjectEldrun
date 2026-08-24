import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentRow, type ProjectDetail, type TabRow } from "../api";

export function Project({ id, back, terminal }: { id: string; back: () => void; terminal: (tab: TabRow) => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const pendingKeys = useRef(new Map<string, string>());
  const load = useCallback(() => void api<ProjectDetail>(`/api/v1/projects/${id}`).then((next) => { setDetail(next); setError(""); }).catch((reason) => { setDetail(null); setError(`Host unavailable: ${String(reason)}`); }), [id]);
  useEffect(load, [load]);
  const create = async (kind: "shell" | "agent", agent?: AgentRow, mode?: string) => {
    setCreating(true); setError("");
    const action = `${kind}:${agent?.id ?? ""}:${mode ?? ""}`;
    const idempotencyKey = pendingKeys.current.get(action) ?? crypto.randomUUID();
    pendingKeys.current.set(action, idempotencyKey);
    try {
      const body = await api<{ tab: TabRow }>(`/api/v1/projects/${id}/tabs`, { method: "POST", body: JSON.stringify({ project_id: id, kind, agent_id: agent?.id, mode, idempotency_key: idempotencyKey }) });
      pendingKeys.current.delete(action);
      terminal(body.tab);
    } catch (reason) { setError(String(reason)); load(); } finally { setCreating(false); }
  };
  return <main className="screen">
    <header><button className="back" onClick={back}>‹</button><h1>{detail?.project.label ?? "Project"}</h1></header>
    {!detail?.desktop_available && <p className="notice">Desktop unavailable — existing sessions can still be opened, but new tabs require Eldrun.</p>}
    {error && <p className="error">{error}</p>}
    <section className="cards">{detail?.tabs.map((tab) => <button className="card" disabled={!tab.available || tab.viewer_busy} key={tab.id} onClick={() => terminal(tab)}><span><strong>{tab.label}</strong><small>{tab.kind}{tab.viewer_busy ? " · in use" : tab.available ? " · live" : " · gone"}</small></span><span>›</span></button>)}</section>
    <section className="create"><button className="primary" disabled={creating || !detail?.desktop_available} onClick={() => void create("shell")}>New shell</button>
      {detail?.agents.map((agent) => <div className="agent-create" key={agent.id}><button disabled={creating || !detail.desktop_available} onClick={() => void create("agent", agent)}>{agent.label}</button>{agent.modes.map((mode) => <button className="mode" disabled={creating || !detail.desktop_available} key={mode} onClick={() => void create("agent", agent, mode)}>{mode}</button>)}</div>)}
    </section>
  </main>;
}
