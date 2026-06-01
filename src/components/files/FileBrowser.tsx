import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";
import {
  type FileEntry,
  type SortKey,
  fileIcon,
  folderIcon,
  fmtModified,
  fmtSize,
  joinRel,
  parentRel,
  relFromAbs,
  visibleEntries,
} from "./fileUtils";

type ViewMode = "list" | "icons";
type ContextMenuState =
  | { kind: "entry"; x: number; y: number; path: string }
  | { kind: "background"; x: number; y: number };

interface Props {
  projectDir: string;
  projectId: string | null;
  active: boolean;
}

export function FileBrowser({ projectDir, projectId, active }: Props) {
  const { openFile } = useWindowsStore();
  const [relPath, setRelPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [showStandardFiles, setShowStandardFiles] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [query, setQuery] = useState("");
  const [pathEntry, setPathEntry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!projectDir) return;
    load("", { replace: true });
  }, [projectDir]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const displayed = useMemo(
    () => visibleEntries(entries, { showHidden, showStandardFiles, query, sortKey, descending }),
    [entries, showHidden, showStandardFiles, query, sortKey, descending],
  );

  async function load(nextRel: string, options: { replace?: boolean } = {}) {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<FileEntry[]>("list_dir", {
        projectDir,
        relPath: nextRel,
      });
      setEntries(result);
      setPathEntry(nextRel);
      setSelected(new Set());
      if (!options.replace && nextRel !== relPath) {
        setHistory((items) => [...items, relPath]);
        setFuture([]);
      }
      setRelPath(nextRel);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function goBack() {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory((items) => items.slice(0, -1));
    setFuture((items) => [relPath, ...items]);
    load(prev, { replace: true });
  }

  function goForward() {
    const next = future[0];
    if (next === undefined) return;
    setFuture((items) => items.slice(1));
    setHistory((items) => [...items, relPath]);
    load(next, { replace: true });
  }

  function activate(entry: FileEntry) {
    if (entry.is_dir) {
      load(joinRel(relPath, entry.name));
    } else {
      openFile(entry.path, undefined, projectId).catch((e) => setError(String(e)));
    }
  }

  function toggleSelected(entry: FileEntry, additive: boolean) {
    setSelected((current) => {
      if (!additive) return new Set([entry.path]);
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function selectedEntries(): FileEntry[] {
    return entries.filter((entry) => selected.has(entry.path));
  }

  function firstSelectedEntry(): FileEntry | undefined {
    return selectedEntries()[0];
  }

  async function createEntry(kind: "file" | "folder") {
    const label = kind === "file" ? "file name" : "folder name";
    const name = window.prompt(`New ${kind}:`, "");
    if (!name?.trim()) return;
    const rel = joinRel(relPath, name.trim());
    try {
      await invoke(kind === "file" ? "create_file" : "create_dir", {
        projectDir,
        relPath: rel,
      });
      await load(relPath, { replace: true });
    } catch (e) {
      setError(`${label}: ${String(e)}`);
    }
  }

  async function renameSelected() {
    const target = selectedEntries()[0];
    if (!target) return;
    const nextName = window.prompt("Rename to:", target.name);
    if (!nextName?.trim() || nextName.trim() === target.name) return;
    try {
      await invoke("rename_path", {
        projectDir,
        oldRel: relFromAbs(projectDir, target.path),
        newName: nextName.trim(),
      });
      await load(relPath, { replace: true });
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteSelected() {
    const targets = selectedEntries();
    if (targets.length === 0) return;
    const confirmed = window.confirm(`Delete ${targets.length} selected item${targets.length === 1 ? "" : "s"}?`);
    if (!confirmed) return;
    try {
      for (const target of targets) {
        await invoke(target.is_dir ? "delete_dir" : "delete_file", {
          projectDir,
          relPath: relFromAbs(projectDir, target.path),
        });
      }
      await load(relPath, { replace: true });
    } catch (e) {
      setError(String(e));
    }
  }

  function copySelectedPaths() {
    const paths = selectedEntries().map((entry) => entry.path);
    if (paths.length === 0) return;
    navigator.clipboard?.writeText(paths.join("\n")).catch(() => {});
  }

  function revealSelected() {
    const target = firstSelectedEntry();
    if (!target) return;
    const path = target.is_dir ? target.path : target.path.slice(0, target.path.lastIndexOf("/"));
    openFile(path, undefined, projectId).catch((e) => setError(String(e)));
  }

  function showProperties() {
    const target = firstSelectedEntry();
    if (!target) return;
    const type = target.is_dir ? "Folder" : target.mime || target.extension || "File";
    window.alert([
      target.name,
      "",
      `Path: ${target.path}`,
      `Type: ${type}`,
      target.is_dir ? "" : `Size: ${fmtSize(target.size)}`,
      `Modified: ${fmtModified(target.modified_secs) || "Unknown"}`,
    ].filter(Boolean).join("\n"));
  }

  function showEntryContextMenu(event: React.MouseEvent, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
    }
    setContextMenu({ kind: "entry", x: event.clientX, y: event.clientY, path: entry.path });
  }

  function showBackgroundContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    if (event.target !== event.currentTarget) return;
    setSelected(new Set());
    setContextMenu({ kind: "background", x: event.clientX, y: event.clientY });
  }

  function runContextAction(action: () => void) {
    setContextMenu(null);
    action();
  }

  function submitPath(event: React.FormEvent) {
    event.preventDefault();
    const raw = pathEntry.trim();
    const root = projectDir.replace(/\/+$/, "");
    const nextRel = raw.startsWith("/") ? relFromAbs(root, raw) : raw.replace(/^\/+/, "");
    load(nextRel);
  }

  if (!projectDir) {
    return <div className="file-browser-empty">No project selected</div>;
  }

  const canMutate = selected.size > 0;

  return (
    <section className={`file-browser ${active ? "active" : ""}`}>
      <div className="file-browser-toolbar">
        <button onClick={goBack} disabled={history.length === 0} title="Back">‹</button>
        <button onClick={goForward} disabled={future.length === 0} title="Forward">›</button>
        <button onClick={() => load(parentRel(relPath))} disabled={!relPath} title="Up">↑</button>
        <button onClick={() => load(relPath, { replace: true })} title="Refresh">↻</button>
        <form className="file-browser-path" onSubmit={submitPath}>
          <span>{projectDir.split("/").pop() || projectDir}</span>
          <input value={pathEntry} onChange={(e) => setPathEntry(e.target.value)} placeholder="/" />
        </form>
        <input
          className="file-browser-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
        />
        <button className={viewMode === "list" ? "selected" : ""} onClick={() => setViewMode("list")}>List</button>
        <button className={viewMode === "icons" ? "selected" : ""} onClick={() => setViewMode("icons")}>Icons</button>
      </div>

      <div className="file-browser-actions">
        <button onClick={() => createEntry("file")}>New File</button>
        <button onClick={() => createEntry("folder")}>New Folder</button>
        <button onClick={renameSelected} disabled={!canMutate}>Rename</button>
        <button onClick={deleteSelected} disabled={!canMutate}>Delete</button>
        <button onClick={copySelectedPaths} disabled={!canMutate}>Copy Path</button>
        <button onClick={revealSelected} disabled={!canMutate}>Reveal</button>
        <label><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Hidden</label>
        <label><input type="checkbox" checked={showStandardFiles} onChange={(e) => setShowStandardFiles(e.target.checked)} /> Scaffold</label>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="name">Name</option>
          <option value="type">Type</option>
          <option value="size">Size</option>
          <option value="modified">Modified</option>
        </select>
        <button onClick={() => setDescending((v) => !v)}>{descending ? "Desc" : "Asc"}</button>
      </div>

      <div className="file-browser-body">
        <aside className="file-browser-sidebar">
          <button className={!relPath ? "selected" : ""} onClick={() => load("")}>Project root</button>
          {entries.filter((e) => e.is_dir).slice(0, 80).map((entry) => (
            <button key={entry.path} onClick={() => load(joinRel(relPath, entry.name))}>
              {entry.name}
            </button>
          ))}
        </aside>
        <div className="file-browser-main" onContextMenu={showBackgroundContextMenu}>
          {loading && <div className="file-browser-message">Loading...</div>}
          {error && <div className="file-browser-error">{error}</div>}
          {!loading && displayed.length === 0 && <div className="file-browser-message">No files</div>}
          {viewMode === "list" ? (
            <div className="file-browser-list">
              <div className="file-browser-list-head">
                <span>Name</span><span>Type</span><span>Size</span><span>Modified</span>
              </div>
              {displayed.map((entry) => (
                <div
                  key={entry.path}
                  className={`file-browser-row ${selected.has(entry.path) ? "selected" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={() => activate(entry)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span><b>{entry.is_dir ? folderIcon() : fileIcon(entry.extension)}</b>{entry.name}</span>
                  <span>{entry.is_dir ? "Folder" : entry.extension || entry.mime || "File"}</span>
                  <span>{entry.is_dir ? "" : fmtSize(entry.size)}</span>
                  <span>{fmtModified(entry.modified_secs)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="file-browser-icons">
              {displayed.map((entry) => (
                <button
                  key={entry.path}
                  className={`file-browser-tile ${selected.has(entry.path) ? "selected" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={() => activate(entry)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span>{entry.is_dir ? folderIcon() : fileIcon(entry.extension)}</span>
                  <b>{entry.name}</b>
                </button>
              ))}
            </div>
          )}
          {contextMenu && (
            <div
              className="context-menu file-browser-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {contextMenu.kind === "entry" ? (
                <>
                  <button onClick={() => runContextAction(() => firstSelectedEntry() && activate(firstSelectedEntry()!))}>Open</button>
                  <button onClick={() => runContextAction(copySelectedPaths)}>Copy Path</button>
                  <button onClick={() => runContextAction(revealSelected)}>Reveal</button>
                  <hr />
                  <button onClick={() => runContextAction(renameSelected)}>Rename</button>
                  <button onClick={() => runContextAction(deleteSelected)}>Delete</button>
                  <hr />
                  <button onClick={() => runContextAction(showProperties)}>Properties</button>
                </>
              ) : (
                <>
                  <button onClick={() => runContextAction(() => createEntry("file"))}>New File</button>
                  <button onClick={() => runContextAction(() => createEntry("folder"))}>New Folder</button>
                  <button onClick={() => runContextAction(() => load(relPath, { replace: true }))}>Refresh</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="file-browser-status">
        {displayed.length} item{displayed.length === 1 ? "" : "s"}
        {selected.size > 0 ? `, ${selected.size} selected` : ""}
        {projectId ? ` · ${projectId}` : ""}
      </footer>
    </section>
  );
}
