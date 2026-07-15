import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FileSourceSwitch,
  ProjectFilesPane,
  useBoxRoots,
  useFileSource,
  useRemoteBlocked,
} from "./ProjectFilesPane";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "./ProjectFilesSettings";
import { useImportDrop } from "./importDrop";
import { useProjectsStore } from "../../stores/projects";
import { PROJECT_FILES_TAB_CMD, useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";
import type { SortKey } from "../../lib/viewers/fileUtils";

/**
 * Open a Files (Project) tab on a folder — what the file tree's "Open in a new
 * tab" does, from the right panel and from another Files (Project) tab alike.
 * The tab lands in the store's current scope, i.e. the project the tree belongs
 * to. Always labelled "Files (Project)" so it reads as this tab kind (not the
 * plain "Files" explorer) at a glance; the browsed folder shows in the tab's
 * own header instead (see `ProjectFilesTab`'s header `title`).
 */
export function openProjectFilesTab(cwd: string, folder: string) {
  useTabsStore.getState().addTab({
    label: "Files (Project)",
    cmd: PROJECT_FILES_TAB_CMD,
    args: [],
    env: {},
    cwd,
    kind: "projectfiles",
    folder,
  });
}

/**
 * The "Files (Project)" tab: the right panel's file view, hosted in a tab. The
 * tree, its drag-and-drop, the git markers and the remote sync overlay all come
 * from the shared `ProjectFilesPane` — this file is only the chrome around it
 * (project name, source switch, import / open-in-OS / downloads / settings) plus
 * the state the panel keeps in its own header.
 *
 * The browsed folder is the tab's own (persisted on the tab, see
 * `TabEntry.folder`) rather than the panel's, so navigating here doesn't yank
 * the panel's tree — and "Open in new tab" on a folder lands the tab on it.
 */
interface Props {
  /** The tab's scope: a project id, a `box:<id>` scope, or "root". */
  scope: string;
  /** The tab's cwd — the tree root when the scope has no project (root scope). */
  cwd: string;
  /** This tab's key, so its browsed folder persists onto the tab. */
  tabKey?: string;
  /** The folder the tab was opened on / last left at. */
  folder?: string;
  /** Whether this window owns the tab store (the main window does; a popout runs
   *  on a streamed copy). Gates the tree's "Open in a new tab" action. */
  canOpenTabs?: boolean;
}

export function ProjectFilesTab({
  scope,
  cwd,
  tabKey,
  folder: initialFolder,
  canOpenTabs,
}: Props) {
  const projects = useProjectsStore((s) => s.projects);
  const project = projects.find((p) => p.id === scope) ?? null;
  const projectDir = project ? resolveProjectDirectory(project) : cwd;
  const localFile = project?.local_file;
  const { activeBox } = useBoxRoots(scope);

  const [folder, setFolder] = useState(initialFolder ?? "");
  const [source, setSource] = useFileSource(project?.id ?? null, !!project?.remote);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { remoteBlocked } = useRemoteBlocked(project?.id ?? null, !!project?.remote);
  const filters = useProjectFileFilters({ localFile, projectDir, remoteBlocked });

  // A box scope has several roots, so an OS drop has no single destination.
  const importDrop = useImportDrop({
    projectDir,
    enabled: !activeBox,
    destRel: folder,
  });

  const onFolderChange = (next: string) => {
    setFolder(next);
    // Persist onto the tab so it reopens where it was left (debounced by the
    // store's own saveLayout).
    if (tabKey) useTabsStore.getState().setTabFolder(tabKey, next);
  };

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = folder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  if (!projectDir) {
    return <div className="file-tree-empty">No project selected</div>;
  }

  return (
    <div
      className={`project-files-tab${importDrop.dropActive ? " drop-active" : ""}${importDrop.dropFlash ? " drop-flash" : ""}`}
      {...importDrop.handlers}
    >
      <div className="project-files-tab-header">
        <span
          className="project-files-tab-name"
          title={folder ? `${projectDir}/${folder}` : projectDir}
        >
          {activeBox ? `▣ ${activeBox.name}` : project?.name ?? "Files"}
          {folder && ` — ${folder}`}
        </span>
        {!activeBox && project?.remote && (
          <FileSourceSwitch source={source} onChange={setSource} />
        )}
        <span className="project-files-tab-spacer" />
        {importDrop.canImport && (
          <button
            className="tab-add-btn"
            onClick={() => void importDrop.importViaDialog()}
            title="Import files into this folder"
          >
            ⬇
          </button>
        )}
        <button className="tab-add-btn" onClick={openInOsBrowser} title="Open folder in file manager">
          ⧉
        </button>
        {!activeBox && (
          <button
            className={`tab-add-btn${showDownloads ? " active" : ""}`}
            aria-pressed={showDownloads}
            onClick={() => setShowDownloads((v) => !v)}
            title="Show recent downloads (copy into this project)"
          >
            📥
          </button>
        )}
        {localFile && (
          <button className="tab-add-btn" onClick={() => setShowSettings(true)} title="Project settings">
            ⚙
          </button>
        )}
      </div>

      <ProjectFilesPane
        scope={scope}
        project={project}
        projectDir={projectDir}
        folder={folder}
        onFolderChange={onFolderChange}
        source={source}
        hiddenEndings={filters.hiddenEndings}
        hiddenPaths={filters.hiddenPaths}
        shownPaths={filters.shownPaths}
        sortKey={sortKey}
        descending={descending}
        onSortChange={(key, desc) => {
          setSortKey(key);
          setDescending(desc);
        }}
        showDownloads={showDownloads}
        onCloseDownloads={() => setShowDownloads(false)}
        onOpenFolderTab={
          canOpenTabs ? (rel) => openProjectFilesTab(projectDir, rel) : undefined
        }
      />

      {importDrop.conflictModal}
      {showSettings && localFile && (
        <ProjectFilesSettingsDialog
          localFile={localFile}
          filters={filters}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
