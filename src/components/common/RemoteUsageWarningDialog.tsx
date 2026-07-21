import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteUsageStore, type RemoteUsageReport } from "../../stores/remoteUsage";
import { hostsForProject } from "../../lib/remoteHosts";

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
 * **Multi-host**: the probe fires for every host that connects — the primary
 * AND any `compute_hosts` worker — so this renders ONE combined dialog per
 * project with a section per connected host, rather than only ever the
 * primary's. A worker connecting after the dialog was dismissed un-dismisses
 * it (same rule the primary always had), so a freshly added machine's usage
 * still gets seen.
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
  hostId: string;
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

interface UserGroup {
  user: string;
  sessions: RemoteUsageReport["users"];
  /** Sum of this user's `ps` `%CPU`/`%MEM` across the top-processes sample — a
   *  login count says nothing about load (one idle `bash` vs. one `python`
   *  pinning a core both read as "1 session"), so this is compute, not session
   *  share. */
  cpuPct: number;
  memPct: number;
}

/** Collapse `who`'s per-session rows into one row per user, each carrying its
 *  summed CPU%/MEM% from `report.topProcs` instead of a session tally. Sorted
 *  by CPU%, busiest first — the point of the panel is spotting who's loading
 *  the host, not roll-call order. Only the top-N processes are sampled (same
 *  data the "Top processes" section shows), so a user's true total can be
 *  higher than what's attributed here if their load falls outside that
 *  sample. */
function groupSessionsByUser(report: RemoteUsageReport): UserGroup[] {
  const order: string[] = [];
  const byUser = new Map<string, RemoteUsageReport["users"]>();
  for (const s of report.users) {
    if (!byUser.has(s.user)) {
      order.push(s.user);
      byUser.set(s.user, []);
    }
    byUser.get(s.user)!.push(s);
  }
  const cpuByUser = new Map<string, number>();
  const memByUser = new Map<string, number>();
  for (const p of report.topProcs) {
    cpuByUser.set(p.user, (cpuByUser.get(p.user) ?? 0) + p.cpuPct);
    memByUser.set(p.user, (memByUser.get(p.user) ?? 0) + p.memPct);
  }
  return order
    .map((user) => ({
      user,
      sessions: byUser.get(user)!,
      cpuPct: cpuByUser.get(user) ?? 0,
      memPct: memByUser.get(user) ?? 0,
    }))
    .sort((a, b) => b.cpuPct - a.cpuPct);
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

/** One host's usage: reasons, CPU/load/memory/GPU stats, the per-user "Logged
 *  in" table, and top processes — repeated per connected host in the combined
 *  dialog (it used to be the dialog's whole body, back when only the primary
 *  was ever probed). */
function HostUsageSection({ label, report }: { label: string; report: RemoteUsageReport }) {
  return (
    <div className="remote-usage-host">
      <div className="remote-usage-host-title">{label}</div>
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
          <div className="remote-usage-section-title">
            Logged in{" "}
            <span className="remote-usage-stat-sub">
              ({report.users.length} session{report.users.length === 1 ? "" : "s"})
            </span>
          </div>
          <ul className="remote-usage-users">
            <li className="remote-usage-users-head" aria-hidden="true">
              <span>User</span>
              <span>CPU</span>
              <span>Sessions</span>
              <span>Mem</span>
            </li>
            {groupSessionsByUser(report).map((g) => (
              <li key={g.user}>
                <span className="remote-usage-user">{g.user}</span>
                <span className="remote-usage-user-cpu">
                  <UsageLight pct={g.cpuPct} />
                  {g.cpuPct.toFixed(0)}%
                </span>
                <span className="remote-usage-user-sessions">{g.sessions.length}</span>
                <span className="remote-usage-user-mem">{g.memPct.toFixed(0)}%</span>
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
    </div>
  );
}

export function RemoteUsageWarningDialog() {
  const activeId = useProjectsStore((s) => s.activeId);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === activeId));
  const setReport = useRemoteUsageStore((s) => s.setReport);
  const dismiss = useRemoteUsageStore((s) => s.dismiss);
  const recheck = useRemoteUsageStore((s) => s.recheck);
  const reportsByHost = useRemoteUsageStore((s) =>
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
      setReport(event.payload.projectId, event.payload.hostId, event.payload.report);
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setReport]);

  // Section order mirrors the System Monitor's host picker (primary, then
  // `compute_hosts` in project order). A report for a host that's since
  // dropped out of that list (removed mid-session) still shows — appended at
  // the end rather than silently vanishing.
  const knownHosts = useMemo(() => hostsForProject(project), [project]);
  const hostIds = useMemo(() => {
    if (!reportsByHost) return [];
    const known = knownHosts.map((h) => h.id).filter((id) => id in reportsByHost);
    const extra = Object.keys(reportsByHost).filter((id) => !known.includes(id));
    return [...known, ...extra];
  }, [reportsByHost, knownHosts]);

  if (!activeId || hostIds.length === 0 || dismissed) return null;
  const reports = reportsByHost!;

  const close = () => dismiss(activeId);
  const onRecheck = () => {
    setRechecking(true);
    void Promise.all(hostIds.map((id) => recheck(activeId, id))).finally(() =>
      setRechecking(false),
    );
  };
  const labelFor = (hostId: string) => knownHosts.find((h) => h.id === hostId)?.label ?? hostId;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="project-dialog remote-usage-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="remote-usage-title">Current remote host usage</h2>
        <p className="remote-usage-lede">
          Eldrun just connected and checked{" "}
          {hostIds.length === 1 ? "the host's" : `${hostIds.length} hosts'`} load,
          memory and logged-in sessions. Here's what's running right now — decide
          whether to proceed.
        </p>
        {hostIds.map((id) => (
          <HostUsageSection key={id} label={labelFor(id)} report={reports[id]} />
        ))}
        <div className="project-dialog-actions">
          <button type="button" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? "Rechecking…" : "Recheck"}
          </button>
          <button type="button" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
