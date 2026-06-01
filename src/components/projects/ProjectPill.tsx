import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";

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

export function ProjectPill({ project, active, onClick, onClose }: Props) {
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [timeToday, setTimeToday] = useState<number | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);

  const handleMouseEnter = async () => {
    if (!pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    setPopupPos({ x: r.left + r.width / 2, y: r.top });
    try {
      const secs = await invoke<number>("get_time_today", { projectId: project.id });
      setTimeToday(secs);
    } catch {
      setTimeToday(null);
    }
  };

  return (
    <>
      {popupPos && createPortal(
        <div
          className="project-pill-popup"
          style={{ left: popupPos.x, top: popupPos.y }}
        >
          {dir && <span className="pill-popup-path">{dir}</span>}
          <span className={`pill-popup-status ${project.status === "inactive" ? "inactive" : "active"}`}>
            {statusLabel(project.status)}
          </span>
          {timeToday !== null && (
            <span className="pill-popup-time">Today: {formatTime(timeToday)}</span>
          )}
        </div>,
        document.body,
      )}
      <div
        ref={pillRef}
        className={`project-pill ${active ? "active" : ""}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => { setPopupPos(null); setTimeToday(null); }}
      >
        <button className="pill-main" onClick={onClick}>
          <span className="pill-folder-icon" aria-hidden>📁</span>
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
