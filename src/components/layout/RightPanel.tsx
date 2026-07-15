import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitHistory } from "../files/GitHistory";
import { GitChangeTree, type ChangeScope } from "../files/GitChangeTree";
import { SearchPanel } from "../files/SearchPanel";
import {
  FileSourceSwitch,
  ProjectFilesPane,
  useBoxRoots,
  useFileSource,
  useRemoteBlocked,
} from "../files/ProjectFilesPane";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "../files/ProjectFilesSettings";
import { openProjectFilesTab } from "../files/ProjectFilesTab";
import { useImportDrop } from "../files/importDrop";
import { useProjectsStore, logoutRemote } from "../../stores/projects";
import { useSyncStore, amberPaths } from "../../stores/sync";
import { openLinkedFile } from "../embed/FileViewerPane";
import { useWindowsStore } from "../../stores/windows";
import { useTabsStore, orderedTabKeys, isPtyTabKind, type TabEntry } from "../../stores/tabs";
import { useActivityStore, type AttentionKind } from "../../stores/activity";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import type { SortKey } from "../../lib/viewers/fileUtils";
import { basename, dirname } from "../../lib/paths";
import { projectTypeTags } from "../projects/projectTypeTags";
import { ProjectHoverCard, useProjectHoverCard } from "../projects/ProjectHoverCard";

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

interface Props {
  open: boolean;
  pinned?: boolean;
  /** Current panel width in px (driven by the left-border resize drag). */
  width?: number;
  /** True while a resize drag is in progress — suppresses width/transform
   *  transitions so the panel tracks the cursor instead of lagging behind. */
  resizing?: boolean;
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTogglePin?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

type View = "files" | "windows" | "git" | "search" | "orange";

/** A hidden subwindow's tab is invisible to the tab bar, so it can't paint its
 *  own glow — this is the same working/needs-decision/finished precedence
 *  `TabBar` uses for the live tab glow, applied here to a hidden group's tab
 *  chips (and rolled up for the group's row) so a hidden pane doesn't go dark
 *  just because it's parked. */
function hiddenTabStatus(
  kind: TabEntry["kind"] | undefined,
  ptyId: string,
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
): "working" | "needs-decision" | "finished" | null {
  if (!kind) return null;
  if (isPtyTabKind(kind) && busyByTab[ptyId]) return "working";
  if (kind === "agent" || kind === "local_agent") {
    const attn = attentionByTab[ptyId];
    if (attn === "decision") return "needs-decision";
    if (attn === "done") return "finished";
  }
  return null;
}

/** Roll several tab statuses up into one, most urgent first — a decision still
 *  waiting on the user outranks a tab merely working, which outranks one that's
 *  just finished unseen. Mirrors `attentionByScope`'s decision-over-done
 *  precedence, extended with `working` for the row-level dot. */
function rollUpStatus(
  statuses: Array<"working" | "needs-decision" | "finished" | null>,
): "working" | "needs-decision" | "finished" | null {
  if (statuses.includes("needs-decision")) return "needs-decision";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("finished")) return "finished";
  return null;
}

export function RightPanel({
  open,
  pinned,
  width,
  resizing,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onTogglePin,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const { projects, activeId } = useProjectsStore();
  const rightPanelFolderByProject = useProjectsStore((s) => s.rightPanelFolderByProject);
  const setRightPanelFolder = useProjectsStore((s) => s.setRightPanelFolder);
  const { windows, refresh, untrack } = useWindowsStore();
  const [view, setView] = useState<View>("files");
  const [showSettings, setShowSettings] = useState(false);
  // Toggles the Downloads section stacked below the file tree (fast-copy of
  // recent downloads into the project). Toolbar ⬇⬇ button; files view only.
  const [showDownloads, setShowDownloads] = useState(false);
  // Kept here, not in the pane: the pane unmounts while the panel shows Git or
  // Search, and the chosen sort must survive the trip back to Files.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [unpushedCommits, setUnpushedCommits] = useState<string[]>([]);
  const [openTree, setOpenTree] = useState<"add" | "commit" | "push" | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  // Whether the active project is missing scaffold files — drives the "no
  // scaffold" type tag shown beside its name, mirroring ProjectPill's hover tags.
  const [scaffoldMissing, setScaffoldMissing] = useState(false);
  // Nested-repo detection: when the browsed folder lives in a git repo distinct
  // from the project's own repo, `nestedRoot` holds that repo's root and the git
  // section re-roots at it. `preferProjectRepo` is the manual toggle override
  // back to the project repo.
  const [nestedRoot, setNestedRoot] = useState<string | null>(null);
  const [preferProjectRepo, setPreferProjectRepo] = useState(false);
  const commitRef = useRef<HTMLTextAreaElement>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);
  const refreshGitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run both git probes concurrently (Eff #9): they hit independent
  // subprocesses, so `Promise.all` collapses two serially-awaited chains into
  // one round of parallel work. Each result still applies independently.
  const runRefreshGit = (dir: string) => {
    void Promise.all([
      invoke<GitStatus>("git_status", { projectDir: dir }).catch(() => null),
      invoke<string[]>("git_unpushed_commits", { projectDir: dir }).catch(() => [] as string[]),
    ]).then(([status, unpushed]) => {
      setGitStatus(status);
      setUnpushedCommits(unpushed);
      // Keep the active project's pill dot in sync from the data we just fetched
      // (no extra git subprocesses), so edits/commits/pushes reflect immediately
      // instead of waiting for the switcher's periodic poll.
      // Don't let a nested repo's status pollute the project pill's dirty dot —
      // that dot tracks the project repo (the switcher's poll recomputes it).
      if (activeId && status && !onNestedRepo) {
        useGitDirtyStore.getState().set(activeId, gitDirtyState(status, unpushed.length));
      }
    });
  };

  // Debounced entry point (Eff #9): bursts of git-affecting actions (add →
  // commit → push, or rapid fs changes) coalesce into a single refresh instead
  // of spawning a fresh trio of subprocesses per call.
  const refreshGit = (dir: string) => {
    if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
    refreshGitTimer.current = setTimeout(() => {
      refreshGitTimer.current = null;
      runRefreshGit(dir);
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (refreshGitTimer.current) clearTimeout(refreshGitTimer.current);
    };
  }, []);

  // The change tree is click-opened and persistent; close it on Escape or a
  // click anywhere outside the action bar (which contains both the toggles and
  // the tree itself).
  useEffect(() => {
    if (!openTree) return;
    const onDown = (e: MouseEvent) => {
      if (!actionBarRef.current?.contains(e.target as Node)) setOpenTree(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenTree(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openTree]);

  const treeScope: ChangeScope | null =
    openTree === "add" ? "unstaged" : openTree === "commit" ? "staged" : openTree === "push" ? "unpushed" : null;

  const activeProject = projects.find((p) => p.id === activeId);
  const projectDir = resolveProjectDirectory(activeProject);
  const localFile = activeProject?.local_file;
  // Remote git/endings probes dispatch over SSH/SFTP via SYNCHRONOUS Tauri
  // commands (run on the main thread). Calling them while the pool is down blocks
  // on the dead session and freezes the window, so suppress them until the remote
  // project is connected. Local projects are never blocked.
  const { remoteSshState, remoteBlocked } = useRemoteBlocked(activeId, !!activeProject?.remote);
  // SSH-sync Phase 1: which side of a remote project the files view shows — the
  // host (remote, SFTP-listed, with the sync overlay) or the local mirror. The
  // switch lives in the header (below); the tree it drives lives in the pane.
  const [fileSource, setFileSource] = useFileSource(activeId, !!activeProject?.remote);
  // Which endings/paths the tree hides, from the project's own project.json —
  // shared with the Files (Project) tab, so both views hide the same files.
  const filters = useProjectFileFilters({ localFile, projectDir, remoteBlocked });
  const rightPanelFolder = activeId ? rightPanelFolderByProject[activeId] ?? "" : "";

  // Detect a nested git repo: if the folder currently browsed in the file tree
  // lives inside a git repo distinct from the project's own repo, re-root the
  // git section at it (auto-switch). Local projects only — the backend returns
  // null for remote ones, so `nestedRoot` stays null and behavior is unchanged.
  useEffect(() => {
    if (!projectDir || activeProject?.remote) {
      setNestedRoot(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      invoke<string | null>("git_repo_root", { projectDir, relPath: "" }).catch(() => null),
      invoke<string | null>("git_repo_root", { projectDir, relPath: rightPanelFolder }).catch(() => null),
    ]).then(([projRoot, folderRoot]) => {
      if (cancelled) return;
      const norm = (p: string | null) => (p ? p.replace(/[/\\]+$/, "") : null);
      const pr = norm(projRoot);
      const fr = norm(folderRoot);
      setNestedRoot(fr && fr !== pr ? fr : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectDir, rightPanelFolder, activeProject?.remote]);

  // Default to auto-switch: reset the manual override on a project switch or
  // whenever we leave the nested repo, so entering one always shows it first.
  useEffect(() => {
    setPreferProjectRepo(false);
  }, [activeId]);
  useEffect(() => {
    if (!nestedRoot) setPreferProjectRepo(false);
  }, [nestedRoot]);

  // The repo root the whole git section (status, commit, push, history) operates
  // on: the nested repo when detected and not overridden, else the project repo.
  const effectiveGitRoot = nestedRoot && !preferProjectRepo ? nestedRoot : projectDir;
  const onNestedRepo = !!nestedRoot && effectiveGitRoot !== projectDir;

  // Diverged (amber/orange) files for the active remote project, from the cached
  // sync status — backs the toolbar count badge and the "Orange" list view. These
  // are exactly the files auto-sync refuses to touch (both sides changed), so they
  // need a human to pick a side.
  const syncMap = useSyncStore((s) => (activeId ? s.byProject[activeId] : undefined));
  const orangeFiles = useMemo(() => amberPaths(syncMap), [syncMap]);
  // The local mirror root, to open an amber file's mirror copy for inspection.
  const mirrorRoot =
    resolveLocalMirror(activeProject) ?? (projectDir ? `${projectDir}/mirror` : null);

  // Resolve the scaffold-missing flag whenever the active project changes.
  // Failures fall back to "present" so a probe error doesn't flash the tag.
  useEffect(() => {
    if (!activeId) {
      setScaffoldMissing(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("project_scaffold_missing", { projectId: activeId })
      .then((v) => { if (!cancelled) setScaffoldMissing(v); })
      .catch(() => { if (!cancelled) setScaffoldMissing(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  const typeTags = activeProject ? projectTypeTags(activeProject, scaffoldMissing) : [];

  // Same hover card as the project pill, shown when hovering the project name
  // here — minus the type tags, which already sit beside the name below.
  const nameHover = useProjectHoverCard(activeProject);

  // When a box scope is open, the panel shows a multi-root file view: the box
  // folder plus every member project's root. Detected from the current tab scope
  // (disjoint `box:<id>` prefix) rather than the project store's activeId.
  const scope = useTabsStore((s) => s.scope);
  // Subwindows the user has hidden in the current scope, surfaced as an
  // auto-pinned section above the toolbar. Their tabs still live in
  // `tabsByScope[scope]` (PTYs mounted, hidden), so the chips resolve labels
  // from there. `unhideGroup`/`closeHiddenGroup` restore or discard them.
  const hiddenGroups = useTabsStore((s) => s.hiddenGroupsByScope[s.scope]);
  const scopeTabs = useTabsStore((s) => s.tabsByScope[s.scope]);
  // Same working/decision/finished glow the tab bar draws for a live tab — a
  // hidden subwindow's tabs are still running underneath the pane, so they keep
  // reporting status even while parked.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  // One status per hidden group's tab, rolled up per group and overall, so the
  // Hidden section still says "something's running in there" without needing
  // the group unhidden and its tab bar drawn.
  const hiddenStatus = useMemo(() => {
    const rows = (hiddenGroups ?? []).map((h) => {
      const tabStatuses = orderedTabKeys(h.subtree).map((k) =>
        hiddenTabStatus(
          scopeTabs?.find((t) => t.key === k)?.kind,
          `${scope}:${k}`,
          busyByTab,
          attentionByTab,
        ),
      );
      return { id: h.id, status: rollUpStatus(tabStatuses), tabStatuses };
    });
    return { rows, overall: rollUpStatus(rows.map((r) => r.status)) };
  }, [hiddenGroups, scopeTabs, scope, busyByTab, attentionByTab]);
  const unhideGroup = useTabsStore((s) => s.unhideGroup);
  const closeHiddenGroup = useTabsStore((s) => s.closeHiddenGroup);
  const [hiddenCollapsed, setHiddenCollapsed] = useState(false);
  // A box scope shows a multi-root file view (the box folder + every member
  // project's root) instead of one project tree; the pane renders it.
  const { activeBox } = useBoxRoots(scope);

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = rightPanelFolder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  // OS file drop → copy into the project, prompting on collisions. Confined to a
  // single active project (a box scope has no single destination root). The
  // whole panel is the drop zone, so a drop outside the files view lands at the
  // project root; inside it, on the browsed folder. Shared with the Files
  // (Project) tab so an import behaves the same wherever it is dropped.
  const importDrop = useImportDrop({
    projectDir,
    enabled: !activeBox,
    destRel: view === "files" ? rightPanelFolder : "",
    // The tree auto-reloads via its fs-watch; refresh git so new untracked files
    // show in the status counts immediately.
    onImported: () => refreshGit(effectiveGitRoot),
  });

  useEffect(() => {
    if (open && activeId) {
      refresh(activeId);
    }
  }, [open, activeId]);

  useEffect(() => {
    if (open && effectiveGitRoot && !remoteBlocked) {
      refreshGit(effectiveGitRoot);
    } else {
      setGitStatus(null);
    }
  }, [open, effectiveGitRoot, remoteBlocked]);

  // The gear dialog belongs to the project it was opened on; a project switch
  // reloads the filters under it, so close it rather than let it re-target.
  useEffect(() => {
    setShowSettings(false);
  }, [localFile, projectDir]);

  const handleAdd = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_add_all", { projectDir: effectiveGitRoot });
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitOpen = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      const msg = await invoke<string>("git_generate_commit_message", { projectDir: effectiveGitRoot });
      setCommitMsg(msg);
      setTimeout(() => commitRef.current?.focus(), 50);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitConfirm = async () => {
    if (!effectiveGitRoot || commitMsg === null) return;
    setGitBusy(true);
    setGitError(null);
    try {
      await invoke("git_commit", { projectDir: effectiveGitRoot, message: commitMsg });
      setCommitMsg(null);
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  const handlePush = async () => {
    if (!effectiveGitRoot) return;
    setGitBusy(true);
    setGitError(null);
    try {
      // On a nested repo, push to its own configured remote (no project id →
      // plain `git push`), not the project's GitHub/GitLab provider flow.
      await invoke("git_push", {
        projectDir: effectiveGitRoot,
        projectId: onNestedRepo ? null : activeId ?? null,
      });
      refreshGit(effectiveGitRoot);
    } catch (e) {
      setGitError(String(e));
    } finally {
      setGitBusy(false);
    }
  };

  return (
    <div
      className={`right-panel ${open ? "open" : ""}${importDrop.dropActive ? " drop-active" : ""}${importDrop.dropFlash ? " drop-flash" : ""}${resizing ? " resizing" : ""}`}
      style={width ? { width } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      {...importDrop.handlers}
    >
      {/* Drag the left border to resize the panel; width persists in settings.
          Pointer capture (set in onResizeStart) keeps the drag alive once the
          cursor leaves this thin strip. */}
      {onResizeStart && (
        <div
          className="right-panel-resize"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title="Drag to resize panel"
          aria-hidden
        />
      )}
      {importDrop.conflictModal}
      <div className="right-panel-header">
        {onTogglePin && (
          <button
            className={`right-panel-pin${pinned ? " pinned" : ""}`}
            aria-pressed={pinned}
            onClick={onTogglePin}
            title={pinned ? "Unpin panel (allow auto-hide)" : "Pin panel open"}
          >
            📌
          </button>
        )}
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: !activeBox && activeProject ? "default" : undefined,
          }}
          onMouseEnter={
            !activeBox && activeProject
              ? (e) => void nameHover.open(e.currentTarget.getBoundingClientRect())
              : undefined
          }
          onMouseLeave={!activeBox && activeProject ? () => nameHover.close() : undefined}
        >
          {activeBox ? `▣ ${activeBox.name}` : activeProject ? activeProject.name : "Files"}
        </span>
        {!activeBox && activeProject && (
          <ProjectHoverCard project={activeProject} state={nameHover} showTags={false} />
        )}
        {/* Static project type tags (git / provider / SSH / scaffold). These are
            labels only — no interactivity — so they deliberately look nothing
            like the source switch below. */}
        {!activeBox && typeTags.length > 0 && (
          <span className="right-panel-type-tags">
            {typeTags.map((t) => (
              <span
                key={t.key}
                className="pill-popup-tag"
                title={t.title}
                style={{ color: t.color, borderColor: t.color, background: `${t.color}22` }}
              >
                {t.label}
              </span>
            ))}
          </span>
        )}
        {/* Remote/Local file-source switch (remote SSH projects only). A live
            segmented control — NOT a tag — that flips the files view between the
            host tree over SFTP ("Remote") and the synced mirror ("Local"). It's
            right-aligned and styled as a switch so it never reads as one of the
            static tags above. */}
        {!activeBox && activeProject?.remote && activeId && (
          <>
          {/* Breaker: drop the switch onto its own row so it left-aligns with the
              pin/name (header padding edge) instead of trailing the tags. */}
          <span style={{ flexBasis: "100%", width: 0, height: 0 }} />
          <FileSourceSwitch source={fileSource} onChange={setFileSource} />
          {/* One-click SSH logout, shown while connected. Lives here (not on the
              project pill) so the pill stays status-only; the danger tint only
              appears on hover. */}
          {remoteSshState === "connected" && (
            <button
              type="button"
              className="right-panel-conn-logout"
              aria-label={`Log out of ${activeProject.remote.host} — disconnect this remote project`}
              title={`Log out of ${activeProject.remote.host}\nDrops the SSH connection${activeProject.remote.openvpn ? " and the VPN tunnel" : ""}. Open tabs stay, their sessions go dead until you reconnect.`}
              onClick={() => logoutRemote(activeProject)}
            >
              <span aria-hidden="true">⏻</span> Logout
            </button>
          )}
          </>
        )}
        {/* Git status/action buttons drop to their own row below the project name
            (forced by the flex-basis breaker) instead of crowding it. Only
            rendered when there's something to do (or we're mid-commit) — an
            empty strip with no actions just wastes space. */}
        {!activeBox && gitStatus?.is_repo &&
          (commitMsg !== null ||
            gitStatus.unstaged + gitStatus.untracked > 0 ||
            gitStatus.staged > 0 ||
            (gitStatus.has_remote && unpushedCommits.length > 0)) && (
          <>
            <span style={{ flexBasis: "100%", width: 0, height: 0 }} />
            <div ref={actionBarRef} className="git-action-bar git-action-bar--inline" style={{ position: "relative" }}>
            {commitMsg !== null ? (
              <>
                <button
                  className="git-action-btn git-action-btn--commit"
                  disabled={gitBusy}
                  onClick={handleCommitConfirm}
                  title="Confirm commit"
                >
                  <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                  <span>↵</span>
                  <span className="git-btn-label">Confirm</span>
                </button>
                <button
                  className="git-action-btn git-action-btn--back"
                  disabled={gitBusy}
                  onClick={() => setCommitMsg(null)}
                  title="Go back"
                >
                  <span>←</span>
                  <span className="git-btn-label">Back</span>
                </button>
              </>
            ) : (
              <>
                {/* Each action only appears when it has work to do: Add when there
                    are unstaged/untracked changes, Commit when something is staged,
                    Push when commits are ahead of the remote. A clean, pushed repo
                    shows no buttons. The caret beside each action opens a
                    navigable folder tree of the files it touches, with line
                    stats. */}
                {gitStatus.unstaged + gitStatus.untracked > 0 && (
                  <div className="git-action git-action--add">
                    <button
                      className="git-action-btn git-action-btn--add"
                      disabled={gitBusy}
                      onClick={handleAdd}
                      title={`Stage all changes (${gitStatus.unstaged + gitStatus.untracked} unstaged)`}
                    >
                      <span data-testid="add-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#f85149" }} />
                      <span>⊕</span>
                      <span className="git-btn-label">Add ({gitStatus.unstaged + gitStatus.untracked})</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label="Show changed files"
                      aria-expanded={openTree === "add"}
                      title="Show changed files"
                      onClick={() => setOpenTree((t) => (t === "add" ? null : "add"))}
                    >
                      {openTree === "add" ? "▴" : "▾"}
                    </button>
                  </div>
                )}
                {gitStatus.staged > 0 && (
                  <div className="git-action git-action--commit">
                    <button
                      className="git-action-btn git-action-btn--commit"
                      disabled={gitBusy}
                      onClick={handleCommitOpen}
                      title={`Commit ${gitStatus.staged} staged`}
                    >
                      <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                      <span>✔</span>
                      <span className="git-btn-label">Commit ({gitStatus.staged})</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label="Show staged files"
                      aria-expanded={openTree === "commit"}
                      title="Show staged files"
                      onClick={() => setOpenTree((t) => (t === "commit" ? null : "commit"))}
                    >
                      {openTree === "commit" ? "▴" : "▾"}
                    </button>
                  </div>
                )}
                {gitStatus.has_remote && unpushedCommits.length > 0 && (
                  <div className="git-action git-action--push">
                    <button
                      className="git-action-btn git-action-btn--push"
                      disabled={gitBusy}
                      onClick={handlePush}
                      title={`Push ${unpushedCommits.length} commit${unpushedCommits.length === 1 ? "" : "s"} to remote`}
                    >
                      <span data-testid="push-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#3fb950" }} />
                      <span>⬆</span>
                      <span className="git-btn-label">Push ({unpushedCommits.length})</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label="Show files in unpushed commits"
                      aria-expanded={openTree === "push"}
                      title="Show files in unpushed commits"
                      onClick={() => setOpenTree((t) => (t === "push" ? null : "push"))}
                    >
                      {openTree === "push" ? "▴" : "▾"}
                    </button>
                  </div>
                )}
                {treeScope && projectDir && (
                  <GitChangeTree projectDir={projectDir} scope={treeScope} />
                )}
              </>
            )}
          </div>
          </>
          )}
      </div>

      {hiddenGroups && hiddenGroups.length > 0 && (
        <div className="hidden-subwindows">
          <button
            type="button"
            className="hidden-sw-header"
            onClick={() => setHiddenCollapsed((c) => !c)}
            title={hiddenCollapsed ? "Show hidden subwindows" : "Collapse"}
          >
            <span className="hidden-sw-caret">{hiddenCollapsed ? "▸" : "▾"}</span>
            Hidden ({hiddenGroups.length})
            {hiddenStatus.overall && (
              <span
                className={`hidden-sw-status-dot ${hiddenStatus.overall}`}
                title={
                  hiddenStatus.overall === "needs-decision"
                    ? "A hidden subwindow is waiting on you"
                    : hiddenStatus.overall === "working"
                      ? "A hidden subwindow is working"
                      : "A hidden subwindow finished, unseen"
                }
              />
            )}
          </button>
          {!hiddenCollapsed && (
            <div className="hidden-sw-list">
              {hiddenGroups.map((h, hi) => {
                const keys = orderedTabKeys(h.subtree);
                const { status: rowStatus, tabStatuses } = hiddenStatus.rows[hi];
                return (
                  <div key={h.id} className="hidden-sw-row">
                    <span className={`hidden-sw-icon${rowStatus ? ` ${rowStatus}` : ""}`}>⊞</span>
                    <div className="hidden-sw-chips">
                      {keys.map((k, ki) => {
                        const label = scopeTabs?.find((t) => t.key === k)?.label ?? k;
                        const status = tabStatuses[ki];
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`hidden-sw-chip${status ? ` ${status}` : ""}`}
                            title={`Restore focused on “${label}”`}
                            onClick={() => unhideGroup(h.id, { activeKey: k })}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="hidden-sw-btn"
                      title="Restore subwindow"
                      onClick={() => unhideGroup(h.id)}
                    >
                      ↩
                    </button>
                    <button
                      type="button"
                      className="hidden-sw-btn hidden-sw-close"
                      title="Close subwindow (discard its tabs)"
                      onClick={() => closeHiddenGroup(h.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="right-panel-toolbar">
        {(["files", "git", "search", "windows"] as View[]).map((v) => (
          <button
            key={v}
            className={`tab-add-btn${view === v ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: v === "files" ? 0 : 2 }}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === "files" ? "Files" : v === "git" ? "Git" : v === "search" ? "Search" : "Apps"}
          </button>
        ))}
        {/* Orange (diverged) files: a dedicated toggle for remote projects,
            badged with the count so conflicts are visible at a glance. Auto-sync
            never touches these, so this is where they get resolved. */}
        {!activeBox && activeProject?.remote && activeId && (
          <button
            className={`tab-add-btn right-panel-orange-btn${view === "orange" ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            aria-pressed={view === "orange"}
            onClick={() => setView((v) => (v === "orange" ? "files" : "orange"))}
            title={`Diverged (orange) files: ${orangeFiles.length}`}
          >
            ± {orangeFiles.length > 0 && <span className="right-panel-orange-count">{orangeFiles.length}</span>}
          </button>
        )}
        {importDrop.canImport && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => void importDrop.importViaDialog()}
            title="Import files into this folder"
          >
            ⬇
          </button>
        )}
        {projectDir && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={openInOsBrowser}
            title="Open folder in file manager"
          >
            ⧉
          </button>
        )}
        {!activeBox && projectDir && (
          <button
            className={`tab-add-btn${showDownloads ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            aria-pressed={showDownloads}
            onClick={() => {
              setShowDownloads((v) => !v);
              // The section lives in the files view; jump there when revealing it.
              if (!showDownloads) setView("files");
            }}
            title="Show recent downloads (copy into this project)"
          >
            📥
          </button>
        )}
        {activeId && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => setShowSettings(true)}
            title="Project settings"
          >
            ⚙
          </button>
        )}
      </div>

      {!activeBox && gitStatus?.is_repo && (
        <>
          {commitMsg !== null && (
            <div style={{ padding: "4px 6px", borderBottom: "1px solid var(--border-color)" }}>
              <textarea
                ref={commitRef}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  fontSize: 11,
                  background: "var(--bg-panel)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 3,
                  padding: "3px 5px",
                  resize: "vertical",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}
          {gitError && (
            <div style={{ fontSize: 10, color: "var(--danger, #f85149)", wordBreak: "break-all", padding: "2px 6px 4px", borderBottom: "1px solid var(--border-color)" }}>
              {gitError}
            </div>
          )}
        </>
      )}

      {view === "git" && (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
          {nestedRoot && (
            <div className="nested-repo-toggle" role="group" aria-label="Git repository">
              <button
                type="button"
                className={`nested-repo-pill${!onNestedRepo ? " active" : ""}`}
                title={projectDir}
                onClick={() => setPreferProjectRepo(true)}
              >
                {activeProject?.name || "Project"}
              </button>
              <button
                type="button"
                className={`nested-repo-pill${onNestedRepo ? " active" : ""}`}
                title={nestedRoot}
                onClick={() => setPreferProjectRepo(false)}
              >
                {basename(nestedRoot) || nestedRoot}
              </button>
            </div>
          )}
          <GitHistory
            projectDir={effectiveGitRoot}
            projectId={onNestedRepo ? undefined : activeProject?.remote ? activeId ?? undefined : undefined}
            remote={!onNestedRepo && !!activeProject?.remote}
            onChanged={() => effectiveGitRoot && refreshGit(effectiveGitRoot)}
          />
        </div>
      )}

      {view === "search" && (
        <SearchPanel projectDir={projectDir} linkingTabKey={undefined} />
      )}

      {view === "orange" && (
        <div className="right-panel-scroll right-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          {orangeFiles.length === 0 ? (
            <div className="right-panel-orange-empty">No diverged files</div>
          ) : (
            orangeFiles.map((rel) => (
              <div key={rel} className="orange-file-row" title={rel}>
                <button
                  type="button"
                  className="orange-file-name"
                  disabled={!mirrorRoot}
                  title={mirrorRoot ? `Open ${rel}` : rel}
                  onClick={() => {
                    if (!mirrorRoot) return;
                    const abs = `${mirrorRoot}/${rel}`;
                    // Open the diverged file as a host-vs-mirror sync diff so the
                    // user sees exactly what differs before picking a side.
                    openLinkedFile(undefined, dirname(abs), {
                      path: abs,
                      viewer: "syncdiff",
                      label: basename(abs),
                    });
                  }}
                >
                  <span className="orange-file-dot" aria-hidden="true">±</span>
                  {rel}
                </button>
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act"
                    title="Take the host copy (overwrite the local mirror)"
                    disabled={remoteBlocked}
                    onClick={() => activeId && void useSyncStore.getState().pull(activeId, rel)}
                  >
                    Take host
                  </button>
                  <button
                    type="button"
                    className="orange-file-act"
                    title="Keep the local copy (force-push over the host)"
                    disabled={remoteBlocked}
                    onClick={() => activeId && void useSyncStore.getState().push(activeId, rel, true)}
                  >
                    Keep local
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {view === "files" && (
        <ProjectFilesPane
          scope={scope}
          project={activeProject ?? null}
          projectDir={projectDir}
          folder={rightPanelFolder}
          onFolderChange={(folder) => {
            if (activeId) setRightPanelFolder(activeId, folder);
          }}
          source={fileSource}
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
          // Right-click → "Open in a new tab": the same file view, on that
          // folder, as a Files (Project) tab in this project's scope.
          onOpenFolderTab={(rel) => openProjectFilesTab(projectDir, rel)}
          // A closed panel keeps no tree mounted (and so no fs-watch).
          mountTree={open}
        />
      )}

      {view === "windows" && (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {windows.length === 0 ? (
            <div className="file-tree-empty">No opened windows</div>
          ) : (
            windows.map((w) => (
              <div key={w.id} className="file-entry">
                <span className="file-icon">🪟</span>
                <span className="file-name" title={w.exec}>
                  {basename(w.exec) || w.exec}
                  {w.file && <span style={{ color: "var(--text-muted)" }}> {basename(w.file)}</span>}
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
      {showSettings && activeProject && localFile && (
        <ProjectFilesSettingsDialog
          localFile={localFile}
          filters={filters}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
