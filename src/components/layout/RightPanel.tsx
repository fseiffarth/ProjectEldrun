import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileTree } from "../files/FileTree";
import { DownloadsSection } from "../files/DownloadsSection";
import { GitHistory } from "../files/GitHistory";
import { GitChangeTree, type ChangeScope } from "../files/GitChangeTree";
import { SearchPanel } from "../files/SearchPanel";
import { Dropdown } from "../common/Dropdown";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore, amberPaths } from "../../stores/sync";
import { openLinkedFile } from "../embed/FileViewerPane";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { useWindowsStore } from "../../stores/windows";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, orderedTabKeys } from "../../stores/tabs";
import { BOX_SCOPE_PREFIX, boxScopeId, useBoxesStore } from "../../stores/boxes";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { useGitDirtyStore, gitDirtyState } from "../../stores/gitDirty";
import { type SortKey, VIEWER_PREF_TYPES } from "../../lib/viewers/fileUtils";
import { basename, dirname, fromFileUri } from "../../lib/paths";
import type { ViewerPref } from "../../types";
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
type ProjectJson = Record<string, unknown>;

const PANEL_HIDDEN_ENDINGS_KEY = "panel_hidden_endings";
const PANEL_HIDDEN_PATHS_KEY = "panel_hidden_paths";
const PANEL_SHOWN_PATHS_KEY = "panel_shown_paths";

function readHiddenEndings(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_HIDDEN_ENDINGS_KEY);
}

function readHiddenPaths(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_HIDDEN_PATHS_KEY);
}

function readShownPaths(project: ProjectJson | null): string[] {
  return readStringList(project, PANEL_SHOWN_PATHS_KEY);
}

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

type ConflictChoice = "replace" | "rename" | "skip";

/** Heuristic: is this drag an external OS file drag (vs. an internal pill/text
 *  drag)? `dragDropEnabled` stays false so HTML5 DnD keeps working for the
 *  app's pointer/HTML drags; an OS file drag advertises Files/uri-list/html
 *  (WebKitGTK uses text/html here). During dragover WebKit may hide the type
 *  list, so an empty list is treated as a file drag too. */
function isExternalFileDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  if (types.length === 0) return true;
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html")
  );
}

/** Convert one `file://` URI to an absolute local path (decoding `%20` etc.).
 * Delegates to the shared OS-aware helper, including UNC authorities. */
function fileUriToPath(uri: string): string | null {
  return fromFileUri(uri);
}

/** Extract absolute local paths from an OS HTML5 file drop. WebKitGTK withholds
 *  `Files`/`text/uri-list` data here but leaks the `file://` URL inside
 *  `text/html`, so scan every text payload for `file://` URIs and dedupe.
 *  NOTE: this drag path is best-effort — some file managers only expose ONE
 *  file this way. Use the Import button for reliable multi-file selection. */
function parseDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const sources = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
    dataTransfer.getData("text/html"),
  ];
  const FILE_URI = /file:\/\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    for (const match of raw.match(FILE_URI) ?? []) {
      const p = fileUriToPath(match);
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

function mergeEndings(...groups: string[][]): string[] {
  const endings = new Map<string, string>();
  for (const group of groups) {
    for (const ending of group) {
      const trimmed = ending.trim();
      if (!trimmed) continue;
      endings.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...endings.values()].sort((a, b) => a.localeCompare(b));
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
}: {
  rootId: string;
  label: string;
  icon: string;
  dir: string;
  localFile?: string;
  variant: "box" | "member";
  sortKey: SortKey;
  descending: boolean;
}) {
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
        <span className="file-root-kind">{variant === "box" ? "box" : "project"}</span>
      </button>
      {!collapsed && (
        <div className="file-root-body">
          <FileTree
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
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [view, setView] = useState<View>("files");
  // SSH-sync Phase 1: which side of a remote project the files view shows — the
  // host (remote, SFTP-listed, with the sync overlay) or the local mirror.
  const [fileSource, setFileSource] = useState<"remote" | "local">("remote");
  const [dropActive, setDropActive] = useState(false);
  const [dropFlash, setDropFlash] = useState(false);
  const [conflict, setConflict] = useState<
    { name: string; remaining: number; resolve: (r: { choice: ConflictChoice; all: boolean }) => void } | null
  >(null);
  const [conflictAll, setConflictAll] = useState(false);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Toggles the Downloads section stacked below the file tree (fast-copy of
  // recent downloads into the project). Toolbar ⬇⬇ button; files view only.
  const [showDownloads, setShowDownloads] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [localProjectSettings, setLocalProjectSettings] = useState<ProjectJson | null>(null);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [availableEndings, setAvailableEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);

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
      if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
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
  const remoteSshState = useRemoteStatusStore((s) =>
    activeId ? s.byProject[activeId]?.ssh : undefined,
  );
  const remoteBlocked = !!activeProject?.remote && remoteSshState !== "connected";
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

  // Default the file source to whichever side is actually usable when a remote
  // project becomes active: connected → Remote (the host tree), disconnected →
  // Local (the mirror, so the panel doesn't open on a Connect prompt). Only
  // resets on a project switch — it never fights a mid-session manual toggle
  // (e.g. the user flips to Remote, then the connection drops: the Connect
  // placeholder below takes over, but the toggle stays put).
  useEffect(() => {
    if (activeId && activeProject?.remote) {
      setFileSource(remoteSshState === "connected" ? "remote" : "local");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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
  const unhideGroup = useTabsStore((s) => s.unhideGroup);
  const closeHiddenGroup = useTabsStore((s) => s.closeHiddenGroup);
  const [hiddenCollapsed, setHiddenCollapsed] = useState(false);
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
    const roots: {
      rootId: string;
      label: string;
      icon: string;
      dir: string;
      localFile?: string;
      variant: "box" | "member";
    }[] = [];
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

  const openInOsBrowser = () => {
    if (!projectDir) return;
    const sub = rightPanelFolder.replace(/^\/+|\/+$/g, "");
    const path = sub ? `${projectDir.replace(/\/+$/, "")}/${sub}` : projectDir;
    invoke("open_in_file_manager", { path }).catch((e) => console.error("open_in_file_manager", e));
  };

  // OS file drop → copy into the project. Confined to a single active project
  // (a box scope has no single destination root). Driven by Tauri's NATIVE
  // drag-drop event (dragDropEnabled=true) because WebKitGTK withholds the file
  // paths from HTML5 drops; the native event hands us every dropped path.
  const canImportDrop = !!projectDir && !activeBox;

  const flashDrop = () => {
    if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    setDropFlash(false);
    requestAnimationFrame(() => setDropFlash(true));
    dropFlashTimer.current = setTimeout(() => setDropFlash(false), 500);
  };

  // Ask the user how to resolve a name collision; resolves via the modal's
  // buttons. Returns the choice plus whether to apply it to all remaining.
  const askConflict = (name: string, remaining: number) =>
    new Promise<{ choice: ConflictChoice; all: boolean }>((resolve) => {
      setConflictAll(false);
      setConflict({ name, remaining, resolve });
    });

  // Copy each absolute source path into the project, prompting on collisions.
  const importPaths = (paths: string[]) => {
    if (!canImportDrop || !projectDir || paths.length === 0) return;
    flashDrop();
    const destRel = view === "files" ? rightPanelFolder : "";
    void (async () => {
      let blanket: ConflictChoice | null = null;
      for (let i = 0; i < paths.length; i++) {
        const sourcePath = paths[i];
        const name = basename(sourcePath) || sourcePath;
        const rel = destRel ? `${destRel}/${name}` : name;
        let choice: ConflictChoice = "rename";
        const exists = await invoke<boolean>("project_path_exists", { projectDir, relPath: rel }).catch(() => false);
        if (exists) {
          if (blanket) {
            choice = blanket;
          } else {
            const res = await askConflict(name, paths.length - 1 - i);
            setConflict(null);
            choice = res.choice;
            if (res.all) blanket = res.choice;
          }
        }
        if (choice === "skip") continue;
        try {
          await invoke("import_external_file", { projectDir, sourcePath, destRel, replace: choice === "replace" });
        } catch (err) {
          console.error("import_external_file", sourcePath, err);
        }
      }
      // FileTree auto-reloads via its fs-watch; refresh git so new untracked
      // files show in the status counts immediately.
      refreshGit(effectiveGitRoot);
    })();
  };

  // HTML5 drag-and-drop (dragDropEnabled stays false so pointer drags — tabs,
  // splits, pills — keep working). Best-effort: WebKitGTK only leaks file paths
  // via text/html and sometimes just one; the Import button is the reliable
  // multi-file path.
  const handleImportDragOver = (e: React.DragEvent) => {
    if (!canImportDrop || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const handleImportDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const handleImportDrop = (e: React.DragEvent) => {
    setDropActive(false);
    if (!canImportDrop || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    importPaths(parseDroppedFilePaths(e.dataTransfer));
  };

  // Reliable multi-file import: native OS file picker → same copy+conflict flow.
  const importViaDialog = async () => {
    if (!canImportDrop) return;
    const picked = await openDialog({ multiple: true, directory: false }).catch(() => null);
    if (!picked) return;
    importPaths(Array.isArray(picked) ? picked : [picked]);
  };

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

  useEffect(() => {
    setShowSettings(false);
    setSettingsError(null);
    if (!localFile || !projectDir) {
      setLocalProjectSettings(null);
      setHiddenEndings([]);
      setAvailableEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      return;
    }
    // `list_project_endings` scans the project dir over SFTP for a remote project —
    // skip it while disconnected (would freeze the main thread). `load_project`
    // reads the LOCAL project.json, so it's always safe to run.
    Promise.all([
      invoke<ProjectJson>("load_project", { localFile }),
      remoteBlocked
        ? Promise.resolve<string[]>([])
        : invoke<string[]>("list_project_endings", { projectDir }).catch(() => []),
    ])
      .then(([project, endings]) => {
        const savedHiddenEndings = readHiddenEndings(project);
        const savedHiddenPaths = readHiddenPaths(project);
        const savedShownPaths = readShownPaths(project);
        const allEndings = mergeEndings(endings, savedHiddenEndings);
        setLocalProjectSettings(project);
        setHiddenEndings(savedHiddenEndings);
        setAvailableEndings(allEndings);
        setHiddenPaths(savedHiddenPaths);
        setShownPaths(savedShownPaths);
      })
      .catch((error) => {
        setLocalProjectSettings(null);
        setHiddenEndings([]);
        setAvailableEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
        setSettingsError(String(error));
      });
  }, [localFile, projectDir, remoteBlocked]);

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

  const saveHiddenEndings = async (nextEndings: string[]) => {
    if (!localFile || !localProjectSettings) return;
    const nextProject = {
      ...localProjectSettings,
      [PANEL_HIDDEN_ENDINGS_KEY]: nextEndings,
      [PANEL_HIDDEN_PATHS_KEY]: hiddenPaths,
      [PANEL_SHOWN_PATHS_KEY]: shownPaths,
    };
    setHiddenEndings(nextEndings);
    setLocalProjectSettings(nextProject);
    setSettingsError(null);
    try {
      await invoke("save_project", { localFile, project: nextProject });
    } catch (e) {
      setSettingsError(String(e));
    }
  };

  const toggleHiddenEnding = (ending: string, checked: boolean) => {
    const existing = new Set(hiddenEndings.map((item) => item.toLowerCase()));
    const nextEndings = checked
      ? existing.has(ending.toLowerCase())
        ? hiddenEndings
        : [...hiddenEndings, ending]
      : hiddenEndings.filter((item) => item.toLowerCase() !== ending.toLowerCase());
    void saveHiddenEndings(nextEndings);
  };

  return (
    <div
      className={`right-panel ${open ? "open" : ""}${dropActive ? " drop-active" : ""}${dropFlash ? " drop-flash" : ""}${resizing ? " resizing" : ""}`}
      style={width ? { width } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDragEnter={handleImportDragOver}
      onDragOver={handleImportDragOver}
      onDragLeave={handleImportDragLeave}
      onDrop={handleImportDrop}
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
      {conflict && createPortal(
        <div
          className="modal-backdrop"
          onMouseDown={() => conflict.resolve({ choice: "skip", all: conflictAll })}
        >
          <div className="settings-dialog" style={{ maxWidth: 380 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="settings-title-row">
              <h2>File already exists</h2>
            </div>
            <p className="settings-help" style={{ wordBreak: "break-all" }}>
              <code>{conflict.name}</code> already exists in this folder. Replace it, or keep both (the new copy is renamed)?
            </p>
            {conflict.remaining > 0 && (
              <label className="viewer-pref-toggle" style={{ marginBottom: 8 }}>
                <Toggle
                  size="sm"
                  checked={conflictAll}
                  onChange={(e) => setConflictAll(e.target.checked)}
                />
                <span>Apply to the {conflict.remaining} remaining file{conflict.remaining > 1 ? "s" : ""}</span>
              </label>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "skip", all: conflictAll })}>
                Skip
              </button>
              <button className="tab-add-btn" onClick={() => conflict.resolve({ choice: "rename", all: conflictAll })}>
                Keep both
              </button>
              <button
                className="tab-add-btn"
                style={{ color: "var(--danger, #f85149)" }}
                onClick={() => conflict.resolve({ choice: "replace", all: conflictAll })}
              >
                Replace
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
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
          <span className="right-panel-source-switch" role="group" aria-label="File source">
            <button
              type="button"
              className={`source-seg${fileSource === "local" ? " active" : ""}`}
              aria-pressed={fileSource === "local"}
              onClick={() => setFileSource("local")}
              title="Show the local synced mirror copy."
            >
              Local
            </button>
            <button
              type="button"
              className={`source-seg${fileSource === "remote" ? " active" : ""}`}
              aria-pressed={fileSource === "remote"}
              onClick={() => setFileSource("remote")}
              title="Show the host tree over SFTP (remote)."
            >
              Remote
            </button>
          </span>
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
          </button>
          {!hiddenCollapsed && (
            <div className="hidden-sw-list">
              {hiddenGroups.map((h) => {
                const keys = orderedTabKeys(h.subtree);
                return (
                  <div key={h.id} className="hidden-sw-row">
                    <span className="hidden-sw-icon">⊞</span>
                    <div className="hidden-sw-chips">
                      {keys.map((k) => {
                        const label = scopeTabs?.find((t) => t.key === k)?.label ?? k;
                        return (
                          <button
                            key={k}
                            type="button"
                            className="hidden-sw-chip"
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
        {canImportDrop && (
          <button
            className="tab-add-btn"
            style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: 2 }}
            onClick={() => void importViaDialog()}
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
        <>
          {/* The Remote/Local toggle now lives in the header (right of the project
              name); this row carries the whole-tree sync action for the active
              source: Remote → pull the host tree into the mirror; Local → push the
              mirror back to the host (skipping host-diverged/orange files). Both
              need a live connection, so the row is gated on !remoteBlocked. */}
          {!activeBox && activeProject?.remote && activeId && !remoteBlocked && (
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
                      void useSyncStore.getState().setAuto(activeId, [""], !autoAll, true)
                    }
                    title={
                      autoAll
                        ? "Auto-syncing the whole project (⟳). Click to stop. Individual files/folders can still be excluded or included from their right-click menu."
                        : "Auto-sync the whole project bidirectionally (host ⇄ local mirror). Diverged files are left for manual resolution; per-file/folder toggles override this."
                    }
                  >
                    {autoAll ? "⟳ Auto-sync: all" : "Auto-sync all"}
                  </button>
                );
              })()}
              {fileSource === "remote" ? (
                <button
                  className="tab-add-btn"
                  style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: "auto" }}
                  onClick={() => void useSyncStore.getState().syncWholeProject(activeId)}
                  title="Sync the whole project tree into the local mirror (remote → local)"
                >
                  Sync all
                </button>
              ) : (
                <button
                  className="tab-add-btn"
                  style={{ fontSize: 10, padding: "1px 6px", height: 20, marginLeft: "auto" }}
                  onClick={() => void useSyncStore.getState().pushWholeProject(activeId)}
                  title="Push the whole local mirror to the host (local → remote). Files that diverged on the host (orange) are skipped, never overwritten."
                >
                  Sync all
                </button>
              )}
            </div>
          )}
          <div className="right-panel-sort">
            {(["name", "size", "type", "created", "modified"] as SortKey[]).map((key) => (
              <button
                key={key}
                className={`sort-key-btn${sortKey === key ? " active" : ""}`}
                onClick={() => sortKey === key ? setDescending((d) => !d) : setSortKey(key)}
                title={sortKey === key ? (descending ? "Descending — click to reverse" : "Ascending — click to reverse") : `Sort by ${key}`}
              >
                {key}{sortKey === key ? (descending ? " ↓" : " ↑") : ""}
              </button>
            ))}
          </div>
          <div className="right-panel-scroll" style={{ flex: 1, overflowY: "auto" }}>
            {open && activeBox ? (
              boxRoots.length === 0 ? (
                <div className="file-tree-empty">No member project folders</div>
              ) : (
                boxRoots.map((r) => (
                  <BoxRootSection
                    key={r.rootId}
                    rootId={r.rootId}
                    label={r.label}
                    icon={r.icon}
                    dir={r.dir}
                    localFile={r.localFile}
                    variant={r.variant}
                    sortKey={sortKey}
                    descending={descending}
                  />
                ))
              )
            ) : (
              open && (() => {
                // SSH-sync Phase 1: a remote project's "Local" source points the
                // tree at the local mirror dir (browsed as a plain local tree);
                // "Remote" keeps the host (SFTP) tree with the sync overlay. A
                // local project ignores the toggle entirely.
                const isRemoteProject = !!activeProject?.remote;
                // Disconnected remote source: don't mount the SFTP-backed tree
                // (its main-thread list_dir would freeze the window). Keep the
                // panel looking the same — the Remote/Local toggle stays up — but
                // show a Connect prompt in the tree area. Selecting "Local" still
                // browses the offline mirror. The whole-window freeze rationale
                // lives on `remoteBlocked` above.
                if (isRemoteProject && fileSource === "remote" && remoteBlocked) {
                  return (
                    <div className="file-tree-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                      <div>
                        {remoteSshState === "connecting"
                          ? "Connecting to the remote host…"
                          : "Disconnected — connect to browse the remote tree."}
                      </div>
                      {remoteSshState !== "connecting" && activeId && (
                        <button
                          type="button"
                          className="dialog-connect-btn"
                          onClick={() => useConnectDialogStore.getState().open(activeId)}
                        >
                          Connect
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
                  resolveLocalMirror(activeProject) ??
                  (projectDir
                    ? `${projectDir.replace(/[/\\]+$/, "")}/mirror`
                    : projectDir);
                const treeDir =
                  isRemoteProject && fileSource === "local" ? mirrorDir : projectDir;
                return (
                  <FileTree
                    projectDir={treeDir}
                    projectId={activeId}
                    localFile={localFile}
                    sortKey={sortKey}
                    descending={descending}
                    hiddenEndings={hiddenEndings}
                    hiddenPaths={hiddenPaths}
                    shownPaths={shownPaths}
                    initialRelPath={rightPanelFolder}
                    onRelPathChange={(folder) => {
                      if (activeId) setRightPanelFolder(activeId, folder);
                    }}
                    syncSource={isRemoteProject ? fileSource : undefined}
                  />
                );
              })()
            )}
          </div>
          {showDownloads && !activeBox && projectDir && (
            <DownloadsSection
              projectDir={projectDir}
              projectId={activeId}
              targetFolder={rightPanelFolder}
              isRemote={!!activeProject?.remote}
              onClose={() => setShowDownloads(false)}
            />
          )}
        </>
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
      {showSettings && activeProject && localFile && createPortal(
        <div className="modal-backdrop settings-backdrop" onMouseDown={() => setShowSettings(false)}>
          <div className="settings-dialog project-settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="settings-title-row">
              <h2>Project Settings</h2>
              <button type="button" className="dialog-close-btn" onClick={() => setShowSettings(false)}>×</button>
            </div>

            <div className="settings-section-title">Panel File Hiding</div>
            <p className="settings-help">
              Click an ending to hide matching files in the right panel. Dimmed endings are hidden.
            </p>
            {availableEndings.length === 0 ? (
              <div className="settings-empty">No file endings found in this project.</div>
            ) : (
              <div className="settings-list project-ending-list">
                {availableEndings.map((ending) => {
                  const checked = hiddenEndings.some((item) => item.toLowerCase() === ending.toLowerCase());
                  return (
                    <button
                      type="button"
                      className={`project-ending-toggle${checked ? " is-hidden" : ""}`}
                      key={ending}
                      aria-pressed={checked}
                      onClick={() => toggleHiddenEnding(ending, !checked)}
                      title={checked ? `Show ${ending} files` : `Hide ${ending} files`}
                    >
                      {ending}
                    </button>
                  );
                })}
              </div>
            )}
            {settingsError && <div className="settings-error">{settingsError}</div>}

            {/* #48 per-file-type native-viewer settings (global, not per-project).
                Toggles opt-in local autocomplete (#45) per type, plus the global
                autosave (#47). */}
            <div className="settings-section-title">Native Viewers</div>
            <p className="settings-help">
              Eldrun renders these file types in-app. Disable a type to open its
              files in your external default app instead. Autocomplete is
              local-only (Ollama) and opt-in.
            </p>
            <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
              <Toggle
                size="sm"
                checked={settings?.autosave !== false}
                onChange={(e) => void updateSettings({ autosave: e.target.checked })}
              />
              <span>Autosave edits</span>
            </label>
            <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
              <Toggle
                size="sm"
                checked={settings?.change_tint !== false}
                onChange={(e) => void updateSettings({ change_tint: e.target.checked })}
              />
              <span>Highlight recent edits (new→old colour trail)</span>
            </label>
            <div className="viewer-prefs-list">
              {VIEWER_PREF_TYPES.map((t) => {
                const pref: ViewerPref = settings?.viewer_prefs?.[t.id] ?? {};
                const enabled = pref.enabled !== false;
                const patch = (next: ViewerPref) =>
                  void updateSettings({
                    viewer_prefs: {
                      ...(settings?.viewer_prefs ?? {}),
                      [t.id]: { ...pref, ...next },
                    },
                  });
                return (
                  <div className="viewer-pref-row" key={t.id}>
                    <span className="viewer-pref-name">{t.label}</span>
                    <span className="viewer-pref-exts">{t.extensions.join(" ")}</span>
                    <label className="viewer-pref-toggle">
                      <Toggle
                        size="sm"
                        checked={enabled}
                        onChange={(e) => patch({ enabled: e.target.checked })}
                      />
                      <span>Enabled</span>
                    </label>
                    {t.autocomplete && (
                      <>
                        <label className="viewer-pref-toggle">
                          <Toggle
                            size="sm"
                            checked={pref.autocomplete === true}
                            disabled={!enabled}
                            onChange={(e) => patch({ autocomplete: e.target.checked })}
                          />
                          <span>Autocomplete</span>
                        </label>
                        {/* #45 default completion-length mode; toggled live
                            in-editor with Shift+Tab while a suggestion shows. */}
                        <Dropdown
                          className="viewer-pref-mode"
                          value={pref.autocomplete_mode ?? "sentence"}
                          disabled={!enabled || pref.autocomplete !== true}
                          title="Default completion length (toggle live with Shift+Tab)"
                          onChange={(v) =>
                            patch({ autocomplete_mode: v as ViewerPref["autocomplete_mode"] })
                          }
                          options={[
                            { value: "sentence", label: "Sentence" },
                            { value: "block", label: "Block" },
                            { value: "scope", label: "Scope" },
                          ]}
                        />
                        {/* Local-model grammar/spelling check — underlines typos
                            (red), grammar (blue), style (green) in the editor. */}
                        <label className="viewer-pref-toggle">
                          <Toggle
                            size="sm"
                            checked={pref.grammar_check === true}
                            disabled={!enabled}
                            onChange={(e) => patch({ grammar_check: e.target.checked })}
                          />
                          <span>Grammar</span>
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {settings?.debug && (
              <>
                <div className="settings-section-title">Debug</div>
                <button
                  className="tab-add-btn"
                  style={{ fontSize: 11, padding: "2px 8px", width: "100%", color: "var(--danger, #f85149)" }}
                  onClick={() => {
                    invoke("clear_project_session", { localFile }).then(() => {
                      window.location.reload();
                    }).catch(console.error);
                  }}
                >
                  Clear session storage
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
