import { useEffect, useState } from "react";
import { FileTree } from "../files/FileTree";
import { useProjectsStore } from "../../stores/projects";
import { useWindowsStore } from "../../stores/windows";
import { resolveProjectDirectory } from "../../types";

interface Props {
  open: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

type View = "files" | "windows";

export function RightPanel({ open, onMouseEnter, onMouseLeave }: Props) {
  const { projects, activeId } = useProjectsStore();
  const { windows, refresh, untrack } = useWindowsStore();
  const [view, setView] = useState<View>("files");

  const activeProject = projects.find((p) => p.id === activeId);
  const projectDir = resolveProjectDirectory(activeProject);

  useEffect(() => {
    if (open && activeId) {
      refresh(activeId);
    }
  }, [open, activeId]);

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
      </div>

      {view === "files" ? (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
          {open && <FileTree projectDir={projectDir} />}
        </div>
      ) : (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {windows.length === 0 ? (
            <div className="file-tree-empty">No tracked windows</div>
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
    </div>
  );
}
