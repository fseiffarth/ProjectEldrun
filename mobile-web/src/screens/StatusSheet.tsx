import { useCallback, useEffect, useState } from "react";
import { ApiError, getAgentStatus, type AgentStatusReport, type TabRow } from "../api";
import { noteParts, parseUsageReport, resolveResetAt } from "../../../shared/usageReport";
import type { SessionStatus } from "../terminal/statusLine";

/** Wording for the tab's own state, which the desktop classified from the
 * session's output. `idle` is the honest fourth: the catalog only publishes the
 * other three, and a tab nobody is waiting on is not "done". */
const STATE_TEXT: Record<AgentStatusReport["state"], string> = {
  working: "Working",
  question: "Waiting on you",
  done: "Finished its turn",
  idle: "Idle",
};

/** `4880` → `1h 21m`. Seconds are dropped above a minute: this is a day's
 * rollup, and a second of it is noise. */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `in 5h 12m` to an instant ahead of `now`; empty once it has passed, which is
 * a panel read before its own rollover and not worth a negative countdown. */
function countdown(at: Date, now: Date): string {
  const minutes = Math.floor((at.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return "";
  if (minutes < 1) return "in <1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A window's rollover said exactly: weekday, date and clock in the phone's own
 * locale and timezone, plus how long is left. The CLI's words name a day or a
 * clock depending on its release and the window (`Mon 9am`, `6:20pm`,
 * `Sep 17, 2pm (Europe/Berlin)`) and are written on the desktop's clock, which
 * need not be the phone's. Placed through `resolveResetAt`, the same reading
 * auto-continue arms off, so the two cannot disagree; a phrase it cannot place
 * is shown in the CLI's own words rather than guessed at.
 */
export function resetText(phrase: string, now: Date): string {
  const at = resolveResetAt(phrase, now);
  if (!at) return `resets ${phrase}`;
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at);
  const left = countdown(at, now);
  return left ? `resets ${when} · ${left}` : `resets ${when}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * The composer's status chip: what this agent tab is doing, and what its CLI
 * says about the account behind it.
 *
 * Two views, the same switch the header uses for the session itself.
 * **Formatted** parses the CLI's panel into bars; **Terminal** shows the panel
 * exactly as the CLI printed it. The raw text is always one tap away on
 * purpose — the format belongs to somebody else's CLI, so a release that
 * reshapes it must cost the reader a nicer layout, never the figures.
 *
 * `live` is what the phone already read off the session's own status line
 * (model, mode, context) — free, and about *this* tab, where the quota panel is
 * about the whole account.
 */
export function StatusSheet({ tab, live, onClose }: {
  tab: TabRow;
  live: SessionStatus | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<"formatted" | "terminal">("formatted");
  const [report, setReport] = useState<AgentStatusReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError("");
    try {
      setReport(await getAgentStatus(tab.id, refresh));
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? "Open desktop Eldrun to read this session's status."
        : cause instanceof ApiError && cause.code === "timeout"
          ? "The agent's CLI did not answer in time. Try again."
          : "The status could not be read.");
    } finally {
      setBusy(false);
    }
  }, [tab.id]);

  useEffect(() => { void load(false); }, [load]);

  const usage = report?.usage;
  const panel = usage?.raw ? parseUsageReport(usage.raw) : null;

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet status-sheet" role="dialog" aria-modal="true" aria-label={`Status of ${tab.label}`} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <h2>Status <small>Untested</small></h2>
        <div className="terminal-view-switch" aria-label="Status view">
          <button className={view === "formatted" ? "selected" : ""} aria-pressed={view === "formatted"} onClick={() => setView("formatted")}>Formatted</button>
          <button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => setView("terminal")}>Terminal</button>
        </div>
      </header>

      {report && <p className={`status-headline ${report.state}`}>
        <strong>{STATE_TEXT[report.state]}</strong>
        {report.agent && <span>{report.agent}</span>}
        {live?.model && <span>{live.model}</span>}
        {live?.mode && <span>{live.mode}</span>}
        {live?.context && <span>{live.context} context</span>}
      </p>}

      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {busy && !report && <p className="sheet-note">Reading…</p>}

      {view === "formatted" && report && <>
        {usage?.supported === false && <p className="sheet-note">
          {usage.error ?? `${usage.label} has no usage readout Eldrun can ask for without opening a tab.`}
        </p>}
        {usage?.supported && usage.error && <p className="sheet-note error">{usage.error}</p>}
        {panel && panel.meters.map((meter) => <div className="usage-meter" key={meter.label}>
          <div>
            <strong>{meter.label}</strong>
            <span>{meter.percent}%</span>
          </div>
          <div className="usage-bar" role="img" aria-label={`${meter.label}: ${meter.percent}% used`}>
            <span style={{ width: `${meter.percent}%` }} />
          </div>
          {meter.resets && <small title={`resets ${meter.resets}`}>{resetText(meter.resets, new Date())}</small>}
        </div>)}
        {panel?.unparsed && <p className="sheet-note">
          {usage?.label} answered in a shape Eldrun does not recognize. The Terminal view has all of it.
        </p>}
        {panel && panel.notes.length > 0 && <ul className="usage-notes">
          {panel.notes.map((note, index) => <li key={`${note.label ?? ""}-${index}`}>
            {note.label && <strong>{note.label}</strong>}
            <span>{noteParts(note.value).join(" · ")}</span>
          </li>)}
        </ul>}

        <div className="usage-today">
          <strong>Today in {report.project}</strong>
          <span>{plural(report.today.prompts, "prompt")} to {report.agent ?? "this agent"}</span>
          <small>
            Across every agent tab in this project: {duration(report.today.worked_s)} working
            {" · "}{plural(report.today.decisions, "decision")}
            {" · "}{plural(report.today.done, "turn")} finished
          </small>
        </div>
      </>}

      {view === "terminal" && <pre className="usage-raw" aria-label="Usage panel as the CLI printed it">
        {usage?.raw ?? usage?.error ?? (busy ? "Reading…" : "Nothing was printed.")}
      </pre>}

      <div className="mobile-schedule-actions">
        {usage?.cached && <span className="sheet-pending">Cached</span>}
        <button disabled={busy} onClick={() => void load(true)}>{busy ? "Reading…" : "Refresh"}</button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </section>
  </div>;
}
