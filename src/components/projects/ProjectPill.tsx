import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { ActivityCalendar } from "./ActivityCalendar";
import { OrbitSpinner } from "../common/OrbitSpinner";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onReorder: (fromId: string, toId: string) => void;
}

const PILL_DRAG_TYPE = "application/x-eldrun-project";

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

function projectDescription(project: ProjectEntry): string {
  return typeof project.description === "string" ? project.description.trim() : "";
}

function formatCpu(pct: number): string {
  return pct < 0.1 ? "idle" : `${pct.toFixed(1)}%`;
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

function EditDescriptionWindow({
  project,
  onSave,
  onClose,
}: {
  project: ProjectEntry;
  onSave: (description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(projectDescription(project));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(value);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="project-dialog edit-description-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{project.name} — Description</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <textarea
          value={value}
          autoFocus
          placeholder="Short description for this project…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function gitTypeLabel(gitType: unknown): string {
  switch (gitType) {
    case "remote-public":
      return "Remote · public";
    case "remote-private":
      return "Remote · private";
    default:
      return "Local only (no remote)";
  }
}

function PublishWindow({
  project,
  onPublish,
  onClose,
}: {
  project: ProjectEntry;
  onPublish: (visibility: "public" | "private") => Promise<string>;
  onClose: () => void;
}) {
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const output = await onPublish(visibility);
      setResult(output || "Published.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Publish to GitHub</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Current: {gitTypeLabel(project.git_type)}
          {isRemoteWork && " · runs on the work-remote host"}
        </div>
        <label>
          Repository visibility
          <select
            value={visibility}
            disabled={busy || Boolean(result)}
            onChange={(e) => setVisibility(e.target.value as "public" | "private")}
          >
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </label>
        <div className="project-dialog-path">
          Runs <code>gh repo create {project.name} --{visibility} --source=. --push</code>.
          Requires <code>gh</code> installed and authenticated.
        </div>
        {error && <div className="project-dialog-error">{error}</div>}
        {result && <div className="scaffold-empty">{result}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" disabled={busy} onClick={() => void publish()}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectPill({ project, active, onClick, onClose, onReorder }: Props) {
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [timeToday, setTimeToday] = useState<number | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [editDescription, setEditDescription] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);
  const description = projectDescription(project);

  const timerPaused = useTimerStore((s) => s.paused);
  const timerActiveId = useTimerStore((s) => s.activeProjectId);
  const getProjectSecs = useTimerStore((s) => s.getProjectSecs);
  const isLiveProject = timerActiveId === project.id;
  const busy = useActivityStore((s) => s.busyByScope[project.id] ?? false);
  const updateProjectDescription = useProjectsStore((s) => s.updateProjectDescription);
  const publishProject = useProjectsStore((s) => s.publishProject);

  // Live per-project CPU%: polled only while the hover popup is open. Keyed on
  // the project's PTY ids (the backend resolves them to child PIDs + descendants).
  const fetchCpu = useCallback(async () => {
    const tabs = useTabsStore.getState().tabsByScope[project.id] ?? [];
    const ptyIds = tabs.map((t) => t.key);
    if (ptyIds.length === 0) {
      setCpu(null);
      return;
    }
    try {
      setCpu(await invoke<number>("project_cpu_percent", { ptyIds }));
    } catch {
      setCpu(null);
    }
  }, [project.id]);

  useEffect(() => {
    if (!popupPos) return;
    let cancelled = false;
    const run = () => { if (!cancelled) void fetchCpu(); };
    run();
    const id = window.setInterval(run, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [popupPos, fetchCpu]);

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
    setPopupPos({ x: r.left + r.width / 2, y: r.bottom });
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
    // Anchor to the bottom of the pill so the menu opens downward, below the bar
    const y = pillRef.current
      ? pillRef.current.getBoundingClientRect().bottom
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
          {description && <span className="pill-popup-description">{description}</span>}
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
          {cpu !== null && (
            <span className="pill-popup-cpu">CPU: {formatCpu(cpu)}</span>
          )}
        </div>,
        document.body,
      )}

      {/* Right-click context menu */}
      {contextMenu && createPortal(
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
          <button
            onClick={() => {
              setContextMenu(null);
              setEditDescription(true);
            }}
          >
            Edit description
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              setShowPublish(true);
            }}
          >
            Publish to GitHub…
          </button>
        </div>,
        document.body,
      )}

      {/* Activity window */}
      {showActivity && (
        <ActivityWindow project={project} onClose={() => setShowActivity(false)} />
      )}

      {/* Edit description window */}
      {editDescription && (
        <EditDescriptionWindow
          project={project}
          onSave={(desc) => updateProjectDescription(project.id, desc)}
          onClose={() => setEditDescription(false)}
        />
      )}

      {/* Publish-to-GitHub window */}
      {showPublish && (
        <PublishWindow
          project={project}
          onPublish={(visibility) => publishProject(project.id, visibility)}
          onClose={() => setShowPublish(false)}
        />
      )}

      <div
        ref={pillRef}
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}${dragOver ? " drag-over" : ""}${dragging ? " dragging" : ""}`}
        draggable
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => { setPopupPos(null); setTimeToday(null); setCpu(null); }}
        onContextMenu={handleContextMenu}
        onDragStart={(e) => {
          // Hide the hover popup so it doesn't linger as a drag ghost.
          setPopupPos(null);
          setDragging(true);
          e.dataTransfer.setData(PILL_DRAG_TYPE, project.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PILL_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
          if (!fromId || fromId === project.id) return;
          e.preventDefault();
          onReorder(fromId, project.id);
        }}
        onDragEnd={() => { setDragOver(false); setDragging(false); }}
      >
        <button className="pill-main" onClick={onClick}>
          <span className="pill-folder-icon" aria-hidden>{timerPaused ? "⏸" : "📁"}</span>
          <span className="project-pill-label">{project.name}</span>
          {busy && <OrbitSpinner className="pill-running-spinner" />}
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
