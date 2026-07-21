import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatBytes,
  formatFan,
  formatMhz,
  formatTempC,
  formatWatts,
  gpuAdapterTooltip,
  gpuLinkLabel,
  gpuPercent,
  gpuTotals,
  type GpuProc,
  type GpuSample,
} from "../../lib/gpu";
import { useProjectsStore } from "../../stores/projects";
import { ConnLamp } from "../common/ConnLamp";
import { UntestedTag } from "../common/UntestedTag";
import { hostsForProject } from "../../lib/remoteHosts";
import { PRIMARY_HOST, sshOf, useRemoteStatusStore } from "../../stores/remoteStatus";

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
  /** Owning user's name (resolved on the sampled machine's passwd db). Empty when
   *  the backend can't resolve an owner (Windows/macOS) — the per-user section is
   *  hidden then. An unmapped uid reads as `#<uid>`. */
  user: string;
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
  /** Per-process GPU memory — populated only on the remote path (sampled on the
   *  host); locally the pane fetches `gpu_process_snapshot` instead. */
  gpu_procs?: GpuProc[];
  /** Whole-package CPU temperature in °C, or null/undefined when no CPU hwmon
   *  sensor is present (or on Windows/macOS, which don't read one). */
  cpu_temp_c?: number | null;
  /** Hottest DIMM temperature in °C, or null/undefined when the board exposes no
   *  on-module sensor (`jc42`/`spd5118`) — most desktops don't wire one. */
  mem_temp_c?: number | null;
}

interface Props {
  /** Owning project, or `null` in the root scope. A remote (SSH) project unlocks
   *  a source toggle so the pane can sample the **host** instead of this machine. */
  projectId: string | null;
  visible: boolean;
}

/** Which machine the pane samples: this one, or a connected remote project's host.
 *  A hostId of `PRIMARY_HOST` selects the project's own remote; any other id
 *  selects a `compute_hosts` worker (`docs/multi_host_remote_plan.md`). */
type Source = "local" | { hostId: string };

const POLL_MS = 1500;
/** The host sample is one SSH round-trip reading its whole `/proc`, so it polls
 *  more gently than the local `/proc` read to keep host load and traffic down. */
const REMOTE_POLL_MS = 3000;

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

/** Traffic-light tone for a utilization percentage, matching the remote-usage
 *  connect dialog exactly: green when effectively idle (≤5%), orange up to 40%,
 *  red above — so the per-user "By user" panel reads identically to the session
 *  stats there. */
type UsageTone = "green" | "orange" | "red";
function usageTone(pct: number): UsageTone {
  if (pct <= 5) return "green";
  if (pct <= 40) return "orange";
  return "red";
}

/** The same green/orange/red dot the remote-usage dialog puts next to a user's
 *  CPU share (`.remote-usage-light`), reused here so the two panels match. */
function UsageLight({ pct }: { pct: number }) {
  const tone = usageTone(pct);
  return (
    <span className={`remote-usage-light is-${tone}`} aria-label={`utilization ${tone}`} />
  );
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

/** One user's share of the machine: their summed CPU%/MEM% across every process
 *  they own, and how many processes that is. This is the same "who's loading the
 *  host" statistic the connect-time usage dialog shows, but derived from the full
 *  process table rather than a top-N `ps` sample — so it's exact, not a sample. */
interface UserRow {
  user: string;
  cpu: number;
  mem: number;
  count: number;
}

/** Collapse the process rows into one row per owning user, summing CPU%/MEM% and
 *  counting processes. Sorted by CPU%, busiest first — the point is spotting who's
 *  loading the machine. Processes with no resolved owner are ignored (the section
 *  itself is hidden when *no* process reports one). */
function groupByUser(rows: ProcRow[]): UserRow[] {
  const byUser = new Map<string, UserRow>();
  for (const r of rows) {
    if (!r.user) continue;
    const cur = byUser.get(r.user) ?? { user: r.user, cpu: 0, mem: 0, count: 0 };
    cur.cpu += r.cpu;
    cur.mem += r.mem;
    cur.count += 1;
    byUser.set(r.user, cur);
  }
  return [...byUser.values()].sort((a, b) => b.cpu - a.cpu);
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

/** One GPU's detail card: identity, memory + utilization meters, live sensors. */
function GpuSection({ gpu }: { gpu: GpuSample }) {
  const { used, total } = gpuTotals([gpu]);
  const link = gpuLinkLabel(gpu);
  const tip = gpuAdapterTooltip(gpu);

  // A fixed set of sensor slots in a fixed order, always rendered from the first
  // frame on. A driver that momentarily (or never) answers a sensor shows `n/a`
  // in its slot rather than dropping the chip — a disappearing chip reflows every
  // chip to its right, which is the flicker (an idle NVIDIA card blanks
  // `power.draw` as `[N/A]`). Keeping the slots stable trades a permanent `n/a`
  // for a sensor a card lacks against a strip that never jumps.
  const sensors = [
    { label: "temp", value: formatTempC(gpu.temp_c) },
    { label: "power", value: formatWatts(gpu.power_w, gpu.power_cap_w) },
    { label: "core", value: formatMhz(gpu.sclk_mhz) },
    { label: "mem", value: formatMhz(gpu.mclk_mhz) },
    { label: "fan", value: formatFan(gpu.fan_percent) },
  ].map((s) => ({ label: s.label, value: s.value ?? "n/a", present: s.value != null }));

  return (
    <div className="sysmon-gpu">
      <div className="sysmon-gpu-head">
        <span className="sysmon-gpu-name" title={tip}>
          {gpu.name}
        </span>
        <span className="sysmon-gpu-meta">
          {gpu.driver}
          {gpu.driver_version ? ` ${gpu.driver_version}` : ""}
          {link ? ` · ${link}` : ""}
        </span>
      </div>
      <div className="sysmon-gpu-meters">
        {/* Both memory pools summed — on an APU the dedicated carve-out alone is
            just the framebuffer (see lib/gpu). */}
        <Meter
          label="VRAM"
          pct={gpuPercent(used, total)}
          caption={`${formatBytes(used)} / ${formatBytes(total)}`}
          title={tip}
        />
        {/* `busy_percent` is null when the driver won't report it — omit the meter
            rather than show a misleading 0%. */}
        {gpu.busy_percent != null && <Meter label="Util" pct={gpu.busy_percent} />}
      </div>
      {sensors.length > 0 && (
        <div className="sysmon-stats sysmon-gpu-sensors">
          {sensors.map((s) => (
            <span key={s.label}>
              {s.label}{" "}
              <b className={s.present ? undefined : "sysmon-sensor-na"}>{s.value}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Top processes by GPU memory. Empty (renders nothing) when the driver reports
 *  no per-process data — best-effort, so its absence is silent, not an error. */
function GpuProcList({ procs }: { procs: GpuProc[] }) {
  const top = procs.filter((p) => p.mem_bytes > 0).slice(0, 8);
  if (top.length === 0) return null;
  return (
    <div className="sysmon-gpu-procs">
      <div className="sysmon-gpu-procs-head">GPU memory by process</div>
      {top.map((p) => (
        <div className="sysmon-gpu-proc" key={p.pid}>
          <span className="sysmon-gpu-proc-mem">{formatBytes(p.mem_bytes)}</span>
          <span className="sysmon-gpu-proc-pid">{p.pid}</span>
          <span className="sysmon-gpu-proc-name" title={p.name}>
            {p.name || "?"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SystemMonitorPane({ projectId, visible }: Props) {
  const [pair, setPair] = useState<{ snap: SystemSnapshot; prev: SystemSnapshot | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Per-process GPU memory, local machine only (the remote /proc script doesn't
  // sample it). Its own command, so the always-visible header never pays for it.
  const [gpuProcs, setGpuProcs] = useState<GpuProc[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [asc, setAsc] = useState(false);
  const [filter, setFilter] = useState("");
  // The detailed process table is collapsible so the CPU/GPU vitals can own the
  // pane; expanded by default (the monitor's main content).
  const [procOpen, setProcOpen] = useState(true);
  // The per-user breakdown is collapsible too, expanded by default when present.
  const [usersOpen, setUsersOpen] = useState(true);
  const prevRef = useRef<SystemSnapshot | null>(null);

  // A remote (SSH) project can sample its primary host, and — multi-host
  // (`docs/multi_host_remote_plan.md`) — any connected `compute_hosts` worker
  // too. Same store reads the Disk Usage pane uses to reach a host over the
  // shared pool.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const byProject = useRemoteStatusStore((s) => s.byProject);
  const byHostAll = useRemoteStatusStore((s) => s.byHost);
  const isRemoteProject = !!project?.remote;

  const hosts = useMemo(() => hostsForProject(project), [project]);

  function connState(hostId: string) {
    if (!projectId) return "off" as const;
    return sshOf({ byProject, byHost: byHostAll }, projectId, hostId);
  }
  const primaryConnected = isRemoteProject && connState(PRIMARY_HOST) === "connected";

  const [source, setSource] = useState<Source>("local");
  // Auto-follow the primary host: point at it once it is connected, "local"
  // otherwise — until the user picks a side explicitly (any host or "local"),
  // which pins the choice.
  const pinnedRef = useRef(false);
  useEffect(() => {
    if (!pinnedRef.current) setSource(primaryConnected ? { hostId: PRIMARY_HOST } : "local");
  }, [primaryConnected]);
  function pickSource(next: Source) {
    pinnedRef.current = true;
    setSource(next);
  }

  const onHost = source !== "local";
  const selectedHostId = onHost ? (source as { hostId: string }).hostId : null;
  const hostConnected = onHost && selectedHostId != null && connState(selectedHostId) === "connected";
  const remoteHost = onHost
    ? (hosts.find((h) => h.id === selectedHostId)?.label ?? "the host")
    : "the host";
  // Whether the pane is actually sampling (and so the table/meters below apply).
  const sampling = visible && !(onHost && !hostConnected);

  // Poll only while visible and (for the host) while it is connected; the pane
  // stays mounted across scope switches, so pausing here stops a hidden monitor
  // from sampling in the background (mirrors AppResourceDisplay /
  // NetworkTrafficPane). CPU/MEM percentages are diffs of successive samples, so
  // switching machine drops the stale previous sample — a delta across two
  // different machines is meaningless.
  useEffect(() => {
    prevRef.current = null;
    setPair(null);
    setError(null);
    setGpuProcs([]);
    if (!sampling) return;
    let cancelled = false;
    async function poll() {
      try {
        const next = await invoke<SystemSnapshot>("system_monitor_snapshot", {
          projectId: onHost ? projectId : null,
          hostId: onHost ? selectedHostId : null,
        });
        if (cancelled) return;
        const prev = prevRef.current;
        prevRef.current = next;
        setPair({ snap: next, prev });
        setError(null);
        // The host samples its own per-process GPU memory into the snapshot; the
        // local machine has a dedicated command for it (kept off the shared,
        // always-polled snapshot). Best-effort either way — an empty list means
        // "no per-process data", not an error.
        if (onHost) {
          if (!cancelled) setGpuProcs(next.gpu_procs ?? []);
        } else {
          try {
            const procs = await invoke<GpuProc[]>("gpu_process_snapshot");
            if (!cancelled) setGpuProcs(procs);
          } catch {
            if (!cancelled) setGpuProcs([]);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void poll();
    const id = window.setInterval(poll, onHost ? REMOTE_POLL_MS : POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sampling, onHost, projectId, selectedHostId]);

  // Every process, before the table's text filter — the per-user breakdown sums
  // over the whole machine, not just what the filter happens to show.
  const allRows = useMemo(() => (pair ? buildRows(pair.snap, pair.prev) : []), [pair]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? allRows.filter(
          (r) =>
            r.comm.toLowerCase().includes(q) ||
            r.cmdline.toLowerCase().includes(q) ||
            String(r.pid) === q,
        )
      : allRows;
    return sortRows(filtered, sortKey, asc);
  }, [allRows, filter, sortKey, asc]);

  const userRows = useMemo(() => groupByUser(allRows), [allRows]);
  const hasUserData = userRows.length > 0;

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
  // Fallback when a backend can't enumerate per-core times (e.g. the Windows
  // ntdll per-core query fails, or any OS returning an empty `per_core`): the
  // aggregate `cpu` field is always populated, so show one machine-wide bar
  // rather than an empty CPU section.
  const aggregateUsage = useMemo(
    () => (snap ? coreUsagePercent(pair?.prev?.cpu, snap.cpu) : 0),
    [snap, pair],
  );

  const arrow = (key: SortKey) => (key === sortKey ? (asc ? " ▲" : " ▼") : "");
  /** Marks the active sort column's header AND its body cells (`.sysmon-table
   *  th.sorted` / `td.sorted`) so the whole column reads as one accent band. */
  const sortedCls = (key: SortKey) => (key === sortKey ? "sorted" : undefined);

  return (
    <div className="sysmon-root">
      <style>{SYSMON_CSS}</style>

      {isRemoteProject && (
        <div className="sysmon-source" role="tablist" aria-label="Monitor source">
          <button
            className={source === "local" ? "sysmon-source-btn active" : "sysmon-source-btn"}
            onClick={() => pickSource("local")}
            role="tab"
            aria-selected={source === "local"}
          >
            This machine
          </button>
          {/* One button per connected machine — the primary and every multi-host
              `compute_hosts` worker — each carrying its own live SSH traffic light
              (the same `ConnLamp` the Remote machines window shows per row), so a
              worker's status is visible right where its usage would be sampled. */}
          {hosts.map((h) => {
            const state = connState(h.id);
            const connected = state === "connected";
            const active = onHost && selectedHostId === h.id;
            return (
              <button
                key={h.id}
                className={active ? "sysmon-source-btn active" : "sysmon-source-btn"}
                onClick={() => pickSource({ hostId: h.id })}
                role="tab"
                aria-selected={active}
                title={connected ? `System monitor on ${h.label}` : `${h.label}: ${state}`}
              >
                <ConnLamp status={state} label={h.label} />
                {h.label}
              </button>
            );
          })}
        </div>
      )}

      {onHost && !hostConnected ? (
        <div className="sysmon-placeholder">
          Connect this project to view {remoteHost}&rsquo;s system monitor.
        </div>
      ) : snap && !snap.supported ? (
        <div className="sysmon-placeholder">
          The system monitor is currently available on Linux only.
        </div>
      ) : !snap ? (
        <div className="sysmon-placeholder">{error ?? "Sampling…"}</div>
      ) : (
        // One scroll region for the whole body (a single scrollbar): the vitals and
        // the process table scroll together, the table's sticky thead pinning to this
        // scroller.
        <div className="sysmon-scroll">
          {/* Hardware vitals as two columns: CPU over Memory on the left, the GPU
              cards on the right (when the machine has one) — separated by a divider —
              so the GPU's VRAM + Util meters and sensor strip sit beside the CPU. */}
          <div className="sysmon-vitals">
            <div className="sysmon-vitals-left">
              <div className="sysmon-cpu-group">
                <div className="sysmon-group-title">
                  CPU
                  <span className="sysmon-group-sub">{snap.num_cores} cores</span>
                </div>
                <div className="sysmon-cores">
                  {coreUsages.length > 0 ? (
                    coreUsages.map((pct, i) => <Meter key={i} label={`${i}`} pct={pct} />)
                  ) : (
                    <Meter label="all" pct={aggregateUsage} />
                  )}
                </div>
                {/* System-load stats belong with the CPU: load average, task count,
                    uptime, and CPU package temperature (when a hwmon sensor exposes
                    one — omitted rather than shown as a fake zero). */}
                <div className="sysmon-stats">
                  <span>
                    load <b>{snap.load_avg.map((n) => n.toFixed(2)).join(" ")}</b>
                  </span>
                  <span>
                    tasks <b>{snap.processes.length}</b>
                  </span>
                  <span>
                    up <b>{formatUptime(snap.uptime_secs)}</b>
                  </span>
                  {snap.cpu_temp_c != null && (
                    <span>
                      cpu temp <b>{formatTempC(snap.cpu_temp_c)}</b>
                    </span>
                  )}
                </div>
              </div>
              <div className="sysmon-mem-group">
                <div className="sysmon-group-title">Memory</div>
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
                <div className="sysmon-stats">
                  <span>
                    avail <b>{formatKib(snap.mem_available_kib)}</b>
                  </span>
                  <span>
                    used{" "}
                    <b>
                      {memPercent(
                        snap.mem_total_kib - snap.mem_available_kib,
                        snap.mem_total_kib,
                      ).toFixed(0)}
                      %
                    </b>
                  </span>
                  {snap.swap_total_kib > 0 && (
                    <span>
                      swap free <b>{formatKib(snap.swap_free_kib)}</b>
                    </span>
                  )}
                  {/* Hottest DIMM temperature, when the board wires an on-module
                      sensor (jc42/spd5118); omitted otherwise — most desktops have none. */}
                  {snap.mem_temp_c != null && (
                    <span>
                      mem temp <b>{formatTempC(snap.mem_temp_c)}</b>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* The GPU detail column: one card per adapter — VRAM + utilization
                meters and its live sensors — then (local only) the processes using
                GPU memory, listed once since the sources don't attribute them per
                card. Rendered only when the machine reports a GPU. */}
            {(snap.gpus ?? []).length > 0 && (
              <div className="sysmon-vitals-right">
                <div className="sysmon-group-title">
                  GPU
                  <span className="sysmon-group-sub">
                    {(snap.gpus ?? []).length}{" "}
                    {(snap.gpus ?? []).length === 1 ? "adapter" : "adapters"}
                  </span>
                </div>
                {(snap.gpus ?? []).map((gpu, i) => (
                  <GpuSection key={`${gpu.name}-${i}`} gpu={gpu} />
                ))}
                <GpuProcList procs={gpuProcs} />
              </div>
            )}
          </div>

          {/* Per-user breakdown: who is loading the machine, summed over the whole
              process table. Shown for a **remote host only** — it exists to answer
              "who else is on this shared machine?", the same question the
              connect-time usage dialog's session stats answer, and it is rendered
              in that dialog's exact look (the `.remote-usage-users` grid + its
              traffic-light dot). Local sampling is always just this user, so the
              panel would be a single trivial row — hidden there. Still gated on the
              host resolving process owners (Linux only; never Windows/macOS). */}
          {onHost && hasUserData && (
            <>
              <div className="sysmon-proc-head">
                <button
                  type="button"
                  className="sysmon-proc-toggle"
                  onClick={() => setUsersOpen((v) => !v)}
                  aria-expanded={usersOpen}
                  title={usersOpen ? "Collapse per-user usage" : "Expand per-user usage"}
                >
                  <span className="sysmon-proc-caret">{usersOpen ? "▾" : "▸"}</span>
                  <span className="sysmon-group-title">By user</span>
                  <UntestedTag />
                </button>
                <span className="sysmon-count">
                  {userRows.length} {userRows.length === 1 ? "user" : "users"}
                </span>
              </div>
              {usersOpen && (
                <div className="sysmon-users">
                  <ul className="remote-usage-users">
                    <li className="remote-usage-users-head" aria-hidden="true">
                      <span>User</span>
                      <span>CPU</span>
                      <span>Procs</span>
                      <span>Mem</span>
                    </li>
                    {userRows.map((u) => (
                      <li key={u.user}>
                        <span className="remote-usage-user">{u.user}</span>
                        <span className="remote-usage-user-cpu">
                          <UsageLight pct={u.cpu} />
                          {u.cpu.toFixed(0)}%
                        </span>
                        <span className="remote-usage-user-sessions">{u.count}</span>
                        <span className="remote-usage-user-mem">{u.mem.toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* The Processes group: its own titled header, collapsible via the caret
              so the vitals above can own the pane when the table isn't needed. */}
          <div className="sysmon-proc-head">
            <button
              type="button"
              className="sysmon-proc-toggle"
              onClick={() => setProcOpen((v) => !v)}
              aria-expanded={procOpen}
              title={procOpen ? "Collapse process list" : "Expand process list"}
            >
              <span className="sysmon-proc-caret">{procOpen ? "▾" : "▸"}</span>
              <span className="sysmon-group-title">Processes</span>
            </button>
            <span className="sysmon-count">
              {rows.length} {rows.length === 1 ? "process" : "processes"}
            </span>
          </div>

          {procOpen && (
            <>
          <div className="sysmon-toolbar">
            <input
              className="sysmon-filter"
              placeholder="Filter by name, command, or PID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="sysmon-table-wrap">
            <table className="sysmon-table">
              <thead>
                <tr>
                  <th className={`num ${sortedCls("pid") ?? ""}`} onClick={() => toggleSort("pid")}>
                    PID{arrow("pid")}
                  </th>
                  <th className={`num ${sortedCls("cpu") ?? ""}`} onClick={() => toggleSort("cpu")}>
                    CPU%{arrow("cpu")}
                  </th>
                  <th className={`num ${sortedCls("mem") ?? ""}`} onClick={() => toggleSort("mem")}>
                    MEM%{arrow("mem")}
                  </th>
                  <th
                    className={`num ${sortedCls("rss_kib") ?? ""}`}
                    onClick={() => toggleSort("rss_kib")}
                  >
                    RSS{arrow("rss_kib")}
                  </th>
                  <th
                    className={`num ${sortedCls("threads") ?? ""}`}
                    onClick={() => toggleSort("threads")}
                  >
                    THR{arrow("threads")}
                  </th>
                  <th className="st">S</th>
                  <th className={`cmd ${sortedCls("comm") ?? ""}`} onClick={() => toggleSort("comm")}>
                    Command{arrow("comm")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pid}>
                    <td className={`num ${sortedCls("pid") ?? ""}`}>{r.pid}</td>
                    <td
                      className={`num ${sortedCls("cpu") ?? ""}`}
                      style={{ color: toneFor(Math.min(100, r.cpu)) }}
                    >
                      {r.cpu.toFixed(1)}
                    </td>
                    <td
                      className={`num ${sortedCls("mem") ?? ""}`}
                      style={{ color: toneFor(r.mem) }}
                    >
                      {r.mem.toFixed(1)}
                    </td>
                    <td className={`num ${sortedCls("rss_kib") ?? ""}`}>{formatKib(r.rss_kib)}</td>
                    <td className={`num ${sortedCls("threads") ?? ""}`}>{r.threads}</td>
                    <td className="st">{r.state}</td>
                    <td className={`cmd ${sortedCls("comm") ?? ""}`} title={r.cmdline}>
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
.sysmon-source {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  flex: 0 0 auto;
}
.sysmon-source-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  border-radius: var(--radius, 4px);
  color: var(--text-secondary);
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sysmon-source-btn:hover {
  background: var(--control-hover-bg);
}
.sysmon-source-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast, #fff);
}
/* The single scroll region: the vitals and the process table scroll together under
   ONE scrollbar. The table's sticky thead pins to this scroller. */
.sysmon-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
/* The vitals region: a left column (CPU over Memory) and a right column (GPU),
   sitting above the process table. */
.sysmon-vitals {
  display: flex;
  gap: 18px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
  align-items: flex-start;
}
.sysmon-vitals-left {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 340px;
  min-width: 240px;
}
/* The GPU column, divided from the CPU/Memory column. The border reads as a
   horizontal rule between them when the pane is narrow enough to wrap the GPU
   below, and as a leading edge beside them when they sit side by side. */
.sysmon-vitals-right {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 300px;
  min-width: 260px;
  border-top: 1px solid var(--border-color);
  padding-top: 10px;
}
/* CPU, Memory, and GPU each read as a titled block so the domains are never
   mistaken for one undifferentiated wall of meters. */
.sysmon-group-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.sysmon-group-sub {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-muted);
}
/* CPU + Memory stack vertically inside the left column, so neither carries a
   horizontal flex basis — they take the column's full width. */
.sysmon-cpu-group,
.sysmon-mem-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sysmon-cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 2px 12px;
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
/* One card per adapter, stacked full-width down the right column. */
.sysmon-gpu {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius, 4px);
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
}
.sysmon-gpu-head {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sysmon-gpu-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sysmon-gpu-meta {
  color: var(--text-muted);
  font-size: 11px;
}
.sysmon-gpu-meters {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sysmon-gpu-sensors {
  margin-top: 0;
  gap: 12px;
}
.sysmon-sensor-na {
  color: var(--text-muted);
  font-weight: 400;
}
.sysmon-gpu-procs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  padding: 8px 10px;
}
.sysmon-gpu-procs-head {
  color: var(--text-secondary);
  font-weight: 600;
  margin-bottom: 3px;
}
.sysmon-gpu-proc {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}
.sysmon-gpu-proc-mem {
  min-width: 62px;
  text-align: right;
  color: var(--text-primary);
  font-weight: 600;
}
.sysmon-gpu-proc-pid {
  min-width: 52px;
  text-align: right;
  color: var(--text-muted);
}
.sysmon-gpu-proc-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The Processes group header: caret toggle + title on the left, count on the right. */
.sysmon-proc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
}
.sysmon-proc-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
}
.sysmon-proc-caret {
  color: var(--text-muted);
  font-size: 10px;
  width: 12px;
  text-align: center;
}
.sysmon-proc-toggle:hover .sysmon-group-title,
.sysmon-proc-toggle:hover .sysmon-proc-caret {
  color: var(--text-primary);
}
.sysmon-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px 6px;
  flex: 0 0 auto;
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
  /* Natural height — the whole body scrolls in the shared .sysmon-scroll region,
     and the table's sticky thead pins to that scroller. */
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
/* The active sort column reads as a distinct vertical band, not just a tinted
   header: a strong accent header and an accent-tinted column body, both bracketed
   by 2px accent edge-lines drawn with an inset box-shadow (so the band gains no
   width and the columns stay aligned). */
.sysmon-table th.sorted {
  background: color-mix(in srgb, var(--accent) 30%, var(--bg-header));
  color: var(--text-primary);
  font-weight: 700;
  box-shadow: inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent);
}
.sysmon-table td.sorted {
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-panel));
  box-shadow: inset 2px 0 0 var(--accent), inset -2px 0 0 var(--accent);
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
/* The per-user breakdown borrows the remote-usage dialog's .remote-usage-users
   grid wholesale (defined in themes.css), so this only positions that panel —
   an indented block below the vitals, not the full-width process scroller. */
.sysmon-users {
  padding: 0 12px 8px;
}
`;
