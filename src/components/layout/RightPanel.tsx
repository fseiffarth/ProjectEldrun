import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../files/FileTree";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { useSettingsStore } from "../../stores/settings";
import { resolveProjectDirectory } from "../../types";

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

export function RightPanel({ open, onMouseEnter, onMouseLeave }: Props) {
  const { projects, activeId } = useProjectsStore();
  const { windows, refresh, untrack } = useWindowsStore();
  const settings = useSettingsStore((s) => s.settings);
  const [view, setView] = useState<View>("files");
  const [showSettings, setShowSettings] = useState(false);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const commitRef = useRef<HTMLTextAreaElement>(null);

  const refreshGit = (dir: string) => {
    invoke<GitStatus>("git_status", { projectDir: dir })
      .then(setGitStatus)
      .catch(() => setGitStatus(null));
  };

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
        {settings?.debug && activeId && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => setShowSettings((s) => !s)}
            title="Debug settings"
          >
            ⚙
          </button>
        )}
      </div>

      {view === "files" ? (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
          {open && <FileTree projectDir={projectDir} projectId={activeId} />}
        </div>
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
      {gitStatus?.is_repo && view === "files" && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "6px 8px" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: gitError || commitMsg !== null ? 4 : 0 }}>
            <button
              className="tab-add-btn"
              style={{ flex: 1, fontSize: 11, padding: "2px 4px" }}
              disabled={gitBusy}
              onClick={handleAdd}
              title={`Stage all changes (${gitStatus.unstaged + gitStatus.untracked} unstaged)`}
            >
              Add{gitStatus.unstaged + gitStatus.untracked > 0 ? ` (${gitStatus.unstaged + gitStatus.untracked})` : ""}
            </button>
            <button
              className="tab-add-btn"
              style={{ flex: 1, fontSize: 11, padding: "2px 4px" }}
              disabled={gitBusy || gitStatus.staged === 0}
              onClick={commitMsg === null ? handleCommitOpen : handleCommitConfirm}
              title={gitStatus.staged === 0 ? "No staged changes" : "Commit staged changes"}
            >
              {commitMsg === null ? `Commit${gitStatus.staged > 0 ? ` (${gitStatus.staged})` : ""}` : "Confirm"}
            </button>
            {gitStatus.has_remote && (
              <button
                className="tab-add-btn"
                style={{ flex: 1, fontSize: 11, padding: "2px 4px" }}
                disabled={gitBusy}
                onClick={handlePush}
                title="Push to remote"
              >
                Push
              </button>
            )}
          </div>
          {commitMsg !== null && (
            <div style={{ marginBottom: 4 }}>
              <textarea
                ref={commitRef}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  fontSize: 11,
                  background: "var(--bg-secondary, #1e1e1e)",
                  color: "var(--text-primary, #ccc)",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  padding: "3px 5px",
                  resize: "vertical",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
              <button
                className="tab-add-btn"
                style={{ fontSize: 11, padding: "1px 6px", marginTop: 2 }}
                onClick={() => setCommitMsg(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {gitError && (
            <div style={{ fontSize: 10, color: "var(--danger, #f85149)", wordBreak: "break-all" }}>
              {gitError}
            </div>
          )}
        </div>
      )}
      {showSettings && settings?.debug && activeId && localFile && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "6px 8px" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Debug</div>
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
        </div>
      )}
    </div>
  );
}
