import { useEffect, useState } from "react";
import { getLaunchOptions, type AgentRow, type CloudLaunchRow, type LaunchOptions } from "../api";
import { isUntested } from "../../../src/lib/untested";
import { useT } from "../../../src/lib/i18n";

/** How the tap wants the agent started, beyond which agent and mode. */
export interface NewTabLaunch {
  /** A linked worktree's opaque id; absent → the project folder. */
  worktree?: string;
  cloud?: "new" | "open";
  task?: string;
}

/**
 * What the project header's ＋ opens: a shell, or one of the agents this
 * desktop offers, in the modes it offers them in — and, last, a document from
 * this phone into the project's inbox (`useProjectInbox`).
 *
 * These are the buttons that used to stand at the foot of the project screen,
 * under every tab card. The sheet puts a shell action first and keeps the
 * agent choices in a compact grid, with each agent's modes inside its tile.
 *
 * Where an agent starts is the desktop "+"'s question too: a project with
 * linked worktrees gets an "Agents start in" row, and an agent with a cloud
 * session gets ☁ buttons in its tile (`src/lib/agents/cloudSessions.ts`). Both
 * come from `launch-options`, asked once the sheet opens; until it answers, the
 * sheet is the plain one. A ☁ New for a CLI that takes its task on the command
 * line swaps the grid for a task box first.
 *
 * Creating is the caller's: it owns the idempotency keys and the jump into the
 * new session, and the sheet closes on the tap rather than waiting for the
 * desktop, so a slow create is a screen the reader can still read.
 */
export function NewTabSheet({ projectId, agents, busy, onPick, onSendFile, onClose }: {
  projectId: string;
  agents: AgentRow[];
  busy: boolean;
  onPick: (kind: "shell" | "agent", agent?: AgentRow, mode?: string, launch?: NewTabLaunch) => void;
  /** Opens the phone's file picker; runs inside the tap, which the picker needs. */
  onSendFile: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<LaunchOptions>({ worktrees: [], cloud: [] });
  /** The picked worktree's id; "" is the project folder. */
  const [where, setWhere] = useState("");
  /** The ☁ New waiting on its task. */
  const [asking, setAsking] = useState<{ agent: AgentRow; launch: CloudLaunchRow } | null>(null);
  const [task, setTask] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    getLaunchOptions(projectId, abort.signal).then(setOptions, () => { /* plain sheet */ });
    return () => abort.abort();
  }, [projectId]);
  const linked = options.worktrees.filter((row) => !row.main);
  const pickAgent = (agent: AgentRow, mode?: string) =>
    onPick("agent", agent, mode, where ? { worktree: where } : undefined);
  const pickCloud = (agent: AgentRow, launch: CloudLaunchRow) => {
    if (launch.task) { setTask(""); setAsking({ agent, launch }); return; }
    onPick("agent", agent, undefined, { cloud: launch.action });
  };
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet new-tab-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.newTab.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{t("mobile.newTab.title")}{isUntested("mobile.project.newTab") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {asking ? <div className="mobile-schedule-form">
        <h3>{t("mobile.newTab.cloudTaskTitle", { agent: asking.agent.label })}{isUntested("mobile.newTab.cloud") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h3>
        <p className="sheet-note">{t("mobile.newTab.cloudTaskHint")}</p>
        <textarea rows={4} maxLength={4000} value={task} autoFocus aria-label={t("mobile.newTab.cloudTaskTitle", { agent: asking.agent.label })} onChange={(event) => setTask(event.target.value)} />
        <div className="mobile-schedule-actions">
          <button onClick={() => setAsking(null)}>{t("mobile.newTab.cloudTaskCancel")}</button>
          <button className="primary" disabled={busy || !task.trim()} onClick={() => onPick("agent", asking.agent, undefined, { cloud: asking.launch.action, task: task.trim() })}>{t("mobile.newTab.cloudTaskStart")}</button>
        </div>
      </div> : <>
      <p className="sheet-note">{t("mobile.newTab.note")}</p>
      <div className="create">
        <button className="primary" disabled={busy} onClick={() => onPick("shell")}>{t("mobile.newTab.shell")}</button>
        {linked.length > 0 && agents.length > 0 && <div className="new-tab-where" role="group" aria-label={t("mobile.newTab.where")}>
          <small>{t("mobile.newTab.where")}{isUntested("mobile.newTab.worktree") && <span className="untested">{t("mobile.newTab.untested")}</span>}</small>
          <button className={where === "" ? "selected" : ""} aria-pressed={where === ""} onClick={() => setWhere("")}>{t("mobile.newTab.projectFolder")}</button>
          {linked.map((row) => <button key={row.id} className={where === row.id ? "selected" : ""} aria-pressed={where === row.id} title={row.label} onClick={() => setWhere(row.id)}>{row.branch || row.label}</button>)}
        </div>}
        <div className="new-tab-agents">{agents.map((agent) => <div className="agent-create" key={agent.id}>
          <button disabled={busy} onClick={() => pickAgent(agent)}>{agent.label}</button>
          {agent.modes.map((mode) => <button className="mode" disabled={busy} key={mode} onClick={() => pickAgent(agent, mode)}>{mode}</button>)}
          {options.cloud.filter((launch) => launch.agent_id === agent.id).map((launch) => <button className="mode" disabled={busy} key={`cloud:${launch.action}`} onClick={() => pickCloud(agent, launch)}>{t(launch.action === "new" ? "mobile.newTab.cloudNew" : "mobile.newTab.cloudOpen")}</button>)}
        </div>)}</div>
        {/* A desktop that reports no agents still opens shells — say so, rather
            than leaving the sheet looking half-loaded. */}
        {agents.length === 0 && <p className="sheet-note">{t("mobile.newTab.noAgents")}</p>}
        {/* No desktop round trip: the sidecar writes the file itself, so this
            is not held back while a create is in flight. */}
        <button className="new-tab-file" onClick={onSendFile}>
          <span><strong>{t("mobile.projectInbox.send")}{isUntested("mobile.project.sendFile") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{t("mobile.projectInbox.hint")}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
        </button>
      </div>
      </>}
    </section>
  </div>;
}
