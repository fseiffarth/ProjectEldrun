import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  resolveProjectDirectory,
  resolveLocalMirror,
  formatRemoteTarget,
  type GitHostingInfo,
  type GitProvider,
  type ProjectEntry,
} from "../../types";
import { useTimerStore } from "../../stores/timer";
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useGitDirtyStore, type GitDirtyState } from "../../stores/gitDirty";
import { ActivityCalendar } from "./ActivityCalendar";
import { CategoryEditor } from "./CategoryEditor";
import { ExtendToRemoteDialog } from "./ExtendToRemoteDialog";
import { OrbitSpinner } from "../common/OrbitSpinner";
import { FolderPickerDialog } from "../common/FolderPickerDialog";
import { RemoteConnMenu } from "../header/RemoteConnMenu";
import { categoryColor, primaryCategoryColor, projectCategories } from "../../lib/categoryColor";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onReorder: (fromId: string, toId: string) => void;
  /** Alt-drop one pill onto another: box the two projects together. */
  onGroup?: (fromId: string, toId: string) => void;
  /** Set when this pill is a member of a box (id of that box). */
  boxId?: string;
  /** Dragging the pill out of its box and releasing over empty space removes it. */
  onLeaveBox?: (projectId: string) => void;
}

export const PILL_DRAG_TYPE = "application/x-eldrun-project";

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

/** Folder-icon title/color per git state — mirrors the file-tree markers'
 *  priority (red ▸ orange ▸ green), plus a neutral "clean" default. */
const GIT_ICON_TITLE: Record<GitDirtyState, string> = {
  clean: "No pending changes",
  dirty: "Uncommitted changes — not yet added",
  staged: "Staged changes — not yet committed",
  unpushed: "Committed — not yet pushed",
};

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

function RenameWindow({
  project,
  onSave,
  onClose,
}: {
  project: ProjectEntry;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!value.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (err) {
      setError(String(err));
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
          <h2>Rename project</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <input
          type="text"
          value={value}
          autoFocus
          placeholder="Project name…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <div className="project-dialog-error">{error}</div>}
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

/** Display name for a hosting provider. */
function providerName(provider: unknown): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

function gitTypeLabel(gitType: unknown, provider?: unknown): string {
  switch (gitType) {
    case "remote-public":
      return `${providerName(provider)} · public`;
    case "remote-private":
      return `${providerName(provider)} · private`;
    case "none":
      return "No git (no repo)";
    default:
      return "Local repo (not pushed)";
  }
}

/** Best-effort guess at the provider for a not-yet-published project: an
 *  explicit prior provider wins, else sniff the profile URL host, else GitHub. */
function guessProvider(project: ProjectEntry): GitProvider {
  if (project.git_provider === "github" || project.git_provider === "gitlab") {
    return project.git_provider;
  }
  if (project.git_profile_url?.toLowerCase().includes("gitlab")) return "gitlab";
  return "github";
}

function PublishWindow({
  project,
  onPublish,
  onClose,
}: {
  project: ProjectEntry;
  onPublish: (provider: GitProvider, visibility: "public" | "private") => Promise<string>;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<GitProvider>(() => guessProvider(project));
  const [visibility, setVisibility] = useState<"public" | "private">(
    project.git_type === "remote-public" ? "public" : "private",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const isRemoteWork = Boolean(project.remote);
  // The CLI the chosen provider drives, surfaced in the command preview/help.
  const cli = provider === "gitlab" ? "glab" : "gh";
  const createPreview =
    provider === "gitlab"
      ? `glab repo create ${project.name} --${visibility} --remoteName origin && git push`
      : `gh repo create ${project.name} --${visibility} --source=. --push`;

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const output = await onPublish(provider, visibility);
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
          <h2>{project.name} — Publish to {providerName(provider)}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Current: {gitTypeLabel(project.git_type, project.git_provider)}
          {isRemoteWork && " · runs on the work-remote host"}
        </div>
        <label>
          Hosting provider
          <select
            value={provider}
            disabled={busy || Boolean(result)}
            onChange={(e) => setProvider(e.target.value as GitProvider)}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
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
          Runs <code>{createPreview}</code>. Requires <code>{cli}</code> installed and
          authenticated (or a token under ⚙ Settings → Git hosting).
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

function GitHostingWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const getProjectGitHosting = useProjectsStore((s) => s.getProjectGitHosting);
  const setProjectGitHosting = useProjectsStore((s) => s.setProjectGitHosting);
  const [info, setInfo] = useState<GitHostingInfo | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [newToken, setNewToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getProjectGitHosting(project.id)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setProfileUrl(i.profile_url ?? "");
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id, getProjectGitHosting]);

  // A typed token always wins over a "remove" request, so clearing only applies
  // when the user hasn't also entered a replacement.
  const effectiveClear = clearToken && !newToken.trim();

  const tokenStatus = (() => {
    if (newToken.trim()) return "Will set a project token (overrides global).";
    if (effectiveClear) return "Will remove the project token; reverts to the global one.";
    if (info?.has_token) return "A project token is set (hidden). Leave blank to keep it.";
    if (info?.has_global_token) return "Inherits the global token.";
    return "No token set — pushes use your system git credentials.";
  })();

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await setProjectGitHosting(project.id, {
        profileUrl: profileUrl.trim() || null,
        token: newToken.trim() || null,
        clearToken: effectiveClear,
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const globalUrl = info?.global_profile_url ?? "";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Git hosting</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-path">
          Overrides the global git hosting for this project only. Leave fields blank
          to inherit the global settings.
        </div>

        <label>
          Profile URL
          <input
            type="text"
            value={profileUrl}
            placeholder={
              globalUrl ? `Inherits global: ${globalUrl}` : "https://github.com/me or https://gitlab.com/me"
            }
            onChange={(e) => setProfileUrl(e.target.value)}
          />
        </label>

        <label>
          {info?.has_token ? "Replace access token" : "Access token"}
          <input
            type="password"
            value={newToken}
            placeholder={info?.has_token ? "Enter a new token to replace…" : "ghp_… / glpat-…"}
            onChange={(e) => {
              setNewToken(e.target.value);
              if (e.target.value) setClearToken(false);
            }}
          />
        </label>
        <div className="project-dialog-path">{tokenStatus}</div>
        {info?.has_token && !newToken.trim() && (
          <label className="settings-switch-row">
            <span>Remove the project token (use global)</span>
            <input
              type="checkbox"
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
            />
          </label>
        )}

        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving || !info}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DisableGitWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Require the exact project name to arm the destructive button.
  const armed = typed.trim() === project.name.trim() && !busy;

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{project.name} — Remove git &amp; history</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="project-dialog-error">
          This permanently deletes this project's <code>.git</code> directory —
          every commit, branch, stash, and remote. <strong>It cannot be undone.</strong>
          {" "}The project becomes a “No git (no repo)” project; your working
          files are left untouched.
        </div>
        <label>
          Type the project name <code>{project.name}</code> to confirm
          <input
            type="text"
            value={typed}
            autoFocus
            placeholder={project.name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            onClick={() => void run()}
            disabled={!armed}
          >
            {busy ? "Removing…" : "Delete git history"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Simple (reversible) confirm for deleting a project to the archive. Permanent
 *  deletion lives behind a typed-confirm in Settings → Archived projects. */
function ArchiveConfirmWindow({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectEntry;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Delete {project.name}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          This disconnects <strong>{project.name}</strong> and moves it to the
          Eldrun archive. You can restore it — or permanently delete it — later
          from <em>Settings → Archived projects</em>.
          {project.remote && (
            <> The files on the remote host are <strong>not</strong> touched.</>
          )}
        </p>
        {error && <div className="project-dialog-error">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            autoFocus
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete to archive"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectPill({ project, active, onClick, onClose, onReorder, onGroup, boxId, onLeaveBox }: Props) {
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [timeToday, setTimeToday] = useState<number | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [editDescription, setEditDescription] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showGitHosting, setShowGitHosting] = useState(false);
  const [showDisableGit, setShowDisableGit] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [editCategories, setEditCategories] = useState(false);
  const [extendRemote, setExtendRemote] = useState(false);
  // When set, the in-app "Move project…" folder browser is open, seeded at this
  // parent directory. `null` = closed.
  const [movePickerInitial, setMovePickerInitial] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // True while an Alt-drag hovers this pill: the drop will box the two
  // projects together rather than reorder. Drives the distinct hover affordance.
  const [groupHint, setGroupHint] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dir = resolveProjectDirectory(project);
  const localMirror = resolveLocalMirror(project);
  const description = projectDescription(project);
  const categories = projectCategories(project);
  const catColor = primaryCategoryColor(categories);

  const timerPaused = useTimerStore((s) => s.paused);
  const timerActiveId = useTimerStore((s) => s.activeProjectId);
  const getProjectSecs = useTimerStore((s) => s.getProjectSecs);
  const isLiveProject = timerActiveId === project.id;
  const busy = useActivityStore((s) => s.busyByScope[project.id] ?? false);
  const gitDirty = useGitDirtyStore((s) => s.byId[project.id]);
  const updateProjectDescription = useProjectsStore((s) => s.updateProjectDescription);
  const renameProject = useProjectsStore((s) => s.renameProject);
  const moveRemoteMirror = useProjectsStore((s) => s.moveRemoteMirror);
  const setProjectSandbox = useProjectsStore((s) => s.setProjectSandbox);
  const setProjectGitDisabled = useProjectsStore((s) => s.setProjectGitDisabled);
  const repairProjectScaffold = useProjectsStore((s) => s.repairProjectScaffold);
  const publishProject = useProjectsStore((s) => s.publishProject);
  const archiveProject = useProjectsStore((s) => s.archiveProject);

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

  // Reveal the project on disk. Local projects open their working directory; a
  // remote (SSH) project has no local tree, so we open its local mirror — the
  // paired connected working copy. If that mirror folder was deleted, let the
  // user freely pick a new location (defaulting to an ssh/<name> subfolder of the
  // projects root), which the backend re-creates and persists.
  const revealOnDisk = useCallback(async () => {
    try {
      let path: string | undefined = dir;
      if (project.remote) {
        const status = await invoke<{ path: string; exists: boolean; suggested: string }>(
          "remote_mirror_status",
          { projectId: project.id, name: project.name },
        );
        path = status.path;
        if (!status.exists) {
          const chosen = await open({
            directory: true,
            defaultPath: status.suggested,
            title: `${project.name} — choose a local mirror folder`,
          });
          if (typeof chosen !== "string") return; // cancelled
          path = await invoke<string>("set_remote_mirror_dir", {
            projectId: project.id,
            path: chosen,
          });
        }
      }
      if (!path) return;
      await invoke("open_in_file_manager", { path });
    } catch (e) {
      console.error("show on disk", e);
    }
  }, [project.remote, project.id, project.name, dir]);

  // Relocate a remote project's local mirror folder. Opens the in-app folder
  // browser (not the OS chooser) seeded at the current mirror's parent; the user
  // browses to a *parent* directory and the backend moves the mirror (and its
  // bytes) to `<parent>/<name>`, re-pointing the pointer. The confirm handler
  // (below, on the dialog) runs the move.
  const moveMirror = useCallback(async () => {
    if (!project.remote) return;
    try {
      const status = await invoke<{ path: string; exists: boolean; suggested: string }>(
        "remote_mirror_status",
        { projectId: project.id, name: project.name },
      );
      const parentOf = (p: string): string => {
        const trimmed = p.replace(/[/\\]+$/, "");
        const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
        return idx > 0 ? trimmed.slice(0, idx) : trimmed;
      };
      setMovePickerInitial(parentOf(status.exists ? status.path : status.suggested));
    } catch (e) {
      console.error("move mirror", e);
      // Fall back to opening the picker at the home default (empty path).
      setMovePickerInitial("");
    }
  }, [project.remote, project.id, project.name]);

  // Confirm handler for the in-app move picker: relocate the mirror into the
  // chosen parent, patch in-memory state (moveRemoteMirror), and close.
  const confirmMove = useCallback(
    async (parent: string, name?: string) => {
      setMovePickerInitial(null);
      try {
        // The chosen name defines the new local mirror folder (backend
        // sanitizes it); fall back to the display name when left blank.
        await moveRemoteMirror(project.id, name?.trim() || project.name, parent);
      } catch (e) {
        console.error("move mirror", e);
      }
    },
    [project.id, project.name, moveRemoteMirror],
  );

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
          {project.remote ? (
            <>
              <span className="pill-popup-path-row">
                <span className="pill-popup-path-label">remote</span>
                <span className="pill-popup-path">{formatRemoteTarget(project.remote)}</span>
              </span>
              {localMirror && (
                <span className="pill-popup-path-row">
                  <span className="pill-popup-path-label">local</span>
                  <span className="pill-popup-path">{localMirror}</span>
                </span>
              )}
            </>
          ) : (
            dir && <span className="pill-popup-path">{dir}</span>
          )}
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
          {/* View / inspect */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">View</div>
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
                void revealOnDisk();
              }}
              title={
                project.remote
                  ? "Open the local mirror (the connected working copy) in the file manager"
                  : "Open the project directory in the file manager"
              }
            >
              Show on disk
            </button>
          </div>

          {/* Edit metadata */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Edit</div>
            <button
              onClick={() => {
                setContextMenu(null);
                setRenaming(true);
              }}
            >
              Rename…
            </button>
            {project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  void moveMirror();
                }}
                title="Move this project's local mirror (the connected working copy) to a new folder"
              >
                Move project…
              </button>
            )}
            {!project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setExtendRemote(true);
                }}
                title="Attach a remote SSH host to this local project — files stay put; push them up manually"
              >
                Extend to remote…
              </button>
            )}
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
                setEditCategories(true);
              }}
              title="Tag this project to color and group it in the cloud and the pill bar"
            >
              Categories…
            </button>
          </div>

          {/* Git */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Git</div>
            {project.git_type === "none" ? (
              !project.remote && (
                <button
                  onClick={() => {
                    setContextMenu(null);
                    void setProjectGitDisabled(project.id, false);
                  }}
                  title="Run git init to start version-controlling this project"
                >
                  Enable git (git init)
                </button>
              )
            ) : (
              <>
                <button
                  onClick={() => {
                    setContextMenu(null);
                    setShowPublish(true);
                  }}
                >
                  Publish to GitHub / GitLab…
                </button>
                {typeof project.git_type === "string" && project.git_type.startsWith("remote") && (
                  <button
                    onClick={() => {
                      setContextMenu(null);
                      setShowGitHosting(true);
                    }}
                    title="Override the global git hosting (profile URL + token) for this project only"
                  >
                    Git hosting…
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => {
                setContextMenu(null);
                void repairProjectScaffold(project.id);
              }}
              title="Fill in any missing scaffold file, default .gitignore pattern, or .claude/settings.json — never overwrites existing content"
            >
              Repair scaffold files
            </button>
          </div>

          {/* Runtime */}
          <div className="context-menu-group">
            <div className="context-menu-group-label">Runtime</div>
            {!project.remote && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  void setProjectSandbox(project.id, !project.sandbox?.enabled);
                }}
                title="Run this project's agent tabs inside a Docker container that mounts only the project directory"
              >
                {project.sandbox?.enabled ? "✓ " : ""}Run agents in Docker sandbox
              </button>
            )}
            <button
              onClick={() => {
                setContextMenu(null);
                // Clear this project's tabs in memory. For the ACTIVE project the
                // debounced saveLayout effect persists the empty layout; for a
                // non-active project nothing else writes it, so persist explicitly.
                useTabsStore.getState().closeAllTabs(project.id);
                if (project.local_file) {
                  void invoke("save_tab_layout", {
                    localFile: project.local_file,
                    tabs: [],
                    groups: null,
                    sessions: [],
                  }).catch(() => {});
                }
              }}
            >
              Close all tabs
            </button>
          </div>

          {/* Danger zone — irreversible / destructive actions, fenced off */}
          <div className="context-menu-danger-zone">
            <div className="context-menu-group-label">Danger zone</div>
            {!project.remote && project.git_type !== "none" && (
              <button
                className="danger"
                onClick={() => {
                  setContextMenu(null);
                  setShowDisableGit(true);
                }}
                title="Delete this project's .git directory and all version-control history (cannot be undone)"
              >
                Remove git &amp; history…
              </button>
            )}
            <button
              className="danger"
              onClick={() => {
                setContextMenu(null);
                setShowArchive(true);
              }}
              title="Disconnect this project and move it to the Eldrun archive. Restore or permanently delete it later from Settings. A remote host's files are never touched."
            >
              Delete project…
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Activity window */}
      {showActivity && (
        <ActivityWindow project={project} onClose={() => setShowActivity(false)} />
      )}

      {/* Rename window */}
      {renaming && (
        <RenameWindow
          project={project}
          onSave={(name) => renameProject(project.id, name)}
          onClose={() => setRenaming(false)}
        />
      )}

      {/* Edit description window */}
      {editDescription && (
        <EditDescriptionWindow
          project={project}
          onSave={(desc) => updateProjectDescription(project.id, desc)}
          onClose={() => setEditDescription(false)}
        />
      )}

      {/* Publish-to-GitHub/GitLab window */}
      {showPublish && (
        <PublishWindow
          project={project}
          onPublish={(provider, visibility) => publishProject(project.id, provider, visibility)}
          onClose={() => setShowPublish(false)}
        />
      )}

      {/* Per-project git-hosting override window */}
      {showGitHosting && (
        <GitHostingWindow project={project} onClose={() => setShowGitHosting(false)} />
      )}

      {/* Category-tag editor */}
      {editCategories && (
        <CategoryEditor project={project} onClose={() => setEditCategories(false)} />
      )}

      {/* Extend a local project to remote (attach an SSH host) */}
      {extendRemote && (
        <ExtendToRemoteDialog project={project} onClose={() => setExtendRemote(false)} />
      )}

      {/* In-app folder browser for "Move project…" (replaces the OS chooser) */}
      {movePickerInitial !== null && (
        <FolderPickerDialog
          initialPath={movePickerInitial}
          title={`${project.name} — move mirror folder to…`}
          confirmLabel="Move here"
          nameLabel="Local folder name"
          nameInitial={project.name}
          onConfirm={confirmMove}
          onClose={() => setMovePickerInitial(null)}
        />
      )}

      {/* Destructive: delete .git + history (typed-confirm) */}
      {showDisableGit && (
        <DisableGitWindow
          project={project}
          onConfirm={() => setProjectGitDisabled(project.id, true)}
          onClose={() => setShowDisableGit(false)}
        />
      )}

      {/* Delete → archive (reversible; simple confirm) */}
      {showArchive && (
        <ArchiveConfirmWindow
          project={project}
          onConfirm={() => archiveProject(project.id)}
          onClose={() => setShowArchive(false)}
        />
      )}

      <div
        ref={pillRef}
        className={`project-pill${active ? " active" : ""}${timerPaused ? " timer-paused" : ""}${dragOver ? " drag-over" : ""}${groupHint ? " drag-group" : ""}${dragging ? " dragging" : ""}${catColor ? " has-category" : ""}`}
        style={catColor ? ({ "--cat-color": catColor } as React.CSSProperties) : undefined}
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
          // Alt toggles the gesture to "box these two together" (see onDrop).
          const wantGroup = e.altKey && !!onGroup;
          if (wantGroup !== groupHint) setGroupHint(wantGroup);
        }}
        onDragLeave={() => { setDragOver(false); setGroupHint(false); }}
        onDrop={(e) => {
          setDragOver(false);
          setGroupHint(false);
          const fromId = e.dataTransfer.getData(PILL_DRAG_TYPE);
          if (!fromId || fromId === project.id) return;
          e.preventDefault();
          // Consume the drop so it does NOT also bubble to an enclosing BoxChip
          // (→ assign-to-box) or the ungrouped pills strip (→ assign-to-null).
          e.stopPropagation();
          // Alt-drop boxes the two projects together; a plain drop reorders.
          if (e.altKey && onGroup) {
            onGroup(fromId, project.id);
          } else {
            onReorder(fromId, project.id);
          }
        }}
        onDragEnd={(e) => {
          setDragOver(false);
          setGroupHint(false);
          setDragging(false);
          // Released over no drop target (dropEffect "none") while this pill is a
          // box member → drag-out: remove it from the box. Drops that landed on a
          // real target (strip, another box, a reorder) set "move" and are handled
          // there, so they don't also trigger a leave here.
          if (boxId && onLeaveBox && e.dataTransfer.dropEffect === "none") {
            onLeaveBox(project.id);
          }
        }}
      >
        <button className="pill-main" onClick={onClick}>
          <span
            className={`pill-folder-icon${timerPaused ? "" : ` git-${gitDirty ?? "clean"}`}`}
            title={timerPaused ? undefined : GIT_ICON_TITLE[gitDirty ?? "clean"]}
            aria-hidden
          >
            {timerPaused ? (
              "⏸"
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
              </svg>
            )}
          </span>
          <span className="project-pill-label">{project.name}</span>
          {busy && <OrbitSpinner className="pill-running-spinner" />}
        </button>
        {categories.length > 0 && (
          <span className="pill-category-dots" title={`Categories: ${categories.join(", ")}`}>
            {categories.map((cat) => (
              <span
                key={cat.toLowerCase()}
                className="pill-category-dot"
                style={{ background: categoryColor(cat) }}
              />
            ))}
          </span>
        )}
        {project.remote && <RemoteConnMenu project={project} compact />}
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
