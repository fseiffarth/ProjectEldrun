import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";
import { type FileEntry, fileIcon, folderIcon, fmtSize, visibleEntries } from "./fileUtils";

interface Props {
  projectDir: string;
  projectId: string | null;
  showHidden?: boolean;
}

export function FileTree({ projectDir, projectId, showHidden = false }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [relPath, setRelPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      // Open file via default app (xdg-open fallback).
      openFile(entry.path, undefined, projectId, "right_file_tree").catch(console.error);
    }
  }

  function goUp() {
    const parts = relPath.split("/").filter(Boolean);
    parts.pop();
    load(parts.join("/"));
  }

  if (!projectDir) {
    return (
      <div className="file-tree-empty">No project selected</div>
    );
  }

  return (
    <div className="file-tree">
      {relPath && (
        <button className="file-tree-up" onClick={goUp} title="Go up">
          ↑ ..
        </button>
      )}
      {loading && <div className="file-tree-loading">Loading…</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {entries.map((e) => (
        <div
          key={e.path}
          className={`file-entry ${e.is_dir ? "dir" : "file"}`}
          onClick={() => handleClick(e)}
        >
          <span className="file-icon">{e.is_dir ? folderIcon() : fileIcon(e.extension)}</span>
          <span className="file-name">{e.name}</span>
          {!e.is_dir && (
            <span className="file-size">{fmtSize(e.size)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
