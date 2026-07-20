import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { GitHistory } from "./GitHistory";
import { GitChangeTree, type ChangeScope } from "./GitChangeTree";
import { SearchPanel } from "./SearchPanel";
import {
  FileSourceSwitch,
  ProjectFilesPane,
  useBoxRoots,
  useRemoteBlocked,
} from "./ProjectFilesPane";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "./ProjectFilesSettings";
import { useImportDrop } from "./importDrop";
import { logoutRemote } from "../../stores/projects";
import { useSyncStore, amberPaths } from "../../stores/sync";
import { openLinkedFile } from "../embed/FileViewerPane";
import { useWindowsStore } from "../../stores/windows";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import { resolveLocalMirror, type ProjectEntry } from "../../types";
import type { SortKey } from "../../lib/viewers/fileUtils";
import { basename, dirname } from "../../lib/paths";
import { projectTypeTags } from "../projects/projectTypeTags";
import { ProjectHoverCard, useProjectHoverCard } from "../projects/ProjectHoverCard";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { UntestedTag } from "../common/UntestedTag";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { persistentSessionOf } from "../../lib/closeRemoteTab";
import { useRemoteStatusStore, sshOf } from "../../stores/remoteStatus";

/** One host tmux session (TODO #85), mirroring the backend `TmuxSession`. */
interface TmuxSession {
  name: string;
  windows: number;
  /** Creation time, seconds since the Unix epoch (host clock). */
  created: number;
  attached: boolean;
}

/** A session row in the (multi-host) Sessions view: the session plus which host
 *  it runs on (the primary or a worker). */
interface SessionRow {
  hostId: string;
  hostLabel: string;
  session: TmuxSession;
}

/** Coarse "created N ago" for a Unix-epoch-seconds timestamp. The host clock may
 *  differ slightly from the local one; a near-now or future value reads "just now"
 *  rather than a negative age. */
function relativeAge(epochSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

type View = "files" | "windows" | "git" | "search" | "orange" | "sessions";

// A single shared empty array for scopes with no registered tabs. Must be a
// stable reference — a Zustand selector that returned a fresh `[]` here would
// make `useSyncExternalStore` see a new snapshot every render and loop forever.
const EMPTY_SCOPE_TABS: TabEntry[] = [];

/**
 * The shared file view rendered by BOTH the right panel (`RightPanel`) and the
 * Files (Project) tab (`ProjectFilesTab`) — the view switcher (Files / Git /
 * Search / Apps / Orange), the inline git action bar, the git history, search,
 * the tracked-windows list, the diverged (orange) list, the type tags, hover
 * card and SSH logout, plus the settings dialog. One component, so the panel and
 * the tab can never drift into two different file *viewers* of the same project
 * — exactly as `ProjectFilesPane` already unifies the tree itself.
 *
 * What each host still owns is what must differ: identity (the panel keys off the
 * active project, a tab off its own scope), the browsed folder (the panel's lives
 * in the projects store, a tab's on its `TabEntry`), where the Remote/Local
 * switch's `useFileSource` hook lives, and the panel-only window chrome (pin,
 * resize border, the "Hidden subwindows" list) which comes in through the
 * `resizeHandle` / `pin` / `hidden` ReactNode slots — meaningless in a tab, so a
 * tab simply passes none.
 */
export interface ProjectFilesViewProps {
  /** The scope: a project id, a `box:<id>` scope, or "root". */
  scope: string;
  /** The project's id (was `activeId` in the panel); null in root scope. */
  projectId: string | null;
  /** The project (was `activeProject`); null in root/box scope. */
  project: ProjectEntry | null;
  /** The tree root. */
  projectDir: string;

  /** The browsed folder (host-owned so two views of one project don't yank each
   *  other around). */
  folder: string;
  onFolderChange: (folder: string) => void;

  /** Which side of a remote project the files view shows — the host over SFTP
   *  ("Remote") or the synced mirror ("Local"). The host owns `useFileSource`. */
  source: "remote" | "local";
  setSource: (s: "remote" | "local") => void;

  /** Whether this view is live/visible. Gates git + windows probes and the pill
   *  dirty-dot write, so a closed panel / background tab never churns them. */
  active: boolean;
  /** Whether the tree (and its fs-watch) is mounted. Forwarded to
   *  `ProjectFilesPane`. */
  mountTree: boolean;

  /** Compact mode: strip everything above the tree's find-files search box — the
   *  project-name header, the view-switcher toolbar (Files/Git/Search/Apps/±),
   *  and the sync + sort rows (`ProjectFilesPane`) — so the search is topmost.
   *  Set only by the docked subwindow viewer (`SubwindowFilesSidebar`); the right
   *  panel and the Files (Project) tab leave it unset and keep the full chrome. */
  compact?: boolean;

  /** Host callback for the tree's "Open in a new tab"; omitted where a tab can't
   *  be owned (a box root, a popout on a streamed tab copy). */
  onOpenFolderTab?: (relPath: string) => void;

  /** The host controls the outer container's own identity (slide-in panel vs.
   *  flex tab, width, resize transitions, hover-reveal handlers); this component
   *  appends the drop classes and spreads the import-drop handlers onto it. */
  containerClassName: string;
  containerStyle?: React.CSSProperties;
  containerProps?: React.HTMLAttributes<HTMLDivElement>;

  /** Panel-only fragments interleaved with the shared DOM (undefined in a tab). */
  resizeHandle?: React.ReactNode;
  pin?: React.ReactNode;
  hidden?: React.ReactNode;
}

export function ProjectFilesView({
  scope,
  projectId,
  project,
  projectDir,
  folder,
  onFolderChange,
  source,
  setSource,
  active,
  mountTree,
  onOpenFolderTab,
  containerClassName,
  containerStyle,
  containerProps,
  resizeHandle,
  pin,
  hidden,
  compact,
}: ProjectFilesViewProps) {
  const { windows, refresh, untrack } = useWindowsStore();
  const [view, setView] = useState<View>("files");
  const [showSettings, setShowSettings] = useState(false);
  // Toggles the Downloads section stacked below the file tree (fast-copy of
  // recent downloads into the project). Toolbar ⬇⬇ button; files view only.
  const [showDownloads, setShowDownloads] = useState(false);
  // Kept here (not in the pane): the pane unmounts while the view shows Git or
  // Search, and the chosen sort must survive the trip back to Files.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [unpushedCommits, setUnpushedCommits] = useState<string[]>([]);
  const [openTree, setOpenTree] = useState<"add" | "commit" | "push" | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  // Whether the project is missing scaffold files — drives the "no scaffold"
  // type tag shown beside its name, mirroring ProjectPill's hover tags.
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

  const localFile = project?.local_file;
  // Remote git/endings probes dispatch over SSH/SFTP via SYNCHRONOUS Tauri
  // commands (run on the main thread). Calling them while the pool is down blocks
  // on the dead session and freezes the window, so suppress them until the remote
  // project is connected. Local projects are never blocked.
  const { remoteSshState, remoteBlocked } = useRemoteBlocked(projectId, !!project?.remote);
  // Which endings/paths the tree hides, from the project's own project.json —
  // shared with the right panel, so both views hide the same files.
  const filters = useProjectFileFilters({ localFile, projectDir, remoteBlocked });

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
      // Keep the project's pill dot in sync from the data we just fetched (no
      // extra git subprocesses), so edits/commits/pushes reflect immediately
      // instead of waiting for the switcher's periodic poll.
      // Don't let a nested repo's status pollute the project pill's dirty dot —
      // that dot tracks the project repo (the switcher's poll recomputes it).
      // Gate on `active` so a background tab never churns the shared store.
      if (active && projectId && status && !onNestedRepo) {
        useGitDirtyStore.getState().set(projectId, gitDirtyState(status, unpushed.length));
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

  // Detect a nested git repo: if the folder currently browsed in the file tree
  // lives inside a git repo distinct from the project's own repo, re-root the
  // git section at it (auto-switch). Local projects only — the backend returns
  // null for remote ones, so `nestedRoot` stays null and behavior is unchanged.
  useEffect(() => {
    if (!projectDir || project?.remote) {
      setNestedRoot(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      invoke<string | null>("git_repo_root", { projectDir, relPath: "" }).catch(() => null),
      invoke<string | null>("git_repo_root", { projectDir, relPath: folder }).catch(() => null),
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
  }, [projectDir, folder, project?.remote]);

  // Default to auto-switch: reset the manual override on a project switch or
  // whenever we leave the nested repo, so entering one always shows it first.
  useEffect(() => {
    setPreferProjectRepo(false);
  }, [projectId]);
  useEffect(() => {
    if (!nestedRoot) setPreferProjectRepo(false);
  }, [nestedRoot]);

  // The repo root the whole git section (status, commit, push, history) operates
  // on: the nested repo when detected and not overridden, else the project repo.
  const effectiveGitRoot = nestedRoot && !preferProjectRepo ? nestedRoot : projectDir;
  const onNestedRepo = !!nestedRoot && effectiveGitRoot !== projectDir;

  // Diverged (amber/orange) files for a remote project, from the cached sync
  // status — backs the toolbar count badge and the "Orange" list view. These are
  // exactly the files auto-sync refuses to touch (both sides changed), so they
  // need a human to pick a side.
  const syncMap = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  const orangeFiles = useMemo(() => amberPaths(syncMap), [syncMap]);
  // The local mirror root, to open an amber file's mirror copy for inspection.
  const mirrorRoot = resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);

  // Persistent (tmux) sessions on the project's hosts (TODO #85): a session
  // outlives the tab that started it, so a host can hold runs no open tab points at
  // (a crashed/relaunched Eldrun, another machine, a hand-started `tmux`). This list
  // makes them discoverable and reattachable — the primary UI surface for the
  // feature. **Multi-host**: aggregated across the primary AND every connected
  // worker, each row tagged with its host; polled while this view is active (rides
  // each host's pooled ControlMaster). An absent tmux / no server yields nothing.
  const sessionHosts = useMemo(() => {
    if (!project?.remote) return [] as { id: string; label: string }[];
    const list = [{ id: "primary", label: project.remote.host }];
    for (const w of project.compute_hosts ?? [])
      list.push({ id: w.id, label: w.label || w.host || w.id });
    return list;
  }, [project?.remote, project?.compute_hosts]);
  // A connectivity signature so the poll re-runs the moment a host connects.
  const connSig = useRemoteStatusStore((s) =>
    sessionHosts.map((h) => `${h.id}:${sshOf(s, projectId ?? "", h.id)}`).join("|"),
  );
  const [sessionRows, setSessionRows] = useState<SessionRow[]>([]);
  useEffect(() => {
    if (!active || !projectId || !project?.remote) {
      setSessionRows([]);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const st = useRemoteStatusStore.getState();
      const connected = sessionHosts.filter((h) => sshOf(st, projectId, h.id) === "connected");
      if (connected.length === 0) {
        if (!cancelled) setSessionRows([]);
        return;
      }
      const lists = await Promise.all(
        connected.map((h) =>
          invoke<TmuxSession[]>("remote_tmux_list", { projectId, hostId: h.id })
            .then((ss) => ss.map((session) => ({ hostId: h.id, hostLabel: h.label, session })))
            .catch(() => [] as SessionRow[]),
        ),
      );
      if (!cancelled) setSessionRows(lists.flat());
    };
    void poll();
    const iv = setInterval(() => void poll(), 7000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [active, projectId, project?.remote, connSig, sessionHosts]);

  // The (host, session) each open shell tab of this scope owns, so a Sessions row
  // can reveal the tab that runs it instead of opening a second attach.
  // Coalesce to the shared empty array OUTSIDE the selector: a selector that
  // returns a fresh `[]` when this scope has no tabs yields a new snapshot on
  // every render, which makes `useSyncExternalStore` loop forever ("getSnapshot
  // should be cached" → Maximum update depth). Returning the stored array (stable)
  // or `undefined` (stable) from the selector, then defaulting here, is loop-safe.
  const scopeTabs = useTabsStore((s) => s.tabsByScope[scope]) ?? EMPTY_SCOPE_TABS;
  const sessionOwners = useMemo(() => {
    const m = new Map<string, string>(); // `${hostId}\0${name}` → owning tab key
    for (const t of scopeTabs) {
      const info = persistentSessionOf(scope, t);
      if (info) m.set(`${info.hostId} ${info.session}`, t.key);
    }
    return m;
  }, [scopeTabs, scope]);

  // Open a host session in a tab: reveal the owning tab if one exists, else add a
  // shell tab on THAT host that ATTACHES to the named session (idempotent; `-D`
  // detaches any other client). The tab carries the name so it reattaches across a
  // restart, and its locality is the row's host.
  const openSession = (hostId: string, name: string) => {
    if (!projectId) return;
    const ownerKey = sessionOwners.get(`${hostId} ${name}`);
    if (ownerKey) {
      useTabsStore.getState().setActive(ownerKey);
      return;
    }
    useTabsStore.getState().addTabToScope(projectId, {
      label: name.startsWith("eldrun-") ? "session" : name,
      cmd: "",
      args: [],
      cwd: projectDir,
      kind: "shell",
      location: hostId === "primary" ? "remote" : `host:${hostId}`,
      tmuxAttach: name,
    });
  };

  // Kill a host session (per-row, confirmed). Drops the row optimistically; the
  // poll reconciles.
  const killSession = (hostId: string, name: string) => {
    if (!projectId) return;
    if (
      !window.confirm(
        `Kill the session “${name}” and any process running in it (e.g. a training run)?`,
      )
    )
      return;
    invoke("remote_tmux_kill", { projectId, hostId, session: name })
      .then(() =>
        setSessionRows((rs) => rs.filter((r) => !(r.hostId === hostId && r.session.name === name))),
      )
      .catch(() => {});
  };

  // Rename a host session (per-row). The name must be tmux-safe; on success the
  // owning tab's persisted name is updated too, so it reattaches to the renamed
  // session after a restart (the live client stays attached — rename never drops it).
  const renameSession = (hostId: string, oldName: string) => {
    if (!projectId) return;
    const proposed = window.prompt("Rename session to:", oldName);
    if (proposed === null) return;
    const next = proposed.trim();
    if (!next || next === oldName) return;
    if (!/^[A-Za-z0-9_-]+$/.test(next)) {
      window.alert("A session name may only contain letters, digits, '-' and '_'.");
      return;
    }
    invoke("remote_tmux_rename", { projectId, hostId, session: oldName, newName: next })
      .then(() => {
        const ownerKey = sessionOwners.get(`${hostId} ${oldName}`);
        if (ownerKey) useTabsStore.getState().setTabTmuxName(scope, ownerKey, next);
        setSessionRows((rs) =>
          rs.map((r) =>
            r.hostId === hostId && r.session.name === oldName
              ? { ...r, session: { ...r.session, name: next } }
              : r,
          ),
        );
      })
      .catch((e) => window.alert(`Rename failed: ${e}`));
  };

  // Resolve the scaffold-missing flag whenever the project changes. Failures
  // fall back to "present" so a probe error doesn't flash the tag.
  useEffect(() => {
    if (!projectId) {
      setScaffoldMissing(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("project_scaffold_missing", { projectId })
      .then((v) => { if (!cancelled) setScaffoldMissing(v); })
      .catch(() => { if (!cancelled) setScaffoldMissing(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const typeTags = project ? projectTypeTags(project, scaffoldMissing) : [];

  // Right-click menu on the SSH (remote) tag: connect/manage the host, or open the
  // multi-host "Remote machines" manager (docs/multi_host_remote_plan.md).
  const openConnectDialog = useConnectDialogStore((s) => s.open);
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const [sshTagMenu, setSshTagMenu] = useState<{ x: number; y: number } | null>(null);

  // Same hover card as the project pill, shown when hovering the project name
  // here — minus the type tags, which already sit beside the name below.
  const nameHover = useProjectHoverCard(project ?? undefined);

  // A box scope shows a multi-root file view (the box folder + every member
  // project's root) instead of one project tree; the pane renders it.
  const { activeBox } = useBoxRoots(scope);

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = folder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  // OS file drop → copy into the project, prompting on collisions. Confined to a
  // single project (a box scope has no single destination root). The whole
  // container is the drop zone, so a drop outside the files view lands at the
  // project root; inside it, on the browsed folder.
  const importDrop = useImportDrop({
    projectDir,
    enabled: !activeBox,
    destRel: view === "files" ? folder : "",
    // The tree auto-reloads via its fs-watch; refresh git so new untracked files
    // show in the status counts immediately.
    onImported: () => refreshGit(effectiveGitRoot),
  });

  useEffect(() => {
    if (active && projectId) {
      refresh(projectId);
    }
  }, [active, projectId]);

  useEffect(() => {
    if (active && effectiveGitRoot && !remoteBlocked) {
      refreshGit(effectiveGitRoot);
    } else {
      setGitStatus(null);
    }
  }, [active, effectiveGitRoot, remoteBlocked]);

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
        projectId: onNestedRepo ? null : projectId ?? null,
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
      className={`${containerClassName}${importDrop.dropActive ? " drop-active" : ""}${importDrop.dropFlash ? " drop-flash" : ""}`}
      style={containerStyle}
      {...containerProps}
      {...importDrop.handlers}
    >
      {resizeHandle}
      {importDrop.conflictModal}
      {/* Compact (docked subwindow) viewer: everything from here down to the git
          commit block is above the tree's find-files search, so it's stripped —
          leaving the search box topmost. The right panel / Files (Project) tab
          render with `compact` unset and keep the full chrome. */}
      {!compact && (
        <>
      <div className="right-panel-header">
        {pin}
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: !activeBox && project ? "default" : undefined,
          }}
          onMouseEnter={
            !activeBox && project
              ? (e) => void nameHover.open(e.currentTarget.getBoundingClientRect())
              : undefined
          }
          onMouseLeave={!activeBox && project ? () => nameHover.close() : undefined}
        >
          {activeBox ? `▣ ${activeBox.name}` : project ? project.name : "Files"}
        </span>
        {!activeBox && project && (
          <ProjectHoverCard project={project} state={nameHover} showTags={false} />
        )}
        {/* Static project type tags (git / provider / SSH / scaffold). These are
            labels only — no interactivity — so they deliberately look nothing
            like the source switch below. */}
        {!activeBox && typeTags.length > 0 && (
          <span className="right-panel-type-tags">
            {typeTags.map((t) => {
              // The SSH tag carries a right-click menu (connect / manage · remote
              // machines); the rest stay pure labels.
              const isSsh = t.key === "ssh" && !!project?.remote && !!projectId;
              return (
                <span
                  key={t.key}
                  className="pill-popup-tag"
                  title={isSsh ? `${t.title}\nRight-click for connection / machines` : t.title}
                  style={{
                    color: t.color,
                    borderColor: t.color,
                    background: `${t.color}22`,
                    cursor: isSsh ? "context-menu" : undefined,
                  }}
                  onContextMenu={
                    isSsh
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSshTagMenu({ x: e.clientX, y: e.clientY });
                        }
                      : undefined
                  }
                >
                  {t.label}
                </span>
              );
            })}
          </span>
        )}
        {sshTagMenu && projectId && createPortal(
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 200 }}
              onPointerDown={() => setSshTagMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSshTagMenu(null);
              }}
            />
            <div
              className="context-menu"
              style={{ left: sshTagMenu.x, top: sshTagMenu.y, zIndex: 201 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="context-menu-group">
                <div className="context-menu-group-label">{project?.remote?.host ?? "Remote"}</div>
                <button
                  onClick={() => {
                    openConnectDialog(projectId, "primary");
                    setSshTagMenu(null);
                  }}
                >
                  Connect / manage…
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    openRemoteMachines(projectId);
                    setSshTagMenu(null);
                  }}
                >
                  Remote machines…
                  <UntestedTag />
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
        {/* Remote/Local file-source switch (remote SSH projects only). A live
            segmented control — NOT a tag — that flips the files view between the
            host tree over SFTP ("Remote") and the synced mirror ("Local"). It's
            right-aligned and styled as a switch so it never reads as one of the
            static tags above. */}
        {!activeBox && project?.remote && projectId && (
          <>
          {/* Breaker: drop the switch onto its own row so it left-aligns with the
              pin/name (header padding edge) instead of trailing the tags. */}
          <span style={{ flexBasis: "100%", width: 0, height: 0 }} />
          <FileSourceSwitch source={source} onChange={setSource} />
          {/* One-click SSH logout, shown while connected. Lives here (not on the
              project pill) so the pill stays status-only; the danger tint only
              appears on hover. */}
          {remoteSshState === "connected" && (
            <button
              type="button"
              className="right-panel-conn-logout"
              aria-label={`Log out of ${project.remote.host} — disconnect this remote project`}
              title={`Log out of ${project.remote.host}\nDrops the SSH connection${project.remote.openvpn ? " and the VPN tunnel" : ""}. Open tabs stay, their sessions go dead until you reconnect.`}
              onClick={() => logoutRemote(project)}
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
            unpushedCommits.length > 0) && (
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
                {unpushedCommits.length > 0 && (
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

      {hidden}

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
        {!activeBox && project?.remote && projectId && (
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
        {/* Persistent (tmux) sessions on the host (TODO #85): remote-only, badged
            with the live session count, so a run left alive on the host is one
            click from being reattached. */}
        {!activeBox && project?.remote && projectId && (
          <button
            className={`tab-add-btn right-panel-orange-btn${view === "sessions" ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            aria-pressed={view === "sessions"}
            onClick={() => setView((v) => (v === "sessions" ? "files" : "sessions"))}
            title={`Persistent host sessions (tmux): ${sessionRows.length}`}
          >
            ☰ {sessionRows.length > 0 && <span className="right-panel-orange-count">{sessionRows.length}</span>}
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
        {projectId && (
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
                  borderRadius: "var(--radius-sm)",
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
                {project?.name || "Project"}
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
            projectId={onNestedRepo ? undefined : project?.remote ? projectId ?? undefined : undefined}
            remote={!onNestedRepo && !!project?.remote}
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
            <>
              {/* Bulk "…for all" resolution: take one side for every diverged
                  file at once. Both are destructive to the losing side, so each
                  confirms first (with the file count). */}
              <div className="orange-bulk-bar">
                <span className="orange-bulk-count">
                  {orangeFiles.length} diverged
                </span>
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act"
                    title="Take the host copy for every diverged file (overwrite the local mirror)"
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      if (
                        !window.confirm(
                          `Take the host copy for all ${orangeFiles.length} diverged files? This overwrites your local mirror edits.`,
                        )
                      )
                        return;
                      void useSyncStore
                        .getState()
                        .resolveAll(projectId, orangeFiles, "host");
                    }}
                  >
                    Take host for all
                  </button>
                  <button
                    type="button"
                    className="orange-file-act"
                    title="Keep the local copy for every diverged file (force-push over the host)"
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      if (
                        !window.confirm(
                          `Keep the local copy for all ${orangeFiles.length} diverged files? This overwrites the host copies.`,
                        )
                      )
                        return;
                      void useSyncStore
                        .getState()
                        .resolveAll(projectId, orangeFiles, "local");
                    }}
                  >
                    Keep local for all
                  </button>
                </div>
              </div>
              {orangeFiles.map((rel) => (
              <div key={rel} className="orange-file-row" title={rel}>
                <button
                  type="button"
                  className="orange-file-name"
                  disabled={!mirrorRoot}
                  title={mirrorRoot ? `Open ${rel}` : rel}
                  onClick={() => {
                    if (!mirrorRoot) return;
                    const abs = `${mirrorRoot}/${rel}`;
                    // Open the diverged file in the three-way merge viewer
                    // (local mirror ⇄ merged ⇄ remote host, PyCharm-style), so
                    // the user can take changes from either side per block and
                    // resolve the divergence in one place.
                    openLinkedFile(undefined, dirname(abs), {
                      path: abs,
                      viewer: "syncmerge",
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
                    onClick={() => projectId && void useSyncStore.getState().pull(projectId, rel)}
                  >
                    Take host
                  </button>
                  <button
                    type="button"
                    className="orange-file-act"
                    title="Keep the local copy (force-push over the host)"
                    disabled={remoteBlocked}
                    onClick={() => projectId && void useSyncStore.getState().push(projectId, rel, true)}
                  >
                    Keep local
                  </button>
                </div>
              </div>
              ))}
            </>
          )}
        </div>
      )}

      {view === "sessions" && (
        <div className="right-panel-scroll right-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          {sessionRows.length === 0 ? (
            <div className="right-panel-orange-empty">
              {remoteBlocked ? "Connect to list host sessions" : "No persistent sessions on the host(s)"}
            </div>
          ) : (
            sessionRows.map(({ hostId, hostLabel, session: s }) => {
              const owned = sessionOwners.has(`${hostId} ${s.name}`);
              // Show the host tag only when the project spans more than one host.
              const showHost = sessionHosts.length > 1;
              return (
                <div key={`${hostId} ${s.name}`} className="orange-file-row" title={s.name}>
                  <button
                    type="button"
                    className="orange-file-name"
                    title={owned ? `Reveal the tab running “${s.name}”` : `Attach to “${s.name}”`}
                    onClick={() => openSession(hostId, s.name)}
                  >
                    <span className="orange-file-dot" aria-hidden="true">
                      {s.attached ? "●" : "○"}
                    </span>
                    {s.name}
                    <span className="tmux-session-meta">
                      {showHost ? `${hostLabel} · ` : ""}
                      {s.windows} win · {relativeAge(s.created)}
                      {owned ? " · open" : ""}
                    </span>
                  </button>
                  <div className="orange-file-actions">
                    <button
                      type="button"
                      className="orange-file-act"
                      title="Rename this session"
                      onClick={() => renameSession(hostId, s.name)}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="orange-file-act"
                      title="Kill this session and everything running in it"
                      aria-label={`Kill session ${s.name}`}
                      onClick={() => killSession(hostId, s.name)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Compact (docked subwindow) viewer strips the whole header above, which
          is where the Remote/Local source switch normally lives — but a remote
          project still needs it here to flip the tree between host and mirror.
          Give it its own row directly above the tree's find-files search box,
          so it's the topmost element the compact viewer shows. */}
      {compact && view === "files" && !activeBox && project?.remote && projectId && (
        <div className="right-panel-source right-panel-source--compact">
          <FileSourceSwitch source={source} onChange={setSource} />
        </div>
      )}
      {view === "files" && (
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
          // Right-click → "Open in a new tab": the same file view, on that
          // folder, as a Files (Project) tab in this project's scope.
          onOpenFolderTab={onOpenFolderTab}
          // A closed panel keeps no tree mounted (and so no fs-watch).
          mountTree={mountTree}
          compact={compact}
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
