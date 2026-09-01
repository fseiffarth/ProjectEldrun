import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "./FileTree";
import { AlertsSection } from "./AlertsSection";
import { DownloadsSection } from "./DownloadsSection";
import { GitHistory } from "./GitHistory";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "./ProjectFilesSettings";
import { remoteMemberTreeDir } from "../../lib/fileMove";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore } from "../../stores/sync";
import { confirmSyncTransfer } from "../../stores/syncConfirm";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import {
  autoFileSource,
  fileSourceSettled,
  useFileSourcePrefStore,
  viewerSourceKey,
  type FileSourceSide,
} from "../../stores/fileSourcePref";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import type { ProjectBox, ProjectEntry } from "../../types";
import type { SortKey } from "../../lib/viewers/fileUtils";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * THE project file view — the tree, the remote sync row and the Downloads
 * section. Rendered twice: by the side panel, and by the "Files
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
 * Which side of a remote project a file view shows.
 *
 * A side is decided ONCE per project and then only ever moves because the user
 * clicked the switch. The first time the project's SSH lamp reads something
 * definite, the usable side is *latched* into `useFileSourcePrefStore` —
 * connected → Remote (the host tree), otherwise → Local (the mirror, so the view
 * doesn't open on a Connect prompt) — and every later read returns that latch.
 * An explicit click replaces it and is remembered across relaunches.
 *
 * The latch is what this hook exists for. The seed used to be an unconditional
 * mount effect over the live lamp, so *anything* that remounted a file view —
 * hiding/re-showing the panels (the panel is unmounted, not hidden), a scope
 * switch that briefly clears the active project, an "Extend to remote" —
 * silently re-derived the side and threw a deliberate Local choice away the
 * moment the pool came up. From the user's side the tree jumped to Remote with
 * nothing touched. `latch` no-ops when the project already has a side, so a
 * remount now costs nothing.
 *
 * `isRemote` stays in the deps because a project can flip local → remote
 * ("Extend to remote") under a mounted view, and only then is there a side to
 * decide at all.
 */
export function useFileSource(projectId: string | null, isRemote: boolean) {
  const stored = useFileSourcePrefStore((s) => (projectId ? s.byProject[projectId] : undefined));
  const { remoteSshState } = useRemoteBlocked(projectId, isRemote);
  useEffect(() => {
    if (!projectId || !isRemote) return;
    // Only a settled lamp is a decision: latching mid-handshake would freeze
    // "remote" onto a project whose connect is about to fail, and a project with
    // no status entry at all (never activated this session) has said nothing yet.
    if (!fileSourceSettled(remoteSshState)) return;
    useFileSourcePrefStore.getState().latch(projectId, autoFileSource(remoteSshState));
  }, [projectId, isRemote, remoteSshState]);
  const setSource = (s: FileSourceSide) => {
    if (projectId) useFileSourcePrefStore.getState().set(projectId, s);
  };
  return [stored ?? autoFileSource(remoteSshState), setSource] as const;
}

/**
 * Like `useFileSource`, but for a viewer that owns its own switch instead of
 * following the project-wide one. Every `ProjectFilesTab` instance (the
 * standalone Files (Project) tab, and every per-subwindow ◫ sidebar) used to
 * share `useFileSourcePrefStore` with the side panel, so flipping Local/Remote
 * *anywhere* flipped it *everywhere* for that project — one shared toggle
 * wearing many faces instead of each viewer owning its own. This takes the
 * project-wide side as a starting point, latches it, and from then on the two
 * are independent in both directions.
 *
 * The choice lives in the store under `viewerId` rather than in component state,
 * and that is the fix rather than a detail: these viewers are remounted by their
 * hosts (the docked column is `key={scope}`, so every scope switch remounts it),
 * and component state does not survive a remount — the viewer came back seeded
 * from the shared value, i.e. flipped to Remote without the user touching it.
 * A viewer with no stable id keeps the old component-state behaviour.
 */
export function useIndependentFileSource(
  projectId: string | null,
  isRemote: boolean,
  viewerId?: string,
) {
  const { remoteSshState } = useRemoteBlocked(projectId, isRemote);
  const key = viewerId && projectId ? viewerSourceKey(viewerId, projectId) : null;
  const own = useFileSourcePrefStore((s) => (key ? s.byViewer[key] : undefined));
  const shared = useFileSourcePrefStore((s) => (projectId ? s.byProject[projectId] : undefined));
  // Fallback for a viewer with nothing stable to remember a choice against.
  const [local, setLocal] = useState<FileSourceSide | null>(null);
  useEffect(() => {
    setLocal(null);
  }, [projectId, isRemote]);
  useEffect(() => {
    if (!key || !isRemote) return;
    if (!fileSourceSettled(remoteSshState)) return;
    const store = useFileSourcePrefStore.getState();
    store.latchViewer(
      key,
      (projectId ? store.byProject[projectId] : undefined) ?? autoFileSource(remoteSshState),
    );
  }, [key, projectId, isRemote, remoteSshState]);
  const source = own ?? local ?? shared ?? autoFileSource(remoteSshState);
  const setSource = (s: FileSourceSide) => {
    if (key) useFileSourcePrefStore.getState().setViewer(key, s);
    else setLocal(s);
  };
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
    <span className="side-panel-source-switch" role="group" aria-label={t("fileSourceSwitch.ariaLabel")}>
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
  /** The member project is a remote (SSH) one — its tree lives on the host, so
   *  the section must gate on the SSH lamp before mounting `FileTree` (a
   *  synchronous SFTP probe at a dead session freezes the window). */
  remote?: boolean;
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
      roots.push({
        rootId: p.id,
        label: p.name,
        icon: "📁",
        dir,
        localFile: p.local_file,
        variant: "member",
        remote: !!p.remote,
      });
    }
    return roots;
  }, [activeBox, projects, scope]);
  return { activeBox, boxRoots };
}

/** One collapsible root inside the box multi-root file view. Reuses `FileTree`
 *  as-is for a single directory; per-root navigation persists via the projects
 *  store's `sidePanelFolderByProject` map keyed by the root's id.
 *
 *  A MEMBER root also carries its own per-project line under the header — the
 *  same Files/Git/Search + ⧉/⚙ controls (and, for a remote member, the same
 *  Remote/Local source switch) the single-project view has, acting on THIS
 *  member. The switch shares the project-wide side (`useFileSource`), so the
 *  box view and the project's own side panel never disagree about which side
 *  is shown; it also stays reachable while disconnected, so a remote member's
 *  mirror is browsable offline (the switch used to not exist here at all, which
 *  stranded remote members on the host tree). */
function BoxRootSection({
  rootId,
  label,
  icon,
  dir,
  localFile,
  variant,
  remote = false,
  sortKey,
  descending,
  onSortChange,
  active = true,
  searchOpen,
  onSearchOpenChange,
  refreshNonce,
}: BoxRoot & {
  sortKey: SortKey;
  descending: boolean;
  onSortChange?: (sortKey: SortKey, descending: boolean) => void;
  active?: boolean;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  refreshNonce?: number;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<"files" | "git">("files");
  const [showSettings, setShowSettings] = useState(false);
  const rel = useProjectsStore((s) => s.sidePanelFolderByProject[rootId] ?? "");
  const setSidePanelFolder = useProjectsStore((s) => s.setSidePanelFolder);
  const project = useProjectsStore((s) =>
    variant === "member" ? s.projects.find((p) => p.id === rootId) ?? null : null,
  );
  // Which side of a remote member the tree shows — the PROJECT-WIDE side, the
  // same latch/choice the side panel's single view reads.
  const [source, setSource] = useFileSource(remote ? rootId : null, remote);
  const { remoteSshState, remoteBlocked: sshDown } = useRemoteBlocked(remote ? rootId : null, remote);
  // "Local" lists the mirror — a plain local tree, never gated on the pool.
  const treeDir = remote
    ? remoteMemberTreeDir(dir, project ? resolveLocalMirror(project) : null, source)
    : dir;
  // A disconnected remote member must not mount an SFTP-backed surface (its
  // synchronous list_dir/git would freeze the window) — same gate as the
  // single-root view. Git always runs against the host for a remote project,
  // so the git view is blocked regardless of the file-source side.
  const remoteBlocked = remote && sshDown && (source === "remote" || view === "git");
  const filters = useProjectFileFilters({
    localFile: localFile ?? undefined,
    projectDir: treeDir,
    remoteBlocked,
  });
  const toolbarBtnStyle = { fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 } as const;
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
      {!collapsed && variant === "member" && (
        <div className="side-panel-toolbar side-panel-toolbar--box-root">
          {(["files", "git"] as const).map((v) => (
            <button
              key={v}
              className={`toolbar-btn${view === v ? " active" : ""}`}
              style={{ ...toolbarBtnStyle, marginLeft: v === "files" ? 0 : 2 }}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {t(v === "files" ? "projectFilesView.tabFiles" : "projectFilesView.tabGit")}
            </button>
          ))}
          <button
            className="toolbar-btn"
            style={toolbarBtnStyle}
            onClick={() => {
              const sub = rel.replace(/^\/+|\/+$/g, "");
              const path = sub ? `${treeDir.replace(/\/+$/, "")}/${sub}` : treeDir;
              invoke("open_in_file_manager", { path }).catch((e) =>
                console.error("open_in_file_manager", e),
              );
            }}
            title={t("projectFilesView.openInFileManagerTitle")}
          >
            ⧉
          </button>
          {localFile && project && (
            <button
              className="toolbar-btn"
              style={toolbarBtnStyle}
              onClick={() => setShowSettings(true)}
              title={t("projectFilesView.projectSettingsTitle")}
            >
              ⚙
            </button>
          )}
          <UntestedTag />
          {remote && (
            <span style={{ marginLeft: "auto" }}>
              <FileSourceSwitch source={source} onChange={setSource} />
            </span>
          )}
        </div>
      )}
      {!collapsed && remoteBlocked && (
        <div className="file-tree-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div>
            {remoteSshState === "connecting"
              ? t("projectFilesPane.connecting")
              : t("projectFilesPane.disconnected")}
          </div>
          {remoteSshState !== "connecting" && (
            <button
              type="button"
              className="dialog-connect-btn"
              onClick={() => useRemoteMachinesStore.getState().open(rootId)}
            >
              {t("common.connect")}
            </button>
          )}
        </div>
      )}
      {!collapsed && !remoteBlocked && view === "files" && (
        <div className="file-root-body">
          <FileTree
            // Same invariant as the single-root tree: (project, root dir) is the
            // tree's identity, so a root whose directory moves — including the
            // Remote/Local source flip — remounts rather than repainting the old
            // one's entries under the new path.
            key={`${rootId}|${treeDir}`}
            projectDir={treeDir}
            projectId={rootId}
            localFile={localFile}
            sortKey={sortKey}
            descending={descending}
            onSortChange={onSortChange}
            hiddenEndings={filters.hiddenEndings}
            hiddenPaths={filters.hiddenPaths}
            shownPaths={filters.shownPaths}
            scanExcluded={filters.scanExcluded}
            onToggleScanExcluded={filters.toggleScanExcluded}
            separateScaffold={filters.separateScaffold}
            separateGitignored={filters.separateGitignored}
            initialRelPath={rel}
            onRelPathChange={(folder) => setSidePanelFolder(rootId, folder)}
            syncSource={remote ? source : undefined}
            remoteProbeDir={remote ? dir : undefined}
            active={active}
            searchOpen={searchOpen}
            onSearchOpenChange={onSearchOpenChange}
            refreshNonce={refreshNonce}
          />
        </div>
      )}
      {!collapsed && !remoteBlocked && view === "git" && (
        <div className="file-root-body">
          <GitHistory
            projectDir={dir}
            projectId={remote ? rootId : undefined}
            remote={remote}
            onChanged={() => {}}
          />
        </div>
      )}
      {showSettings && project && localFile && (
        <ProjectFilesSettingsDialog
          localFile={localFile}
          project={project}
          filters={filters}
          onClose={() => setShowSettings(false)}
        />
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
  /** Tree grouping (`panel_separate_scaffold` / `panel_separate_gitignored` in
   *  project.json, edited in Project Settings): whether the root's scaffold and
   *  everything git ignores get their own collapsible sections. Omitted by a
   *  host with no project.json behind it, which simply gets the default (on). */
  separateScaffold?: boolean;
  separateGitignored?: boolean;
  /** Sort is the host's, not the pane's: the side panel unmounts this pane when
   *  it shows Git/Search, and a sort order that reset itself on the way back
   *  would be a worse view than the one the user chose. The control itself is
   *  rendered by the tree, right-aligned in the breadcrumb (⌂) row — it used to
   *  own a full-width row of key buttons above the tree, which cost a row of
   *  height for five words the view already sorts by. */
  sortKey: SortKey;
  descending: boolean;
  onSortChange: (sortKey: SortKey, descending: boolean) => void;
  showDownloads: boolean;
  onCloseDownloads: () => void;
  /** The opt-in Alerts group below the tree. Already gated on `files_alerts` by
   *  the host, so this is only the toggle's own state. */
  showAlerts: boolean;
  onCloseAlerts: () => void;
  /** Offers the tree's "Open in a new tab" action (see FileTree). Omitted where
   *  the host can't own a tab — a box's multi-root view, a detached window. */
  onOpenFolderTab?: (relPath: string) => void;
  /** False keeps the tree unmounted (the side panel does this while closed, so
   *  a hidden panel costs no fs-watch). */
  mountTree?: boolean;
  /** Whether this surface is on screen. A mounted-but-hidden tree (a background
   *  Files tab, a backgrounded project) keeps its listing but stops all standing
   *  work — fs-watch, sync re-stat, host probes, folder-size walks — restarting
   *  with a catch-up when its project becomes current again (see FileTree). */
  active?: boolean;
  /** Compact (docked subwindow) mode: hide the remote-sync row and the sort
   *  control so the tree's find-files search box is the topmost element. */
  compact?: boolean;
  /** The in-tree search box's fold state and the manual re-list, both owned by
   *  the host: the 🔍 / ↻ pair lives in the Files/Git/Apps toolbar row, not in
   *  a row of the tree's own. Forwarded verbatim to every FileTree below (the
   *  single-root tree and each of a box's roots), so one toggle folds them all
   *  — a box's roots are one search affordance, not N. */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  refreshNonce?: number;
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
  separateScaffold = true,
  separateGitignored = true,
  sortKey,
  descending,
  onSortChange,
  showDownloads,
  onCloseDownloads,
  showAlerts,
  onCloseAlerts,
  onOpenFolderTab,
  mountTree = true,
  active = true,
  compact,
  searchOpen,
  onSearchOpenChange,
  refreshNonce,
}: Props) {
  const t = useT();
  const { activeBox, boxRoots } = useBoxRoots(scope);
  const projectId = project?.id ?? null;
  const isRemoteProject = !!project?.remote;
  const { remoteSshState, remoteBlocked } = useRemoteBlocked(projectId, isRemoteProject);
  const syncMap = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  // Live per-file progress for the whole-tree transfer below. The tree renders
  // this too, but only in its REMOTE bar — and a push is by definition started
  // from the Local side, where that bar is not on screen. So a whole-project push
  // had no progress anywhere in the window: it ran for minutes looking exactly
  // like a button that does nothing.
  const syncProgress = useSyncStore((s) => (projectId ? s.progressByProject[projectId] : null));
  const [syncBusy, setSyncBusy] = useState(false);
  // The outcome line under the row: what the transfer did, or why it failed.
  // `bad` only colours it — a skipped-conflicts result is not an error.
  const [syncResult, setSyncResult] = useState<{ text: string; bad: boolean } | null>(null);

  /**
   * Run one whole-tree transfer with the confirm dialog in front of it, and
   * REPORT it. Both buttons went through a bare `void (async () => …)()`, so the
   * one thing a user needs to see was the one thing that could not reach them:
   * `sync_push`/`sync_whole_project` reject on the ordinary failures (a dropped
   * pool — "remote project not connected — reconnect first" — a walk that hit an
   * unreadable dir), and an unhandled rejection inside a floating promise renders
   * nothing at all. The success path was silent too, and a push that skips every
   * file as host-diverged is *also* a legitimate 0-file success — three different
   * things, one identical blank.
   */
  async function runWholeTreeSync(direction: "pull" | "push") {
    if (!projectId || syncBusy) return;
    const ok = await confirmSyncTransfer({
      projectId,
      direction,
      relPath: "",
      isDir: true,
      label: project?.name ?? projectId,
    });
    if (!ok) return;
    setSyncBusy(true);
    setSyncResult(null);
    try {
      if (direction === "pull") {
        await useSyncStore.getState().syncWholeProject(projectId);
        setSyncResult({ text: t("projectFilesPane.syncPullDone"), bad: false });
      } else {
        const r = await useSyncStore.getState().pushWholeProject(projectId);
        const parts = [t("projectFilesPane.syncPushed", { count: r.pushed })];
        // Named separately because they are different answers to "why wasn't my
        // file pushed": a conflict is the safe-direction policy working (the file
        // is on the host, changed, and stays orange in the tree), a failure is the
        // transfer breaking.
        if (r.conflicts.length > 0) {
          parts.push(t("projectFilesPane.syncSkipped", { count: r.conflicts.length }));
        }
        if (r.failed_total > 0) {
          parts.push(t("projectFilesPane.syncFailed", { count: r.failed_total }));
          if (r.first_error) parts.push(r.first_error);
        }
        if (r.skipped_excluded > 0) {
          parts.push(t("projectFilesPane.syncExcludedSkipped", { count: r.skipped_excluded }));
        }
        setSyncResult({ text: parts.join(" · "), bad: r.failed_total > 0 });
      }
    } catch (err) {
      setSyncResult({ text: String(err), bad: true });
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <>
      {/* The whole-tree sync action for the active source: Remote → pull the host
          tree into the mirror; Local → push the mirror back to the host (skipping
          host-diverged/orange files). Both need a live connection, so the row is
          gated on !remoteBlocked. */}
      {!compact && !activeBox && isRemoteProject && projectId && !remoteBlocked && (
        <div className="side-panel-source">
          {/* Project-wide auto-sync toggle: the root "" marker. When on, the
              whole tree bidirectionally auto-syncs; individual files/folders
              can still be carved out (or opted in) from their own context
              menu, which overrides this. */}
          {(() => {
            const autoAll = !!syncMap?.[""]?.auto;
            return (
              <button
                className="toolbar-btn"
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
            className="toolbar-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20 }}
            onClick={() => useBigFoldersStore.getState().open(projectId)}
            title={t("projectFilesPane.bigFoldersTitle")}
          >
            {t("projectFilesPane.bigFolders")}
          </button>
          <UntestedTag />
          {/* Both directions ask first (`stores/syncConfirm`). This is the widest
              transfer in the app — one click over the *whole* tree, in whichever
              direction the source switch happens to be on — so the one thing it
              must never be is ambiguous about which side it is about to
              overwrite. */}
          {/* Live counter, in the row that holds the button that started it — so
              the feedback is where the click was, whichever side the source
              switch is on. `total` is known from the first event (the walk runs
              before any transfer), so this is a real fraction, not a spinner. */}
          {syncProgress && (
            <span
              className="file-tree-sync-progress"
              style={{ marginLeft: "auto" }}
              title={t("fileTree.syncingRel", { rel: syncProgress.rel || "…" })}
            >
              ⟳ {syncProgress.done}/{syncProgress.total}
            </span>
          )}
          <button
            className="toolbar-btn"
            style={{
              fontSize: 10,
              padding: "1px 6px",
              height: 20,
              ...(syncProgress ? { marginLeft: 6 } : { marginLeft: "auto" }),
            }}
            disabled={syncBusy}
            onClick={() => void runWholeTreeSync(source === "remote" ? "pull" : "push")}
            title={t(
              source === "remote"
                ? "projectFilesPane.syncAllRemoteTitle"
                : "projectFilesPane.syncAllLocalTitle",
            )}
          >
            {syncBusy ? t("projectFilesPane.syncAllBusy") : t("projectFilesPane.syncAll")}
          </button>
        </div>
      )}
      {/* The outcome of the last whole-tree transfer. Dismissible, and it stays
          until dismissed or superseded: a push that ends in one second must not
          report itself in a toast the user is not looking at yet. */}
      {!compact && !activeBox && isRemoteProject && projectId && syncResult && (
        <div
          className={`project-files-sync-result${syncResult.bad ? " project-files-sync-result--bad" : ""}`}
          role="status"
        >
          <span>{syncResult.text}</span>
          <button
            className="file-tree-up"
            onClick={() => setSyncResult(null)}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </div>
      )}
      <div className="side-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
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
                onSortChange={compact ? undefined : onSortChange}
                active={active}
                searchOpen={searchOpen}
                onSearchOpenChange={onSearchOpenChange}
                refreshNonce={refreshNonce}
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
                onSortChange={compact ? undefined : onSortChange}
                hiddenEndings={hiddenEndings}
                hiddenPaths={hiddenPaths}
                shownPaths={shownPaths}
                scanExcluded={scanExcluded}
                onToggleScanExcluded={onToggleScanExcluded}
                separateScaffold={separateScaffold}
                separateGitignored={separateGitignored}
                initialRelPath={folder}
                onRelPathChange={onFolderChange}
                onOpenFolderTab={onOpenFolderTab}
                syncSource={isRemoteProject ? source : undefined}
                remoteProbeDir={isRemoteProject ? projectDir : undefined}
                active={active}
                searchOpen={searchOpen}
                onSearchOpenChange={onSearchOpenChange}
                refreshNonce={refreshNonce}
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
      {/* Below Downloads, and with no project condition of its own: mail,
          appointments and cards are global, so the group is the same wherever
          the viewer is mounted. Only a box's multi-root view is excluded, and
          that is already the toolbar button's rule. */}
      {showAlerts && !activeBox && <AlertsSection onClose={onCloseAlerts} />}
    </>
  );
}
