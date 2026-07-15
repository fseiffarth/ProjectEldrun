import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatBytes,
  gpuAdapterTooltip,
  gpuBusy,
  gpuPercent,
  gpuTotals,
  type GpuSample,
} from "../../lib/gpu";

// ── Backend snapshot shape (mirrors sysstat::SystemSnapshot, snake_case) ──────

export interface CpuTimes {
  busy: number;
  total: number;
}

export interface ProcSample {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string;
  state: string;
  rss_kib: number;
  cpu_jiffies: number;
  threads: number;
}

export interface SystemSnapshot {
  supported: boolean;
  clk_tck: number;
  num_cores: number;
  cpu: CpuTimes;
  per_core: CpuTimes[];
  mem_total_kib: number;
  mem_available_kib: number;
  swap_total_kib: number;
  swap_free_kib: number;
  load_avg: [number, number, number];
  uptime_secs: number;
  processes: ProcSample[];
  /** Every GPU whose memory the machine reports; empty when none (see `lib/gpu`). */
  gpus: GpuSample[];
}

interface Props {
  /** Whole-machine view — no project scope. */
  visible: boolean;
}

const POLL_MS = 1500;

// ── Pure delta helpers (unit-tested in SystemMonitorSampling.test.ts) ─────────

/**
 * CPU utilisation of one core (or the aggregate) as a 0–100 percentage, from two
 * successive cumulative [`CpuTimes`] samples: `(busyΔ / totalΔ) * 100`. Returns 0
 * with no previous sample, a non-positive total delta, or a negative busy delta
 * (a counter reset / first frame), and clamps to 100.
 */
export function coreUsagePercent(
  prev: CpuTimes | undefined,
  next: CpuTimes,
): number {
  if (!prev) return 0;
  const totalDelta = next.total - prev.total;
  const busyDelta = next.busy - prev.busy;
  if (totalDelta <= 0 || busyDelta < 0) return 0;
  return Math.min(100, (busyDelta / totalDelta) * 100);
}

/**
 * Per-process CPU% in top's convention (% of a single core, so a fully busy
 * N-thread process can report up to N*100). Derived from the process's jiffy
 * delta over the machine's total-CPU-jiffy delta, scaled by core count. Returns
 * 0 on the first frame (no previous jiffies), a non-positive total delta, or a
 * negative process delta (pid reuse / exit-respawn).
 */
export function procCpuPercent(
  prevJiffies: number | undefined,
  nextJiffies: number,
  totalDelta: number,
  numCores: number,
): number {
  if (prevJiffies === undefined || totalDelta <= 0) return 0;
  const delta = nextJiffies - prevJiffies;
  if (delta < 0) return 0;
  return (delta / totalDelta) * numCores * 100;
}

/** Resident memory as a 0–100 percentage of total RAM. */
export function memPercent(rssKib: number, memTotalKib: number): number {
  if (memTotalKib <= 0) return 0;
  return (rssKib / memTotalKib) * 100;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Human-readable size from KiB (KiB → MiB → GiB → TiB). */
function formatKib(kib: number): string {
  if (kib < 1024) return `${kib} K`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} M`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(gib < 10 ? 2 : 1)} G`;
  return `${(gib / 1024).toFixed(2)} T`;
}

/** Seconds → `Dd HH:MM:SS` / `HH:MM:SS` uptime string. */
function formatUptime(secs: number): string {
  const s = Math.floor(secs);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/** Green → amber → red tone for a 0–100 load ratio. */
function toneFor(pct: number): string {
  if (pct >= 90) return "var(--danger)";
  if (pct >= 60) return "var(--warning)";
  return "var(--success)";
}

// ── Derived rows ──────────────────────────────────────────────────────────────

interface ProcRow extends ProcSample {
  cpu: number;
  mem: number;
}

type SortKey = "cpu" | "mem" | "rss_kib" | "pid" | "threads" | "comm";

function buildRows(snap: SystemSnapshot, prev: SystemSnapshot | null): ProcRow[] {
  const totalDelta = prev ? snap.cpu.total - prev.cpu.total : 0;
  const prevJiff = new Map<number, number>(
    prev ? prev.processes.map((p) => [p.pid, p.cpu_jiffies]) : [],
  );
  return snap.processes.map((p) => ({
    ...p,
    cpu: procCpuPercent(prevJiff.get(p.pid), p.cpu_jiffies, totalDelta, snap.num_cores),
    mem: memPercent(p.rss_kib, snap.mem_total_kib),
  }));
}

function sortRows(rows: ProcRow[], key: SortKey, asc: boolean): ProcRow[] {
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "comm") return dir * a.comm.localeCompare(b.comm);
    return dir * ((a[key] as number) - (b[key] as number));
  });
}

// ── Small presentational bits ─────────────────────────────────────────────────

function Meter({
  label,
  pct,
  caption,
  title,
}: {
  label: string;
  pct: number;
  caption?: string;
  /** Hover detail — the GPU meters use it to name the adapter and split its pools. */
  title?: string;
}) {
  return (
    <div className="sysmon-meter" title={title}>
      <span className="sysmon-meter-label">{label}</span>
      <span className="sysmon-meter-bar">
        <span
          className="sysmon-meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: toneFor(pct) }}
        />
      </span>
      <span className="sysmon-meter-caption">{caption ?? `${pct.toFixed(0)}%`}</span>
    </div>
  );
}

export function SystemMonitorPane({ visible }: Props) {
  const [pair, setPair] = useState<{ snap: SystemSnapshot; prev: SystemSnapshot | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState("");
  const prevRef = useRef<SystemSnapshot | null>(null);

  // Poll only while visible; the pane stays mounted across scope switches, so
  // pausing here stops a hidden monitor from sampling in the background (mirrors
  // AppResourceDisplay / NetworkTrafficPane).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    async function poll() {
      try {
        const next = await invoke<SystemSnapshot>("system_monitor_snapshot");
        if (cancelled) return;
        const prev = prevRef.current;
        prevRef.current = next;
        setPair({ snap: next, prev });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [visible]);

  const rows = useMemo(() => {
    if (!pair) return [];
    const built = buildRows(pair.snap, pair.prev);
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? built.filter(
          (r) =>
            r.comm.toLowerCase().includes(q) ||
            r.cmdline.toLowerCase().includes(q) ||
            String(r.pid) === q,
        )
      : built;
    return sortRows(filtered, sortKey, asc);
  }, [pair, filter, sortKey, asc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAsc((a) => !a);
    } else {
      setSortKey(key);
      // Text sorts ascending by default; numeric metrics descending (biggest first).
      setAsc(key === "comm");
    }
  }

  const snap = pair?.snap;
  const coreUsages = useMemo(
    () => (snap ? snap.per_core.map((c, i) => coreUsagePercent(pair?.prev?.per_core[i], c)) : []),
    [snap, pair],
  );

  const arrow = (key: SortKey) => (key === sortKey ? (asc ? " ▲" : " ▼") : "");

  return (
    <div className="sysmon-root">
      <style>{SYSMON_CSS}</style>

      {snap && !snap.supported ? (
        <div className="sysmon-placeholder">
          The system monitor is currently available on Linux only.
        </div>
      ) : !snap ? (
        <div className="sysmon-placeholder">{error ?? "Sampling…"}</div>
      ) : (
        <>
          <div className="sysmon-header">
            <div className="sysmon-cores">
              {coreUsages.map((pct, i) => (
                <Meter key={i} label={`${i}`} pct={pct} />
              ))}
            </div>
            <div className="sysmon-gauges">
              <Meter
                label="Mem"
                pct={memPercent(snap.mem_total_kib - snap.mem_available_kib, snap.mem_total_kib)}
                caption={`${formatKib(snap.mem_total_kib - snap.mem_available_kib)} / ${formatKib(
                  snap.mem_total_kib,
                )}`}
              />
              <Meter
                label="Swp"
                pct={
                  snap.swap_total_kib > 0
                    ? memPercent(snap.swap_total_kib - snap.swap_free_kib, snap.swap_total_kib)
                    : 0
                }
                caption={
                  snap.swap_total_kib > 0
                    ? `${formatKib(snap.swap_total_kib - snap.swap_free_kib)} / ${formatKib(
                        snap.swap_total_kib,
                      )}`
                    : "none"
                }
              />
              {/* One meter per adapter, and both its pools summed — on an APU the
                  dedicated carve-out alone is just the framebuffer (see lib/gpu). */}
              {(snap.gpus ?? []).map((gpu, i) => {
                const { used, total } = gpuTotals([gpu]);
                return (
                  <Meter
                    key={`${gpu.name}-${i}`}
                    label="GPU"
                    pct={gpuPercent(used, total)}
                    caption={`${formatBytes(used)} / ${formatBytes(total)}`}
                    title={gpuAdapterTooltip(gpu)}
                  />
                );
              })}
              <div className="sysmon-stats">
                {gpuBusy(snap.gpus ?? []) != null && (
                  <span>
                    gpu <b>{Math.round(gpuBusy(snap.gpus)!)}%</b>
                  </span>
                )}
                <span>
                  load <b>{snap.load_avg.map((n) => n.toFixed(2)).join(" ")}</b>
                </span>
                <span>
                  tasks <b>{snap.processes.length}</b>
                </span>
                <span>
                  up <b>{formatUptime(snap.uptime_secs)}</b>
                </span>
              </div>
            </div>
          </div>

          <div className="sysmon-toolbar">
            <input
              className="sysmon-filter"
              placeholder="Filter by name, command, or PID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
            <span className="sysmon-count">
              {rows.length} {rows.length === 1 ? "process" : "processes"}
            </span>
          </div>

          <div className="sysmon-table-wrap">
            <table className="sysmon-table">
              <thead>
                <tr>
                  <th className="num" onClick={() => toggleSort("pid")}>
                    PID{arrow("pid")}
                  </th>
                  <th className="num" onClick={() => toggleSort("cpu")}>
                    CPU%{arrow("cpu")}
                  </th>
                  <th className="num" onClick={() => toggleSort("mem")}>
                    MEM%{arrow("mem")}
                  </th>
                  <th className="num" onClick={() => toggleSort("rss_kib")}>
                    RSS{arrow("rss_kib")}
                  </th>
                  <th className="num" onClick={() => toggleSort("threads")}>
                    THR{arrow("threads")}
                  </th>
                  <th className="st">S</th>
                  <th className="cmd" onClick={() => toggleSort("comm")}>
                    Command{arrow("comm")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pid}>
                    <td className="num">{r.pid}</td>
                    <td className="num" style={{ color: toneFor(Math.min(100, r.cpu)) }}>
                      {r.cpu.toFixed(1)}
                    </td>
                    <td className="num" style={{ color: toneFor(r.mem) }}>
                      {r.mem.toFixed(1)}
                    </td>
                    <td className="num">{formatKib(r.rss_kib)}</td>
                    <td className="num">{r.threads}</td>
                    <td className="st">{r.state}</td>
                    <td className="cmd" title={r.cmdline}>
                      {r.cmdline}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const SYSMON_CSS = `
.sysmon-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  color: var(--text-primary);
  font-size: 12px;
  overflow: hidden;
}
.sysmon-placeholder {
  margin: auto;
  color: var(--text-muted);
  padding: 24px;
  text-align: center;
}
.sysmon-header {
  display: flex;
  gap: 18px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}
.sysmon-cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 2px 12px;
  flex: 1 1 320px;
  min-width: 220px;
}
.sysmon-gauges {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
  flex: 1 1 220px;
}
.sysmon-meter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.sysmon-meter-label {
  color: var(--text-muted);
  min-width: 28px;
  text-align: right;
}
.sysmon-meter-bar {
  flex: 1;
  height: 8px;
  background: var(--control-bg);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  overflow: hidden;
}
.sysmon-meter-fill {
  display: block;
  height: 100%;
  transition: width 0.3s linear;
}
.sysmon-meter-caption {
  color: var(--text-secondary);
  min-width: 44px;
  text-align: right;
}
.sysmon-stats {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 2px;
  color: var(--text-muted);
}
.sysmon-stats b {
  color: var(--text-primary);
  font-weight: 600;
}
.sysmon-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
}
.sysmon-filter {
  flex: 1;
  max-width: 340px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--radius, 4px);
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}
.sysmon-filter:focus {
  border-color: var(--accent);
}
.sysmon-count {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.sysmon-table-wrap {
  flex: 1;
  overflow: auto;
}
.sysmon-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.sysmon-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-header);
  color: var(--text-secondary);
  text-align: left;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
  user-select: none;
}
.sysmon-table th.num,
.sysmon-table td.num {
  text-align: right;
}
.sysmon-table th.st,
.sysmon-table td.st {
  text-align: center;
  color: var(--text-muted);
}
.sysmon-table td {
  padding: 3px 10px;
  white-space: nowrap;
}
.sysmon-table td.cmd {
  max-width: 640px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}
.sysmon-table tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
.sysmon-table tbody tr:hover {
  background: var(--control-hover-bg);
}
`;
