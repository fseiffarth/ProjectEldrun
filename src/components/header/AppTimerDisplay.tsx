import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useTimerStore } from "../../stores/timer";
import { ActivityCalendar } from "../projects/ActivityCalendar";

function formatTime(secs: number): string {
  if (secs < 60) return "< 1m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function GlobalActivityWindow({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<Record<string, number>>("get_project_activity", { projectId: "" })
      .then(setData)
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="activity-window" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-window-header">
          <span className="activity-window-title">Global Activity</span>
          <button className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="activity-window-body">
          {loading ? (
            <div className="activity-loading">Loading…</div>
          ) : (
            <ActivityCalendar data={data} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AppTimerDisplay() {
  const paused = useTimerStore((s) => s.paused);
  const toggle = useTimerStore((s) => s.toggle);
  const [displayText, setDisplayText] = useState("< 1m");
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    const update = () => {
      setDisplayText(formatTime(useTimerStore.getState().getAppSecs()));
    };
    update();
    if (paused) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <>
      <button
        className={`app-timer-btn${paused ? " paused" : ""}`}
        title={`Today: ${displayText}${paused ? "\nPaused — click to resume" : "\nClick to pause • Right-click for activity"}`}
        onClick={() => void toggle()}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowActivity(true);
        }}
      >
        <span className="app-timer-dot" />
        <span className="app-timer-text">{displayText}</span>
      </button>
      {showActivity && <GlobalActivityWindow onClose={() => setShowActivity(false)} />}
    </>
  );
}
