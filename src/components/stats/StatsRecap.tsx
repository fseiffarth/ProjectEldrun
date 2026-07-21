import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";

import { APP_TIMER_ID } from "../../stores/timer";
import { ROOT_SCOPE, useUsageStore, type GitStats } from "../../stores/usage";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { METRIC, agentLabel } from "../../lib/usageMetrics";
import {
  breakdown,
  dayKey,
  periodKeys,
  totalOf,
  type Counters,
  type Period,
} from "../../lib/usageRollup";
import { formatBytes, type ByteCounts, type NetUsageReport } from "../monitoring/NetworkTrafficPane";
import { Toggle } from "../common/Toggle";

/** Human duration, matching the header timer's phrasing. */
function formatTime(secs: number): string {
  if (secs < 60) return secs > 0 ? "< 1m" : "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** `n thing` / `n things` — the recap reads as a sentence, so it must agree. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const DAY_MS = 86_400_000;

/** One headline number. */
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stats-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/** A labelled bar in a breakdown list, sized against the largest row. */
function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="stats-bar-row">
      <span className="stats-bar-label" title={label}>{label}</span>
      <span className="stats-bar-track">
        <span className="stats-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="stats-bar-value">{suffix ?? value}</span>
    </div>
  );
}

/**
 * Per-hour sparkline over a day's 24 UTC hour buckets — hand-rolled SVG, like
 * every other graph in Eldrun (there is no chart dependency, and this is not the
 * place to add one). Only meaningful for the Day period.
 */
function HourSparkline({ hours, anchorMs }: { hours: Record<string, Counters>; anchorMs: number }) {
  const date = dayKey(anchorMs);
  const values = Array.from({ length: 24 }, (_, h) => {
    const bucket = hours[`${date}T${String(h).padStart(2, "0")}`] ?? {};
    // "Activity" here is everything the user did that hour, agent and shell alike.
    return (
      totalOf(breakdown(bucket, METRIC.AGENT_PROMPT)) + (bucket[METRIC.SHELL_COMMAND] ?? 0)
    );
  });
  const max = Math.max(1, ...values);
  const busiest = values.indexOf(Math.max(...values));
  const width = 600;
  const height = 60;
  const barW = width / 24;

  if (max <= 1 && values.every((v) => v === 0)) return null;

  return (
    <div className="stats-spark-wrap">
      <svg
        className="stats-spark"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Activity by hour of day (UTC)"
      >
        {values.map((v, h) => (
          <rect
            key={h}
            x={h * barW + 1}
            y={height - (v / max) * height}
            width={barW - 2}
            height={(v / max) * height}
            className={h === busiest ? "stats-spark-bar busiest" : "stats-spark-bar"}
          />
        ))}
      </svg>
      <div className="stats-spark-legend">
        <span>busiest hour {String(busiest).padStart(2, "0")}:00 UTC</span>
        <span className="stats-spark-scale">peak {max}</span>
      </div>
    </div>
  );
}

interface Props {
  onClose: () => void;
  /** Which day the recap opens on. The startup recap anchors on yesterday — the
   *  day that actually finished; opened from Settings it anchors on today. */
  initialAnchorMs: number;
  /** Shown only when the recap opened by itself, since it is the thing that
   *  turns that off. */
  showAutoToggle: boolean;
}

export function StatsRecap({ onClose, initialAnchorMs, showAutoToggle }: Props) {
  const [period, setPeriod] = useState<Period>("day");
  const [anchorMs] = useState(initialAnchorMs);
  const [timeByDay, setTimeByDay] = useState<Record<string, Record<string, number>>>({});
  const [net, setNet] = useState<NetUsageReport>({ hours: {}, days: {} });
  const [git, setGit] = useState<GitStats | null>(null);

  const report = useUsageStore((s) => s.report);
  const loadUsage = useUsageStore((s) => s.load);
  const projects = useProjectsStore((s) => s.projects);
  const autoOn = useSettingsStore((s) => s.settings?.daily_stats_recap ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  useEffect(() => {
    void loadUsage();
    void invoke<Record<string, Record<string, number>>>("get_time_activity_all")
      .then(setTimeByDay)
      .catch(() => setTimeByDay({}));
    void invoke<NetUsageReport>("get_net_usage", { projectId: "" })
      .then(setNet)
      .catch(() => setNet({ hours: {}, days: {} }));
  }, [loadUsage]);

  const keys = useMemo(() => periodKeys(period, anchorMs), [period, anchorMs]);

  // Git is derived on demand (never stored), so it is re-read whenever the window
  // moves. `since` is the first day of the period; a remote project reports zero
  // rather than stalling the dialog on an unreachable host.
  useEffect(() => {
    const since = keys[0];
    const dirs = projects.map((p) => p.directory).filter((d): d is string => !!d);
    let cancelled = false;
    void Promise.all(
      dirs.map((dir) =>
        invoke<GitStats>("usage_git_stats", { projectDir: dir, since }).catch(
          () => null,
        ),
      ),
    ).then((all) => {
      if (cancelled) return;
      setGit(
        all.filter((g): g is GitStats => !!g).reduce(
          (acc, g) => ({
            commits: acc.commits + g.commits,
            filesChanged: acc.filesChanged + g.filesChanged,
            linesAdded: acc.linesAdded + g.linesAdded,
            linesRemoved: acc.linesRemoved + g.linesRemoved,
          }),
          { commits: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
        ),
      );
    });
    return () => { cancelled = true; };
  }, [keys, projects]);

  // ── The numbers ─────────────────────────────────────────────────────────
  const counters: Counters = useMemo(() => {
    const acc: Counters = {};
    for (const key of keys) {
      for (const [metric, n] of Object.entries(report?.days?.[key] ?? {})) {
        acc[metric] = (acc[metric] ?? 0) + n;
      }
    }
    return acc;
  }, [report, keys]);

  // `agent.tab` must not swallow `agent.tab.local.*` — a local model is its own
  // namespace, and folding it here would count every local tab twice.
  const tabsByAgent = breakdown(counters, METRIC.AGENT_TAB, [METRIC.AGENT_TAB_LOCAL]);
  const localTabs = breakdown(counters, METRIC.AGENT_TAB_LOCAL);
  const activeByAgent = breakdown(counters, METRIC.AGENT_ACTIVE);
  const promptsByAgent = breakdown(counters, METRIC.AGENT_PROMPT);

  const usedTabs = totalOf(activeByAgent);
  const prompts = totalOf(promptsByAgent);
  const openedTabs = totalOf(tabsByAgent) + totalOf(localTabs);

  // The per-model view merges cloud agents and local models into one ranking —
  // "which models did I work with" is one question, not two.
  const byModel: Record<string, number> = {};
  for (const [leaf, n] of Object.entries(activeByAgent)) {
    byModel[agentLabel(leaf)] = (byModel[agentLabel(leaf)] ?? 0) + n;
  }

  // Time per project, over the same window.
  const secsByProject: Record<string, number> = {};
  for (const key of keys) {
    for (const [pid, secs] of Object.entries(timeByDay[key] ?? {})) {
      // The app's own total is tracked under a pseudo-project; it is the whole
      // session, not a project, so it must not appear as one in the ranking.
      if (pid === APP_TIMER_ID) continue;
      secsByProject[pid] = (secsByProject[pid] ?? 0) + secs;
    }
  }
  const appSecs = keys.reduce((sum, k) => sum + (timeByDay[k]?.[APP_TIMER_ID] ?? 0), 0);
  const projectName = (id: string) =>
    id === ROOT_SCOPE ? "Root terminal" : projects.find((p) => p.id === id)?.name ?? id;
  const rankedProjects = Object.entries(secsByProject)
    .filter(([, secs]) => secs > 0)
    .sort((a, b) => b[1] - a[1]);

  const bytes: ByteCounts = keys.reduce<ByteCounts>(
    (acc, key) => {
      const c = net.days?.[key];
      return { rx: acc.rx + (c?.rx ?? 0), tx: acc.tx + (c?.tx ?? 0) };
    },
    { rx: 0, tx: 0 },
  );

  const created = counters[METRIC.FILE_CREATED] ?? 0;
  const modified = counters[METRIC.FILE_MODIFIED] ?? 0;
  const deleted = counters[METRIC.FILE_DELETED] ?? 0;
  const shellCommands = counters[METRIC.SHELL_COMMAND] ?? 0;
  const workedS = counters[METRIC.AGENT_WORKED_S] ?? 0;
  const decisions = counters[METRIC.AGENT_DECISION] ?? 0;

  const label = period === "day" ? dayLabel(anchorMs) : period === "week" ? "This week" : "This month";
  const empty = openedTabs + prompts + shellCommands + created + modified + deleted === 0;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="stats-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Your work in Eldrun</h2>
          <div className="stats-period-switch" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={period === p.id ? "stats-period-btn active" : "stats-period-btn"}
                onClick={() => setPeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="dialog-scroll">
        <p className="settings-help stats-window-label">{label}</p>

        {empty ? (
          <p className="stats-empty">
            Nothing recorded for this period yet. Open an agent, run a command, edit a
            file — it will show up here.
          </p>
        ) : (
          <>
            {/* ── Agents ───────────────────────────────────────────────── */}
            <div className="settings-section-title">Agents</div>
            <p className="stats-headline">
              You used <strong>{plural(usedTabs, "agent tab")}</strong>, asking them{" "}
              <strong>{plural(prompts, "thing")}</strong>.
            </p>
            {Object.keys(byModel).length > 0 && (
              <div className="stats-bars">
                {Object.entries(byModel)
                  .sort((a, b) => b[1] - a[1])
                  .map(([model, n]) => (
                    <Bar key={model} label={model} value={n} max={Math.max(...Object.values(byModel))} />
                  ))}
              </div>
            )}
            <div className="stats-metrics">
              <Metric label="Agent tabs opened" value={String(openedTabs)} />
              <Metric
                label="Agents working"
                value={formatTime(workedS)}
                sub="summed across tabs"
              />
              <Metric
                label="Stopped to ask you"
                value={String(decisions)}
                sub={decisions === 1 ? "time" : "times"}
              />
            </div>

            {/* ── Work per project ─────────────────────────────────────── */}
            <div className="settings-section-title">Work</div>
            {rankedProjects.length > 0 ? (
              <div className="stats-bars">
                {rankedProjects.map(([pid, secs]) => (
                  <Bar
                    key={pid}
                    label={projectName(pid)}
                    value={secs}
                    max={rankedProjects[0][1]}
                    suffix={formatTime(secs)}
                  />
                ))}
              </div>
            ) : (
              <p className="settings-help">No tracked time in this period.</p>
            )}
            <div className="stats-metrics">
              <Metric label="Eldrun open" value={formatTime(appSecs)} />
              <Metric label="Commands run" value={String(shellCommands)} sub="in shell tabs" />
              <Metric label="Network" value={`↓ ${formatBytes(bytes.rx)}`} sub={`↑ ${formatBytes(bytes.tx)}`} />
            </div>

            {/* ── Files ────────────────────────────────────────────────── */}
            <div className="settings-section-title">Files</div>
            <div className="stats-metrics">
              <Metric label="Created" value={String(created)} />
              <Metric label="Modified" value={String(modified)} />
              <Metric label="Deleted" value={String(deleted)} />
              {git && (
                <Metric
                  label="Committed"
                  value={plural(git.commits, "commit")}
                  sub={`+${git.linesAdded} −${git.linesRemoved}`}
                />
              )}
            </div>
            <p className="settings-help">
              File counts come from watching your project tree, so they cover only local
              files — a remote project is counted through its local mirror, and one
              without a mirror records nothing. Commits are counted from git, for commits
              you authored.
            </p>

            {/* ── Rhythm ───────────────────────────────────────────────── */}
            {period === "day" && report?.hours && (
              <>
                <div className="settings-section-title">Rhythm</div>
                <HourSparkline hours={report.hours} anchorMs={anchorMs} />
              </>
            )}
          </>
        )}

        {showAutoToggle && (
          <label className="settings-switch-row stats-auto-row">
            <span>Show this at the start of each day</span>
            <Toggle
              checked={autoOn}
              onChange={(e) => void updateSettings({ daily_stats_recap: e.target.checked })}
            />
          </label>
        )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "Yesterday" / "Today" / the date, for the Day window's caption. */
function dayLabel(anchorMs: number): string {
  const today = dayKey(Date.now());
  const anchor = dayKey(anchorMs);
  if (anchor === today) return "Today";
  if (anchor === dayKey(Date.now() - DAY_MS)) return "Yesterday";
  return anchor;
}
