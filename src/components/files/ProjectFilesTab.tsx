import { useEffect, useState } from "react";
import { ProjectFilesView } from "./ProjectFilesView";
import { useIndependentFileSource } from "./ProjectFilesPane";
import { useProjectsStore } from "../../stores/projects";
import { PROJECT_FILES_TAB_CMD, useTabsStore } from "../../stores/tabs";
import { resolveProjectDirectory } from "../../types";

/**
 * Open a Files (Project) tab on a folder — what the file tree's "Open in a new
 * tab" does, from the right panel and from another Files (Project) tab alike.
 * The tab lands in the store's current scope, i.e. the project the tree belongs
 * to. Always labelled "Files (Project)" so it reads as this tab kind (not the
 * plain "Files" explorer) at a glance; the browsed folder shows in the tab's
 * own header instead (see `ProjectFilesView`'s header).
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
 * The "Files (Project)" tab: the right panel's file viewer, hosted in a tab.
 * Everything visible — the view switcher, git bar + history, search, apps,
 * orange list, tree, drag-and-drop, sync overlay, type tags, source switch and
 * settings — comes from the shared `ProjectFilesView`, the same component
 * `RightPanel` renders, so the tab can never drift from the panel. This host
 * owns only what must differ: it resolves the project from its own `scope`
 * (rather than the active project) and keeps the browsed folder on the *tab*
 * (`TabEntry.folder`, persisted), which is what makes "Open in a new tab" on a
 * folder mean anything after a restart. It passes none of the panel-only window
 * chrome (pin, resize border, hidden-subwindows) — a tab has none.
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
  /** Override where a folder change is persisted. The docked subwindow viewer
   *  passes this to route the browsed folder onto its group NODE
   *  (`GroupNode.filesFolder`) instead of a tab; when omitted, a folder change
   *  persists onto `tabKey`'s `TabEntry.folder` as before. */
  persistFolder?: (folder: string) => void;
  /** Whether this window owns the tab store (the main window does; a popout runs
   *  on a streamed copy). Gates the tree's "Open in a new tab" action. */
  canOpenTabs?: boolean;
  /** Whether this tab is the visible one in its group. Gates the git/windows
   *  probes so a background tab doesn't churn — its tree stays mounted regardless. */
  visible?: boolean;
  /** Compact mode: strip the header + view-switcher toolbar + sync/sort rows so
   *  the find-files search is topmost. Set by the docked subwindow viewer only. */
  compact?: boolean;
}

export function ProjectFilesTab({
  scope,
  cwd,
  tabKey,
  folder: initialFolder,
  canOpenTabs,
  visible,
  compact,
  persistFolder,
}: Props) {
  const projects = useProjectsStore((s) => s.projects);
  const project = projects.find((p) => p.id === scope) ?? null;
  const projectDir = project ? resolveProjectDirectory(project) : cwd;

  const [folder, setFolder] = useState(initialFolder ?? "");
  const [source, setSource] = useIndependentFileSource(project?.id ?? null, !!project?.remote);

  // Re-seed when the persisted folder changes out from under us — a restart
  // restore or a popout's streamed `files` edit hands a new browsed folder that
  // must win over local state. In steady state the persisted value tracks
  // `folder`, so this is a no-op except on those external updates.
  useEffect(() => {
    setFolder(initialFolder ?? "");
  }, [initialFolder]);

  const onFolderChange = (next: string) => {
    setFolder(next);
    // Persist so it reopens where it was left (debounced by the store's own
    // saveLayout): the docked viewer routes onto its group node (persistFolder),
    // a tab onto its own TabEntry.folder.
    if (persistFolder) persistFolder(next);
    else if (tabKey) useTabsStore.getState().setTabFolder(tabKey, next);
  };

  if (!projectDir) {
    return <div className="file-tree-empty">No project selected</div>;
  }

  return (
    <ProjectFilesView
      scope={scope}
      projectId={project?.id ?? null}
      project={project}
      projectDir={projectDir}
      folder={folder}
      onFolderChange={onFolderChange}
      source={source}
      setSource={setSource}
      // The tab keeps its tree (and fs-watch) mounted even in the background, but
      // must not run git/windows probes off-screen.
      active={visible ?? true}
      mountTree
      onOpenFolderTab={canOpenTabs ? (rel) => openProjectFilesTab(projectDir, rel) : undefined}
      containerClassName="project-files-tab"
      compact={compact}
    />
  );
}
