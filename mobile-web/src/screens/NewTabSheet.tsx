import { type AgentRow } from "../api";
import { isUntested } from "../../../src/lib/untested";

/**
 * What the project header's ＋ opens: a shell, or one of the agents this
 * desktop offers, in the modes it offers them in.
 *
 * These are the buttons that used to stand at the foot of the project screen,
 * under every tab card. A project with five tabs and three agents put them a
 * full screen's scroll away from the thing that opens them, and the reader who
 * wants a new session is the reader who has just looked at the cards and found
 * none that fits. The sheet keeps the rows exactly as they read down there —
 * the agent's name taking the line, its modes beside it (`agent-create`) — and
 * moves them under the thumb.
 *
 * Creating is the caller's: it owns the idempotency keys and the jump into the
 * new session, and the sheet closes on the tap rather than waiting for the
 * desktop, so a slow create is a screen the reader can still read.
 */
export function NewTabSheet({ agents, busy, onPick, onClose }: {
  agents: AgentRow[];
  busy: boolean;
  onPick: (kind: "shell" | "agent", agent?: AgentRow, mode?: string) => void;
  onClose: () => void;
}) {
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet new-tab-sheet" role="dialog" aria-modal="true" aria-label="New tab" onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>New tab{isUntested("mobile.project.newTab") && <small>Untested</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">The tab opens in the desktop's Eldrun window, and this phone attaches to it.</p>
      <div className="create">
        <button className="primary" disabled={busy} onClick={() => onPick("shell")}>New shell</button>
        {agents.map((agent) => <div className="agent-create" key={agent.id}>
          <button disabled={busy} onClick={() => onPick("agent", agent)}>{agent.label}</button>
          {agent.modes.map((mode) => <button className="mode" disabled={busy} key={mode} onClick={() => onPick("agent", agent, mode)}>{mode}</button>)}
        </div>)}
        {/* A desktop that reports no agents still opens shells — say so, rather
            than leaving the sheet looking half-loaded. */}
        {agents.length === 0 && <p className="sheet-note">No agents are configured on the desktop, so a shell is what this project can open.</p>}
      </div>
    </section>
  </div>;
}
