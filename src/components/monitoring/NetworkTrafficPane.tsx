import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../common/Dropdown";
import { isoWeekKeys, summarizeBuckets } from "../../lib/usageRollup";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { isCarefulHost, primaryTargetOf } from "../../lib/carefulHost";
import { isHpcHost } from "../../lib/hpcHost";

export interface NetworkInterfaceSnapshot {
  name: string;
  rxBytes: number;
  txBytes: number;
  up: boolean;
  loopback: boolean;
}

export interface NetworkConnectionSnapshot {
  protocol: string;
  state: string;
  localAddress: string;
  localPort: string;
  remoteAddress: string;
  remotePort: string;
  pid?: number;
  process?: string;
}

export interface NetworkHostSnapshot {
  supported: boolean;
  remote: boolean;
  connected: boolean;
  sampledAtMs: number;
  hostLabel: string;
  interfaces: NetworkInterfaceSnapshot[];
  connections?: NetworkConnectionSnapshot[];
  warning?: string;
}

export interface SshLinkSnapshot {
  supported: boolean;
  connected: boolean;
  sampledAtMs: number;
  connectionId?: string;
  rxBytes: number;
  txBytes: number;
  localEndpoint?: string;
  remoteEndpoint?: string;
  warning?: string;
}

export interface TrafficPoint {
  at: number;
  rxRate: number;
  txRate: number;
}

interface Props {
  projectId: string;
  visible: boolean;
  onConnect?: () => void;
}

interface CounterSample {
  id: string;
  at: number;
  rx: number;
  tx: number;
}

const HISTORY_POINTS = 300;
const CONNECTION_POLL_EVERY = 5;
/** The live cadence, for a local read and for an ordinary remote box. */
const LIVE_POLL_MS = 1000;
/** …and the cadence on a **careful** or HPC-tagged host, matching
 *  `SystemMonitorPane`'s `CAREFUL_POLL_MS` exactly — the same machine must not be
 *  read gently by one pane and hammered by another. On a remote project the host
 *  snapshot is a *shell exec on the host* (`commands::network`), so the old fixed
 *  1 s tick was one command per second against a login node for as long as the
 *  tab stayed open: precisely the "process causing load over a longer period" a
 *  cluster's rules reserve the right to kill. */
const CAREFUL_POLL_MS = 12_000;

export function rateFromSamples(
  previous: CounterSample | null,
  next: CounterSample,
): { rxRate: number; txRate: number; rxDelta: number; txDelta: number } {
  if (
    !previous ||
    previous.id !== next.id ||
    next.at <= previous.at ||
    next.rx < previous.rx ||
    next.tx < previous.tx
  ) {
    return { rxRate: 0, txRate: 0, rxDelta: 0, txDelta: 0 };
  }
  const seconds = (next.at - previous.at) / 1000;
  const rxDelta = next.rx - previous.rx;
  const txDelta = next.tx - previous.tx;
  return {
    rxRate: rxDelta / seconds,
    txRate: txDelta / seconds,
    rxDelta,
    txDelta,
  };
}

export function aggregateInterfaceCounters(
  interfaces: NetworkInterfaceSnapshot[],
  selected: string,
): { id: string; rx: number; tx: number } {
  const chosen =
    selected === "aggregate"
      ? interfaces.filter((iface) => iface.up && !iface.loopback)
      : interfaces.filter((iface) => iface.name === selected);
  return {
    id: selected,
    rx: chosen.reduce((sum, iface) => sum + iface.rxBytes, 0),
    tx: chosen.reduce((sum, iface) => sum + iface.txBytes, 0),
  };
}

export interface ByteCounts {
  rx: number;
  tx: number;
}

/** Bucket key ("YYYY-MM-DD" or "YYYY-MM-DDTHH", UTC) → bytes moved in it. */
export type ByteCountsByBucket = Record<string, ByteCounts>;

/** How many discrete files were downloaded/uploaded by the sync engine. */
export interface FileCounts {
  down: number;
  up: number;
}

/** Bucket key ("YYYY-MM-DD" or "YYYY-MM-DDTHH", UTC) → files synced in it. */
export type FileCountsByBucket = Record<string, FileCounts>;

/** Persisted per-project SSH-link usage, at the two granularities stored. */
export interface NetUsageReport {
  /** UTC hours ("YYYY-MM-DDTHH"); only the retained window (14 days). */
  hours: ByteCountsByBucket;
  /** UTC dates ("YYYY-MM-DD"); full history. */
  days: ByteCountsByBucket;
  /** UTC hours ("YYYY-MM-DDTHH"); files transferred, retained window. */
  fileHours?: FileCountsByBucket;
  /** UTC dates ("YYYY-MM-DD"); files transferred, full history. */
  fileDays?: FileCountsByBucket;
}

export interface NetUsageTotals {
  hour: ByteCounts;
  today: ByteCounts;
  week: ByteCounts;
  month: ByteCounts;
  overall: ByteCounts;
}

export interface NetUsageFileTotals {
  hour: FileCounts;
  today: FileCounts;
  week: FileCounts;
  month: FileCounts;
  overall: FileCounts;
}

// The bucket → calendar-window folding is shared with the usage recap, which
// reads a store of the same shape (`usage_stats.json`): same UTC keys, same
// ISO-week alignment, different payload. One implementation, in lib/usageRollup;
// re-exported here because this pane is where it has always been imported from.
export { isoWeekKeys };

/**
 * Fold the persisted usage maps into this-hour / today / this-week / this-month
 * / overall totals — [`summarizeBuckets`] specialised to byte counts.
 */
export function summarizeNetUsage(report: NetUsageReport, nowMs: number): NetUsageTotals {
  return summarizeBuckets<ByteCounts>(
    report,
    nowMs,
    () => ({ rx: 0, tx: 0 }),
    (into, counts) => {
      into.rx += counts?.rx ?? 0;
      into.tx += counts?.tx ?? 0;
    },
  );
}

/**
 * Fold the persisted file-count maps into this-hour / today / this-week /
 * this-month / overall totals — [`summarizeBuckets`] specialised to how many
 * files the sync engine downloaded/uploaded, mirroring [`summarizeNetUsage`].
 */
export function summarizeNetFileUsage(report: NetUsageReport, nowMs: number): NetUsageFileTotals {
  return summarizeBuckets<FileCounts>(
    { hours: report.fileHours, days: report.fileDays },
    nowMs,
    () => ({ down: 0, up: 0 }),
    (into, counts) => {
      into.down += counts?.down ?? 0;
      into.up += counts?.up ?? 0;
    },
  );
}

export function formatFileCount(value: number): string {
  return value.toLocaleString();
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function endpoint(address: string, port: string): string {
  if (!port) return address;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${host}:${port}`;
}

function TrafficGraph({ points, pollMs }: { points: TrafficPoint[]; pollMs: number }) {
  const width = 600;
  const height = 150;
  // How far back the graph actually reaches: a fixed point count at a cadence
  // that is no longer fixed. Stating "5 min" while a gently-polled host shows an
  // hour would be the kind of quiet mislabel a slower poll is easy to introduce.
  const spanMin = Math.max(1, Math.round((HISTORY_POINTS * pollMs) / 60000));
  const max = Math.max(1, ...points.flatMap((point) => [point.rxRate, point.txRate]));
  const path = (field: "rxRate" | "txRate") =>
    points
      .map((point, index) => {
        const x = points.length <= 1 ? width : (index / (HISTORY_POINTS - 1)) * width;
        const y = height - (point[field] / max) * (height - 12);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div className="network-graph-wrap">
      <div className="network-graph-scale">peak {formatRate(max)}</div>
      <svg
        className="network-graph"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${spanMin}-minute receive and transmit rate history`}
      >
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="network-grid-line" />
        {points.length > 1 && (
          <>
            <path d={path("rxRate")} className="network-line receive" />
            <path d={path("txRate")} className="network-line transmit" />
          </>
        )}
      </svg>
      <div className="network-graph-legend">
        <span className="receive">● Download</span>
        <span className="transmit">● Upload</span>
        <span className="network-history-label">rolling {spanMin} min</span>
      </div>
    </div>
  );
}

function StatusPanel({
  title,
  message,
  reconnect,
}: {
  title: string;
  message: string;
  reconnect?: () => void;
}) {
  return (
    <div className="network-status-panel">
      <div className="network-status-title">{title}</div>
      <div className="network-status-message">{message}</div>
      {reconnect && (
        <button className="btn-primary" onClick={reconnect}>
          Connect
        </button>
      )}
    </div>
  );
}

export function NetworkTrafficPane({ projectId, visible, onConnect }: Props) {
  const [view, setView] = useState<"host" | "link">("host");
  const [host, setHost] = useState<NetworkHostSnapshot | null>(null);
  const [link, setLink] = useState<SshLinkSnapshot | null>(null);
  const [connections, setConnections] = useState<NetworkConnectionSnapshot[]>([]);
  const [selectedInterface, setSelectedInterface] = useState("aggregate");
  const [history, setHistory] = useState<TrafficPoint[]>([]);
  const [sessionRx, setSessionRx] = useState(0);
  const [sessionTx, setSessionTx] = useState(0);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState<"ALL" | "TCP" | "UDP">("ALL");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<NetUsageReport>({
    hours: {},
    days: {},
    fileHours: {},
    fileDays: {},
  });
  const previous = useRef<CounterSample | null>(null);

  // Whose network this is, and whether it may be read unasked. Two gates, both
  // about the same fact: on a remote project `network_host_snapshot` runs a
  // shell command *on the host*.
  //
  //  * **The lamp, read here.** The only connectivity check used to be
  //    `result.connected` — the answer to a request already made, so a project
  //    whose pool was down still dialled once a second to be told "not
  //    connected". The SSH state is known before the call; ask it first.
  //  * **The careful/HPC cadence.** Same constant, same reasoning as the system
  //    monitor: a shared login node is not to carry a sustained background load,
  //    and a network tab left open all afternoon at 1 s is exactly that.
  //
  // A local project keeps both as they were — there is no host to be careful of,
  // and the snapshot is a `/proc` read of this machine.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useSettingsStore((s) => s.settings);
  const sshState = useRemoteStatusStore((s) => s.byProject[projectId]?.ssh);
  const isRemoteProject = !!project?.remote;
  const sshDown = isRemoteProject && sshState !== "connected";
  // The HPC tag outranks the Light/Detailed answer, exactly as `SystemMonitorPane`
  // has it: a machine the user called a cluster login node is read gently whatever
  // else is stored for it.
  const carefulHost =
    isRemoteProject &&
    (isHpcHost(settings, primaryTargetOf(project)) ||
      isCarefulHost(settings, primaryTargetOf(project)));
  // Only the **host** view costs the host anything. The SSH-link view is a local
  // `ss` read of this machine's own socket (`commands::network`'s
  // `linux_ssh_link`), so it keeps the live cadence on any machine.
  const pollMs = carefulHost && view === "host" ? CAREFUL_POLL_MS : LIVE_POLL_MS;

  useEffect(() => {
    previous.current = null;
    setHistory([]);
    setSessionRx(0);
    setSessionTx(0);
  }, [view, selectedInterface, projectId]);

  useEffect(() => {
    // A disconnected remote project samples nothing at all — see `sshDown`.
    if (!visible || !projectId || sshDown) return;
    // A hidden tab does not sample. Start with a fresh baseline when it becomes
    // visible again so bytes transferred while hidden are not folded into the
    // first visible rate/session-total point.
    previous.current = null;
    let cancelled = false;
    let inFlight = false;
    let tick = 0;

    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        let counterSample: CounterSample | null = null;
        if (view === "link") {
          const result = await invoke<SshLinkSnapshot>("network_ssh_link_snapshot", {
            projectId,
          });
          if (cancelled) return;
          setLink(result);
          if (result.supported && result.connected) {
            counterSample = {
              id: result.connectionId ?? "connected",
              at: result.sampledAtMs,
              rx: result.rxBytes,
              tx: result.txBytes,
            };
          } else {
            previous.current = null;
          }
        } else {
          const includeConnections = tick % CONNECTION_POLL_EVERY === 0;
          tick += 1;
          const result = await invoke<NetworkHostSnapshot>("network_host_snapshot", {
            projectId,
            includeConnections,
          });
          if (cancelled) return;
          setHost(result);
          if (result.connections) setConnections(result.connections);
          if (result.supported && result.connected) {
            const counters = aggregateInterfaceCounters(result.interfaces, selectedInterface);
            counterSample = {
              id: counters.id,
              at: result.sampledAtMs,
              rx: counters.rx,
              tx: counters.tx,
            };
          } else {
            previous.current = null;
          }
        }
        setError(null);
        if (counterSample) {
          const rate = rateFromSamples(previous.current, counterSample);
          previous.current = counterSample;
          setHistory((current) => [
            ...current.slice(-(HISTORY_POINTS - 1)),
            { at: counterSample.at, rxRate: rate.rxRate, txRate: rate.txRate },
          ]);
          setSessionRx((value) => value + rate.rxDelta);
          setSessionTx((value) => value + rate.txDelta);
        }
      } catch (reason) {
        previous.current = null;
        if (!cancelled) setError(String(reason));
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, selectedInterface, view, visible, sshDown, pollMs]);

  // Persisted per-project SSH-link usage (accrued in the background by
  // `services::net_usage`), refreshed slowly since it changes at most every
  // ~30 s. Independent of the 1 s live poll and of the host/link view.
  useEffect(() => {
    if (!visible || !projectId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await invoke<NetUsageReport>("get_net_usage", { projectId });
        if (!cancelled) {
          setUsage({
            hours: data?.hours ?? {},
            days: data?.days ?? {},
            fileHours: data?.fileHours ?? {},
            fileDays: data?.fileDays ?? {},
          });
        }
      } catch {
        // Leave the last-known totals in place on a transient failure.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, visible]);

  const current = history[history.length - 1] ?? { rxRate: 0, txRate: 0 };
  // The project's own record, not the last snapshot's: with the poll gated on the
  // lamp a disconnected remote project has no snapshot to read remoteness from,
  // and it must still offer its Remote-host / SSH-link tabs.
  const remote = isRemoteProject || (host?.remote ?? false);
  const usageTotals = useMemo(() => summarizeNetUsage(usage, Date.now()), [usage]);
  const fileTotals = useMemo(() => summarizeNetFileUsage(usage, Date.now()), [usage]);
  const warning = view === "link" ? link?.warning : host?.warning;
  // "Disconnected" is now something the pane knows rather than something it is
  // told: nothing was polled, so neither snapshot can report it.
  const available = sshDown
    ? false
    : view === "link"
      ? link?.supported !== false && link?.connected !== false
      : host?.supported !== false && host?.connected !== false;

  const filteredConnections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connections.filter((connection) => {
      if (protocol !== "ALL" && connection.protocol !== protocol) return false;
      if (!needle) return true;
      return [
        connection.protocol,
        connection.state,
        connection.localAddress,
        connection.localPort,
        connection.remoteAddress,
        connection.remotePort,
        connection.process ?? "",
        connection.pid?.toString() ?? "",
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [connections, protocol, query]);

  if (error && !host && !link) {
    return <StatusPanel title="Network monitor unavailable" message={error} />;
  }

  if (!available) {
    const connected = sshDown ? false : view === "link" ? link?.connected : host?.connected;
    return (
      <div className="network-pane">
        {remote && (
          <div className="network-view-tabs">
            <button className={view === "host" ? "active" : ""} onClick={() => setView("host")}>
              Remote Host
            </button>
            <button className={view === "link" ? "active" : ""} onClick={() => setView("link")}>
              SSH Link
            </button>
          </div>
        )}
        <StatusPanel
          title={connected === false ? "SSH project disconnected" : "Collector unsupported"}
          message={warning ?? error ?? "Network data is unavailable on this platform."}
          reconnect={connected === false ? onConnect : undefined}
        />
      </div>
    );
  }

  return (
    <div className="network-pane">
      <div className="network-toolbar">
        <div>
          <div className="network-heading">Network Traffic</div>
          <div className="network-subheading">
            {view === "link"
              ? `${link?.localEndpoint ?? "local"} ↔ ${link?.remoteEndpoint ?? host?.hostLabel ?? "SSH host"}`
              : host?.hostLabel ?? "Local host"}
          </div>
        </div>
        {remote && (
          <div className="network-view-tabs">
            <button className={view === "host" ? "active" : ""} onClick={() => setView("host")}>
              Remote Host
            </button>
            <button className={view === "link" ? "active" : ""} onClick={() => setView("link")}>
              SSH Link
            </button>
          </div>
        )}
        {view === "host" && (
          <label className="network-interface-select">
            Interface
            <Dropdown
              value={selectedInterface}
              onChange={setSelectedInterface}
              options={[
                { value: "aggregate", label: "Active non-loopback" },
                ...(host?.interfaces ?? []).map((iface) => ({
                  value: iface.name,
                  label: `${iface.name}${!iface.up ? " (down)" : ""}`,
                })),
              ]}
            />
          </label>
        )}
      </div>

      <div className="network-metrics">
        <div className="network-metric receive">
          <span>Download</span>
          <strong>{formatRate(current.rxRate)}</strong>
          <small>{formatBytes(sessionRx)} this view</small>
        </div>
        <div className="network-metric transmit">
          <span>Upload</span>
          <strong>{formatRate(current.txRate)}</strong>
          <small>{formatBytes(sessionTx)} this view</small>
        </div>
      </div>

      {remote && (
        <div className="network-usage-totals">
          <span className="network-usage-label">SSH-link usage</span>
          {(
            [
              ["This hour", usageTotals.hour],
              ["Today", usageTotals.today],
              ["This week", usageTotals.week],
              ["This month", usageTotals.month],
              ["Overall", usageTotals.overall],
            ] as const
          ).map(([label, counts]) => (
            <span key={label} className="network-usage-stat">
              {label} <span className="rx">↓ {formatBytes(counts.rx)}</span>{" "}
              <span className="tx">↑ {formatBytes(counts.tx)}</span>
            </span>
          ))}
        </div>
      )}

      {remote && (
        <div className="network-usage-totals">
          <span className="network-usage-label">Files synced</span>
          {(
            [
              ["This hour", fileTotals.hour],
              ["Today", fileTotals.today],
              ["This week", fileTotals.week],
              ["This month", fileTotals.month],
              ["Overall", fileTotals.overall],
            ] as const
          ).map(([label, counts]) => (
            <span key={label} className="network-usage-stat">
              {label} <span className="rx">↓ {formatFileCount(counts.down)}</span>{" "}
              <span className="tx">↑ {formatFileCount(counts.up)}</span>
            </span>
          ))}
        </div>
      )}

      <TrafficGraph points={history} pollMs={pollMs} />

      {warning && <div className="network-warning">{warning}</div>}
      {error && <div className="network-warning">{error}</div>}

      {view === "host" && (
        <section className="network-connections">
          <div className="network-connections-head">
            <div>
              <h3>Connections</h3>
              <span>{filteredConnections.length} visible</span>
            </div>
            <div className="network-connection-filters">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search endpoint, process, PID…"
                aria-label="Search network connections"
              />
              <Dropdown
                value={protocol}
                title="Filter connection protocol"
                onChange={(v) => setProtocol(v as "ALL" | "TCP" | "UDP")}
                options={[
                  { value: "ALL", label: "TCP + UDP" },
                  { value: "TCP", label: "TCP" },
                  { value: "UDP", label: "UDP" },
                ]}
              />
            </div>
          </div>
          <div className="network-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Protocol</th>
                  <th>State</th>
                  <th>Local</th>
                  <th>Remote</th>
                  <th>Process</th>
                </tr>
              </thead>
              <tbody>
                {filteredConnections.map((connection, index) => (
                  <tr
                    key={`${connection.protocol}/${connection.localAddress}/${connection.localPort}/${connection.remoteAddress}/${connection.remotePort}/${connection.pid ?? "x"}/${index}`}
                  >
                    <td>{connection.protocol}</td>
                    <td>{connection.state}</td>
                    <td>{endpoint(connection.localAddress, connection.localPort)}</td>
                    <td>{endpoint(connection.remoteAddress, connection.remotePort)}</td>
                    <td>
                      {connection.process ?? "—"}
                      {connection.pid != null ? ` · ${connection.pid}` : ""}
                    </td>
                  </tr>
                ))}
                {filteredConnections.length === 0 && (
                  <tr>
                    <td colSpan={5} className="network-empty-row">
                      No matching connections
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="network-table-note">
            Host-wide view. Process names are limited to sockets visible to the current user.
          </div>
        </section>
      )}
      {view === "link" && (
        <div className="network-link-note">
          Counts the shared SSH transport. Terminals, SFTP, sync, git, and any projects using
          the same ControlMaster contribute to these totals.
        </div>
      )}
    </div>
  );
}
