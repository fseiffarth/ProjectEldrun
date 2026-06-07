import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";
import { type FileEntry, fileIcon, folderIcon, fmtSize, fmtModified, visibleEntries } from "./fileUtils";

function sizeCategory(bytes: number): string {
  if (bytes < 10 * 1024) return "size-small";
  if (bytes < 500 * 1024) return "size-medium";
  if (bytes < 10 * 1024 * 1024) return "size-large";
  return "size-huge";
}

interface Props {
  projectDir: string;
  projectId: string | null;
  showHidden?: boolean;
}

type GitStatusMap = Record<string, string>;

const STATUS_COLOR: Record<string, string> = {
  staged:    "#3fb950", // green
  untracked: "#f85149", // red
  modified:  "#f85149", // red
  ignored:   "#e3b341", // yellow
};

export function FileTree({ projectDir, projectId, showHidden = false }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [relPath, setRelPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitStatuses, setGitStatuses] = useState<GitStatusMap>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; entry: FileEntry } | null>(null);
  const { openFile } = useWindowsStore();

  useEffect(() => {
    if (!projectDir) return;
    load("");
  }, [projectDir]);

  async function load(rel: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<FileEntry[]>("list_dir", {
        projectDir,
        relPath: rel,
      });
      setEntries(visibleEntries(result, { showHidden, showStandardFiles: false }));
      setRelPath(rel);
      const statuses = await invoke<GitStatusMap>("git_file_statuses", {
        projectDir,
        relPath: rel,
      }).catch(() => ({}));
      setGitStatuses(statuses);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleClick(entry: FileEntry) {
    if (entry.is_dir) {
      const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
      load(rel);
    } else {
      openFile(entry.path, undefined, projectId, "right_file_tree").catch(console.error);
    }
  }

  function goUp() {
    const parts = relPath.split("/").filter(Boolean);
    parts.pop();
    load(parts.join("/"));
  }

  function handleEntryMouseEnter(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    if (entry.modified_secs || entry.created_secs) {
      setTooltip({ rect: e.currentTarget.getBoundingClientRect(), entry });
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!projectDir) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== "");
    if (!files.length) return;
    setLoading(true);
    setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const rel = relPath ? `${relPath}/${file.name}` : file.name;
        await invoke("write_project_file_bytes", {
          projectDir,
          relPath: rel,
          content: Array.from(new Uint8Array(buf)),
        });
      }
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  if (!projectDir) {
    return (
      <div className="file-tree-empty">No project selected</div>
    );
  }

  return (
    <div
      className={`file-tree${isDragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {relPath && (
        <button className="file-tree-up" onClick={goUp} title="Go up">
          ↑ ..
        </button>
      )}
      {loading && <div className="file-tree-loading">Loading…</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {entries.map((e) => {
        const status = gitStatuses[e.name];
        const barColor = status ? STATUS_COLOR[status] : undefined;
        const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
        return (
          <div
            key={e.path}
            className={`file-entry ${e.is_dir ? "dir" : "file"}`}
            onClick={() => handleClick(e)}
            onMouseEnter={(ev) => handleEntryMouseEnter(ev, e)}
            onMouseLeave={() => setTooltip(null)}
          >
            <span
              style={{
                width: 3,
                alignSelf: "stretch",
                borderRadius: 2,
                marginRight: 4,
                flexShrink: 0,
                background: barColor ?? "transparent",
              }}
            />
            <span className="file-icon">{e.is_dir ? folderIcon() : fileIcon(e.extension)}</span>
            <span className="file-name">{e.name}</span>
            {!e.is_dir && (
              <span className={`file-size ${sizeClass}`}>{fmtSize(e.size)}</span>
            )}
          </div>
        );
      })}
      {tooltip && createPortal(
        <div
          className="file-tooltip"
          style={{ right: window.innerWidth - tooltip.rect.left + 8, top: tooltip.rect.top }}
        >
          {tooltip.entry.created_secs && (
            <div><span className="file-tooltip-label">Created </span>{fmtModified(tooltip.entry.created_secs)}</div>
          )}
          {tooltip.entry.modified_secs && (
            <div><span className="file-tooltip-label">Modified</span>{fmtModified(tooltip.entry.modified_secs)}</div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
