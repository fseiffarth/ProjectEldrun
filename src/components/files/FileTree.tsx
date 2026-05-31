import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  extension: string | null;
  mime: string | null;
}

interface Props {
  projectDir: string;
  showHidden?: boolean;
}

export function FileTree({ projectDir, showHidden = false }: Props) {
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
      const visible = showHidden
        ? result
        : result.filter((e) => !e.name.startsWith("."));
      setEntries(visible);
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
      openFile(entry.path).catch(console.error);
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
          <span className="file-icon">{e.is_dir ? "📁" : fileIcon(e.extension)}</span>
          <span className="file-name">{e.name}</span>
          {!e.is_dir && (
            <span className="file-size">{fmtSize(e.size)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function fileIcon(ext: string | null): string {
  switch (ext) {
    case ".py": return "🐍";
    case ".rs": return "🦀";
    case ".ts":
    case ".tsx": return "⟨⟩";
    case ".js":
    case ".jsx": return "⚡";
    case ".md": return "📝";
    case ".json": return "{}";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".svg": return "🖼";
    case ".sh": return "⚙";
    default: return "📄";
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
