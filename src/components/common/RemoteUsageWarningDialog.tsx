import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteUsageStore, type RemoteUsageReport } from "../../stores/remoteUsage";

/**
 * Reports a remote project's host usage right after connecting — CPU/load,
 * memory, GPU, logged-in sessions and top processes (see `services::remote_usage`
 * for the probe). It is **not** a verdict: the dialog is shown on *every*
 * connect regardless of whether the backend's `busy` heuristic tripped, so the
 * user reads the current usage and decides for themselves whether to proceed.
 * `report.busy`/`report.reasons` are surfaced as extra context (a "may be in
 * use" hint) but never gate the popup. Note the one known false positive the
 * hint carries: an Eldrun terminal tab already open to the same host shows up in
 * `who` exactly like a human login.
 *
 * Mounted once at the shell, like `LocalLossDialog`. Unlike that one this is
 * advisory, not a record of something already destroyed, so a backdrop click
 * dismisses it same as any ordinary modal.
 *
 * Pushed: the backend runs the probe fire-and-forget right after
 * `remote_connect` resolves (manual dialog and silent auto-connect alike) and
 * emits it as a `remote-usage-report` event, since a probe that could hang or
 * fail must never delay activation. This listens globally (not gated on the
 * active project) so a report for a background project is not lost, and only
 * renders for whichever project is on screen.
 */

interface UsageReportEvent {
  projectId: string;
  report: RemoteUsageReport;
}

function fmtPct(used: number, total: number): string {
  if (total <= 0) return "?";
  return `${Math.round((used / total) * 100)}%`;
}

/**
 * Traffic-light tone for a CPU/GPU utilization percentage: green when the host
 * is effectively idle (≤5%), orange up to 40%, red above — so a glance at the
 * connect report says whether the machine is free to work on.
 */
type UsageTone = "green" | "orange" | "red";
function usageTone(pct: number): UsageTone {
  if (pct <= 5) return "green";
  if (pct <= 40) return "orange";
  return "red";
}

function UsageLight({ pct }: { pct: number }) {
  const tone = usageTone(pct);
  return (
    <span
      className={`remote-usage-light is-${tone}`}
      aria-label={`utilization ${tone}`}
    />
  );
}

export function RemoteUsageWarningDialog() {
  const activeId = useProjectsStore((s) => s.activeId);
  const setReport = useRemoteUsageStore((s) => s.setReport);
  const dismiss = useRemoteUsageStore((s) => s.dismiss);
  const recheck = useRemoteUsageStore((s) => s.recheck);
  const report = useRemoteUsageStore((s) =>
    activeId ? s.reports[activeId] : undefined,
  );
  const dismissed = useRemoteUsageStore((s) =>
    activeId ? (s.dismissed[activeId] ?? false) : true,
  );
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<UsageReportEvent>("remote-usage-report", (event) => {
      setReport(event.payload.projectId, event.payload.report);
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setReport]);

  if (!activeId || !report || dismissed) return null;

  const close = () => dismiss(activeId);
  const onRecheck = () => {
    setRechecking(true);
    void recheck(activeId).finally(() => setRechecking(false));
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="project-dialog remote-usage-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="remote-usage-title">Current remote host usage</h2>
        <p className="remote-usage-lede">
          Eldrun just connected and checked the host's load, memory and logged-in
          sessions. Here's what's running right now — decide whether to proceed.
        </p>
        {report.reasons.length > 0 && (
          <ul className="remote-usage-reasons">
            {report.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="remote-usage-stats">
          <div className="remote-usage-stat">
            <span className="remote-usage-stat-label">CPU</span>
            <span className="remote-usage-stat-value">
              <UsageLight pct={report.cpuPct} />
              {report.cpuPct.toFixed(0)}%{" "}
              <span className="remote-usage-stat-sub">
                ({report.cpuCount} core{report.cpuCount === 1 ? "" : "s"})
              </span>
            </span>
          </div>
          <div className="remote-usage-stat">
            <span className="remote-usage-stat-label">Load average</span>
            <span className="remote-usage-stat-value">
              {report.load1.toFixed(2)}, {report.load5.toFixed(2)}, {report.load15.toFixed(2)}
            </span>
          </div>
          <div className="remote-usage-stat">
            <span className="remote-usage-stat-label">Memory</span>
            <span className="remote-usage-stat-value">
              {report.memUsedMb} / {report.memTotalMb} MB{" "}
              <span className="remote-usage-stat-sub">
                ({fmtPct(report.memUsedMb, report.memTotalMb)})
              </span>
            </span>
          </div>
          {report.gpus.map((g, i) => (
            <div className="remote-usage-stat" key={`${g.name}-${i}`}>
              <span className="remote-usage-stat-label">GPU{report.gpus.length > 1 ? ` ${i}` : ""}</span>
              <span className="remote-usage-stat-value">
                <UsageLight pct={g.utilPct} />
                {g.utilPct.toFixed(0)}%{" "}
                <span className="remote-usage-stat-sub">
                  ({g.memUsedMb} / {g.memTotalMb} MB · {g.name})
                </span>
              </span>
            </div>
          ))}
        </div>
        {report.users.length > 0 && (
          <div className="remote-usage-section">
            <div className="remote-usage-section-title">Logged in</div>
            <ul className="remote-usage-users">
              {report.users.map((u, i) => (
                <li key={`${u.user}-${u.tty}-${i}`}>
                  <span className="remote-usage-user">{u.user}</span>
                  <span className="remote-usage-tty">{u.tty}</span>
                  <span className="remote-usage-detail">{u.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.topProcs.length > 0 && (
          <div className="remote-usage-section">
            <div className="remote-usage-section-title">Top processes</div>
            <ul className="remote-usage-procs">
              {report.topProcs.map((p, i) => (
                <li key={`${p.pid}-${i}`}>
                  <span className="remote-usage-proc-cmd">{p.command}</span>
                  <span className="remote-usage-proc-user">{p.user}</span>
                  <span className="remote-usage-proc-pct">{p.cpuPct.toFixed(1)}% cpu</span>
                  <span className="remote-usage-proc-pct">{p.memPct.toFixed(1)}% mem</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="remote-usage-actions">
          <button type="button" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? "Rechecking…" : "Recheck"}
          </button>
          <button type="button" className="primary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
