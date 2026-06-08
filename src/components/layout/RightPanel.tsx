import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../files/FileTree";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { useSettingsStore } from "../../stores/settings";
import { resolveProjectDirectory } from "../../types";
import { type SortKey } from "../files/fileUtils";

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

interface Props {
  open: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

type View = "files" | "windows";
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

export function RightPanel({ open, onMouseEnter, onMouseLeave }: Props) {
  const { projects, activeId } = useProjectsStore();
  const { windows, refresh, untrack } = useWindowsStore();
  const settings = useSettingsStore((s) => s.settings);
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
        <span style={{ flex: 1 }}>
          {activeProject ? activeProject.name : "Files"}
        </span>
        <button
          className="tab-add-btn"
          style={{ fontSize: 10, padding: "1px 6px", height: 20 }}
          onClick={() => setView(view === "files" ? "windows" : "files")}
        >
          {view === "files" ? "Apps" : "Files"}
        </button>
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

      {gitStatus?.is_repo && view === "files" && (
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
                  <span data-testid="commit-bar" style={{ width: 3, alignSelf: "stretch", borderRadius: 2, marginRight: 4, flexShrink: 0, background: "#e3b341" }} />
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
                  <span data-testid="add-bar" style={{ width: 3, alignSelf: "stretch", borderRadius: 2, marginRight: 4, flexShrink: 0, background: "#f85149" }} />
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
                  <span data-testid="commit-bar" style={{ width: 3, alignSelf: "stretch", borderRadius: 2, marginRight: 4, flexShrink: 0, background: "#e3b341" }} />
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
                    <span data-testid="push-bar" style={{ width: 3, alignSelf: "stretch", borderRadius: 2, marginRight: 4, flexShrink: 0, background: "#3fb950" }} />
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

      {view === "files" ? (
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
            {open && (
              <FileTree
                projectDir={projectDir}
                projectId={activeId}
                sortKey={sortKey}
                descending={descending}
                hiddenEndings={hiddenEndings}
                hiddenPaths={hiddenPaths}
                shownPaths={shownPaths}
              />
            )}
          </div>
        </>
      ) : (
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
