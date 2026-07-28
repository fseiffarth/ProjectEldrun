import { useEffect, useMemo, useState } from "react";
import { FileTree } from "./FileTree";
import { DownloadsSection } from "./DownloadsSection";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore } from "../../stores/sync";
import { confirmSyncTransfer } from "../../stores/syncConfirm";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { useFileSourcePrefStore } from "../../stores/fileSourcePref";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import type { ProjectBox, ProjectEntry } from "../../types";
import type { SortKey } from "../../lib/viewers/fileUtils";
import { useT, type TranslationKey } from "../../lib/i18n";

const SORT_KEY_LABEL: Record<SortKey, TranslationKey> = {
  name: "sortKey.name",
  size: "sortKey.size",
  type: "sortKey.type",
  created: "sortKey.created",
  modified: "sortKey.modified",
};

/**
 * THE project file view — the tree, its sort row, the remote sync row and the
 * Downloads section. Rendered twice: by the right panel, and by the "Files
 * (Project)" tab (`ProjectFilesTab`). One component, so the two can never drift
 * into two different file views of the same project.
 *
 * What each host still owns is what must differ between them: the browsed
 * folder (two views of one project must not yank each other around), the
 * remote/local source switch's placement, and the chrome around the tree.
 */

/** Whether a remote project's SSH pool is down. Git/endings/SFTP probes are
 *  SYNCHRONOUS Tauri commands (main thread), so dispatching one at a dead
 *  session freezes the window — every caller gates on this. Local projects are
 *  never blocked. */
export function useRemoteBlocked(projectId: string | null, isRemote: boolean) {
  const remoteSshState = useRemoteStatusStore((s) =>
    projectId ? s.byProject[projectId]?.ssh : undefined,
  );
  return { remoteSshState, remoteBlocked: isRemote && remoteSshState !== "connected" };
}

/**
 * Which side of a remote project a file view shows. Defaults to whichever side
 * is actually usable when the project changes: connected → Remote (the host
 * tree), disconnected → Local (the mirror, so the view doesn't open on a Connect
 * prompt). Only resets on a project switch — it never fights a mid-session
 * manual toggle (flip to Remote, then lose the connection: the Connect
 * placeholder takes over, but the toggle stays put).
 *
 * Backed by `useFileSourcePrefStore` (keyed by project id), not local state, so
 * a freshly opened subwindow file viewer (`FileViewerPane`) can default to
 * whichever side this tree is CURRENTLY showing for the project.
 */
export function useFileSource(projectId: string | null, isRemote: boolean) {
  const stored = useFileSourcePrefStore((s) => (projectId ? s.byProject[projectId] : undefined));
  const { remoteSshState } = useRemoteBlocked(projectId, isRemote);
  // `isRemote` (not just `projectId`) in the deps: a project can flip local → remote
  // ("Extend to remote") while this view is already mounted on the same id, and
  // without re-seeding here it keeps whatever the store already held — typically
  // nothing for a project that was never remote, which falls through to the
  // "remote" default below and points every file op at an SFTP host that may not
  // have finished its first lockstep sync yet. `isRemote` itself only moves on an
  // extend/detach, never on a mere connect/disconnect, so this can't fight a
  // mid-session manual toggle the way resetting on `remoteSshState` would.
  useEffect(() => {
    if (projectId && isRemote) {
      useFileSourcePrefStore.getState().set(projectId, remoteSshState === "connected" ? "remote" : "local");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isRemote]);
  const setSource = (s: "remote" | "local") => {
    if (projectId) useFileSourcePrefStore.getState().set(projectId, s);
  };
  return [stored ?? "remote", setSource] as const;
}

/**
 * Like `useFileSource`, but for a viewer that must NOT keep mirroring the
 * shared per-project preference forever — only take it as a starting point.
 * Every `ProjectFilesTab` instance (the standalone Files (Project) tab, and
 * every per-subwindow ◫ sidebar) used to share `useFileSourcePrefStore`
 * with the right panel, so flipping Local/Remote *anywhere* flipped it
 * *everywhere* for that project — one shared toggle wearing many faces
 * instead of each viewer owning its own. This seeds from the right panel's
 * current value on mount (and again if the underlying project's identity or
 * remote-ness changes, matching `useFileSource`'s own reseed), then keeps the
 * choice in plain component state: this viewer's later toggles never write
 * back to the shared store, and the shared store's later changes never read
 * back into this viewer.
 */
export function useIndependentFileSource(projectId: string | null, isRemote: boolean) {
  const { remoteSshState } = useRemoteBlocked(projectId, isRemote);
  const [source, setSource] = useState<"remote" | "local">("remote");
  useEffect(() => {
    if (!projectId || !isRemote) return;
    const shared = useFileSourcePrefStore.getState().byProject[projectId];
    setSource(shared ?? (remoteSshState === "connected" ? "remote" : "local"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isRemote]);
  return [source, setSource] as const;
}

/** The Remote/Local file-source switch (remote SSH projects only). A live
 *  segmented control — NOT a tag — that flips the tree between the host tree
 *  over SFTP ("Remote") and the synced mirror ("Local"). */
export function FileSourceSwitch({
  source,
  onChange,
  remoteDisabled = false,
  remoteDisabledTitle,
}: {
  source: "remote" | "local";
  onChange: (s: "remote" | "local") => void;
  /** Disable the Remote segment — used when the open file has no counterpart on
   *  the host (a local-only file), so the switch can't strand the viewer on a
   *  read error. Ignored while the Remote side is the active one. */
  remoteDisabled?: boolean;
  remoteDisabledTitle?: string;
}) {
  const t = useT();
  // Never disable the segment that's currently active — that would leave the
  // switch with no lit button. (A remote-native tab whose file is missing shows
  // its own read error; the escape hatch there is switching TO Local.)
  const disableRemote = remoteDisabled && source !== "remote";
  return (
    <span className="right-panel-source-switch" role="group" aria-label={t("fileSourceSwitch.ariaLabel")}>
      <button
        type="button"
        className={`source-seg${source === "local" ? " active" : ""}`}
        aria-pressed={source === "local"}
        onClick={() => onChange("local")}
        title={t("fileSourceSwitch.localTitle")}
      >
        {t("fileSourceSwitch.local")}
      </button>
      <button
        type="button"
        className={`source-seg${source === "remote" ? " active" : ""}`}
        aria-pressed={source === "remote"}
        disabled={disableRemote}
        onClick={() => onChange("remote")}
        title={
          disableRemote
            ? remoteDisabledTitle ?? t("fileSourceSwitch.remoteDisabledTitle")
            : t("fileSourceSwitch.remoteTitle")
        }
      >
        {t("fileSourceSwitch.remote")}
      </button>
    </span>
  );
}

export interface BoxRoot {
  rootId: string;
  label: string;
  icon: string;
  dir: string;
  localFile?: string;
  variant: "box" | "member";
}

/** A box scope has no single root: the file view shows the box folder plus every
 *  member project's root. Resolved from the scope id, not the active project. */
export function useBoxRoots(scope: string): { activeBox: ProjectBox | null; boxRoots: BoxRoot[] } {
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const activeBox = useMemo(
    () =>
      scope.startsWith(BOX_SCOPE_PREFIX)
        ? boxes.find((b) => boxScopeId(b.id) === scope) ?? null
        : null,
    [scope, boxes],
  );
  const boxRoots = useMemo(() => {
    if (!activeBox) return [];
    const roots: BoxRoot[] = [];
    if (activeBox.folder) {
      roots.push({ rootId: scope, label: activeBox.name, icon: "▣", dir: activeBox.folder, variant: "box" });
    }
    for (const id of activeBox.member_ids) {
      const p = projects.find((m) => m.id === id);
      if (!p) continue;
      const dir = resolveProjectDirectory(p);
      if (!dir) continue;
      roots.push({ rootId: p.id, label: p.name, icon: "📁", dir, localFile: p.local_file, variant: "member" });
    }
    return roots;
  }, [activeBox, projects, scope]);
  return { activeBox, boxRoots };
}

/** One collapsible root inside the box multi-root file view. Reuses `FileTree`
 *  as-is for a single directory; per-root navigation persists via the projects
 *  store's `rightPanelFolderByProject` map keyed by the root's id. */
function BoxRootSection({
  rootId,
  label,
  icon,
  dir,
  localFile,
  variant,
  sortKey,
  descending,
}: BoxRoot & { sortKey: SortKey; descending: boolean }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const rel = useProjectsStore((s) => s.rightPanelFolderByProject[rootId] ?? "");
  const setRightPanelFolder = useProjectsStore((s) => s.setRightPanelFolder);
  return (
    <div className={`file-root file-root--${variant}${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="file-root-header"
        onClick={() => setCollapsed((c) => !c)}
        title={dir}
      >
        <span className="file-root-caret" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="file-root-icon" aria-hidden>
          {icon}
        </span>
        <span className="file-root-name">{label}</span>
        <span className="file-root-kind">
          {t(variant === "box" ? "fileRoot.kindBox" : "fileRoot.kindProject")}
        </span>
      </button>
      {!collapsed && (
        <div className="file-root-body">
          <FileTree
            // Same invariant as the single-root tree: (project, root dir) is the
            // tree's identity, so a root whose directory moves remounts rather
            // than repainting the old one's entries under the new path.
            key={`${rootId}|${dir}`}
            projectDir={dir}
            projectId={rootId}
            localFile={localFile}
            sortKey={sortKey}
            descending={descending}
            hiddenEndings={[]}
            hiddenPaths={[]}
            shownPaths={[]}
            initialRelPath={rel}
            onRelPathChange={(folder) => setRightPanelFolder(rootId, folder)}
          />
        </div>
      )}
    </div>
  );
}

interface Props {
  /** Tab scope this view belongs to: a project id, a `box:<id>` scope, or "root". */
  scope: string;
  /** The project the tree shows, or null in the root scope / a box scope. */
  project: ProjectEntry | null;
  /** The tree's root directory (the project dir, or the tab's cwd at root). */
  projectDir: string;
  /** Project-relative folder currently browsed, owned by the host. */
  folder: string;
  onFolderChange: (folder: string) => void;
  /** Which side of a remote project to show (see useFileSource). */
  source: "remote" | "local";
  hiddenEndings: string[];
  hiddenPaths: string[];
  shownPaths: string[];
  /** Folders excluded from recursive scans, and the toggle that maintains the
   *  list. Omitted by hosts with no project.json to write to (a box's multi-root
   *  view), which simply don't offer the action. */
  scanExcluded?: string[];
  onToggleScanExcluded?: (relPath: string, excluded: boolean) => void;
  /** Sort is the host's, not the pane's: the right panel unmounts this pane when
   *  it shows Git/Search, and a sort order that reset itself on the way back
   *  would be a worse view than the one the user chose. */
  sortKey: SortKey;
  descending: boolean;
  onSortChange: (sortKey: SortKey, descending: boolean) => void;
  showDownloads: boolean;
  onCloseDownloads: () => void;
  /** Offers the tree's "Open in a new tab" action (see FileTree). Omitted where
   *  the host can't own a tab — a box's multi-root view, a detached window. */
  onOpenFolderTab?: (relPath: string) => void;
  /** False keeps the tree unmounted (the right panel does this while closed, so
   *  a hidden panel costs no fs-watch). */
  mountTree?: boolean;
  /** Compact (docked subwindow) mode: hide the remote-sync row and the sort row
   *  so the tree's find-files search box is the topmost element. */
  compact?: boolean;
}

export function ProjectFilesPane({
  scope,
  project,
  projectDir,
  folder,
  onFolderChange,
  source,
  hiddenEndings,
  hiddenPaths,
  shownPaths,
  scanExcluded,
  onToggleScanExcluded,
  sortKey,
  descending,
  onSortChange,
  showDownloads,
  onCloseDownloads,
  onOpenFolderTab,
  mountTree = true,
  compact,
}: Props) {
  const t = useT();
  const { activeBox, boxRoots } = useBoxRoots(scope);
  const projectId = project?.id ?? null;
  const isRemoteProject = !!project?.remote;
  const { remoteSshState, remoteBlocked } = useRemoteBlocked(projectId, isRemoteProject);
  const syncMap = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));

  return (
    <>
      {/* The whole-tree sync action for the active source: Remote → pull the host
          tree into the mirror; Local → push the mirror back to the host (skipping
          host-diverged/orange files). Both need a live connection, so the row is
          gated on !remoteBlocked. */}
      {!compact && !activeBox && isRemoteProject && projectId && !remoteBlocked && (
        <div className="right-panel-source">
          {/* Project-wide auto-sync toggle: the root "" marker. When on, the
              whole tree bidirectionally auto-syncs; individual files/folders
              can still be carved out (or opted in) from their own context
              menu, which overrides this. */}
          {(() => {
            const autoAll = !!syncMap?.[""]?.auto;
            return (
              <button
                className="tab-add-btn"
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  height: 20,
                  ...(autoAll
                    ? { color: "var(--accent)", borderColor: "var(--accent)" }
                    : {}),
                }}
                onClick={() =>
                  void useSyncStore.getState().setAuto(projectId, [""], !autoAll, true)
                }
                title={t(
                  autoAll
                    ? "projectFilesPane.autoSyncOnTitle"
                    : "projectFilesPane.autoSyncOffTitle",
                )}
              >
                {t(autoAll ? "projectFilesPane.autoSyncOn" : "projectFilesPane.autoSyncOff")}
              </button>
            );
          })()}
          {/* The whole-project version of the file tree's per-folder auto-sync
              price check: which folders are too big to sync, on both sides. It
              opens itself once when a project is first paired with a host; this
              is how it is re-opened (e.g. once the project is finally connected,
              so the host column can be filled in). */}
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20 }}
            onClick={() => useBigFoldersStore.getState().open(projectId)}
            title={t("projectFilesPane.bigFoldersTitle")}
          >
            {t("projectFilesPane.bigFolders")}
          </button>
          {/* Both directions ask first (`stores/syncConfirm`). This is the widest
              transfer in the app — one click over the *whole* tree, in whichever
              direction the source switch happens to be on — so the one thing it
              must never be is ambiguous about which side it is about to
              overwrite. */}
          {source === "remote" ? (
            <button
              className="tab-add-btn"
              style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: "auto" }}
              onClick={() =>
                void (async () => {
                  const ok = await confirmSyncTransfer({
                    projectId,
                    direction: "pull",
                    relPath: "",
                    isDir: true,
                    label: project?.name ?? projectId,
                  });
                  if (ok) await useSyncStore.getState().syncWholeProject(projectId);
                })()
              }
              title={t("projectFilesPane.syncAllRemoteTitle")}
            >
              {t("projectFilesPane.syncAll")}
            </button>
          ) : (
            <button
              className="tab-add-btn"
              style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: "auto" }}
              onClick={() =>
                void (async () => {
                  const ok = await confirmSyncTransfer({
                    projectId,
                    direction: "push",
                    relPath: "",
                    isDir: true,
                    label: project?.name ?? projectId,
                  });
                  if (ok) await useSyncStore.getState().pushWholeProject(projectId);
                })()
              }
              title={t("projectFilesPane.syncAllLocalTitle")}
            >
              {t("projectFilesPane.syncAll")}
            </button>
          )}
        </div>
      )}
      {!compact && (
      <div className="right-panel-sort">
        {(["name", "size", "type", "created", "modified"] as SortKey[]).map((key) => (
          <button
            key={key}
            className={`sort-key-btn${sortKey === key ? " active" : ""}`}
            onClick={() =>
              sortKey === key
                ? onSortChange(key, !descending)
                : onSortChange(key, descending)
            }
            title={
              sortKey === key
                ? t(
                    descending
                      ? "projectFilesPane.sortDescendingTitle"
                      : "projectFilesPane.sortAscendingTitle",
                  )
                : t("projectFilesPane.sortByTitle", { key: t(SORT_KEY_LABEL[key]) })
            }
          >
            {t(SORT_KEY_LABEL[key])}{sortKey === key ? (descending ? " ↓" : " ↑") : ""}
          </button>
        ))}
      </div>
      )}
      <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {mountTree && activeBox ? (
          boxRoots.length === 0 ? (
            <div className="file-tree-empty">{t("projectFilesPane.noMemberFolders")}</div>
          ) : (
            boxRoots.map((r) => (
              <BoxRootSection
                key={r.rootId}
                {...r}
                sortKey={sortKey}
                descending={descending}
              />
            ))
          )
        ) : (
          mountTree && (() => {
            // A remote project's "Local" source points the tree at the local
            // mirror dir (browsed as a plain local tree); "Remote" keeps the host
            // (SFTP) tree with the sync overlay. A local project ignores it.
            //
            // Disconnected remote source: don't mount the SFTP-backed tree (its
            // main-thread list_dir would freeze the window). Keep the view looking
            // the same — the Remote/Local switch stays up — but show a Connect
            // prompt in the tree area. Selecting "Local" still browses the offline
            // mirror.
            if (isRemoteProject && source === "remote" && remoteBlocked) {
              return (
                <div className="file-tree-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <div>
                    {remoteSshState === "connecting"
                      ? t("projectFilesPane.connecting")
                      : t("projectFilesPane.disconnected")}
                  </div>
                  {remoteSshState !== "connecting" && projectId && (
                    <button
                      type="button"
                      className="dialog-connect-btn"
                      onClick={() => useRemoteMachinesStore.getState().open(projectId)}
                    >
                      {t("common.connect")}
                    </button>
                  )}
                </div>
              );
            }
            // The relocatable mirror override (projects.json `extra["mirror"]`,
            // updated by `move_remote_mirror`) is authoritative; fall back to the
            // default `<state_dir>/mirror` only for legacy projects that never
            // persisted one. Computing `${projectDir}/mirror` unconditionally
            // pointed the Local tree at the pre-move location after a relocate.
            const mirrorDir =
              resolveLocalMirror(project) ??
              (projectDir
                ? `${projectDir.replace(/[/\\]+$/, "")}/mirror`
                : projectDir);
            const treeDir = isRemoteProject && source === "local" ? mirrorDir : projectDir;
            return (
              <FileTree
                // The tree's identity IS (project, root dir) — every piece of its
                // state (browsed rel path, the listed entries and their ABSOLUTE
                // paths, selection, git statuses, folder sizes) belongs to that
                // pair, and none of it is re-derived from props on a change. Its
                // one reload effect is gated on `remoteBlocked`, so switching to
                // a not-yet-connected remote project left the previous project's
                // listing on screen — under the new project's root — and opening
                // a row then acted on the OLD project's path. Keying makes the
                // switch a remount, so no state can outlive the project it
                // describes. The same holds for the Remote/Local source flip,
                // which is likewise a different root dir.
                key={`${projectId ?? ""}|${treeDir}`}
                projectDir={treeDir}
                projectId={projectId}
                localFile={project?.local_file}
                sortKey={sortKey}
                descending={descending}
                hiddenEndings={hiddenEndings}
                hiddenPaths={hiddenPaths}
                shownPaths={shownPaths}
                scanExcluded={scanExcluded}
                onToggleScanExcluded={onToggleScanExcluded}
                initialRelPath={folder}
                onRelPathChange={onFolderChange}
                onOpenFolderTab={onOpenFolderTab}
                syncSource={isRemoteProject ? source : undefined}
                remoteProbeDir={isRemoteProject ? projectDir : undefined}
              />
            );
          })()
        )}
      </div>
      {showDownloads && !activeBox && projectDir && (
        <DownloadsSection
          projectDir={projectDir}
          projectId={projectId}
          targetFolder={folder}
          isRemote={isRemoteProject}
          onClose={onCloseDownloads}
        />
      )}
    </>
  );
}
