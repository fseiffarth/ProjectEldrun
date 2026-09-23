import { type AgentRow } from "../api";
import { isUntested } from "../../../src/lib/untested";
import { useT } from "../../../src/lib/i18n";

/**
 * What the project header's ＋ opens: a shell, or one of the agents this
 * desktop offers, in the modes it offers them in — and, last, a document from
 * this phone into the project's inbox (`useProjectInbox`).
 *
 * These are the buttons that used to stand at the foot of the project screen,
 * under every tab card. The sheet puts a shell action first and keeps the
 * agent choices in a compact grid, with each agent's modes inside its tile.
 *
 * Creating is the caller's: it owns the idempotency keys and the jump into the
 * new session, and the sheet closes on the tap rather than waiting for the
 * desktop, so a slow create is a screen the reader can still read.
 */
export function NewTabSheet({ agents, busy, onPick, onSendFile, onClose }: {
  agents: AgentRow[];
  busy: boolean;
  onPick: (kind: "shell" | "agent", agent?: AgentRow, mode?: string) => void;
  /** Opens the phone's file picker; runs inside the tap, which the picker needs. */
  onSendFile: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet new-tab-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.newTab.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{t("mobile.newTab.title")}{isUntested("mobile.project.newTab") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.newTab.note")}</p>
      <div className="create">
        <button className="primary" disabled={busy} onClick={() => onPick("shell")}>{t("mobile.newTab.shell")}</button>
        <div className="new-tab-agents">{agents.map((agent) => <div className="agent-create" key={agent.id}>
          <button disabled={busy} onClick={() => onPick("agent", agent)}>{agent.label}</button>
          {agent.modes.map((mode) => <button className="mode" disabled={busy} key={mode} onClick={() => onPick("agent", agent, mode)}>{mode}</button>)}
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
    </section>
  </div>;
}
