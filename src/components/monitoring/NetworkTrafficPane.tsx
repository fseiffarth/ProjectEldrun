import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

function TrafficGraph({ points }: { points: TrafficPoint[] }) {
  const width = 600;
  const height = 150;
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
        aria-label="Five-minute receive and transmit rate history"
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
        <span className="network-history-label">rolling 5 min</span>
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
  const previous = useRef<CounterSample | null>(null);

  useEffect(() => {
    previous.current = null;
    setHistory([]);
    setSessionRx(0);
    setSessionTx(0);
  }, [view, selectedInterface, projectId]);

  useEffect(() => {
    if (!visible || !projectId) return;
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
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, selectedInterface, view, visible]);

  const current = history[history.length - 1] ?? { rxRate: 0, txRate: 0 };
  const remote = host?.remote ?? false;
  const warning = view === "link" ? link?.warning : host?.warning;
  const available =
    view === "link"
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
    const connected = view === "link" ? link?.connected : host?.connected;
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
            <select
              value={selectedInterface}
              onChange={(event) => setSelectedInterface(event.target.value)}
            >
              <option value="aggregate">Active non-loopback</option>
              {(host?.interfaces ?? []).map((iface) => (
                <option key={iface.name} value={iface.name}>
                  {iface.name}
                  {!iface.up ? " (down)" : ""}
                </option>
              ))}
            </select>
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

      <TrafficGraph points={history} />

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
              <select
                value={protocol}
                onChange={(event) => setProtocol(event.target.value as "ALL" | "TCP" | "UDP")}
                aria-label="Filter connection protocol"
              >
                <option value="ALL">TCP + UDP</option>
                <option value="TCP">TCP</option>
                <option value="UDP">UDP</option>
              </select>
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
