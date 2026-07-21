import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/globalMachines";
import {
  machineKey,
  projectHostKey,
  useRemoteUsageStore,
  type RemoteUsageReport,
  type UsageTarget,
} from "../../stores/remoteUsage";
import { hostsForProject } from "../../lib/remoteHosts";
import { sameTarget } from "../../lib/machineSync";
import { PRIMARY_HOST } from "../../stores/remoteStatus";

/**
 * Host usage — CPU/load, memory, GPU, logged-in sessions and top processes (see
 * `services::remote_usage` for the probe). It is **not** a verdict:
 * `report.busy`/`report.reasons` are surfaced as extra context (a "may be in
 * use" hint) but never gate anything. Note the one known false positive the hint
 * carries: an Eldrun terminal tab already open to the same host shows up in
 * `who` exactly like a human login.
 *
 * **On demand only.** It used to pop up by itself after every connect, which
 * put a modal in front of a user who had just asked for something else. Now the
 * *only* thing that opens it is the header Machines menu's "Remote host usage…"
 * button (`useRemoteUsageStore.open`), and opening it rechecks every host so
 * what's on screen is current rather than however stale the last connect's
 * report had become.
 *
 * **Its subject is the machine list, not a project.** It opens from the Machines
 * menu, so it shows a section for **every global machine, in that menu's exact
 * order** (`stores/globalMachines`), then the active project's own hosts — the
 * primary and any `compute_hosts` worker — that aren't already in the list. The
 * two are matched by SSH target (`lib/machineSync`'s `sameTarget`), never by id:
 * dropping a machine onto a project copies it by value, so `user@host:port` is
 * the only bridge, and without that dedupe one machine would appear twice.
 *
 * Mounted once at the shell, like `LocalLossDialog`. Advisory, not a record of
 * something already destroyed, so a backdrop click closes it same as any
 * ordinary modal.
 *
 * The connect-time probe still runs (the backend emits a `remote-usage-report`
 * event per project host after `remote_connect`) and this still listens for it
 * globally, so a just-connected project's report is already cached when the
 * button is pressed — but receiving one no longer shows anything.
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
      {/* Shown for **every** host, even with no sessions: `who` on a host reached
          only over the pooled (non-PTY) master has no utmp entry of its own, so a
          compute node with no interactive login is legitimately empty. The empty
          note makes that explicit rather than dropping the section, which read as
          "only the primary host reports logins". */}
      <div className="remote-usage-section">
        <div className="remote-usage-section-title">
          Logged in{" "}
          <span className="remote-usage-stat-sub">
            ({report.users.length} session{report.users.length === 1 ? "" : "s"})
          </span>
        </div>
        {report.users.length > 0 ? (
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
        ) : (
          <div className="remote-usage-empty">No interactive logins on this host.</div>
        )}
      </div>
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
  const machines = useGlobalMachinesStore((s) => s.machines);
  const setReport = useRemoteUsageStore((s) => s.setReport);
  const close = useRemoteUsageStore((s) => s.close);
  const recheck = useRemoteUsageStore((s) => s.recheck);
  const reports = useRemoteUsageStore((s) => s.reports);
  const isOpen = useRemoteUsageStore((s) => s.isOpen);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<UsageReportEvent>("remote-usage-report", (event) => {
      setReport(
        projectHostKey(event.payload.projectId, event.payload.hostId),
        event.payload.report,
      );
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setReport]);

  // Every global machine first, in the Machines menu's own order — this dialog
  // opens from that menu, so its list must be that list. Then the active
  // project's own hosts (primary, then `compute_hosts` in project order, the
  // same order the System Monitor's host picker uses), minus any whose SSH
  // target is already a machine above: the two lists are related by
  // `user@host:port` and nothing else, since attaching a machine to a project
  // copies it by value rather than linking ids.
  const targets = useMemo<UsageTarget[]>(() => {
    const list: UsageTarget[] = machines.map((m) => ({
      kind: "machine",
      key: machineKey(m.id),
      label: m.label || m.host,
      user: m.user,
      host: m.host,
      port: m.port,
    }));
    if (project?.remote) {
      const hostLabels = hostsForProject(project);
      const specs = [
        { id: PRIMARY_HOST, spec: project.remote },
        ...(project.compute_hosts ?? []).map((w) => ({ id: w.id, spec: w })),
      ];
      for (const { id, spec } of specs) {
        if (machines.some((m) => sameTarget(m, spec))) continue;
        const label = hostLabels.find((h) => h.id === id)?.label ?? spec.host;
        list.push({
          kind: "projectHost",
          key: projectHostKey(project.id, id),
          label: `${label} — ${project.name}`,
          projectId: project.id,
          hostId: id,
        });
      }
    }
    return list;
  }, [machines, project]);

  // Opening is itself the request for a reading: whatever the last connect left
  // cached is however old the session is, so every host is rechecked as the
  // dialog appears (its sections fill in as the probes land).
  const targetKey = targets.map((t) => t.key).join("|");
  const runRecheck = useMemo(
    () => () => {
      if (targets.length === 0) return;
      setRechecking(true);
      void Promise.all(targets.map((t) => recheck(t))).finally(() => setRechecking(false));
    },
    // `targetKey` stands in for `targets` (a fresh array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetKey, recheck],
  );
  useEffect(() => {
    if (isOpen) runRecheck();
  }, [isOpen, runRecheck]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="project-dialog dialog-framed remote-usage-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>Current remote host usage</h2>
          <button type="button" className="dialog-close-btn" onClick={close}>×</button>
        </div>
        <div className="dialog-scroll">
          <p className="remote-usage-lede">
            {targets.length === 0
              ? "No machines to check — add one in the Machines menu, or open a remote project."
              : `Load, memory and logged-in sessions on ${
                  targets.length === 1 ? "1 host" : `${targets.length} hosts`
                }, ${rechecking ? "being read now" : "as last read"} — here's what's running right now.`}
          </p>
          {targets.map((t) =>
            reports[t.key] ? (
              <HostUsageSection key={t.key} label={t.label} report={reports[t.key]} />
            ) : (
              <div className="remote-usage-host" key={t.key}>
                <div className="remote-usage-host-title">{t.label}</div>
                <div className="remote-usage-empty">
                  {rechecking ? "Checking…" : "No reading — the host may be unreachable."}
                </div>
              </div>
            ),
          )}
          <div className="project-dialog-actions">
            <button type="button" onClick={runRecheck} disabled={rechecking}>
              {rechecking ? "Rechecking…" : "Recheck"}
            </button>
            <button type="button" onClick={close}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
