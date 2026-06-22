import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../files/FileTree";
import { GitHistory } from "../files/GitHistory";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import { resolveProjectDirectory } from "../../types";
import { type SortKey, VIEWER_PREF_TYPES } from "../files/fileUtils";
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

type View = "files" | "windows" | "git";
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

  const refreshGit = (dir: string) => {
    invoke<GitStatus>("git_status", { projectDir: dir })
      .then(setGitStatus)
      .catch(() => setGitStatus(null));
    invoke<Record<string, string>>("git_file_statuses", { projectDir: dir, relPath: "" })
      .then(setGitFileList)
      .catch(() => setGitFileList({}));
    invoke<string[]>("git_unpushed_commits", { projectDir: dir })
      .then(setUnpushedCommits)
      .catch(() => setUnpushedCommits([]));
  };

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
      className={`right-panel ${open ? "open" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
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
        <span style={{ flex: 1 }}>
          {activeBox ? `▣ ${activeBox.name}` : activeProject ? activeProject.name : "Files"}
        </span>
        {(["files", "git", "windows"] as View[]).map((v) => (
          <button
            key={v}
            className={`tab-add-btn${view === v ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: v === "files" ? 0 : 2 }}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === "files" ? "Files" : v === "git" ? "Git" : "Apps"}
          </button>
        ))}
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
                <button
                  className="git-action-btn"
                  disabled={gitBusy}
                  onClick={handleAdd}
                  title={`Stage all changes (${gitStatus.unstaged + gitStatus.untracked} unstaged)`}
                  onMouseEnter={() => setHoveredBtn("add")}
                >
                  <span data-testid="add-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#f85149" }} />
                  <span>⊕</span>
                  <span className="git-btn-label">Add{gitStatus.unstaged + gitStatus.untracked > 0 ? ` (${gitStatus.unstaged + gitStatus.untracked})` : ""}</span>
                </button>
                <button
                  className="git-action-btn"
                  disabled={gitBusy || gitStatus.staged === 0}
                  onClick={handleCommitOpen}
                  title={gitStatus.staged === 0 ? "No staged changes" : `Commit ${gitStatus.staged} staged`}
                  onMouseEnter={() => setHoveredBtn("commit")}
                >
                  <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                  <span>✔</span>
                  <span className="git-btn-label">Commit{gitStatus.staged > 0 ? ` (${gitStatus.staged})` : ""}</span>
                </button>
                {gitStatus.has_remote && (
                  <button
                    className="git-action-btn"
                    disabled={gitBusy}
                    onClick={handlePush}
                    title="Push to remote"
                    onMouseEnter={() => setHoveredBtn("push")}
                  >
                    <span data-testid="push-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#3fb950" }} />
                    <span>⬆</span>
                    <span className="git-btn-label">Push</span>
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
              Eldrun renders these file types in-app. Configure their behaviour
              below. Autocomplete is local-only (Ollama) and opt-in.
            </p>
            <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={settings?.autosave === true}
                onChange={(e) => void updateSettings({ autosave: e.target.checked })}
              />
              <span>Autosave edits</span>
            </label>
            <div className="viewer-prefs-list">
              {VIEWER_PREF_TYPES.filter((t) => t.autocomplete).map((t) => {
                const pref: ViewerPref = settings?.viewer_prefs?.[t.id] ?? {};
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
                    {t.autocomplete && (
                      <label className="viewer-pref-toggle">
                        <input
                          type="checkbox"
                          checked={pref.autocomplete === true}
                          onChange={(e) => patch({ autocomplete: e.target.checked })}
                        />
                        <span>Autocomplete</span>
                      </label>
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
