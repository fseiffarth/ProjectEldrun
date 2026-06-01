import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useTimerStore } from "../../stores/timer";
import { ActivityCalendar } from "./ActivityCalendar";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}

function statusLabel(status: string): string {
  if (status === "current") return "Current";
  if (status === "active") return "Active";
  return "Inactive";
}

function formatTime(secs: number): string {
  if (secs < 60) return "< 1m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const ORBIT_R = 4;
const ORBIT_DOTS = [0, 120, 240].map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { cx: ORBIT_R * Math.sin(rad), cy: -ORBIT_R * Math.cos(rad) };
});

function OrbitSpinner() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="-6 -6 12 12"
      className="orbit-spinner"
      aria-hidden
    >
      {ORBIT_DOTS.map(({ cx, cy }, i) => (
        <circle key={i} cx={cx} cy={cy} r={1.4} className="orbit-dot" />
      ))}
    </svg>
  );
}

interface ContextMenuPos { x: number; y: number }

function ActivityWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const [data, setData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<Record<string, number>>("get_project_activity", { projectId: project.id })
      .then(setData)
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, [project.id]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="activity-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-window-header">
          <span className="activity-window-title">{project.name} — Activity</span>
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

export function ProjectPill({ project, active, onClick, onClose }: Props) {
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [timeToday, setTimeToday] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);

  const timerPaused = useTimerStore((s) => s.paused);
  const timerActiveId = useTimerStore((s) => s.activeProjectId);
  const getProjectSecs = useTimerStore((s) => s.getProjectSecs);
  const isLiveProject = timerActiveId === project.id;

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [contextMenu]);

  const handleMouseEnter = async () => {
    if (contextMenu) return;
    if (!pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    setPopupPos({ x: r.left + r.width / 2, y: r.top });
    try {
      if (isLiveProject) {
        setTimeToday(getProjectSecs());
      } else {
        const secs = await invoke<number>("get_time_today", { projectId: project.id });
        setTimeToday(secs);
      }
    } catch {
      setTimeToday(null);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPopupPos(null);
    // Anchor to the top of the pill so the menu opens upward, above the bar
    const y = pillRef.current
      ? pillRef.current.getBoundingClientRect().top
      : e.clientY;
    setContextMenu({ x: e.clientX, y });
  };

  return (
    <>
      {/* Hover popup — hidden while context menu is open */}
      {popupPos && !contextMenu && createPortal(
        <div
          className="project-pill-popup"
          style={{ left: popupPos.x, top: popupPos.y }}
        >
          {dir && <span className="pill-popup-path">{dir}</span>}
          <span className={`pill-popup-status ${project.status === "inactive" ? "inactive" : "active"}`}>
            {statusLabel(project.status)}
          </span>
          {timeToday !== null && (
            <span className="pill-popup-time">
              Today: {formatTime(timeToday)}
              {isLiveProject && timerPaused && " (paused)"}
              {isLiveProject && !timerPaused && <OrbitSpinner />}
            </span>
          )}
        </div>,
        document.body,
      )}

      {/* Right-click context menu */}
      {contextMenu && createPortal(
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y, transform: "translateY(-100%)" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setContextMenu(null);
              setShowActivity(true);
            }}
          >
            Show Activity
          </button>
        </div>,
        document.body,
      )}

      {/* Activity window */}
      {showActivity && (
        <ActivityWindow project={project} onClose={() => setShowActivity(false)} />
      )}

      <div
        ref={pillRef}
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => { setPopupPos(null); setTimeToday(null); }}
        onContextMenu={handleContextMenu}
      >
        <button className="pill-main" onClick={onClick}>
          <span className="pill-folder-icon" aria-hidden>{timerPaused ? "⏸" : "📁"}</span>
          <span className="project-pill-label">{project.name}</span>
        </button>
        <button
          className="pill-close-btn"
          title="Close project"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          ×
        </button>
      </div>
    </>
  );
}
