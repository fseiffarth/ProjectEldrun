/**
 * The dev-only perf panel — a floating, non-modal readout over the running
 * app: per-command IPC cost, main-thread stalls, slow React commits and the
 * process-tree resource numbers the backend already measures
 * (`debug_app_resource_usage` / `webview_rss_kib`).
 *
 * DEV-ONLY: mounted from `AppShell` behind `import.meta.env.DEV`, lazily, so
 * neither this file nor its CSS reaches a shipped bundle. Deliberately **not**
 * a `.modal-backdrop` dialog: the whole point is to watch the numbers while
 * using the app, so it must float beside the UI, never block it.
 *
 * English-only on purpose: this surface never ships, so it stays out of the
 * ~3700-key i18n table rather than adding five translations of "avg ms".
 *
 * The panel re-renders on a 1s tick while open instead of subscribing to the
 * monitor's buffers — a per-IPC-call subscription would make the profiler a
 * measurable cost in its own trace. Closed, it costs one keydown listener.
 */

import { useEffect, useState } from "react";
import {
  perfInvoke,
  perfState,
  resetPerf,
  setReactScan,
  SLOW_CALL_MS,
  SLOW_COMMIT_MS,
  IPC_RING_CAP,
  type ReactScanState,
} from "./perfMonitor";
import {
  aggregateCalls,
  fmtBytes,
  fmtClock,
  fmtMs,
  stallSummary,
} from "./perfStats";
import { UntestedTag } from "../components/common/UntestedTag";
import "./devPerf.css";

const RATE_WINDOW_MS = 60_000;
const STALL_WINDOW_MS = 60_000;
const IPC_ROWS_SHOWN = 14;
const RESOURCE_POLL_MS = 2000;

interface ResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
}

export function DevPerfHost() {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const [res, setRes] = useState<ResourceUsage | null>(null);
  const [rendererKib, setRendererKib] = useState<number>(0);
  const [scanState, setScanState] = useState<ReactScanState>(perfState().reactScan);

  // Ctrl+Alt+P toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 1s repaint while open — the buffers are read fresh each render.
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // Resource poll while open, through the unpatched channel (perfInvoke) so
  // the panel's own polling stays out of the IPC table it renders.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const poll = () => {
      perfInvoke<ResourceUsage>("debug_app_resource_usage")
        .then((r) => {
          if (alive) setRes(r);
        })
        .catch(() => undefined);
      perfInvoke<number>("webview_rss_kib")
        .then((kib) => {
          if (alive) setRendererKib(kib);
        })
        .catch(() => undefined);
    };
    poll();
    const t = window.setInterval(poll, RESOURCE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open]);

  if (!open) {
    return (
      <button
        className="dev-perf-fab"
        title="Perf monitor (Ctrl+Alt+P)"
        onClick={() => setOpen(true)}
      >
        ⏱
      </button>
    );
  }

  const st = perfState();
  const now = Date.now();
  const rows = aggregateCalls(st.calls, now, RATE_WINDOW_MS).slice(0, IPC_ROWS_SHOWN);
  const stalls = stallSummary(st.stalls, now, STALL_WINDOW_MS);
  const recentStalls = st.stalls.slice(-8).reverse();
  const slowCalls = st.slow.slice(-10).reverse();
  const commits = st.commits.slice(-8).reverse();
  const scanOn = scanState === "on" || scanState === "on-late";

  const toggleScan = () => {
    const next = !scanOn;
    void setReactScan(next).then(() => setScanState(perfState().reactScan));
  };

  return (
    <div className="dev-perf-panel">
      <div className="dev-perf-head">
        <span className="dev-perf-title">
          Perf monitor <UntestedTag />
        </span>
        <span className="dev-perf-head-actions">
          <button onClick={() => resetPerf()} title="Clear all buffers">
            Reset
          </button>
          <button onClick={() => setOpen(false)} title="Close (Ctrl+Alt+P)">
            ✕
          </button>
        </span>
      </div>

      <div className="dev-perf-body">
        <section>
          <h4>Process tree</h4>
          {res ? (
            <div className="dev-perf-grid">
              <span>CPU</span>
              <span>{res.cpu_percent.toFixed(1)}%</span>
              <span>RSS (all)</span>
              <span>{fmtBytes(res.rss_bytes)}</span>
              <span>Renderer RSS</span>
              <span>{rendererKib > 0 ? fmtBytes(rendererKib * 1024) : "—"}</span>
              <span>Processes</span>
              <span>{res.process_count}</span>
            </div>
          ) : (
            <div className="dev-perf-empty">reading…</div>
          )}
        </section>

        <section>
          <h4>
            Main-thread stalls <small>(last 60s — {st.longTasks ? "longtask + timer lag" : "timer lag only"})</small>
          </h4>
          <div className="dev-perf-grid">
            <span>Stalls</span>
            <span>{stalls.count}</span>
            <span>Worst</span>
            <span>{stalls.worstMs > 0 ? fmtMs(stalls.worstMs) : "—"}</span>
          </div>
          {recentStalls.length > 0 && (
            <ul className="dev-perf-list">
              {recentStalls.map((s, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(s.ts)}</span> blocked ~{fmtMs(s.ms)}
                  <small> ({s.kind})</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4>
            Slow React commits <small>(&gt;{SLOW_COMMIT_MS}ms)</small>
          </h4>
          {commits.length === 0 ? (
            <div className="dev-perf-empty">none recorded</div>
          ) : (
            <ul className="dev-perf-list">
              {commits.map((c, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(c.ts)}</span> {fmtMs(c.ms)}
                  <small> ({c.phase})</small>
                </li>
              ))}
            </ul>
          )}
          <label className="dev-perf-scan">
            <input type="checkbox" checked={scanOn} onChange={toggleScan} />
            <span>
              react-scan render highlighting
              {scanState === "on-late" && <small> — full coverage after reload</small>}
              {scanState === "failed" && <small> — failed to load (see console)</small>}
            </span>
          </label>
        </section>

        <section>
          <h4>
            IPC commands <small>(last {IPC_RING_CAP} calls; rate over 60s; by total time)</small>
          </h4>
          {rows.length === 0 ? (
            <div className="dev-perf-empty">no calls traced yet</div>
          ) : (
            <table className="dev-perf-table">
              <thead>
                <tr>
                  <th>command</th>
                  <th>calls</th>
                  <th>/min</th>
                  <th>avg</th>
                  <th>max</th>
                  <th>total</th>
                  <th>err</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cmd}>
                    <td className="mono">{r.cmd}</td>
                    <td>{r.count}</td>
                    <td>{r.perMin >= 10 ? Math.round(r.perMin) : r.perMin.toFixed(1)}</td>
                    <td>{fmtMs(r.avgMs)}</td>
                    <td>{fmtMs(r.maxMs)}</td>
                    <td>{fmtMs(r.totalMs)}</td>
                    <td>{r.errors > 0 ? r.errors : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h4>
            Slow IPC calls <small>(&gt;{SLOW_CALL_MS}ms, newest first)</small>
          </h4>
          {slowCalls.length === 0 ? (
            <div className="dev-perf-empty">none recorded</div>
          ) : (
            <ul className="dev-perf-list">
              {slowCalls.map((c, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(c.ts)}</span>{" "}
                  <span className="mono">{c.cmd}</span> {fmtMs(c.ms)}
                  {c.argBytes !== null && c.argBytes > 2048 && (
                    <small> — {fmtBytes(c.argBytes)} args</small>
                  )}
                  {!c.ok && <small> — failed</small>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
