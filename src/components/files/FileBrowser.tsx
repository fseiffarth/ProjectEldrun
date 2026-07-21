import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { useWindowsStore } from "../../stores/windows";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import {
  type FileEntry,
  type SortKey,
  STANDARD_PROJECT_FILES,
  disabledViewers,
  fileIcon,
  folderIcon,
  fmtModified,
  fmtSize,
  joinRel,
  parentRel,
  relFromAbs,
  visibleEntries,
} from "../../lib/viewers/fileUtils";
import { basename, dirname, isAbsolute } from "../../lib/paths";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import { openFileEntry } from "./openFileEntry";

type ProjectJson = Record<string, unknown>;

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

type ViewMode = "list" | "icons";
const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  type: "Type",
  size: "Size",
  modified: "Modified",
  created: "Created",
};
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
  const projects = useProjectsStore((s) => s.projects);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const [relPath, setRelPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [showStandardFiles, setShowStandardFiles] = useState(true);
  const [separateScaffold, setSeparateScaffold] = useState(true);
  const [showUserHidden, setShowUserHidden] = useState(false);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [query, setQuery] = useState("");
  const [pathEntry, setPathEntry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const localFile = projects.find((p) => p.id === projectId)?.local_file ?? null;

  useEffect(() => {
    if (!localFile) {
      setHiddenEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      return;
    }
    invoke<ProjectJson>("load_project", { localFile })
      .then((project) => {
        setHiddenEndings(readStringList(project, "panel_hidden_endings"));
        setHiddenPaths(readStringList(project, "panel_hidden_paths"));
        setShownPaths(readStringList(project, "panel_shown_paths"));
      })
      .catch(() => {
        setHiddenEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
      });
  }, [localFile]);

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
    () => visibleEntries(entries, {
      showHidden,
      showStandardFiles,
      query,
      sortKey,
      descending,
      relPath,
      hiddenEndings: showUserHidden ? [] : hiddenEndings,
      hiddenPaths: showUserHidden ? [] : hiddenPaths,
      shownPaths: showUserHidden ? [] : shownPaths,
    }),
    [entries, showHidden, showStandardFiles, query, sortKey, descending, relPath, showUserHidden, hiddenEndings, hiddenPaths, shownPaths],
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

  // Open on double-click. A folder navigates in; a file with a native in-app
  // viewer opens in the project's focused subwindow, while a type with no native
  // viewer — or a Shift+double-click — opens in the OS default app. The single
  // open-a-file policy shared with the FileTree (see `openFileEntry`).
  function activate(entry: FileEntry, ev?: React.MouseEvent) {
    if (entry.is_dir) {
      load(joinRel(relPath, entry.name));
      return;
    }
    openFileEntry({
      entry,
      projectDir,
      projectId,
      origin: "middle_file_browser",
      external: ev?.shiftKey ?? false,
      disabled: disabledViewerSet,
    });
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
      // Retarget any open viewer tab of this file (main + detached) to the new
      // path — swap the basename on the entry's own absolute path (== embedPath).
      const oldAbs = target.path;
      const newAbs = `${oldAbs.slice(0, oldAbs.lastIndexOf("/") + 1)}${nextName.trim()}`;
      retargetTabsForRenamedPath(oldAbs, newAbs);
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
        // Close any open viewer tab for the deleted file/folder (main + detached).
        closeTabsForDeletedPath(target.path);
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
    const path = target.is_dir ? target.path : dirname(target.path);
    openFile(path, undefined, projectId, "middle_file_browser").catch((e) =>
      setError(String(e)),
    );
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
    const nextRel = isAbsolute(raw) ? relFromAbs(projectDir, raw) : raw.replace(/^\/+/, "");
    load(nextRel);
  }

  if (!projectDir) {
    return <div className="file-browser-empty">No project selected</div>;
  }

  const canMutate = selected.size > 0;

  // Delete key removes the current selection — the keyboard twin of the Delete
  // button / context-menu action. Ignored while a text field (path/search/rename
  // prompt) has focus so it never eats a keystroke there.
  function handleKeyDown(ev: React.KeyboardEvent) {
    if (ev.key !== "Delete" || selected.size === 0) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    ev.preventDefault();
    void deleteSelected();
  }

  return (
    <section className={`file-browser ${active ? "active" : ""}`} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="file-browser-toolbar">
        <button onClick={goBack} disabled={history.length === 0} title="Back">‹</button>
        <button onClick={goForward} disabled={future.length === 0} title="Forward">›</button>
        <button onClick={() => load(parentRel(relPath))} disabled={!relPath} title="Up">↑</button>
        <button onClick={() => load(relPath, { replace: true })} title="Refresh">↻</button>
        <form className="file-browser-path" onSubmit={submitPath}>
          <span>{basename(projectDir) || projectDir}</span>
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
        <label><Toggle size="sm" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Hidden</label>
        <label><Toggle size="sm" checked={showStandardFiles} onChange={(e) => setShowStandardFiles(e.target.checked)} /> Scaffold</label>
        <label><Toggle size="sm" checked={separateScaffold} onChange={(e) => setSeparateScaffold(e.target.checked)} /> Separate scaffold</label>
        <label><Toggle size="sm" checked={showUserHidden} onChange={(e) => setShowUserHidden(e.target.checked)} /> User hidden</label>
        <Dropdown
          title="Sort by"
          value={sortKey}
          onChange={(v) => setSortKey(v as SortKey)}
          options={(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
            value: key,
            label: SORT_LABELS[key],
          }))}
        />
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
          {(() => {
            const splitScaffold = !relPath && showStandardFiles && separateScaffold;
            const regular = splitScaffold ? displayed.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : displayed;
            const scaffold = splitScaffold ? displayed.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];

            function renderListRow(entry: FileEntry, isScaffold = false) {
              return (
                <div
                  key={entry.path}
                  className={`file-browser-row${selected.has(entry.path) ? " selected" : ""}${isScaffold ? " scaffold" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={(e) => activate(entry, e)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span><b>{entry.is_dir ? folderIcon() : fileIcon(entry.extension)}</b>{entry.name}</span>
                  <span>{entry.is_dir ? "Folder" : entry.extension || entry.mime || "File"}</span>
                  <span>{entry.is_dir ? "" : fmtSize(entry.size)}</span>
                  <span>{fmtModified(entry.modified_secs)}</span>
                </div>
              );
            }

            function renderIconTile(entry: FileEntry, isScaffold = false) {
              return (
                <button
                  key={entry.path}
                  className={`file-browser-tile${selected.has(entry.path) ? " selected" : ""}${isScaffold ? " scaffold" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={(e) => activate(entry, e)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span>{entry.is_dir ? folderIcon() : fileIcon(entry.extension)}</span>
                  <b>{entry.name}</b>
                </button>
              );
            }

            return viewMode === "list" ? (
              <div className="file-browser-list">
                <div className="file-browser-list-head">
                  <span>Name</span><span>Type</span><span>Size</span><span>Modified</span>
                </div>
                {regular.map((e) => renderListRow(e, false))}
                {scaffold.length > 0 && (
                  <>
                    <div className="file-browser-section-divider">scaffold</div>
                    {scaffold.map((e) => renderListRow(e, true))}
                  </>
                )}
              </div>
            ) : (
              <div className="file-browser-icons">
                {regular.map((e) => renderIconTile(e, false))}
                {scaffold.length > 0 && (
                  <>
                    <div className="file-browser-section-divider file-browser-section-divider--icons">scaffold</div>
                    {scaffold.map((e) => renderIconTile(e, true))}
                  </>
                )}
              </div>
            );
          })()}
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
