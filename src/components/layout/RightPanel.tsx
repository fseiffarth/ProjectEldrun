import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTree } from "../files/FileTree";
import { GitHistory } from "../files/GitHistory";
import { SearchPanel } from "../files/SearchPanel";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import { resolveProjectDirectory } from "../../types";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import { type SortKey, VIEWER_PREF_TYPES } from "../../lib/viewers/fileUtils";
import type { ViewerPref } from "../../types";

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

interface Props {
  open: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

type View = "files" | "windows" | "git" | "search";
type ProjectJson = Record<string, unknown>;

const PANEL_HIDDEN_ENDINGS_KEY = "panel_hidden_endings";
const PANEL_HIDDEN_PATHS_KEY = "panel_hidden_paths";
const PANEL_SHOWN_PATHS_KEY = "panel_shown_paths";

function readHiddenEndings(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_HIDDEN_ENDINGS_KEY);
}

function readHiddenPaths(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_HIDDEN_PATHS_KEY);
}

function readShownPaths(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_SHOWN_PATHS_KEY);
}

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

type ConflictChoice = "replace" | "rename" | "skip";

/** Heuristic: is this drag an external OS file drag (vs. an internal pill/text
 *  drag)? `dragDropEnabled` stays false so HTML5 DnD keeps working for the
 *  app's pointer/HTML drags; an OS file drag advertises Files/uri-list/html
 *  (WebKitGTK uses text/html here). During dragover WebKit may hide the type
 *  list, so an empty list is treated as a file drag too. */
function isExternalFileDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  if (types.length === 0) return true;
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html")
  );
}

/** Convert one `file://` URI to an absolute local path (decoding `%20` etc.),
 *  dropping any `file://host/…` authority. */
function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let rest = uri.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash > 0) rest = rest.slice(slash);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** Extract absolute local paths from an OS HTML5 file drop. WebKitGTK withholds
 *  `Files`/`text/uri-list` data here but leaks the `file://` URL inside
 *  `text/html`, so scan every text payload for `file://` URIs and dedupe.
 *  NOTE: this drag path is best-effort — some file managers only expose ONE
 *  file this way. Use the Import button for reliable multi-file selection. */
function parseDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const sources = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
    dataTransfer.getData("text/html"),
  ];
  const FILE_URI = /file:\/\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    for (const match of raw.match(FILE_URI) ?? []) {
      const p = fileUriToPath(match);
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

function mergeEndings(...groups: string[][]): string[] {
  const endings = new Map<string, string>();
  for (const group of groups) {
    for (const ending of group) {
      const trimmed = ending.trim();
      if (!trimmed) continue;
      endings.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...endings.values()].sort((a, b) => a.localeCompare(b));
}

/** One collapsible root inside the box multi-root file view. Reuses `FileTree`
 *  as-is for a single directory; per-root navigation persists via the projects
 *  store's `rightPanelFolderByProject` map keyed by the root's id. */
function BoxRootSection({
  rootId,
  label,
  icon,
  dir,
  localFile,
  variant,
  sortKey,
  descending,
}: {
  rootId: string;
  label: string;
  icon: string;
  dir: string;
  localFile?: string;
  variant: "box" | "member";
  sortKey: SortKey;
  descending: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rel = useProjectsStore((s) => s.rightPanelFolderByProject[rootId] ?? "");
  const setRightPanelFolder = useProjectsStore((s) => s.setRightPanelFolder);
  return (
    <div className={`file-root file-root--${variant}${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="file-root-header"
        onClick={() => setCollapsed((c) => !c)}
        title={dir}
      >
        <span className="file-root-caret" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="file-root-icon" aria-hidden>
          {icon}
        </span>
        <span className="file-root-name">{label}</span>
        <span className="file-root-kind">{variant === "box" ? "box" : "project"}</span>
      </button>
      {!collapsed && (
        <div className="file-root-body">
          <FileTree
            projectDir={dir}
            projectId={rootId}
            localFile={localFile}
            sortKey={sortKey}
            descending={descending}
            hiddenEndings={[]}
            hiddenPaths={[]}
            shownPaths={[]}
            initialRelPath={rel}
            onRelPathChange={(folder) => setRightPanelFolder(rootId, folder)}
          />
        </div>
      )}
    </div>
  );
}

export function RightPanel({ open, pinned, onTogglePin, onMouseEnter, onMouseLeave }: Props) {
  const { projects, activeId } = useProjectsStore();
  const rightPanelFolderByProject = useProjectsStore((s) => s.rightPanelFolderByProject);
  const setRightPanelFolder = useProjectsStore((s) => s.setRightPanelFolder);
  const { windows, refresh, untrack } = useWindowsStore();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [view, setView] = useState<View>("files");
  const [dropActive, setDropActive] = useState(false);
  const [dropFlash, setDropFlash] = useState(false);
  const [conflict, setConflict] = useState<
    { name: string; remaining: number; resolve: (r: { choice: ConflictChoice; all: boolean }) => void } | null
  >(null);
  const [conflictAll, setConflictAll] = useState(false);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [localProjectSettings, setLocalProjectSettings] = useState<ProjectJson | null>(null);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [availableEndings, setAvailableEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitFileList, setGitFileList] = useState<Record<string, string>>({});
  const [unpushedCommits, setUnpushedCommits] = useState<string[]>([]);
  const [hoveredBtn, setHoveredBtn] = useState<"add" | "commit" | "push" | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const commitRef = useRef<HTMLTextAreaElement>(null);
  const refreshGitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run all three git probes concurrently (Eff #9): they hit independent
  // subprocesses, so `Promise.all` collapses three serially-awaited chains into
  // one round of parallel work. Each result still applies independently.
  const runRefreshGit = (dir: string) => {
    void Promise.all([
      invoke<GitStatus>("git_status", { projectDir: dir }).catch(() => null),
      invoke<Record<string, string>>("git_file_statuses", { projectDir: dir, relPath: "" }).catch(
        () => ({}) as Record<string, string>,
      ),
      invoke<string[]>("git_unpushed_commits", { projectDir: dir }).catch(() => [] as string[]),
    ]).then(([status, files, unpushed]) => {
      setGitStatus(status);
      setGitFileList(files);
      setUnpushedCommits(unpushed);
      // Keep the active project's pill dot in sync from the data we just fetched
      // (no extra git subprocesses), so edits/commits/pushes reflect immediately
      // instead of waiting for the switcher's periodic poll.
      if (activeId && status) {
        useGitDirtyStore.getState().set(activeId, gitDirtyState(status, unpushed.length));
      }
    });
  };

  // Debounced entry point (Eff #9): bursts of git-affecting actions (add →
  // commit → push, or rapid fs changes) coalesce into a single refresh instead
  // of spawning a fresh trio of subprocesses per call.
  const refreshGit = (dir: string) => {
    if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
    refreshGitTimer.current = setTimeout(() => {
      refreshGitTimer.current = null;
      runRefreshGit(dir);
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
      if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    };
  }, []);

  const hoverItems: string[] =
    hoveredBtn === "add"
      ? Object.entries(gitFileList).filter(([, s]) => s === "untracked" || s === "modified").map(([f]) => f)
      : hoveredBtn === "commit"
      ? Object.entries(gitFileList).filter(([, s]) => s === "staged").map(([f]) => f)
      : hoveredBtn === "push"
      ? unpushedCommits
      : [];

  const activeProject = projects.find((p) => p.id === activeId);
  const projectDir = resolveProjectDirectory(activeProject);
  const localFile = activeProject?.local_file;
  const rightPanelFolder = activeId ? rightPanelFolderByProject[activeId] ?? "" : "";

  // When a box scope is open, the panel shows a multi-root file view: the box
  // folder plus every member project's root. Detected from the current tab scope
  // (disjoint `box:<id>` prefix) rather than the project store's activeId.
  const scope = useTabsStore((s) => s.scope);
  const boxes = useBoxesStore((s) => s.boxes);
  const activeBox = useMemo(
    () =>
      scope.startsWith(BOX_SCOPE_PREFIX)
        ? boxes.find((b) => boxScopeId(b.id) === scope) ?? null
        : null,
    [scope, boxes],
  );
  const boxRoots = useMemo(() => {
    if (!activeBox) return [];
    const roots: {
      rootId: string;
      label: string;
      icon: string;
      dir: string;
      localFile?: string;
      variant: "box" | "member";
    }[] = [];
    if (activeBox.folder) {
      roots.push({ rootId: scope, label: activeBox.name, icon: "▣", dir: activeBox.folder, variant: "box" });
    }
    for (const id of activeBox.member_ids) {
      const p = projects.find((m) => m.id === id);
      if (!p) continue;
      const dir = resolveProjectDirectory(p);
      if (!dir) continue;
      roots.push({ rootId: p.id, label: p.name, icon: "📁", dir, localFile: p.local_file, variant: "member" });
    }
    return roots;
  }, [activeBox, projects, scope]);

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = rightPanelFolder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  // OS file drop → copy into the project. Confined to a single active project
  // (a box scope has no single destination root). Driven by Tauri's NATIVE
  // drag-drop event (dragDropEnabled=true) because WebKitGTK withholds the file
  // paths from HTML5 drops; the native event hands us every dropped path.
  const canImportDrop = !!projectDir && !activeBox;

  const flashDrop = () => {
    if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    setDropFlash(false);
    requestAnimationFrame(() => setDropFlash(true));
    dropFlashTimer.current = setTimeout(() => setDropFlash(false), 500);
  };

  // Ask the user how to resolve a name collision; resolves via the modal's
  // buttons. Returns the choice plus whether to apply it to all remaining.
  const askConflict = (name: string, remaining: number) =>
    new Promise<{ choice: ConflictChoice; all: boolean }>((resolve) => {
      setConflictAll(false);
      setConflict({ name, remaining, resolve });
    });

  // Copy each absolute source path into the project, prompting on collisions.
  const importPaths = (paths: string[]) => {
    if (!canImportDrop || !projectDir || paths.length === 0) return;
    flashDrop();
    const destRel = view === "files" ? rightPanelFolder : "";
    void (async () => {
      let blanket: ConflictChoice | null = null;
      for (let i = 0; i < paths.length; i++) {
        const sourcePath = paths[i];
        const name = sourcePath.replace(/\/+$/, "").split("/").pop() || sourcePath;
        const rel = destRel ? `${destRel}/${name}` : name;
        let choice: ConflictChoice = "rename";
        const exists = await invoke<boolean>("project_path_exists", { projectDir, relPath: rel }).catch(() => false);
        if (exists) {
          if (blanket) {
            choice = blanket;
          } else {
            const res = await askConflict(name, paths.length - 1 - i);
            setConflict(null);
            choice = res.choice;
            if (res.all) blanket = res.choice;
          }
        }
        if (choice === "skip") continue;
        try {
          await invoke("import_external_file", { projectDir, sourcePath, destRel, replace: choice === "replace" });
        } catch (err) {
          console.error("import_external_file", sourcePath, err);
        }
      }
      // FileTree auto-reloads via its fs-watch; refresh git so new untracked
      // files show in the status counts immediately.
      refreshGit(projectDir);
    })();
  };

  // HTML5 drag-and-drop (dragDropEnabled stays false so pointer drags — tabs,
  // splits, pills — keep working). Best-effort: WebKitGTK only leaks file paths
  // via text/html and sometimes just one; the Import button is the reliable
  // multi-file path.
  const handleImportDragOver = (e: React.DragEvent) => {
    if (!canImportDrop || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const handleImportDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const handleImportDrop = (e: React.DragEvent) => {
    setDropActive(false);
    if (!canImportDrop || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    importPaths(parseDroppedFilePaths(e.dataTransfer));
  };

  // Reliable multi-file import: native OS file picker → same copy+conflict flow.
  const importViaDialog = async () => {
    if (!canImportDrop) return;
    const picked = await openDialog({ multiple: true, directory: false }).catch(() => null);
    if (!picked) return;
    importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  useEffect(() => {
    if (open && activeId) {
      refresh(activeId);
    }
  }, [open, activeId]);

  useEffect(() => {
    if (open && projectDir) {
      refreshGit(projectDir);
    } else {
      setGitStatus(null);
    }
  }, [open, projectDir]);

  useEffect(() => {
    setShowSettings(false);
    setSettingsError(null);
    if (!localFile || !projectDir) {
      setLocalProjectSettings(null);
      setHiddenEndings([]);
      setAvailableEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      return;
    }
    Promise.all([
      invoke<ProjectJson>("load_project", { localFile }),
      invoke<string[]>("list_project_endings", { projectDir }).catch(() => []),
    ])
      .then(([project, endings]) => {
        const savedHiddenEndings = readHiddenEndings(project);
        const savedHiddenPaths = readHiddenPaths(project);
        const savedShownPaths = readShownPaths(project);
        const allEndings = mergeEndings(endings, savedHiddenEndings);
        setLocalProjectSettings(project);
        setHiddenEndings(savedHiddenEndings);
        setAvailableEndings(allEndings);
        setHiddenPaths(savedHiddenPaths);
        setShownPaths(savedShownPaths);
      })
      .catch((error) => {
        setLocalProjectSettings(null);
        setHiddenEndings([]);
        setAvailableEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
        setSettingsError(String(error));
      });
  }, [localFile, projectDir]);

  const handleAdd = async () => {
    if (!projectDir) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_add_all", { projectDir });
      refreshGit(projectDir);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitOpen = async () => {
    if (!projectDir) return;
    setGitBusy(true);
    setGitError(null);
    try {
      const msg = await invoke<string>("git_generate_commit_message", { projectDir });
      setCommitMsg(msg);
      setTimeout(() => commitRef.current?.focus(), 50);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitConfirm = async () => {
    if (!projectDir || commitMsg === null) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_commit", { projectDir, message: commitMsg });
      setCommitMsg(null);
      refreshGit(projectDir);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handlePush = async () => {
    if (!projectDir) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_push", { projectDir });
      refreshGit(projectDir);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const saveHiddenEndings = async (nextEndings: string[]) => {
    if (!localFile || !localProjectSettings) return;
    const nextProject = {
      ...localProjectSettings,
      [PANEL_HIDDEN_ENDINGS_KEY]: nextEndings,
      [PANEL_HIDDEN_PATHS_KEY]: hiddenPaths,
      [PANEL_SHOWN_PATHS_KEY]: shownPaths,
    };
    setHiddenEndings(nextEndings);
    setLocalProjectSettings(nextProject);
    setSettingsError(null);
    try {
      await invoke("save_project", { localFile, project: nextProject });
    } catch (e) {
      setSettingsError(String(e));
    }
  };

  const toggleHiddenEnding = (ending: string, checked: boolean) => {
    const existing = new Set(hiddenEndings.map((item) => item.toLowerCase()));
    const nextEndings = checked
      ? existing.has(ending.toLowerCase())
        ? hiddenEndings
        : [...hiddenEndings, ending]
      : hiddenEndings.filter((item) => item.toLowerCase() !== ending.toLowerCase());
    void saveHiddenEndings(nextEndings);
  };

  return (
    <div
      className={`right-panel ${open ? "open" : ""}${dropActive ? " drop-active" : ""}${dropFlash ? " drop-flash" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDragEnter={handleImportDragOver}
      onDragOver={handleImportDragOver}
      onDragLeave={handleImportDragLeave}
      onDrop={handleImportDrop}
    >
      {conflict && createPortal(
        <div
          className="modal-backdrop"
          onMouseDown={() => conflict.resolve({ choice: "skip", all: conflictAll })}
        >
          <div className="settings-dialog" style={{ maxWidth: 380 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="settings-title-row">
              <h2>File already exists</h2>
            </div>
            <p className="settings-help" style={{ wordBreak: "break-all" }}>
              <code>{conflict.name}</code> already exists in this folder. Replace it, or keep both (the new copy is renamed)?
            </p>
            {conflict.remaining > 0 && (
              <label className="viewer-pref-toggle" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={conflictAll}
                  onChange={(e) => setConflictAll(e.target.checked)}
                />
                <span>Apply to the {conflict.remaining} remaining file{conflict.remaining > 1 ? "s" : ""}</span>
              </label>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "skip", all: conflictAll })}>
                Skip
              </button>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "rename", all: conflictAll })}>
                Keep both
              </button>
              <button
                className="tab-add-btn"
                style={{ color: "var(--danger, #f85149)" }}
                onClick={() => conflict.resolve({ choice: "replace", all: conflictAll })}
              >
                Replace
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div className="right-panel-header">
        {onTogglePin && (
          <button
            className={`right-panel-pin${pinned ? " pinned" : ""}`}
            aria-pressed={pinned}
            onClick={onTogglePin}
            title={pinned ? "Unpin panel (allow auto-hide)" : "Pin panel open"}
          >
            📌
          </button>
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeBox ? `▣ ${activeBox.name}` : activeProject ? activeProject.name : "Files"}
        </span>
        {(["files", "git", "search", "windows"] as View[]).map((v) => (
          <button
            key={v}
            className={`tab-add-btn${view === v ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: v === "files" ? 0 : 2 }}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === "files" ? "Files" : v === "git" ? "Git" : v === "search" ? "Search" : "Apps"}
          </button>
        ))}
        {canImportDrop && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => void importViaDialog()}
            title="Import files into this folder"
          >
            ⬇
          </button>
        )}
        {projectDir && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={openInOsBrowser}
            title="Open folder in file manager"
          >
            ⧉
          </button>
        )}
        {activeId && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => setShowSettings(true)}
            title="Project settings"
          >
            ⚙
          </button>
        )}
      </div>

      {!activeBox && gitStatus?.is_repo && view === "files" && (
        <>
          {/* Only render the action bar when there's something to do (or we're
              mid-commit) — an empty strip with no actions just wastes space. */}
          {(commitMsg !== null ||
            gitStatus.unstaged + gitStatus.untracked > 0 ||
            gitStatus.staged > 0 ||
            (gitStatus.has_remote && unpushedCommits.length > 0)) && (
          <div className="git-action-bar" style={{ position: "relative" }} onMouseLeave={() => setHoveredBtn(null)}>
            {commitMsg !== null ? (
              <>
                <button
                  className="git-action-btn"
                  disabled={gitBusy}
                  onClick={handleCommitConfirm}
                  title="Confirm commit"
                  onMouseEnter={() => setHoveredBtn("commit")}
                >
                  <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                  <span>↵</span>
                  <span className="git-btn-label">Confirm</span>
                </button>
                <button
                  className="git-action-btn"
                  disabled={gitBusy}
                  onClick={() => setCommitMsg(null)}
                  title="Go back"
                >
                  <span>←</span>
                  <span className="git-btn-label">Back</span>
                </button>
              </>
            ) : (
              <>
                {/* Each action only appears when it has work to do: Add when there
                    are unstaged/untracked changes, Commit when something is staged,
                    Push when commits are ahead of the remote. A clean, pushed repo
                    shows no buttons. */}
                {gitStatus.unstaged + gitStatus.untracked > 0 && (
                  <button
                    className="git-action-btn"
                    disabled={gitBusy}
                    onClick={handleAdd}
                    title={`Stage all changes (${gitStatus.unstaged + gitStatus.untracked} unstaged)`}
                    onMouseEnter={() => setHoveredBtn("add")}
                  >
                    <span data-testid="add-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#f85149" }} />
                    <span>⊕</span>
                    <span className="git-btn-label">Add ({gitStatus.unstaged + gitStatus.untracked})</span>
                  </button>
                )}
                {gitStatus.staged > 0 && (
                  <button
                    className="git-action-btn"
                    disabled={gitBusy}
                    onClick={handleCommitOpen}
                    title={`Commit ${gitStatus.staged} staged`}
                    onMouseEnter={() => setHoveredBtn("commit")}
                  >
                    <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                    <span>✔</span>
                    <span className="git-btn-label">Commit ({gitStatus.staged})</span>
                  </button>
                )}
                {gitStatus.has_remote && unpushedCommits.length > 0 && (
                  <button
                    className="git-action-btn"
                    disabled={gitBusy}
                    onClick={handlePush}
                    title={`Push ${unpushedCommits.length} commit${unpushedCommits.length === 1 ? "" : "s"} to remote`}
                    onMouseEnter={() => setHoveredBtn("push")}
                  >
                    <span data-testid="push-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#3fb950" }} />
                    <span>⬆</span>
                    <span className="git-btn-label">Push ({unpushedCommits.length})</span>
                  </button>
                )}
                {hoveredBtn && hoverItems.length > 0 && (
                  <div className="git-hover-list" data-testid="git-hover-list">
                    {hoverItems.map((item, i) => (
                      <div key={i} className="git-hover-item">{item}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          )}
          {commitMsg !== null && (
            <div style={{ padding: "4px 6px", borderBottom: "1px solid var(--border-color)" }}>
              <textarea
                ref={commitRef}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  fontSize: 11,
                  background: "var(--bg-panel)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 3,
                  padding: "3px 5px",
                  resize: "vertical",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}
          {gitError && (
            <div style={{ fontSize: 10, color: "var(--danger, #f85149)", wordBreak: "break-all", padding: "2px 6px 4px", borderBottom: "1px solid var(--border-color)" }}>
              {gitError}
            </div>
          )}
        </>
      )}

      {view === "git" && (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
          <GitHistory projectDir={projectDir} onChanged={() => projectDir && refreshGit(projectDir)} />
        </div>
      )}

      {view === "search" && (
        <SearchPanel projectDir={projectDir} linkingTabKey={undefined} />
      )}

      {view === "files" && (
        <>
          <div className="right-panel-sort">
            {(["name", "size", "type", "created", "modified"] as SortKey[]).map((key) => (
              <button
                key={key}
                className={`sort-key-btn${sortKey === key ? " active" : ""}`}
                onClick={() => sortKey === key ? setDescending((d) => !d) : setSortKey(key)}
                title={sortKey === key ? (descending ? "Descending — click to reverse" : "Ascending — click to reverse") : `Sort by ${key}`}
              >
                {key}{sortKey === key ? (descending ? " ↓" : " ↑") : ""}
              </button>
            ))}
          </div>
          <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
            {open && activeBox ? (
              boxRoots.length === 0 ? (
                <div className="file-tree-empty">No member project folders</div>
              ) : (
                boxRoots.map((r) => (
                  <BoxRootSection
                    key={r.rootId}
                    rootId={r.rootId}
                    label={r.label}
                    icon={r.icon}
                    dir={r.dir}
                    localFile={r.localFile}
                    variant={r.variant}
                    sortKey={sortKey}
                    descending={descending}
                  />
                ))
              )
            ) : (
              open && (
                <FileTree
                  projectDir={projectDir}
                  projectId={activeId}
                  localFile={localFile}
                  sortKey={sortKey}
                  descending={descending}
                  hiddenEndings={hiddenEndings}
                  hiddenPaths={hiddenPaths}
                  shownPaths={shownPaths}
                  initialRelPath={rightPanelFolder}
                  onRelPathChange={(folder) => {
                    if (activeId) setRightPanelFolder(activeId, folder);
                  }}
                />
              )
            )}
          </div>
        </>
      )}

      {view === "windows" && (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {windows.length === 0 ? (
            <div className="file-tree-empty">No opened windows</div>
          ) : (
            windows.map((w) => (
              <div key={w.id} className="file-entry">
                <span className="file-icon">🪟</span>
                <span className="file-name" title={w.exec}>
                  {w.exec.split("/").pop() ?? w.exec}
                  {w.file && <span style={{ color: "var(--text-muted)" }}> {w.file.split("/").pop()}</span>}
                </span>
                <button
                  className="tab-close"
                  onClick={() => untrack(w.id)}
                  title="Untrack"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {showSettings && activeProject && localFile && createPortal(
        <div className="modal-backdrop settings-backdrop" onMouseDown={() => setShowSettings(false)}>
          <div className="settings-dialog project-settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="settings-title-row">
              <h2>Project Settings</h2>
              <button type="button" className="dialog-close-btn" onClick={() => setShowSettings(false)}>×</button>
            </div>

            <div className="settings-section-title">Panel File Hiding</div>
            <p className="settings-help">
              Click an ending to hide matching files in the right panel. Dimmed endings are hidden.
            </p>
            {availableEndings.length === 0 ? (
              <div className="settings-empty">No file endings found in this project.</div>
            ) : (
              <div className="settings-list project-ending-list">
                {availableEndings.map((ending) => {
                  const checked = hiddenEndings.some((item) => item.toLowerCase() === ending.toLowerCase());
                  return (
                    <button
                      type="button"
                      className={`project-ending-toggle${checked ? " is-hidden" : ""}`}
                      key={ending}
                      aria-pressed={checked}
                      onClick={() => toggleHiddenEnding(ending, !checked)}
                      title={checked ? `Show ${ending} files` : `Hide ${ending} files`}
                    >
                      {ending}
                    </button>
                  );
                })}
              </div>
            )}
            {settingsError && <div className="settings-error">{settingsError}</div>}

            {/* #48 per-file-type native-viewer settings (global, not per-project).
                Toggles opt-in local autocomplete (#45) per type, plus the global
                autosave (#47). */}
            <div className="settings-section-title">Native Viewers</div>
            <p className="settings-help">
              Eldrun renders these file types in-app. Disable a type to open its
              files in your external default app instead. Autocomplete is
              local-only (Ollama) and opt-in.
            </p>
            <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={settings?.autosave !== false}
                onChange={(e) => void updateSettings({ autosave: e.target.checked })}
              />
              <span>Autosave edits</span>
            </label>
            <div className="viewer-prefs-list">
              {VIEWER_PREF_TYPES.map((t) => {
                const pref: ViewerPref = settings?.viewer_prefs?.[t.id] ?? {};
                const enabled = pref.enabled !== false;
                const patch = (next: ViewerPref) =>
                  void updateSettings({
                    viewer_prefs: {
                      ...(settings?.viewer_prefs ?? {}),
                      [t.id]: { ...pref, ...next },
                    },
                  });
                return (
                  <div className="viewer-pref-row" key={t.id}>
                    <span className="viewer-pref-name">{t.label}</span>
                    <span className="viewer-pref-exts">{t.extensions.join(" ")}</span>
                    <label className="viewer-pref-toggle">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => patch({ enabled: e.target.checked })}
                      />
                      <span>Enabled</span>
                    </label>
                    {t.autocomplete && (
                      <>
                        <label className="viewer-pref-toggle">
                          <input
                            type="checkbox"
                            checked={pref.autocomplete === true}
                            disabled={!enabled}
                            onChange={(e) => patch({ autocomplete: e.target.checked })}
                          />
                          <span>Autocomplete</span>
                        </label>
                        {/* #45 default completion-length mode; toggled live
                            in-editor with Shift+Tab while a suggestion shows. */}
                        <select
                          className="viewer-pref-mode"
                          value={pref.autocomplete_mode ?? "sentence"}
                          disabled={!enabled || pref.autocomplete !== true}
                          title="Default completion length (toggle live with Shift+Tab)"
                          onChange={(e) =>
                            patch({ autocomplete_mode: e.target.value as ViewerPref["autocomplete_mode"] })
                          }
                        >
                          <option value="sentence">Sentence</option>
                          <option value="block">Block</option>
                          <option value="scope">Scope</option>
                        </select>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {settings?.debug && (
              <>
                <div className="settings-section-title">Debug</div>
                <button
                  className="tab-add-btn"
                  style={{ fontSize: 11, padding: "2px 8px", width: "100%", color: "var(--danger, #f85149)" }}
                  onClick={() => {
                    invoke("clear_project_session", { localFile }).then(() => {
                      window.location.reload();
                    }).catch(console.error);
                  }}
                >
                  Clear session storage
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
