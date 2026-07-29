import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { RunHostPicker } from "../tabs/TabLocalityBadges";
import { ProjectFilesSettingsDialog, useProjectFileFilters } from "./ProjectFilesSettings";
import { useImportDrop } from "./importDrop";
import { logoutRemote, useProjectsStore } from "../../stores/projects";
import { useSyncStore, amberPaths } from "../../stores/sync";
import { confirmSyncTransfer } from "../../stores/syncConfirm";
import { openLinkedFile } from "../embed/FileViewerPane";
import { useWindowsStore } from "../../stores/windows";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import { resolveLocalMirror, type ProjectEntry } from "../../types";
import { fmtModified, type SortKey } from "../../lib/viewers/fileUtils";
import { basename, dirname } from "../../lib/paths";
import { projectTypeTags } from "../projects/projectTypeTags";
import { ProjectHoverCard, useProjectHoverCard } from "../projects/ProjectHoverCard";
import { useRemoteMachinesStore } from "../../stores/remoteMachines";
import { UntestedTag } from "../common/UntestedTag";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { persistentSessionOf } from "../../lib/closeRemoteTab";
import { useRemoteStatusStore, sshOf } from "../../stores/remoteStatus";
import {
  sessionHostsOf,
  useHostSessions,
  useHostSessionsStore,
  useShowAllSessions,
  type SessionRow,
} from "../../stores/hostSessions";
import {
  slurmAvailable,
  slurmQueue,
  slurmCancel,
  slurmJobOut,
  openLogTab,
  type SlurmJob,
} from "../../lib/slurm";
import { useHpcJobsStore } from "../../stores/hpcJobs";
import { useSettingsStore } from "../../stores/settings";
import {
  wsAvailable,
  wsList,
  wsExtend,
  wsAnchor,
  wsTargetForProject,
  setProjectHpc,
  pullLogs,
  moveProjectRoot,
  projectPathIn,
  findProjectWorkspace,
  shouldWarnExpiry,
  remainingLabel,
  expiryTone,
  type HpcWorkspace,
} from "../../lib/hpcWorkspace";
import { useT, type TranslationKey } from "../../lib/i18n";

/** How long the pointer must rest on a session row before its stats card opens
 *  (TODO #85) — same value and rationale as `FileTree`'s `TOOLTIP_DWELL_MS`:
 *  long enough that a mouse merely passing over the list never triggers it. */
const TOOLTIP_DWELL_MS = 400;

/** The row's own name button shows a short, stable label rather than the raw
 *  `eldrun-<uuid>` — meaningless to read at a glance and mostly there to keep
 *  the name unique. The full id lives in the session-stats popup instead
 *  (`SessionStatsMenu` below), alongside the rest of the row's detail. A
 *  hand-started/foreign session's name is usually short and meaningful
 *  (`train`), so it's shown as-is. */
function sessionDisplayName(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  name: string,
): string {
  return name.startsWith("eldrun-") ? t("projectFilesView.sessionLabel") : name;
}

/** Absolute local-time readout for a host-clock epoch timestamp, for the
 *  session-stats popup (the row itself only ever shows relative age). */
function absoluteTime(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString();
}

/** "How long has this session existed" / "how long has it sat idle", as a
 *  compact duration (not the `relativeAge` "N ago" phrasing, which reads
 *  wrong as a label next to "Uptime"/"Idle for"). */
function relativeDuration(epochSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** Anchor for the per-row session-stats hover card (TODO #85) — the same
 *  dwell-triggered tooltip pattern `FileTree` uses for a file/folder row
 *  (`handleEntryMouseEnter`/`.file-tooltip`), applied to a session row. Carries
 *  only the (host, name) identity, not a snapshot of the session — the card
 *  looks the live row up from `sessionRows` on every render, so its stats keep
 *  advancing with the Sessions view's own 7s poll while it's open, rather than
 *  freezing at whatever "working"/uptime the session had when the dwell fired. */
interface SessionTooltip {
  rect: DOMRect;
  hostId: string;
  name: string;
}

interface MtimeCue {
  text: string;
  tone: "remote" | "local" | "neutral";
  title: string;
}

/** Which copy has the later recorded mtime, as a small badge. Remote (host)
 *  and local clocks may differ, so this is intentionally a timestamp cue,
 *  never an automatic resolution — the full "modified when" detail lives in
 *  the tooltip rather than the badge itself. Tone always names the side the
 *  text is about: remote = --warning (orange), local = --success (green),
 *  matching the take-remote/keep-local icon buttons below.
 *
 *  A row only reaches this list once the manifest has recorded a synced base
 *  for it (`amberPaths` reads `state === "amber"`, which `compute_state`
 *  never sets for an untracked path) — so a null mtime here is never "this
 *  file was never synced," it's "this file WAS synced and one side's copy
 *  has since been deleted." The tooltip says so explicitly, since the badge
 *  text alone ("Remote only") reads ambiguously otherwise. */
function mtimeDivergenceCue(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  hostMtime: number | null | undefined,
  localMtime: number | null | undefined,
): MtimeCue | null {
  if (hostMtime == null && localMtime == null) return null;
  const hostLabel =
    hostMtime != null
      ? t("projectFilesView.remoteModified", { when: fmtModified(hostMtime) })
      : t("projectFilesView.remoteDeletedSinceSync");
  const localLabel =
    localMtime != null
      ? t("projectFilesView.localModified", { when: fmtModified(localMtime) })
      : t("projectFilesView.localDeletedSinceSync");
  const title = `${hostLabel}\n${localLabel}`;
  if (hostMtime == null) return { text: t("projectFilesView.localOnly"), tone: "local", title };
  if (localMtime == null) return { text: t("projectFilesView.remoteOnly"), tone: "remote", title };
  if (hostMtime > localMtime) return { text: t("projectFilesView.remoteNewer"), tone: "remote", title };
  if (localMtime > hostMtime) return { text: t("projectFilesView.localNewer"), tone: "local", title };
  return { text: t("projectFilesView.sameTime"), tone: "neutral", title };
}

interface GitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  has_remote: boolean;
  is_repo: boolean;
}

type View = "files" | "windows" | "git" | "search" | "orange" | "sessions" | "jobs";

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

  /** Compact mode: strip the project-name/tags/source-switch/git-bar header row
   *  and the Alerts group (with its 🔔) — the view-switcher toolbar (Files/Git/
   *  Search/Apps/±/sessions/jobs/import/etc.) and every view it switches to
   *  render identically to the full chrome. The sync + sort rows
   *  (`ProjectFilesPane`) are still stripped, so the tree's find-files search
   *  stays topmost there. Set only by the docked subwindow viewer
   *  (`SubwindowFilesSidebar`); the right panel and the Files (Project) tab
   *  leave it unset and keep the full chrome. */
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
  const t = useT();
  const { windows, refresh, untrack } = useWindowsStore();
  const [view, setView] = useState<View>("files");
  const [showSettings, setShowSettings] = useState(false);
  // Toggles the Downloads section stacked below the file tree (fast-copy of
  // recent downloads into the project). Toolbar ⬇⬇ button; files view only.
  const [showDownloads, setShowDownloads] = useState(false);
  // The Alerts group stacked below the file tree (urgent mail, the next
  // appointments, due/overdue cards). Unlike Downloads there is no local shown
  // flag: `files_alerts` IS the visibility, which is what lets the × stick — the
  // group is on by default, so a close that came back at the next remount (and
  // this viewer is mounted many times over) would be a control that doesn't work.
  // Being the same switch the Settings dialog writes, the two can't disagree.
  const alertsEnabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  // ...but never in the docked subwindow column (`compact`), whatever the
  // setting says: that viewer is a ~300px sidebar beside a terminal, where a
  // strip of mail/appointment/card rows takes the space the tree is there for
  // — and it is the surface mounted many times over at once, so one alert
  // would be repeated once per open subwindow. Its 🔔 goes with it: a toggle
  // that writes a setting whose group can never appear here is a dead control
  // (and would silently arm the group in the panel and every Files tab).
  // The right panel and the Files (Project) tab are unaffected.
  const alertsHere = alertsEnabled && !compact;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
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
  //
  // The list, its poll and its toggle all live in `stores/hostSessions`, NOT
  // here: this component is rendered by the right panel, by every Files (Project)
  // tab and by every subwindow's docked column at once, and a per-instance poll
  // meant one `tmux ls` per host per surface every 7s — and, worse, that a
  // session killed in one surface sat on in the others until their own interval
  // came round. The store keeps one reading per project, refcounted by the
  // surfaces showing it (`active` decides whether this one subscribes at all), so
  // every viewer reads the same rows and a kill/rename lands in all of them.
  const sessionHosts = useMemo(() => sessionHostsOf(project), [project]);
  const sessionRows = useHostSessions(projectId, active && !!project?.remote);
  // The Sessions list is scoped to THIS project by default (the backend filters
  // by session name, falling back to the session's working directory for the
  // pre-scoping and hand-started ones a name cannot attribute). This is the
  // escape hatch: a host's full listing, so a session running outside any
  // project tree — an orphaned run whose tab is long gone — is still reachable
  // to attach to or kill. Shared like the list itself: it changes what the
  // backend returns, so two viewers of one project must not hold two answers.
  const [showAllSessions, setShowAllSessions] = useShowAllSessions(projectId);

  // Per-row session-stats hover card (TODO #85): the exact dwell-tooltip
  // mechanism `FileTree` uses for a file/folder row — open on a genuine pause,
  // not mere mouse-in (a bare `onMouseEnter` measurement would reflow on every
  // pass over the list), close immediately on leave.
  const [sessionTooltip, setSessionTooltip] = useState<SessionTooltip | null>(null);
  const sessionTooltipRef = useRef<HTMLDivElement | null>(null);
  const sessionTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelSessionTooltipTimer() {
    if (sessionTooltipTimer.current !== null) {
      clearTimeout(sessionTooltipTimer.current);
      sessionTooltipTimer.current = null;
    }
  }
  useEffect(() => () => cancelSessionTooltipTimer(), []);
  function handleSessionRowMouseEnter(e: React.MouseEvent<HTMLDivElement>, hostId: string, name: string) {
    const row = e.currentTarget;
    cancelSessionTooltipTimer();
    sessionTooltipTimer.current = setTimeout(() => {
      sessionTooltipTimer.current = null;
      setSessionTooltip({ rect: row.getBoundingClientRect(), hostId, name });
    }, TOOLTIP_DWELL_MS);
  }
  function handleSessionRowMouseLeave() {
    cancelSessionTooltipTimer();
    setSessionTooltip(null);
  }
  // Vertical-only overflow correction, same as `FileTree`'s `tooltipShift`: a
  // row near the bottom of a short docked viewer still measures its anchor
  // against the whole app window, so an unclamped `top` could push the card
  // past the window's bottom edge. Horizontal side is picked in the render
  // below (whichever side of the row has more room).
  const [sessionTooltipShift, setSessionTooltipShift] = useState(0);
  useLayoutEffect(() => {
    if (!sessionTooltip) {
      setSessionTooltipShift(0);
      return;
    }
    const el = sessionTooltipRef.current;
    if (!el) {
      setSessionTooltipShift(0);
      return;
    }
    const overflow = sessionTooltip.rect.top + el.offsetHeight - (window.innerHeight - 8);
    setSessionTooltipShift(overflow > 0 ? overflow : 0);
  }, [sessionTooltip]);
  // Closing a session (kill/rename) drops it from `sessionRows`; the card has
  // no session left to look up, so it self-closes rather than showing
  // stale/blank stats.
  useEffect(() => {
    if (!sessionTooltip) return;
    const stillThere = sessionRows.some(
      (r) => r.hostId === sessionTooltip.hostId && r.session.name === sessionTooltip.name,
    );
    if (!stillThere) setSessionTooltip(null);
  }, [sessionRows, sessionTooltip]);

  // Keep the Sessions view grouped in the configured machine order. A fallback
  // group preserves a row if a machine was renamed or removed while its list
  // request was still in flight.
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, { hostId: string; hostLabel: string; rows: SessionRow[] }>();
    for (const host of sessionHosts)
      groups.set(host.id, { hostId: host.id, hostLabel: host.label, rows: [] });
    for (const row of sessionRows) {
      const group = groups.get(row.hostId);
      if (group) group.rows.push(row);
      else groups.set(row.hostId, { hostId: row.hostId, hostLabel: row.hostLabel, rows: [row] });
    }
    return [...groups.values()].filter((group) => group.rows.length > 0);
  }, [sessionHosts, sessionRows]);

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
    for (const tab of scopeTabs) {
      const info = persistentSessionOf(scope, tab);
      if (info) m.set(`${info.hostId} ${info.session}`, tab.key);
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
  // poll reconciles. Unlike a tab close (which merely detaches), a kill terminates
  // the session, so the tab that owns it — now attached to a dead session — is
  // closed too rather than left showing a defunct terminal.
  const killSession = (hostId: string, name: string) => {
    if (!projectId) return;
    if (!window.confirm(t("projectFilesView.confirmKillSession", { name }))) return;
    const ownerKey = sessionOwners.get(`${hostId} ${name}`);
    invoke("remote_tmux_kill", { projectId, hostId, session: name })
      .then(() => {
        // Into the SHARED list, so the panel, the tab and every docked column
        // drop the row together rather than each waiting out its own poll.
        useHostSessionsStore.getState().dropRow(projectId, hostId, name);
        if (ownerKey) useTabsStore.getState().removeTab(ownerKey);
      })
      .catch(() => {});
  };

  // Rename a host session (per-row). The name must be tmux-safe; on success the
  // owning tab's persisted name is updated too, so it reattaches to the renamed
  // session after a restart (the live client stays attached — rename never drops it).
  const renameSession = (hostId: string, oldName: string) => {
    if (!projectId) return;
    const proposed = window.prompt(t("projectFilesView.renameSessionPrompt"), oldName);
    if (proposed === null) return;
    const next = proposed.trim();
    if (!next || next === oldName) return;
    if (!/^[A-Za-z0-9_-]+$/.test(next)) {
      window.alert(t("projectFilesView.sessionNameInvalid"));
      return;
    }
    invoke("remote_tmux_rename", { projectId, hostId, session: oldName, newName: next })
      .then(() => {
        const ownerKey = sessionOwners.get(`${hostId} ${oldName}`);
        if (ownerKey) useTabsStore.getState().setTabTmuxName(scope, ownerKey, next);
        useHostSessionsStore.getState().renameRow(projectId, hostId, oldName, next);
      })
      .catch((e) => window.alert(t("projectFilesView.renameSessionFailed", { error: String(e) })));
  };

  // ── SLURM jobs (HPC) ──────────────────────────────────────────────────────
  // A Jobs view, primary-only to start: whether the primary host has SLURM, and
  // this user's live queue on it. Rides the primary's pooled ControlMaster; polled
  // only while the view is active (like Sessions). A local project with SLURM (a
  // login node) also gets it. The session store carries just-submitted jobs so a
  // Watch can resolve their log path without a fresh scontrol.
  const [slurmSupported, setSlurmSupported] = useState(false);
  const [jobRows, setJobRows] = useState<SlurmJob[]>([]);
  const sessionJobs = useHpcJobsStore((s) =>
    projectId ? s.byProject[projectId] : undefined,
  );
  // Primary connectivity, so probes/polls re-run the moment it connects.
  const primaryConn = useRemoteStatusStore((s) => sshOf(s, projectId ?? "", "primary"));
  const primaryReady = !project?.remote || primaryConn === "connected";
  useEffect(() => {
    if (!active || !projectDir || !primaryReady) {
      setSlurmSupported(false);
      return;
    }
    let cancelled = false;
    slurmAvailable(projectDir)
      .then((info) => { if (!cancelled) setSlurmSupported(info.available); })
      .catch(() => { if (!cancelled) setSlurmSupported(false); });
    return () => { cancelled = true; };
  }, [active, projectDir, primaryReady]);
  useEffect(() => {
    if (!active || view !== "jobs" || !slurmSupported || !projectDir) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const jobs = await slurmQueue(projectDir);
        if (!cancelled) setJobRows(jobs);
      } catch {
        if (!cancelled) setJobRows([]);
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 7000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [active, view, slurmSupported, projectDir]);

  // Watch a job: open a log tab tailing its stdout. Use the session store's path
  // if we submitted it this session, else resolve via scontrol.
  const watchJob = async (jobId: string, name: string) => {
    if (!projectDir) return;
    try {
      const known = sessionJobs?.find((j) => j.jobId === jobId);
      const outFile =
        known?.outFile ??
        (await slurmJobOut(projectDir, jobId, undefined, project?.hpc?.logs_dir));
      openLogTab({
        scope,
        projectDir,
        outFile,
        jobLabel: `${jobId} ${name}`,
        hostId: "primary",
        isRemote: !!project?.remote,
      });
    } catch (e) {
      window.alert(t("projectFilesView.watchJobResolveFailed", { jobId, error: String(e) }));
    }
  };

  // ── HPC workspaces (Phase C) ──────────────────────────────────────────────
  // A workspace is the piece of the cluster's parallel filesystem this project's
  // data lives on — and it is DELETED when it expires. The wizard is where one is
  // allocated; this is where an already-running project *sees the clock* and
  // spends an extension before the deadline. Read once when the Jobs view opens
  // (never polled: `ws_list` is a full SSH round trip and the number moves in
  // days, not seconds).
  const [wsRows, setWsRows] = useState<HpcWorkspace[]>([]);
  const [wsBusy, setWsBusy] = useState(false);
  // The read runs for the Jobs view AND — when the project records a workspace —
  // as soon as its host is reachable, because the expiry banner has to appear
  // without the user first opening a view they have no reason to visit.
  const wantWorkspaces = view === "jobs" || Boolean(project?.hpc?.workspace_id);
  useEffect(() => {
    if (!active || !wantWorkspaces || !projectDir || !primaryReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await wsAvailable(wsTargetForProject(projectDir));
        if (cancelled || !info.available) {
          if (!cancelled) setWsRows([]);
          return;
        }
        const list = await wsList(wsTargetForProject(projectDir));
        if (!cancelled) setWsRows(list);
      } catch {
        if (!cancelled) setWsRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [active, wantWorkspaces, projectDir, primaryReady]);

  // The workspace this project's tree actually lives in — the one whose expiry
  // deletes the host copy of the project, not merely "some data".
  const projectWs = useMemo(
    () => findProjectWorkspace(wsRows, project?.hpc, project?.remote?.remote_path),
    [wsRows, project?.hpc, project?.remote?.remote_path],
  );
  const [expiryDismissed, setExpiryDismissed] = useState("");
  const warnExpiry =
    shouldWarnExpiry(projectWs) && expiryDismissed !== `${projectWs?.id}:${projectWs?.remaining_days}`;

  // Spend one of a workspace's extensions. The filesystem it was allocated on has
  // to be repeated, so the row's own value is passed straight back.
  const extendWs = async (ws: HpcWorkspace) => {
    if (!projectDir) return;
    const answer = window.prompt(t("projectFilesView.extendWorkspacePrompt", { id: ws.id }), "30");
    if (!answer) return;
    const days = Number(answer.trim());
    if (!Number.isFinite(days) || days < 1) return;
    try {
      const next = await wsExtend(wsTargetForProject(projectDir), ws.id, days, ws.filesystem);
      setWsRows((rs) => rs.map((r) => (r.id === ws.id ? { ...r, ...next } : r)));
    } catch (e) {
      window.alert(t("projectFilesView.extendWorkspaceFailed", { id: ws.id, error: String(e) }));
    }
  };

  // Move the project's host tree into another workspace — the escape hatch an
  // expiry makes inevitable (a primary's remote_path is otherwise fixed at
  // creation). Nothing is copied host-side: the new root starts empty and is
  // re-seeded from the LOCAL MIRROR, which is the durable copy. Whatever the old
  // workspace still holds stays there until it expires, so this must be said
  // before it happens, not after.
  const moveProjectTo = async (ws: HpcWorkspace) => {
    if (!projectId || !project?.remote) return;
    const folder = basename(project.remote.remote_path.replace(/\/+$/, "")) || projectId;
    const dest = projectPathIn(ws, folder);
    const ok = window.confirm(t("projectFilesView.confirmMoveProject", { dest }));
    if (!ok) return;
    setWsBusy(true);
    try {
      // The pool caches the spec, so the connection has to be dropped around the
      // rewrite and re-opened against the new root.
      await invoke("remote_disconnect", { projectId }).catch(() => {});
      const updated = await moveProjectRoot(projectId, dest);
      useProjectsStore.setState((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? { ...p, ...updated } : p)),
      }));
      // Reconnect BEFORE re-anchoring: the anchor script rides the project's SSH
      // path, and between the disconnect above and this there is no session for
      // it to ride (on a password host it would have nothing to authenticate
      // with, and no prompt could be answered from here).
      // `viaLogin`: credential-less by necessity (there is no prompt to answer from
      // here), so it can only ride an existing master — never evidence of key auth.
      // `background: false`: this is the middle of a move the user clicked, and the
      // host it runs against is a cluster by construction — the dial policy's default
      // would refuse it on exactly the machines this flow exists for.
      await invoke("remote_connect", { projectId, viaLogin: true, background: false }).catch(
        () => {},
      );

      // Re-anchor: the record file gains a line naming the new workspace, and the
      // `workspace` symlink re-points. This is exactly the history the record
      // exists for — a project passes through several workspaces in a year.
      let logsDir = project.hpc?.logs_dir;
      const anchorRel = project.hpc?.anchor_rel;
      if (anchorRel) {
        try {
          const made = await wsAnchor(wsTargetForProject(projectDir), {
            anchorRel,
            workspacePath: ws.path,
            workspaceId: ws.id,
            projectName: project.name,
            makeLogs: true,
          });
          logsDir = made.logs_dir ?? logsDir;
        } catch {
          /* the move already succeeded; the anchor is a convenience */
        }
      }
      await setProjectHpc(projectId, {
        workspace_id: ws.id,
        workspace_path: ws.path,
        filesystem: ws.filesystem,
        anchor_dir: project.hpc?.anchor_dir,
        anchor_rel: anchorRel,
        logs_dir: logsDir,
      }).catch(() => {});
    } catch (e) {
      window.alert(t("projectFilesView.moveProjectFailed", { error: String(e) }));
    } finally {
      setWsBusy(false);
    }
  };

  // Copy the home anchor's logs into the local mirror — the provenance record on
  // the machine the user actually reads logs on.
  const pullProjectLogs = async () => {
    const dir = project?.hpc?.logs_dir;
    if (!projectId || !dir) return;
    try {
      const n = await pullLogs(projectId, dir);
      window.alert(
        n > 0
          ? t(n === 1 ? "projectFilesView.pulledLogsOne" : "projectFilesView.pulledLogsMany", { count: n })
          : t("projectFilesView.noLogsYet"),
      );
    } catch (e) {
      window.alert(t("projectFilesView.copyLogsFailed", { error: String(e) }));
    }
  };

  // Cancel a job (confirmed). Drops the row optimistically; the poll reconciles.
  const cancelJob = (jobId: string, name: string) => {
    if (!projectDir) return;
    if (
      !window.confirm(
        t("projectFilesView.confirmCancelJob", { jobId, name: name ? ` (${name})` : "" }),
      )
    )
      return;
    slurmCancel(projectDir, jobId)
      .then(() => {
        setJobRows((rs) => rs.filter((r) => r.id !== jobId));
        if (projectId) useHpcJobsStore.getState().remove(projectId, jobId, "primary");
      })
      .catch((e) => window.alert(t("projectFilesView.cancelJobFailed", { error: String(e) })));
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

  // Right-click menu on the SSH (remote) tag: open the one unified "Remote machines"
  // hub, which connects/manages every host and adds workers
  // (docs/multi_host_remote_plan.md).
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const [sshTagMenu, setSshTagMenu] = useState<{ x: number; y: number } | null>(null);

  // Import button's Files.../Folder... menu — same portal+backdrop pattern as
  // the SSH tag's context menu above.
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);

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
      {/* Compact (docked subwindow) viewer: only the project-name/tags/source-
          switch/git-bar header is stripped — the tree's find-files search stays
          topmost. The Files/Git/Search/Apps toolbar (± diverged, sessions, jobs,
          import, open-in-OS, downloads, settings) renders in both modes, so a
          subwindow file viewer behaves identically to the right panel / Files
          (Project) tab except for that header row. */}
      {!compact && (
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
          {activeBox ? `▣ ${activeBox.name}` : project ? project.name : t("projectFilesView.filesFallbackName")}
        </span>
        {!activeBox && project && (
          <ProjectHoverCard project={project} state={nameHover} showTags={false} />
        )}
        {/* Static project type tags (git / provider / SSH / scaffold). These are
            labels only — no interactivity — so they deliberately look nothing
            like the source switch below. */}
        {!activeBox && typeTags.length > 0 && (
          <span className="right-panel-type-tags">
            {typeTags.map((tag) => {
              // The SSH tag carries a right-click menu (connect / manage · remote
              // machines); the rest stay pure labels.
              const isSsh = tag.key === "ssh" && !!project?.remote && !!projectId;
              return (
                <span
                  key={tag.key}
                  className="pill-popup-tag"
                  title={
                    isSsh
                      ? `${tag.title}\n${t("projectFilesView.sshTagContextHint")}`
                      : tag.title
                  }
                  style={{
                    color: tag.color,
                    borderColor: tag.color,
                    background: `${tag.color}22`,
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
                  {tag.label}
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
                <div className="context-menu-group-label">
                  {project?.remote?.host ?? t("projectFilesView.remoteFallback")}
                </div>
                {/* One unified hub: connect/manage every host (primary + workers)
                    and add a machine, all from "Remote machines…". */}
                <button
                  className="untested"
                  onClick={() => {
                    openRemoteMachines(projectId);
                    setSshTagMenu(null);
                  }}
                >
                  {t("projectFilesView.remoteMachinesEllipsis")}
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
          {/* Run-host picker — which REMOTE machine (primary or a worker) scripts
              and shells launched from this project run on, distinct from the source
              switch's read side. Deliberately absent on Local: there is only one
              local machine, so the control would have nothing to choose, and
              showing a machine name there would state the opposite of what happens
              (a Local-side ▶ runs in a local shell and the preference cannot
              overrule it — see `lib/pythonRun`'s `pythonRunPlan`). */}
          {source === "remote" && (
            <RunHostPicker
              projectId={projectId}
              primaryHost={project.remote.label || project.remote.host}
              computeHosts={project.compute_hosts}
            />
          )}
          {/* One-click SSH logout, shown while connected. Lives here (not on the
              project pill) so the pill stays status-only; the danger tint only
              appears on hover. */}
          {remoteSshState === "connected" && (
            <button
              type="button"
              className="right-panel-conn-logout"
              aria-label={t("projectFilesView.logoutAriaLabel", { host: project.remote.host })}
              title={t("projectFilesView.logoutTitle", {
                host: project.remote.host,
                vpn: project.remote.openvpn ? t("projectFilesView.logoutVpnSuffix") : "",
              })}
              onClick={() => logoutRemote(project)}
            >
              <span aria-hidden="true">⏻</span> {t("projectFilesView.logout")}
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
                  title={t("projectFilesView.confirmCommitTitle")}
                >
                  <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                  <span>↵</span>
                  <span className="git-btn-label">{t("projectFilesView.confirm")}</span>
                </button>
                <button
                  className="git-action-btn git-action-btn--back"
                  disabled={gitBusy}
                  onClick={() => setCommitMsg(null)}
                  title={t("projectFilesView.goBackTitle")}
                >
                  <span>←</span>
                  <span className="git-btn-label">{t("projectFilesView.back")}</span>
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
                      title={t("projectFilesView.stageAllTitle", { count: gitStatus.unstaged + gitStatus.untracked })}
                    >
                      <span data-testid="add-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#f85149" }} />
                      <span>⊕</span>
                      <span className="git-btn-label">{t("projectFilesView.add", { count: gitStatus.unstaged + gitStatus.untracked })}</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label={t("projectFilesView.showChangedFiles")}
                      aria-expanded={openTree === "add"}
                      title={t("projectFilesView.showChangedFiles")}
                      onClick={() => setOpenTree((prev) => (prev === "add" ? null : "add"))}
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
                      title={t("projectFilesView.commitStagedTitle", { count: gitStatus.staged })}
                    >
                      <span data-testid="commit-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#e3b341" }} />
                      <span>✔</span>
                      <span className="git-btn-label">{t("projectFilesView.commit", { count: gitStatus.staged })}</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label={t("projectFilesView.showStagedFiles")}
                      aria-expanded={openTree === "commit"}
                      title={t("projectFilesView.showStagedFiles")}
                      onClick={() => setOpenTree((prev) => (prev === "commit" ? null : "commit"))}
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
                      title={t(
                        unpushedCommits.length === 1
                          ? "projectFilesView.pushCommitOneTitle"
                          : "projectFilesView.pushCommitManyTitle",
                        { count: unpushedCommits.length },
                      )}
                    >
                      <span data-testid="push-bar" style={{ width: 7, height: 7, borderRadius: "50%", marginRight: 5, flexShrink: 0, background: "#3fb950" }} />
                      <span>⬆</span>
                      <span className="git-btn-label">{t("projectFilesView.push", { count: unpushedCommits.length })}</span>
                    </button>
                    <button
                      className="git-action-toggle"
                      disabled={gitBusy}
                      aria-label={t("projectFilesView.showUnpushedFiles")}
                      aria-expanded={openTree === "push"}
                      title={t("projectFilesView.showUnpushedFiles")}
                      onClick={() => setOpenTree((prev) => (prev === "push" ? null : "push"))}
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
      )}

      {hidden}

      {/* Compact (docked subwindow) viewer strips the whole header above, which
          is where the Remote/Local source switch normally lives — but a remote
          project still needs it here to flip the tree between host and mirror.
          It gets its own row in the header's place: ABOVE the Files/Git/Search/
          Apps toolbar, so the compact viewer stacks source-switch → view row →
          content in the same order the right panel does. Deliberately NOT gated
          on the files view — the right panel's switch is always up, and a row
          that appeared only under "Files" would shove the toolbar up and down on
          every view change. */}
      {compact && !activeBox && project?.remote && projectId && (
        <div className="right-panel-source right-panel-source--compact">
          <FileSourceSwitch source={source} onChange={setSource} />
          {/* Remote side only, same reason as the full header's copy above — and
              this is the compact (docked subwindow) viewer, where the switch and
              the picker sit on one narrow row and a stale machine name beside a
              Local tag is at its most misleading. */}
          {source === "remote" && (
            <RunHostPicker
              projectId={projectId}
              primaryHost={project.remote.label || project.remote.host}
              computeHosts={project.compute_hosts}
            />
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
            {t(
              v === "files"
                ? "projectFilesView.tabFiles"
                : v === "git"
                  ? "projectFilesView.tabGit"
                  : v === "search"
                    ? "projectFilesView.tabSearch"
                    : "projectFilesView.tabApps",
            )}
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
            title={t("projectFilesView.divergedFilesTitle", { count: orangeFiles.length })}
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
            title={t("projectFilesView.persistentSessionsTitle", { count: sessionRows.length })}
          >
            ☰ {sessionRows.length > 0 && <span className="right-panel-orange-count">{sessionRows.length}</span>}
          </button>
        )}
        {/* SLURM jobs (HPC): shown only when the host actually has SLURM, so the
            toggle never appears off-cluster. Badged with the live queue count. */}
        {!activeBox && slurmSupported && projectId && (
          <button
            className={`tab-add-btn right-panel-orange-btn${view === "jobs" ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            aria-pressed={view === "jobs"}
            onClick={() => setView((v) => (v === "jobs" ? "files" : "jobs"))}
            title={t("projectFilesView.slurmJobsTitle", { count: jobRows.length })}
          >
            ⚙ {jobRows.length > 0 && <span className="right-panel-orange-count">{jobRows.length}</span>}
          </button>
        )}
        {importDrop.canImport && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setImportMenu({ x: r.left, y: r.bottom + 2 });
            }}
            title={t("projectFilesView.importTitle")}
          >
            ⬇
          </button>
        )}
        {importMenu && createPortal(
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 200 }}
              onPointerDown={() => setImportMenu(null)}
            />
            <div
              className="context-menu"
              style={{ left: importMenu.x, top: importMenu.y, zIndex: 201 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setImportMenu(null);
                  void importDrop.importViaDialog();
                }}
              >
                {t("projectFilesView.importFiles")}
              </button>
              <button
                onClick={() => {
                  setImportMenu(null);
                  void importDrop.importFolderViaDialog();
                }}
              >
                {t("projectFilesView.importFolder")}
              </button>
            </div>
          </>,
          document.body,
        )}
        {projectDir && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={openInOsBrowser}
            title={t("projectFilesView.openInFileManagerTitle")}
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
            title={t("projectFilesView.showDownloadsTitle")}
          >
            📥
          </button>
        )}
        {/* Always offered, never gated on the setting it writes: the button IS
            the way back, so hiding it whenever the group is off would leave the
            × a one-way door out of a default-on feature, reopenable only from
            the Project Settings dialog. A box's multi-root view is excluded for
            the Downloads group's reason — it has no single project below. */}
        {!activeBox && !compact && (
          <button
            className={`tab-add-btn${alertsEnabled ? " active" : ""}`}
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            aria-pressed={alertsEnabled}
            onClick={() => {
              void updateSettings({ files_alerts: !alertsEnabled });
              // The group lives in the files view; jump there when revealing it.
              if (!alertsEnabled) setView("files");
            }}
            title={t("filesAlerts.toolbarTitle")}
          >
            🔔
          </button>
        )}
        {projectId && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => setShowSettings(true)}
            title={t("projectFilesView.projectSettingsTitle")}
          >
            ⚙
          </button>
        )}
      </div>

      {/* The workspace clock. A workspace expiry does not merely delete "some
          data" — for a project whose root lives in one it deletes the host tree,
          repo included. So the warning is raised wherever the user is (every
          view, not just Jobs), states the two actions that answer it, and is
          dismissible only until the number changes. */}
      {warnExpiry && projectWs && (
        <div className={`hpc-expiry-banner tone-${expiryTone(projectWs)}`}>
          <span>
            {t("projectFilesView.expiryPre")} <strong>{projectWs.id}</strong> — {remainingLabel(projectWs)}.{" "}
            {t("projectFilesView.expiryPost")}
          </span>
          <div className="hpc-expiry-actions">
            <button type="button" onClick={() => void extendWs(projectWs)}>
              {t("projectFilesView.extendEllipsis")}
            </button>
            <button type="button" onClick={() => setView("jobs")}>
              {t("projectFilesView.workspaces")}
            </button>
            <button
              type="button"
              title={t("projectFilesView.dismissExpiryTitle")}
              onClick={() => setExpiryDismissed(`${projectWs.id}:${projectWs.remaining_days}`)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {!compact && !activeBox && gitStatus?.is_repo && (
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

      {view === "git" && (
        <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
          {nestedRoot && (
            <div className="nested-repo-toggle" role="group" aria-label={t("projectFilesView.gitRepositoryAriaLabel")}>
              <button
                type="button"
                className={`nested-repo-pill${!onNestedRepo ? " active" : ""}`}
                title={projectDir}
                onClick={() => setPreferProjectRepo(true)}
              >
                {project?.name || t("projectFilesView.projectFallback")}
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
            <div className="right-panel-orange-empty">{t("projectFilesView.noDivergedFiles")}</div>
          ) : (
            <>
              {/* Bulk "…for all" resolution: take one side for every diverged
                  file at once. Both are destructive to the losing side — and by
                  definition every file here has content on BOTH sides — so each
                  goes through the shared transfer confirmation, which names the
                  losing files rather than only counting them. Header + icon
                  buttons (not a text button per row) so the bar stays compact. */}
              <div className="orange-bulk-bar">
                <span className="orange-bulk-count">
                  {t("projectFilesView.divergedCount", { count: orangeFiles.length })}
                </span>
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--remote"
                    aria-label={t("projectFilesView.takeRemoteAllAria")}
                    title={t("projectFilesView.takeRemoteAllTitle")}
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "pull",
                          relPath: "",
                          isDir: true,
                          label: project?.name ?? projectId,
                          relPaths: orangeFiles,
                          force: true,
                        });
                        if (!ok) return;
                        await useSyncStore
                          .getState()
                          .resolveAll(projectId, orangeFiles, "host");
                      })();
                    }}
                  >
                    ⬇
                  </button>
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--local"
                    aria-label={t("projectFilesView.keepLocalAllAria")}
                    title={t("projectFilesView.keepLocalAllTitle")}
                    disabled={remoteBlocked}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "push",
                          relPath: "",
                          isDir: true,
                          label: project?.name ?? projectId,
                          relPaths: orangeFiles,
                          force: true,
                        });
                        if (!ok) return;
                        await useSyncStore
                          .getState()
                          .resolveAll(projectId, orangeFiles, "local");
                      })();
                    }}
                  >
                    ⬆
                  </button>
                </div>
              </div>
              {orangeFiles.map((rel) => {
                const rowHostMtime = syncMap?.[rel]?.hostMtime;
                const rowLocalMtime = syncMap?.[rel]?.localMtime;
                const mtimeCue = mtimeDivergenceCue(t, rowHostMtime, rowLocalMtime);
                // "Remote only" / "Local only": the other side has no file at
                // all, so the action that would act on it is a no-op — disable
                // it rather than leave a button that errors when clicked.
                const noHostFile = rowHostMtime == null;
                const noLocalFile = rowLocalMtime == null;
                return (
                  <div key={rel} className="orange-file-row" title={rel}>
                <button
                  type="button"
                  className="orange-file-name"
                  disabled={!mirrorRoot}
                  title={mirrorRoot ? t("projectFilesView.openFileTitle", { rel }) : rel}
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
                {mtimeCue && (
                  <span
                    className={`orange-mtime-badge orange-mtime-badge--${mtimeCue.tone}`}
                    title={mtimeCue.title}
                  >
                    {mtimeCue.text}
                  </span>
                )}
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--remote"
                    aria-label={t("projectFilesView.takeRemoteAria")}
                    title={t(noHostFile ? "projectFilesView.noRemoteCopyTitle" : "projectFilesView.takeRemoteTitle")}
                    disabled={remoteBlocked || noHostFile}
                    // Per-row take-a-side: the other side's copy of this file is
                    // gone the moment it runs, and this row exists precisely
                    // because both sides hold something. Ask, naming the file.
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "pull",
                          relPath: rel,
                          isDir: false,
                          label: basename(rel) || rel,
                          force: true,
                        });
                        if (ok) await useSyncStore.getState().pull(projectId, rel);
                      })();
                    }}
                  >
                    ⬇
                  </button>
                  <button
                    type="button"
                    className="orange-file-act orange-file-act--icon orange-file-act--local"
                    aria-label={t("projectFilesView.keepLocalAria")}
                    title={t(noLocalFile ? "projectFilesView.noLocalCopyTitle" : "projectFilesView.keepLocalTitle")}
                    disabled={remoteBlocked || noLocalFile}
                    onClick={() => {
                      if (!projectId) return;
                      void (async () => {
                        const ok = await confirmSyncTransfer({
                          projectId,
                          direction: "push",
                          relPath: rel,
                          isDir: false,
                          label: basename(rel) || rel,
                          force: true,
                        });
                        if (ok) await useSyncStore.getState().push(projectId, rel, true);
                      })();
                    }}
                  >
                    ⬆
                  </button>
                </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {view === "sessions" && (
        <div className="right-panel-scroll right-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          {!remoteBlocked && (
            <label
              className="tmux-scope-toggle"
              title={t("projectFilesView.tmuxScopeOff") + t("projectFilesView.tmuxScopeOn")}
            >
              <input
                type="checkbox"
                checked={showAllSessions}
                onChange={(e) => setShowAllSessions(e.target.checked)}
              />
              {t("projectFilesView.allHostSessions")}
            </label>
          )}
          {sessionRows.length === 0 ? (
            <div className="right-panel-orange-empty">
              {t(
                remoteBlocked
                  ? "projectFilesView.connectToListSessions"
                  : showAllSessions
                    ? "projectFilesView.noSessionsOnHosts"
                    : "projectFilesView.noSessionsForProject",
              )}
            </div>
          ) : (
            sessionGroups.map(({ hostId, hostLabel, rows }) => (
              <section
                className="tmux-machine-group"
                key={hostId}
                aria-label={t("projectFilesView.persistentSessionsOnHostAria", { host: hostLabel })}
              >
                <div className="tmux-machine-group-title">{hostLabel}</div>
                {rows.map(({ session: s }) => {
                  const owned = sessionOwners.has(`${hostId} ${s.name}`);
                  return (
                    <div
                      key={`${hostId} ${s.name}`}
                      className="orange-file-row"
                      onMouseEnter={(e) => handleSessionRowMouseEnter(e, hostId, s.name)}
                      onMouseLeave={handleSessionRowMouseLeave}
                    >
                      <button
                        type="button"
                        className="orange-file-name"
                        title={t(
                          owned ? "projectFilesView.revealTabRunning" : "projectFilesView.attachTo",
                          { name: s.name },
                        )}
                        onClick={() => openSession(hostId, s.name)}
                      >
                        <span className="orange-file-dot" aria-hidden="true">
                          {s.attached ? "●" : "○"}
                        </span>
                        {s.working && (
                          <span className="tmux-work-dot" aria-hidden="true" title={t("projectFilesView.workingTitle")} />
                        )}
                        <span className="tmux-session-label">{sessionDisplayName(t, s.name)}</span>
                        {owned && <span className="tmux-session-meta">{t("projectFilesView.openMeta")}</span>}
                      </button>
                      <div className="orange-file-actions">
                        <button
                          type="button"
                          className="orange-file-act"
                          title={t("projectFilesView.renameSessionTitle")}
                          onClick={() => renameSession(hostId, s.name)}
                        >
                          {t("projectFilesView.rename")}
                        </button>
                        <button
                          type="button"
                          className="orange-file-act"
                          title={t("projectFilesView.killSessionTitle")}
                          aria-label={t("projectFilesView.killSessionAria", { name: s.name })}
                          onClick={() => killSession(hostId, s.name)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>
      )}
      {sessionTooltip && (() => {
        const statsRow = sessionRows.find(
          (r) => r.hostId === sessionTooltip.hostId && r.session.name === sessionTooltip.name,
        );
        if (!statsRow) return null;
        const s = statsRow.session;
        const owned = sessionOwners.has(`${statsRow.hostId} ${s.name}`);
        // Same side-picking + vertical-shift positioning as FileTree's `.file-tooltip`:
        // opens toward whichever side of the row has more room, and is pulled up if
        // it would otherwise overflow the window's bottom edge.
        const style: React.CSSProperties =
          window.innerWidth - sessionTooltip.rect.right > sessionTooltip.rect.left
            ? { left: sessionTooltip.rect.right + 8, top: sessionTooltip.rect.top - sessionTooltipShift }
            : { right: window.innerWidth - sessionTooltip.rect.left + 8, top: sessionTooltip.rect.top - sessionTooltipShift };
        return createPortal(
          <div ref={sessionTooltipRef} className="file-tooltip" style={style}>
            <div className="file-tooltip-name">
              {s.name}
              <UntestedTag />
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipHost")}</span>
              {statsRow.hostLabel}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipStatus")}</span>
              {s.working
                ? t("projectFilesView.tooltipWorking", { command: s.currentCommand })
                : t("projectFilesView.tooltipIdle")}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipUptime")}</span>
              {t("projectFilesView.tooltipSince", {
                duration: relativeDuration(s.created),
                when: absoluteTime(s.created),
              })}
            </div>
            <div>
              <span className="file-tooltip-label">
                {t(s.working ? "projectFilesView.tooltipActive" : "projectFilesView.tooltipIdleFor")}
              </span>
              {s.working ? t("projectFilesView.tooltipNow") : relativeDuration(s.activity)}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipWindows")}</span>
              {s.windows}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipAttached")}</span>
              {t(s.attached ? "common.yes" : "common.no")}
            </div>
            <div>
              <span className="file-tooltip-label">{t("projectFilesView.tooltipOpenInTab")}</span>
              {t(owned ? "common.yes" : "common.no")}
            </div>
          </div>,
          document.body,
        );
      })()}

      {view === "jobs" && (
        <div className="right-panel-scroll right-panel-orange" style={{ flex: 1, overflowY: "auto" }}>
          <div className="right-panel-jobs-head">
            <UntestedTag />
          </div>
          {wsRows.length > 0 && (
            <>
              <div className="right-panel-orange-note">
                {t("projectFilesView.workspacesNote")}
                {project?.hpc?.logs_dir && (
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.pullLogsTitle", { dir: project.hpc.logs_dir })}
                    onClick={() => void pullProjectLogs()}
                  >
                    {t("projectFilesView.pullLogs")}
                  </button>
                )}
              </div>
              {wsRows.map((ws) => {
                const here = projectWs?.id === ws.id && projectWs?.path === ws.path;
                return (
                  <div key={`${ws.filesystem ?? ""}/${ws.id}`} className="orange-file-row" title={ws.path}>
                    <span className="orange-file-name" style={{ cursor: "default" }}>
                      <span className="orange-file-dot" aria-hidden="true">{here ? "●" : "○"}</span>
                      {ws.id}
                      <span className={`tmux-session-meta hpc-ws-remaining tone-${expiryTone(ws)}`}>
                        {[
                          here ? t("projectFilesView.thisProject") : "",
                          ws.filesystem ?? "",
                          remainingLabel(ws),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <div className="orange-file-actions">
                      <button
                        type="button"
                        className="orange-file-act"
                        title={t("projectFilesView.extendWorkspaceTitle")}
                        onClick={() => void extendWs(ws)}
                      >
                        {t("projectFilesView.extend")}
                      </button>
                      {!here && project?.remote && (
                        <button
                          type="button"
                          className="orange-file-act"
                          disabled={wsBusy}
                          title={t("projectFilesView.moveHereTitle")}
                          onClick={() => void moveProjectTo(ws)}
                        >
                          {t("projectFilesView.moveHere")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {jobRows.length === 0 ? (
            <div className="right-panel-orange-empty">
              {t(
                remoteBlocked
                  ? "projectFilesView.connectToListJobs"
                  : "projectFilesView.noQueuedJobs",
              )}
            </div>
          ) : (
            jobRows.map((j) => (
              <div key={j.id} className="orange-file-row" title={`${j.id} ${j.name}`}>
                <button
                  type="button"
                  className="orange-file-name"
                  title={t("projectFilesView.watchJobTitle", { id: j.id })}
                  onClick={() => void watchJob(j.id, j.name)}
                >
                  <span className="orange-file-dot" aria-hidden="true">
                    {j.state === "RUNNING" ? "●" : "○"}
                  </span>
                  {j.name || j.id}
                  <span className="tmux-session-meta">
                    {j.id} · {j.state}
                    {j.time ? ` · ${j.time}` : ""}
                    {j.nodes ? ` · ${j.nodes} node${j.nodes === "1" ? "" : "s"}` : ""}
                    {j.reason && j.reason !== "(None)" ? ` · ${j.reason}` : ""}
                  </span>
                </button>
                <div className="orange-file-actions">
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.watchJobTitle", { id: j.id })}
                    onClick={() => void watchJob(j.id, j.name)}
                  >
                    {t("projectFilesView.watch")}
                  </button>
                  <button
                    type="button"
                    className="orange-file-act"
                    title={t("projectFilesView.cancelJobTitle")}
                    aria-label={t("projectFilesView.cancelJobAria", { id: j.id })}
                    onClick={() => cancelJob(j.id, j.name)}
                  >
                    ×
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
          project={project}
          projectDir={projectDir}
          folder={folder}
          onFolderChange={onFolderChange}
          source={source}
          hiddenEndings={filters.hiddenEndings}
          hiddenPaths={filters.hiddenPaths}
          shownPaths={filters.shownPaths}
          scanExcluded={filters.scanExcluded}
          onToggleScanExcluded={filters.toggleScanExcluded}
          sortKey={sortKey}
          descending={descending}
          onSortChange={(key, desc) => {
            setSortKey(key);
            setDescending(desc);
          }}
          showDownloads={showDownloads}
          onCloseDownloads={() => setShowDownloads(false)}
          showAlerts={alertsHere}
          onCloseAlerts={() => void updateSettings({ files_alerts: false })}
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
            <div className="file-tree-empty">{t("projectFilesView.noOpenedWindows")}</div>
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
                  title={t("projectFilesView.untrackTitle")}
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
