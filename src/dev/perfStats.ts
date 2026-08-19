/**
 * Pure logic for the dev-only perf monitor (`src/dev/perfMonitor.ts`) — ring
 * buffers, aggregation and formatting, with no window, no clock and no Tauri,
 * so "does the IPC table add up" is answered by a unit test rather than by
 * staring at a live panel (`src/__tests__/DevPerf.test.ts`).
 *
 * Everything here is DEV-ONLY by construction: the only importers sit behind
 * `import.meta.env.DEV` guards, so none of it reaches a shipped bundle.
 */

/** One completed IPC round trip, as the tracer recorded it. */
export interface IpcCall {
  cmd: string;
  /** Wall-clock ms (Date.now) — for display. */
  ts: number;
  /** Duration in ms (performance.now delta). */
  ms: number;
  ok: boolean;
}

/** A call slow enough to keep individually, with its payload size if known. */
export interface SlowIpcCall extends IpcCall {
  /** JSON size of the args, or null when they could not be measured. */
  argBytes: number | null;
}

/** A main-thread stall: either measured timer lag or a `longtask` entry. */
export interface Stall {
  ts: number;
  ms: number;
  kind: "lag" | "longtask";
}

/** A slow React commit, recorded by the dev <Profiler> around the app. */
export interface SlowCommit {
  ts: number;
  ms: number;
  phase: string;
}

/** One row of the per-command IPC table. */
export interface CmdRow {
  cmd: string;
  count: number;
  /** Calls per minute over the rate window, not over the whole buffer. */
  perMin: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  errors: number;
}

/**
 * Append to a bounded ring: past `cap`, the oldest entry falls out. Mutates
 * in place — the buffers live on a window global so they survive HMR, and
 * replacing the array would strand old references.
 */
export function pushRing<T>(arr: T[], item: T, cap: number): void {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/**
 * Fold the call buffer into one row per command, sorted by total time spent —
 * "which command is costing the most", which is the question the panel exists
 * to answer. Totals cover the whole (bounded) buffer; `perMin` covers only
 * the trailing `rateWindowMs`, so a burst at startup does not read as a
 * standing poll an hour later.
 */
export function aggregateCalls(
  calls: IpcCall[],
  now: number,
  rateWindowMs: number,
): CmdRow[] {
  const byCmd = new Map<string, CmdRow & { recent: number }>();
  for (const c of calls) {
    let row = byCmd.get(c.cmd);
    if (!row) {
      row = { cmd: c.cmd, count: 0, perMin: 0, totalMs: 0, avgMs: 0, maxMs: 0, errors: 0, recent: 0 };
      byCmd.set(c.cmd, row);
    }
    row.count += 1;
    row.totalMs += c.ms;
    if (c.ms > row.maxMs) row.maxMs = c.ms;
    if (!c.ok) row.errors += 1;
    if (now - c.ts <= rateWindowMs) row.recent += 1;
  }
  const rows: CmdRow[] = [];
  for (const r of byCmd.values()) {
    rows.push({
      cmd: r.cmd,
      count: r.count,
      perMin: rateWindowMs > 0 ? (r.recent * 60_000) / rateWindowMs : 0,
      totalMs: r.totalMs,
      avgMs: r.count > 0 ? r.totalMs / r.count : 0,
      maxMs: r.maxMs,
      errors: r.errors,
    });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  return rows;
}

/** How rough the last `windowMs` were: stall count and the worst single one. */
export function stallSummary(
  stalls: Stall[],
  now: number,
  windowMs: number,
): { count: number; worstMs: number } {
  let count = 0;
  let worstMs = 0;
  for (const s of stalls) {
    if (now - s.ts > windowMs) continue;
    count += 1;
    if (s.ms > worstMs) worstMs = s.ms;
  }
  return { count, worstMs };
}

/** Compact duration: "0.4ms", "12ms", "1.3s". */
export function fmtMs(ms: number): string {
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

/** Compact byte count: "312B", "4.2KB", "1.8MB". */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${Math.round(bytes)}B`;
}

/** Wall-clock HH:MM:SS for a stall/call row (dev tool: always 24h). */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
