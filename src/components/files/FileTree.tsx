import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useTabsStore } from "../../stores/tabs";
import { useDragStore, type EmbedCap, type FileDragItem } from "../../stores/drag";
import { commitFileDrop, fileDropGoesToNewWindow } from "../tabs/commitFileDrop";
import { startDetachedDropSession } from "../tabs/detachedDropTargets";
import { FileDropContext } from "./fileDropContext";
import { openFileEntry } from "./openFileEntry";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import {
  startCursorPoll,
  desktopCursor,
  snapshotFrame,
  physToClient,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/coords";
import { bindDragRelease, dragPlatform, PLATFORM } from "../../lib/dragPlatform";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore, type SyncFileState } from "../../stores/sync";
import { useActivityStore } from "../../stores/activity";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import { type FileEntry, type InternalViewer, type SortKey, fileIcon, folderIcon, fmtSize, fmtModified, visibleEntries, internalViewerFor, disabledViewers, fileEntriesEqual, stringMapsEqual, nextSelection, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import { type TexCapability, type TexCompileResult, getTexCapability, lastLogLine } from "../../lib/viewers/tex";
import { basename, dirname, relativePathWithin, resolvePath } from "../../lib/paths";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";
import { isPythonPath, isPythonMainScript } from "../../lib/viewers/python";
import { runPythonFile, runCwd, placeForFocused } from "../../lib/pythonRun";
import {
  shellRunnerFor,
  shellScriptRunPlan,
  type ScriptShell,
} from "../../lib/shellScriptRun";
import { readFileText } from "../embed/fileAccess";
import { SetDefaultAppDialog } from "./SetDefaultAppDialog";
import { normalizeScanPath } from "./ProjectFilesSettings";
import { FileTreeSearch } from "./FileTreeSearch";
import { useClampToViewport } from "../../hooks/useClampToViewport";

// Persist whether the collapsed "gitignored" files section is expanded, so the
// choice survives right-panel hide/show and remounts (FileTree remounts each
// time the panel reopens). Mirrors GitHistory's localStorage view pref.
const GITIGNORED_EXPANDED_KEY = "eldrun.fileTree.gitignoredExpanded";

// A stable empty-object fallback for the `python_run_args` selector below — a
// fresh `{}` literal on every render would change the snapshot's reference
// identity each time, which `useSyncExternalStore` (what the store hook is
// built on) reads as "changed" and re-renders forever.
const EMPTY_PY_ARGS: Record<string, string> = {};

function sizeCategory(bytes: number): string {
  if (bytes < 10 * 1024) return "size-small";
  if (bytes < 500 * 1024) return "size-medium";
  if (bytes < 10 * 1024 * 1024) return "size-large";
  return "size-huge";
}

/** Hover title for a non-ignored size figure: the total + ignored split when
 *  there's ignored content to split out, else the plain fallback wording. */
function sizeTitle(shown: number, ignored: number, fallback: string): string {
  return ignored > 0 ? `${fmtSize(shown + ignored)} total — ${fmtSize(ignored)} git-ignored` : fallback;
}

interface Props {
  projectDir: string;
  projectId: string | null;
  /** Path to the project's project.json; enables the project-scoped default app. */
  localFile?: string | null;
  sortKey?: SortKey;
  descending?: boolean;
  hiddenEndings?: string[];
  hiddenPaths?: string[];
  shownPaths?: string[];
  /** Folders excluded from every recursive scan (`scan_excluded_paths` in
   *  project.json). They still LIST — only their size walk is skipped — so the
   *  exclusion stays visible and reversible on the row it applies to. */
  scanExcluded?: string[];
  /** When given, folder rows offer "Exclude from scans" / "Include in scans". */
  onToggleScanExcluded?: (relPath: string, excluded: boolean) => void;
  initialRelPath?: string | null;
  onRelPathChange?: (relPath: string) => void;
  /** When given, the context menu offers "Open in a new tab" — on a folder, and
   *  on the background for the folder currently browsed. The host decides what
   *  that tab is (a Files (Project) tab) and which scope it lands in; a tree with
   *  no way to own a tab (a box root, a detached window) simply omits this. */
  onOpenFolderTab?: (relPath: string) => void;
  /** SSH-sync Phase 1: which side of a remote project this tree shows. `"remote"`
   *  = the host source with the sync overlay + select-to-sync affordance; `"local"`
   *  = the local mirror (browsed/watched as a plain local tree). Absent = a normal
   *  local/remote project tree (no sync UI). */
  syncSource?: "remote" | "local";
  /** For a remote project's LOCAL-mirror view: the project's remote state dir
   *  (the one `list_dir` resolves to the host over SFTP — i.e. the pane's own
   *  `projectDir`, the parent of `mirror/`). Lets the mirror tree cheaply readdir
   *  the host for the browsed folder and flag which local-only child folders don't
   *  exist on the remote yet. Absent for a local project / the remote-source view. */
  remoteProbeDir?: string | null;
}

type GitStatusMap = Record<string, string>;
/** `rowRect` is the right-clicked row's bounding box, captured at open time, so
 *  a glowing frame can float onto it and show which entry the menu targets. */
type EntryContextMenu = {
  x: number;
  y: number;
  entry: FileEntry | null;
  rowRect: { left: number; top: number; width: number; height: number } | null;
} | null;
type DeleteConfirm = { entries: FileEntry[] } | null;
/** Open paste-rename window: `kind` is whether the source is the in-app file
 *  clipboard or a system-clipboard image (screenshot); `name` is the name being
 *  chosen for the pasted result in the current folder. */
type PastePrompt = { kind: "file" | "image"; name: string; error: string | null };
/** A folder whose auto-sync toggle would pull enough from the host to be worth
 *  confirming first (`AUTO_SYNC_WARN_*`), with what it priced. */
type AutoConfirm = { entry: FileEntry; files: number; bytes: number } | null;

/** Auto-syncing a host folder bigger than either of these asks first. They are
 *  "would you notice this landing on your disk?" thresholds, not limits — the
 *  point is that byte-sync ignores `.gitignore`, so a folder full of experiment
 *  output looks exactly like a folder full of code to it. */
const AUTO_SYNC_WARN_FILES = 200;
const AUTO_SYNC_WARN_BYTES = 100 * 1024 * 1024;

export const STATUS_COLOR: Record<string, string> = {
  modified:  "#f85149", // red – tracked, unstaged working-tree change
  untracked: "#f85149", // red – new, not yet tracked
  staged:    "#d29922", // orange – staged, not committed
  unpushed:  "#3fb950", // green – committed locally, not pushed
  ignored:   "#6e7681", // dim gray – ignored by git
};

const STATUS_TITLE: Record<string, string> = {
  modified:  "Modified — unstaged changes",
  untracked: "Untracked — not yet added",
  staged:    "Staged — not yet committed",
  unpushed:  "Committed — not yet pushed",
  ignored:   "Ignored by git",
};

/** Marker shown to the left of a tree entry for its git status.
 *  Ignored → gray ✕ glyph; everything else → a colored dot (red unstaged/
 *  untracked, orange staged, green committed-not-pushed); clean → empty slot. */
function GitMarker({ status }: { status: string | undefined }) {
  const slot: React.CSSProperties = {
    width: 11,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginRight: 3,
    fontSize: 11,
    lineHeight: 1,
  };
  if (status === "ignored") {
    return (
      <span style={{ ...slot, color: STATUS_COLOR[status] }} title={STATUS_TITLE[status]}>
        ✕
      </span>
    );
  }
  const color = status ? STATUS_COLOR[status] : undefined;
  return (
    <span style={slot} title={status ? STATUS_TITLE[status] : undefined}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color ?? "transparent" }} />
    </span>
  );
}


// Native drag-out (tauri-plugin-drag) needs the OS drag-preview icon as a base64
// PNG data URL (its icon field rejects a bare path), read synchronously inside
// the `dragstart` gesture. The backend returns that data URL; cache it
// process-wide so every file row shares one warm-up (kicked off at mount) and
// reads it without awaiting.
let dragIconDataUrl = "";
let dragIconPromise: Promise<string> | null = null;
function warmDragIcon(): Promise<string> {
  if (!dragIconPromise) {
    dragIconPromise = invoke<string>("drag_preview_icon")
      .then((p) => (dragIconDataUrl = p))
      .catch(() => "");
  }
  return dragIconPromise;
}

// TEMPORARY (Windows drag QA — remove together with every dragDbg call): mirror
// the drag/selection gesture lifecycle into crash.log via report_frontend_error
// so a failing gesture can be read back without devtools open.
function dragDbg(message: string) {
  try {
    void invoke("report_frontend_error", { kind: "drag-debug", message, stack: null }).catch(() => {});
  } catch {
    /* diagnostics must never affect the gesture */
  }
}

/** Turn a raw `list_dir` failure into a sentence a user can act on. The common
 *  case, by far, is switching a remote project's file view to "Remote" while
 *  sitting in a folder that only exists in the local mirror (never synced to the
 *  host): the backend's SFTP `open_dir` fails deep in ssh2 with text like
 *  "sftp open_dir failed: …", which means nothing to a user. Say what actually
 *  happened and what to do about it instead. */
function describeListError(e: unknown, remoteSource: boolean): string {
  const raw = String(e);
  if (remoteSource) {
    // A missing/denied directory on the host. ssh2/libssh surface this as
    // "no such file", "No such file", "failure", or a bare open_dir error.
    if (/open_dir|read_dir|no such file|not found|failure|permission/i.test(raw)) {
      return "This folder isn't on the remote host — it may be local-only (never synced). Switch to Local to view it.";
    }
    return "Couldn't list this folder on the remote host. Check the connection and try again.";
  }
  return "Couldn't open this folder.";
}

export function FileTree({
  projectDir,
  projectId,
  localFile = null,
  sortKey = "name",
  descending = false,
  hiddenEndings = [],
  hiddenPaths = [],
  scanExcluded,
  onToggleScanExcluded,
  shownPaths = [],
  initialRelPath = "",
  onRelPathChange,
  onOpenFolderTab,
  syncSource,
  remoteProbeDir,
}: Props) {
  // Non-null inside a detached popout: replaces the main window's CenterPanel
  // drop authority (which this window can't reach) for a file dragged onto a
  // pane. See fileDropContext.
  const fileDrop = useContext(FileDropContext);
  const [rawEntries, setRawEntries] = useState<FileEntry[]>([]);
  // Recursive folder sizes (bytes), keyed by absolute folder path. Filled in
  // lazily by a per-folder backend call so a big subtree never blocks the
  // listing — the tree renders immediately and each folder's size appears
  // once it resolves. `requestedSizes` guards against re-dispatching the same
  // folder while it's in flight (or after it failed), so fs-watch churn doesn't
  // trigger a request storm; both reset in `load()` (navigation / refresh) so a
  // re-listed folder recomputes. Shared between the two size-fetch effects
  // below (plain `dir_size` for the gitignored section, `dir_size_breakdown`
  // for everything else) so the same folder is never fetched by both — besides
  // being wasted work, two independent walks of the same folder can disagree
  // if it's being actively written to, which would make the ignored split
  // exceed the total from the other call.
  const [dirSizes, setDirSizes] = useState<Record<string, number>>({});
  const requestedSizes = useRef<Set<string>>(new Set());
  // Which listing the in-flight size calls belong to. Bumped by `load()`, the
  // only thing that invalidates the cache — so a result is stale ONLY if the
  // folder was re-listed under it, never merely because the tree re-rendered.
  // This is load-bearing: the effects below key on `sections`, whose identity
  // changes on any re-render (`load()` itself sets rawEntries and THEN, a
  // round-trip later, gitStatuses), and cancelling on that would drop every
  // size call still in flight — permanently, since `requestedSizes` keeps it
  // from being re-dispatched. Small folders resolved inside the gap and showed
  // a size; a big one (the whole point of the feature) never did.
  const sizeGeneration = useRef(0);
  // Scan exclusions, normalised once per change into the one spelling the backend
  // matches on. `scanExcludedList` is what the walk commands receive (it prunes
  // excluded subtrees *nested inside* a folder being sized); `isScanExcluded`
  // additionally stops us dispatching a walk for an excluded folder at all.
  const scanExcludedList = useMemo(
    () => (scanExcluded ?? []).map(normalizeScanPath).filter(Boolean),
    [scanExcluded],
  );
  const scanExcludedSet = useMemo(() => new Set(scanExcludedList), [scanExcludedList]);
  const isScanExcluded = useCallback(
    (rel: string) => scanExcludedSet.has(normalizeScanPath(rel)),
    [scanExcludedSet],
  );
  // The rel path of the most recent `load` call — lets the async remote-boundary
  // probe bail if navigation has moved on since the listing it was probing failed.
  const loadTargetRef = useRef<string>("");
  // Bytes of a folder's recursive size that are git-ignored, for folders that
  // are NOT themselves ignored (they sit in the regular/standard section) but
  // contain ignored content — e.g. a source folder with a build output dir
  // inside. Filled from the same `dir_size_breakdown` call that fills
  // `dirSizes` for these folders (one walk, both numbers), so the split can
  // never exceed the total it was measured against. A folder with no ignored
  // content is simply absent from this map (nothing to annotate).
  const [dirIgnoredBytes, setDirIgnoredBytes] = useState<Record<string, number>>({});
  // Which files can be embedded as a frameless in-tab app (Group K #40). Keyed
  // by extension (default-app resolution is per-mime/extension), so we only
  // query the backend once per distinct extension. Only embeddable files get the
  // drag-to-tab affordance (3D hover + pointer drag); the rest open on dblclick.
  const [embedByExt, setEmbedByExt] = useState<Record<string, boolean>>({});
  // Seed from the saved folder (`initialRelPath`) rather than "" so a (re)mount
  // renders that folder immediately. Starting at "" made every remount paint the
  // ROOT for one frame — then the mount effect's async `load(initialRelPath)`
  // would snap back to the saved folder, so a remounting tree visibly flickered
  // "root ↔ current folder". Reading the prop lazily fixes that for all remount
  // causes; the mount effect below still runs and just fetches this folder's
  // listing (relPath is already correct, so there is no root frame).
  const [relPath, setRelPath] = useState(() => initialRelPath ?? "");
  // Multi-selection: a set of entry ABSOLUTE paths (`e.path`, the row key), plus
  // the range anchor. Click selects; shift-click extends a contiguous range;
  // ctrl/cmd-click toggles a row. Backs bulk delete/move/copy, drag-all, and
  // open-all. Cleared on folder navigation (in `load`) and pruned when the
  // listing changes (fs-watch removes a selected file).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When a remote listing fails because the folder isn't on the host, this holds
  // the crumb index (into the path segments) of the FIRST segment that doesn't
  // exist on the host — everything from here on is local-only. null when the
  // whole path exists (the normal case) or the source is local. The breadcrumb
  // tints the on-host prefix and strikes through the local-only tail from it.
  const [missingCrumbDepth, setMissingCrumbDepth] = useState<number | null>(null);
  const [gitStatuses, setGitStatuses] = useState<GitStatusMap>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const [separateScaffold, setSeparateScaffold] = useState(true);
  const [gitignoredExpanded, setGitignoredExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GITIGNORED_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [scaffoldExpanded, setScaffoldExpanded] = useState(false);
  // Whether the Ctrl key is currently held. While held, file rows arm NATIVE
  // HTML5 drag-and-drop (export/copy the file to an embedded browser / external
  // target like Signal) instead of the pointer-based drag-to-tab. The two can't
  // both be armed on the same drag (native DnD fires pointercancel on WebKitGTK
  // and breaks the pointer drag — see onEntryPointerDown's R6 note), so Ctrl is
  // the explicit switch. Tracked as state so `draggable` re-evaluates per row
  // when Ctrl is pressed/released.
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; entry: FileEntry } | null>(null);
  // In-tree search: while `search` is non-empty the tree body is replaced by a
  // flat result list (FileTreeSearch). `searchMode` picks filename vs. content
  // search; `searchCase` only applies to content search (name search is fuzzy).
  // Both backends walk the canonical LOCAL path, so the search box is only shown
  // for a non-remote-source tree (see `remoteListing` below).
  // Right-click on the breadcrumb turns the path into an editable field (holding
  // the current folder's absolute path) so a path can be typed/pasted to jump —
  // and copies that absolute path to the clipboard. `null` = not editing.
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const pathEditRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<"name" | "content">("name");
  const [searchCase, setSearchCase] = useState(false);
  // Search scope: false (default) confines the search to the browsed folder
  // (`relPath`); true searches from the project root. Only meaningful in a
  // subfolder — at the root the two are identical.
  const [searchRoot, setSearchRoot] = useState(false);
  // A pending "reveal in tree" (jump-to-path) request from a search result: the
  // parent folder to navigate to and the entry name to select once it lists.
  const [pendingReveal, setPendingReveal] = useState<{ parent: string; name: string } | null>(null);
  // Drag-to-move: the rel path of the folder / breadcrumb under the cursor while
  // a file is being dragged (null = none). The ref carries the live value into
  // the drag's window-bound release handler (which captured an earlier closure);
  // the state drives the drop-target highlight and only changes when the hovered
  // target changes (not every pointermove), so the tree re-renders rarely.
  const moveTargetRef = useRef<string | null>(null);
  const [moveTargetRel, setMoveTargetRel] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  // The focusable tree root. File rows preventDefault on pointerdown to arm the
  // drag, which suppresses the browser's default focus-the-ancestor — so we move
  // focus here explicitly on selection, or the tree's key handlers (Enter/Delete/
  // Escape) would only fire after a manual Tab-in (notably in the docked sidebar).
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  useClampToViewport(contextMenuRef, contextMenu, setContextMenu);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [autoConfirm, setAutoConfirm] = useState<AutoConfirm>(null);
  const [defaultAppFor, setDefaultAppFor] = useState<FileEntry | null>(null);
  const [pastePrompt, setPastePrompt] = useState<PastePrompt | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  // SSH-sync Phase 2: project-relative paths whose push was blocked by a stale
  // host base, awaiting the user's keep-local / take-host / skip choice. The
  // first is shown in the conflict modal; resolving advances the queue.
  const [pushConflicts, setPushConflicts] = useState<string[]>([]);
  const [pushBusy, setPushBusy] = useState(false);
  // Whether the system clipboard holds an image when the context menu opened
  // (probed async on right-click), gating the "Paste screenshot" option.
  const [clipboardImage, setClipboardImage] = useState(false);
  const clipboardEntries = useFileClipboardStore((s) => s.entries);
  const setClipboardEntries = useFileClipboardStore((s) => s.setEntries);
  const clearClipboard = useFileClipboardStore((s) => s.clear);
  // The primary clipboard item — backs the single-file paste-rename prompt and
  // its labels. Multi-item pastes read the full `clipboardEntries` array.
  const clipboard = clipboardEntries[0] ?? null;
  // TeX toolchain presence (null until probed); absolute paths of .tex files
  // currently compiling, for the inline build spinner.
  const [texCap, setTexCap] = useState<TexCapability | null>(null);
  const [compiling, setCompiling] = useState<Set<string>>(new Set());
  // Per-file arguments for the ▶ Run button, remembered so a re-run reuses them.
  // Set via the right-click popover (`argsPopover`, positioned at the cursor).
  // Same shared, persisted map the open-editor's Run/Debug toolbar reads/writes
  // (`FileViewerPane.tsx`'s `pyArgs`/`setPyArgs`) — keyed by absolute path in
  // global settings, not local component state, so it survives this tree
  // unmounting (right-panel hide/close) and an Eldrun restart.
  const pyArgsByPath = useSettingsStore((s) => s.settings?.python_run_args ?? EMPTY_PY_ARGS);
  const setPyArgs = useCallback((path: string, v: string) => {
    void useSettingsStore.getState().setPythonRunArgs(path, v);
  }, []);
  const [argsPopover, setArgsPopover] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
    draft: string;
  } | null>(null);
  const argsPopoverRef = useRef<HTMLDivElement | null>(null);
  const argsInputRef = useRef<HTMLInputElement | null>(null);
  useClampToViewport(argsPopoverRef, argsPopover, setArgsPopover);
  useEffect(() => {
    if (!argsPopover) return;
    argsInputRef.current?.focus();
    argsInputRef.current?.select();
  }, [argsPopover?.entry.path]);
  const runInBackground = useSettingsStore((s) => s.settings?.run_scripts_in_background ?? true);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const runningScripts = useActivityStore((s) => s.runningScripts);
  const runningRunFiles = useActivityStore((s) => s.runningRunFiles);
  const runScript = useActivityStore((s) => s.runScript);
  // Mount-free remote (Phase 2): a remote project lists over SFTP and has no
  // local inotify watcher, so we skip the fs-watch wiring and offer a manual
  // refresh control instead. Local projects keep live watch-driven updates.
  const isRemote = useProjectsStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.remote,
  );
  // The local mirror root for a remote project, resolved the same way
  // `ProjectFilesPane`/`ProjectFilesView` do (persisted override, else the default
  // `<state_dir>/mirror`). Used to build the mirror-side absolute path the
  // three-way merge viewer (`SyncMergeView`) opens a diverged file at — the ± diff
  // button below routes through it. Null for a local (non-remote) project.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const mirrorRoot = useMemo(() => {
    if (!project?.remote) return null;
    return (
      resolveLocalMirror(project) ??
      `${resolveProjectDirectory(project).replace(/[/\\]+$/, "")}/mirror`
    );
  }, [project]);
  // SSH-sync Phase 1: the local mirror source (`syncSource === "local"`) is a
  // plain LOCAL tree even though its project is remote — it lists/​watches the
  // local mirror dir and is never gated on the SSH pool. Only a remote-SOURCE
  // tree dispatches its listing over SFTP. `remoteListing` is the flag the
  // watch/refresh-bar/pool-gate logic below keys on.
  const treatLocal = syncSource === "local";
  const remoteListing = isRemote && !treatLocal;
  // SSH-sync overlay state for the remote source: per-path green/amber/none + the
  // in-flight transfer progress. Only consulted in the remote-source view.
  const syncStatus = useSyncStore((s) => (projectId ? s.byProject[projectId] : undefined));
  // Aggregated sync state for FOLDERS that have no manifest entry of their own.
  // The manifest tracks files (a directory only gets an entry when it is
  // explicitly folder-selected / folder-auto-synced); files pulled individually
  // leave every ancestor folder absent, so a folder row's own-path lookup
  // defaults to "none" and paints a red "push to host" button even when every
  // file inside it is green/in-sync. This rolls each tracked file's state up onto
  // all of its ancestor directories: `any` = the folder contains a tracked file,
  // `allGreen` = they are all green. A folder with its own entry still uses that
  // (handled at the lookup site); this only rescues the entry-less ones. Keyed by
  // project-relative directory path.
  const dirSyncAgg = useMemo(() => {
    const agg: Record<string, { any: boolean; allGreen: boolean }> = {};
    if (!syncStatus) return agg;
    for (const [p, s] of Object.entries(syncStatus)) {
      if (s.isDir) continue; // dir entries are authoritative on their own row
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        const cur = agg[dir] ?? { any: false, allGreen: true };
        cur.any = true;
        if (s.state !== "green") cur.allGreen = false;
        agg[dir] = cur;
      }
    }
    return agg;
  }, [syncStatus]);
  const syncProgress = useSyncStore((s) => (projectId ? s.progressByProject[projectId] : undefined));
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const syncPull = useSyncStore((s) => s.pull);
  const syncPush = useSyncStore((s) => s.push);
  const syncMarkSelected = useSyncStore((s) => s.markSelected);
  const syncSetAuto = useSyncStore((s) => s.setAuto);
  const syncAutoPreview = useSyncStore((s) => s.autoPreview);
  // A remote project's `list_dir`/`git_file_statuses` dispatch over SSH/SFTP on
  // the backend. Those are SYNCHRONOUS Tauri commands (they run on the main
  // thread), so calling them while the pooled connection is down blocks on the
  // dead SSH session and FREEZES the whole window. Gate every listing on the pool
  // being "connected": until then the tree shows a disconnected note instead of
  // issuing any remote call. Reconnect (header lamp / center placeholder) brings
  // the pool up, flips this true, and the load effect re-runs.
  const remoteSshState = useRemoteStatusStore((s) =>
    projectId ? s.byProject[projectId]?.ssh : undefined,
  );
  const remoteBlocked = remoteListing && remoteSshState !== "connected";
  // Local-mirror view of a remote project: the NAMES of the browsed folder's
  // immediate children that exist on the host, from one SFTP readdir per
  // navigation (only while the pool is live — a host readdir is a main-thread
  // command that would freeze on a dead session, like every other remote call).
  // A local child folder absent from this set is local-only — it has never
  // reached the host — and the tree flags it so "Local" mode doesn't quietly
  // imply the whole mirror is on the remote. `null` = unknown (not this view, or
  // disconnected): flag nothing rather than guess.
  const [hostChildNames, setHostChildNames] = useState<Set<string> | null>(null);

  // Dotfiles always render inline here — there's no separate "hidden" section;
  // any that are actually gitignored get pulled into the gitignored section
  // below instead (see the render below).
  const entries = useMemo(
    () => visibleEntries(rawEntries, {
      showHidden: true,
      showStandardFiles: true,
      sortKey,
      descending,
      hiddenEndings,
      relPath,
      hiddenPaths,
      shownPaths,
    }),
    [rawEntries, sortKey, descending, hiddenEndings, relPath, hiddenPaths, shownPaths],
  );

  // Whether a visible Python file is a "main" script (has a module-level
  // `if __name__ == "__main__":` guard) — the Run ▶ button only shows for
  // those, not for every importable module. Resolved lazily per file since it
  // needs the file's content, which the tree listing doesn't carry. Keyed by
  // path + size + mtime so an on-disk edit (picked up by the fs watcher's
  // `entries` change) gets rechecked instead of trusting a stale verdict.
  const [pyMainByPath, setPyMainByPath] = useState<Record<string, boolean>>({});
  const pyMainChecked = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A remote-source listing's `readFileText` is an SFTP round trip — doing
    // one per visible .py file just to place the Run button would visibly
    // stall the tree. Remote falls back to the old any-.py-file behavior
    // instead (see `canPyRun` below).
    if (remoteListing) return;
    const pending = entries.filter(
      (e) => !e.is_dir && isPythonPath(e.path)
        && !pyMainChecked.current.has(`${e.path}#${e.size}#${e.modified_secs ?? 0}`),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => pyMainChecked.current.add(`${e.path}#${e.size}#${e.modified_secs ?? 0}`));
    let cancelled = false;
    (async () => {
      for (const e of pending) {
        const text = await readFileText(e.path, projectId).catch(() => null);
        if (cancelled) return;
        setPyMainByPath((m) => ({ ...m, [e.path]: text != null && isPythonMainScript(text) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, remoteListing, projectId]);

  // The three on-screen sections in render order (regular, then the collapsible
  // scaffold + gitignored groups). Shared by the renderer and the selection
  // click handler so a shift-range spans exactly what the user sees. Mirrors the
  // split the render body applies below.
  const sections = useMemo(() => {
    const isRoot = !relPath && separateScaffold;
    const nonStandard = isRoot ? entries.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : entries;
    const standard = isRoot ? entries.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];
    const regular = nonStandard.filter((e) => gitStatuses[e.name] !== "ignored");
    const gitignored = nonStandard.filter((e) => gitStatuses[e.name] === "ignored");
    return { regular, standard, gitignored };
  }, [entries, relPath, separateScaffold, gitStatuses]);

  // Flat list of visible row paths in on-screen order — the axis a shift-range
  // spans. Collapsed sections contribute no rows (they aren't rendered).
  const orderedVisible = useMemo(() => {
    const paths = sections.regular.map((e) => e.path);
    if (scaffoldExpanded) paths.push(...sections.standard.map((e) => e.path));
    if (gitignoredExpanded) paths.push(...sections.gitignored.map((e) => e.path));
    return paths;
  }, [sections, scaffoldExpanded, gitignoredExpanded]);

  // Prune selected paths that vanished from the listing (fs-watch removed a
  // file, a folder was deleted, etc.) so stale entries never linger in bulk ops.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.path));
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (live.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [entries]);

  function clearSelection() {
    anchorRef.current = null;
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }

  // Apply a click on a row to the selection, honouring shift (range) and
  // ctrl/cmd (toggle) via the pure `nextSelection` helper.
  function selectFromClick(entry: FileEntry, ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    setSelected((prev) => {
      const { selected: next, anchor } = nextSelection(
        prev,
        orderedVisible,
        anchorRef.current,
        entry.path,
        { shift: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey },
      );
      anchorRef.current = anchor;
      return next;
    });
  }

  // Resolve embed capability for any not-yet-known file extension in view. One
  // backend call per distinct extension; results cached in embedByExt.
  useEffect(() => {
    const unknown = new Map<string, string>(); // ext → a sample path
    for (const e of entries) {
      if (e.is_dir) continue;
      const ext = e.extension ?? "";
      if (!(ext in embedByExt) && !unknown.has(ext)) unknown.set(ext, e.path);
    }
    if (unknown.size === 0) return;
    let cancelled = false;
    (async () => {
      // Fire every distinct-extension capability probe concurrently rather than
      // awaiting each in series (Eff #8): the checks are independent, so the
      // batch finishes in roughly one round-trip instead of N.
      const results = await Promise.all(
        [...unknown].map(async ([ext, path]) => {
          try {
            const cap = await invoke<EmbedCap>("embed_capability", { path, handler: null, projectId });
            return [ext, cap.os_embeddable && cap.app_embeddable] as const;
          } catch {
            return [ext, false] as const;
          }
        }),
      );
      if (!cancelled) setEmbedByExt((m) => ({ ...m, ...Object.fromEntries(results) }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Lazily compute the recursive size of each visible gitignored-section
  // folder. Fires one backend call per not-yet-requested folder (concurrently
  // — they're independent) and fills `dirSizes` as each resolves. A failed
  // call is left unresolved; the `requestedSizes` guard keeps it (and
  // steady-state re-renders / fs-watch reloads) from re-dispatching. Plain
  // `dir_size` is enough here — the whole folder is ignored by definition, so
  // there's no split to compute, unlike the regular/standard effect below.
  useEffect(() => {
    const pending = sections.gitignored.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      invoke<number>("dir_size", { projectDir, relPath: relForEntry(e), excluded: scanExcludedList })
        .then((bytes) => {
          if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.gitignored]);

  // Lazily compute the recursive size of each visible regular/standard-section
  // folder, split into ignored vs. non-ignored bytes in the SAME backend walk
  // that produces the total — so a folder with e.g. a build output dir mixed
  // in with source can show that split, and the ignored figure can never
  // exceed the total it was measured against (two independent walks of the
  // same folder can disagree if it's being actively written to, which is
  // exactly the kind of folder — build/output dirs — this feature targets).
  // Fills both `dirSizes` and `dirIgnoredBytes` from one response, sharing
  // `requestedSizes` with the effect above so no folder is fetched twice.
  useEffect(() => {
    const candidates = [...sections.regular, ...sections.standard];
    const pending = candidates.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      invoke<{ total: number; ignored: number }>("dir_size_breakdown", {
        projectDir,
        relPath: relForEntry(e),
        excluded: scanExcludedList,
      })
        .then(({ total, ignored }) => {
          if (sizeGeneration.current !== gen) return;
          setDirSizes((m) => ({ ...m, [e.path]: total }));
          if (ignored > 0) setDirIgnoredBytes((m) => ({ ...m, [e.path]: ignored }));
        })
        .catch(() => {
          // Fall back to the plain total rather than showing no size at all —
          // `dir_size_breakdown` can fail for reasons `dir_size` wouldn't (a
          // backend that hasn't picked up this new command yet, no `git` on
          // PATH), and a folder's size is more important than its ignored split.
          invoke<number>("dir_size", { projectDir, relPath: relForEntry(e), excluded: scanExcludedList })
            .then((bytes) => {
              if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
            })
            .catch(() => {
              /* best-effort display aid — leave unresolved on failure */
            });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.regular, sections.standard]);

  // Total bytes contained in each section, kept separate rather than merged
  // into one figure — the point of splitting scaffold/gitignored out visually
  // is that their weight (e.g. a huge gitignored build dir) shouldn't hide
  // inside the "real" content total. Sums whatever `dirSizes`/`e.size` already
  // know; unresolved subfolder sizes count as 0 until their `dir_size` call
  // lands, same best-effort as the per-row display above. `regular`/`standard`
  // are non-ignored-only (mirroring the per-row headline number), with the
  // ignored portion pulled out separately so callers can put it on hover —
  // `gitignored` needs no such split, it's ignored content in its entirety.
  const groupSizes = useMemo(() => {
    const total = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirSizes[e.path] ?? 0) : e.size), 0);
    const ignored = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirIgnoredBytes[e.path] ?? 0) : 0), 0);
    const regularIgnored = ignored(sections.regular);
    const standardIgnored = ignored(sections.standard);
    return {
      regular: total(sections.regular) - regularIgnored,
      regularIgnored,
      standard: total(sections.standard) - standardIgnored,
      standardIgnored,
      gitignored: total(sections.gitignored),
    };
  }, [sections, dirSizes, dirIgnoredBytes]);

  const isEmbeddable = (e: FileEntry): boolean =>
    !e.is_dir && embedByExt[e.extension ?? ""] === true;

  // A file can be dragged onto a tab bar if either: it opens in a built-in
  // viewer (pdf/markdown/text — always, independent of any external app), or its
  // external default handler is embeddable. The built-in viewer wins when both
  // apply, so PDFs/text/markdown never depend on the configured external app.
  const draggableToTab = (e: FileEntry): InternalViewer | "embed" | null => {
    if (e.is_dir) return null;
    const viewer = internalViewerFor(e, disabledViewerSet);
    if (viewer) return viewer;
    return isEmbeddable(e) ? "embed" : null;
  };

  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((cap) => { if (!cancelled) setTexCap(cap); });
    return () => { cancelled = true; };
  }, []);

  // Track Ctrl so file rows can switch to native DnD (export/copy to browser or
  // an external app) while it's held. Also clear on blur/visibility loss so a
  // release that happens while another window has focus doesn't leave rows stuck
  // in native-drag mode.
  useEffect(() => {
    // Warm the native drag-out preview icon so its path is ready (sync-readable)
    // by the time the user starts a Ctrl-drag. Only the plugin path (Win/mac)
    // needs it — the Linux `start_file_drag` embeds the icon backend-side.
    if (PLATFORM !== "linux") void warmDragIcon();
    let lastCtrl = false; // TEMPORARY drag QA: log transitions only, not every repeat
    const sync = (e: KeyboardEvent) => {
      if (e.ctrlKey !== lastCtrl) {
        lastCtrl = e.ctrlKey;
        dragDbg(`ctrlHeld=${e.ctrlKey} (${e.type})`);
      }
      setCtrlHeld(e.ctrlKey);
    };
    const clear = () => setCtrlHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (!projectDir) return;
    // Don't list a disconnected remote project's tree — the sync list_dir/
    // git_file_statuses commands would block the main thread on the dead SSH pool
    // and freeze the app. Re-runs once the pool connects (remoteBlocked flips).
    if (remoteBlocked) return;
    load(initialRelPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, remoteBlocked]);

  // SSH-sync Phase 1: keep the sync overlay fresh — re-stat selected files
  // whenever the tree (re)lists. Runs for both the remote-source tree and the
  // local-mirror tree (the marker is symmetric); `remoteBlocked` only ever gates
  // the remote-source case; the mirror tree keeps working offline off the last-
  // known manifest state (the backend falls back gracefully when the pool is
  // down — see `sync_status`).
  useEffect(() => {
    if (isRemote && projectId && !remoteBlocked) {
      void refreshSyncStatus(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRemote, projectId, remoteBlocked, relPath]);

  // SSH-sync: the host tree has no change watcher (inotify can't see the SFTP
  // tree), so a remote-side edit wouldn't flip a file to amber until the user
  // re-lists — and the local-mirror view has no re-list button at all. Re-stat
  // the SELECTED files (cheap metadata over the pooled ControlMaster — NOT a
  // tree re-list) whenever Eldrun regains focus and on a light interval, so a
  // remote-only divergence surfaces on its own shortly after it happens instead
  // of silently going stale. Gated on a live pool so a cold connection never
  // re-stats (which would report stale green); runs for both the remote-source
  // and local-mirror views (the amber marker is symmetric).
  useEffect(() => {
    if (!isRemote || !projectId || remoteSshState !== "connected") return;
    const refresh = () => { void refreshSyncStatus(projectId); };
    window.addEventListener("focus", refresh);
    // Only tick while Eldrun is focused: a backgrounded window doesn't need to
    // keep re-stat'ing the host every 15 s (the `focus` listener re-stats on
    // return anyway), which keeps an idle remote project off the wire.
    const id = window.setInterval(() => {
      if (document.hasFocus()) refresh();
    }, 15000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(id);
    };
  }, [isRemote, projectId, remoteSshState, refreshSyncStatus]);

  // Local-mirror view: readdir the HOST for the browsed folder so folders that
  // live only in the local mirror can be flagged (see `hostChildNames`). One
  // cheap SFTP readdir per navigation, gated on a live pool. If the folder ITSELF
  // isn't on the host (readdir fails), every local child here is off-host too, so
  // an empty set is the right answer — it flags them all.
  useEffect(() => {
    if (!treatLocal || !isRemote || !remoteProbeDir || remoteSshState !== "connected") {
      setHostChildNames(null);
      return;
    }
    let cancelled = false;
    const target = relPath;
    invoke<FileEntry[]>("list_dir", { projectDir: remoteProbeDir, relPath: target })
      .then((entries) => {
        if (!cancelled) setHostChildNames(new Set(entries.map((x) => x.name)));
      })
      .catch(() => {
        if (!cancelled) setHostChildNames(new Set());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treatLocal, isRemote, remoteProbeDir, remoteSshState, relPath]);

  // Live updates: watch the currently-displayed directory on the backend and
  // re-fetch when it changes, so files created/removed by terminals, agents, or
  // other processes appear without manual navigation. Re-points to the new
  // directory whenever relPath changes; tears down on unmount/panel close.
  useEffect(() => {
    // Remote projects have no local fs watcher (inotify can't see the SFTP tree);
    // they refresh manually via the toolbar button. Skip the watch wiring. The
    // local mirror source IS a real local dir, so it keeps live watch updates.
    if (!projectDir || remoteListing) return;
    const absDir = relPath ? `${projectDir}/${relPath}` : projectDir;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    invoke("watch_dir", { path: absDir }).catch(() => {});
    listen("fs-change", () => {
      // Coalesce the burst of events a single write emits into one reload.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(relPath), 250);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
      invoke("unwatch_dir").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, relPath, remoteListing]);

  async function load(rel: string) {
    // Never issue the (synchronous, main-thread) remote listing commands while the
    // pool is down — they would freeze the window. See `remoteBlocked`.
    if (remoteBlocked) return;
    loadTargetRef.current = rel;
    setLoading(true);
    setError(null);
    setMissingCrumbDepth(null);
    // Navigating into a different folder abandons the current selection (its
    // paths aren't on screen anymore). The quiet fs-watch `refresh()` deliberately
    // does NOT clear — a background re-list must not wipe an in-progress selection.
    clearSelection();
    // Re-listing (navigation or an explicit refresh) recomputes folder sizes:
    // drop the cache + in-flight guard so the effect re-requests them fresh, and
    // bump the generation so a call still walking the OLD folder can't land its
    // bytes on the new listing. The quiet fs-watch `refresh()` deliberately does
    // NOT do this — folder sizes stay put through watch churn.
    sizeGeneration.current += 1;
    requestedSizes.current.clear();
    setDirSizes({});
    setDirIgnoredBytes({});
    try {
      const result = await invoke<FileEntry[]>("list_dir", {
        projectDir,
        relPath: rel,
      });
      setRawEntries(result);
      setRelPath(rel);
      onRelPathChange?.(rel);
      const statuses = await invoke<GitStatusMap>("git_file_statuses", {
        projectDir,
        relPath: rel,
      }).catch(() => ({}));
      setGitStatuses(statuses);
    } catch (e) {
      // The listing failed — most often because "Remote" was selected in a
      // folder that only exists in the local mirror. Drop the previous listing
      // (which would otherwise leave the LOCAL files on screen under a Remote
      // header, falsely implying they're on the host) and show a readable
      // reason. Keep `relPath` so the breadcrumb / Local switch still work.
      setRawEntries([]);
      setGitStatuses({});
      setRelPath(rel);
      onRelPathChange?.(rel);
      setError(describeListError(e, remoteListing));
      // Remote source: find where the path stops existing on the host so the
      // breadcrumb can show the boundary (on-host prefix vs local-only tail).
      // Only on a remote failure, walking up from the deepest ancestor — a
      // handful of cheap SFTP stats over the already-live pool.
      if (remoteListing) void probeRemoteBoundary(rel);
    } finally {
      setLoading(false);
    }
  }

  // Walk up the failed path to the deepest ancestor that DOES list on the host,
  // and mark the first segment past it as the start of the local-only tail. Root
  // ("") is assumed present, so a path whose very first segment is absent marks
  // depth 0. Best-effort and self-cancelling: a newer `load` clears the state.
  async function probeRemoteBoundary(rel: string) {
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) return;
    let depth = 0; // default: first segment already missing
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join("/");
      try {
        await invoke<FileEntry[]>("list_dir", { projectDir, relPath: prefix });
        depth = k;
        break;
      } catch {
        // keep walking up
      }
    }
    // Guard against a race: only apply if we're still on the same failed path.
    if (loadTargetRef.current === rel) setMissingCrumbDepth(depth);
  }

  // Right-click the breadcrumb: copy the current folder's absolute path to the
  // clipboard and open the inline path editor pre-filled with it.
  function startPathEdit() {
    const abs = resolvePath(projectDir, relPath);
    navigator.clipboard?.writeText(abs).catch(() => {});
    setPathEdit(abs);
  }

  // Commit the edited path: accept either an absolute path or a project-relative
  // one, resolve it against the project root, and navigate there when it stays
  // inside the project. A path outside the project is rejected (the tree is
  // project-scoped) — the field just closes without navigating.
  function commitPathEdit() {
    const raw = pathEdit?.trim() ?? "";
    setPathEdit(null);
    if (!raw) return;
    const abs = resolvePath(projectDir, raw);
    const rel = relativePathWithin(projectDir, abs);
    if (rel === null) return;
    if (rel !== relPath) void load(rel);
  }

  // Focus + select the path field when it opens so the copied path can be
  // replaced or edited immediately.
  useEffect(() => {
    if (pathEdit !== null) pathEditRef.current?.select();
  }, [pathEdit !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quiet reload for the fs watcher: re-fetch the current directory without the
  // loading flash, and only swap state in when the result actually changed.
  // Replacing rawEntries/gitStatuses on every event (a single write emits a
  // burst) is what caused the tree to flicker, so we diff before committing.
  async function refresh(rel: string) {
    if (remoteBlocked) return;
    let result: FileEntry[];
    try {
      result = await invoke<FileEntry[]>("list_dir", { projectDir, relPath: rel });
    } catch {
      return; // transient (e.g. dir mid-rename) — keep the last good listing
    }
    setRawEntries((prev) => (fileEntriesEqual(prev, result) ? prev : result));
    const statuses = await invoke<GitStatusMap>("git_file_statuses", {
      projectDir,
      relPath: rel,
    }).catch(() => ({}));
    setGitStatuses((prev) => (stringMapsEqual(prev, statuses) ? prev : statuses));
  }

  // Jump-to-path: reveal a project-relative path in the tree. A folder navigates
  // into it; a file navigates to its parent folder and selects+scrolls it. Leaves
  // search mode so the tree (with the target selected) is what's shown. Used by
  // every search result (both name and content hits).
  function revealPath(rel: string, isDir: boolean) {
    setSearch("");
    if (isDir) {
      load(rel);
      return;
    }
    const parts = rel.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? "";
    const parent = parts.slice(0, -1).join("/");
    // Expand the collapsible sections so the row is rendered wherever it lives
    // (a scaffold or gitignored file would otherwise be hidden). The subsequent
    // effect selects and scrolls once the folder has listed.
    setScaffoldExpanded(true);
    setGitignoredExpanded(true);
    setPendingReveal({ parent, name });
    if (parent !== relPath) load(parent);
  }

  // Resolve a pending reveal once the target folder is listed: select the entry
  // and scroll its row into view, then clear the request. Gives up (clears) if
  // the entry isn't in the listing — e.g. hidden by a filter.
  useEffect(() => {
    if (!pendingReveal) return;
    if (pendingReveal.parent !== relPath) return; // still navigating
    const entry = entries.find((e) => e.name === pendingReveal.name);
    if (!entry) {
      setPendingReveal(null);
      return;
    }
    anchorRef.current = entry.path;
    setSelected(new Set([entry.path]));
    const path = entry.path;
    requestAnimationFrame(() => {
      try {
        document
          .querySelector(`[data-entry-path="${CSS.escape(path)}"]`)
          ?.scrollIntoView({ block: "center" });
      } catch {
        /* best-effort scroll */
      }
    });
    setPendingReveal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, pendingReveal, relPath]);

  function handleClick(entry: FileEntry) {
    if (entry.is_dir) {
      const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
      load(rel);
    } else if (entry.extension === ".zip") {
      // A zip "opens" by extracting in place into a sibling folder, then
      // navigating into it — rather than handing the archive to an external app.
      void extractArchive(entry);
    } else {
      openEntry(entry, false);
    }
  }

  // Open one file entry: a native-viewer type lands as an embed tab in the
  // project's focused subwindow (or streams into a popout via `fileDrop`); a
  // type with no native viewer, or an explicit external open (Shift), opens in
  // the OS default app. The single open-a-file policy — see `openFileEntry`.
  function openEntry(entry: FileEntry, external: boolean) {
    openFileEntry({
      entry,
      projectDir,
      projectId,
      origin: "right_file_tree",
      external,
      disabled: disabledViewerSet,
      // In a detached popout, stream the viewer tab into that window rather than
      // writing the popout's non-authoritative local tab store.
      placeTab: fileDrop ? fileDrop.openTab : undefined,
    });
  }

  // Single-click routing. A plain click on a folder navigates into it (and
  // drops any selection); every other click — a file, or a modifier-click on a
  // folder — drives the multi-selection instead (shift = range, ctrl/cmd =
  // toggle). Opening a file stays a double-click (onDoubleClick → handleOpen).
  function handleRowClick(ev: React.MouseEvent, entry: FileEntry) {
    dragDbg(`rowClick ${entry.name} shift=${ev.shiftKey} ctrl=${ev.ctrlKey}`); // TEMPORARY drag QA
    const hasMod = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (entry.is_dir && !hasMod) {
      clearSelection();
      handleClick(entry);
      return;
    }
    selectFromClick(entry, ev);
    // Take keyboard focus so Delete/Enter/Escape act on this selection without a
    // manual Tab-in (the row's pointerdown preventDefault suppresses auto-focus).
    treeRootRef.current?.focus({ preventScroll: true });
  }

  // Open a file on double-click. A native-viewer type opens in the focused
  // subwindow; a type with no native viewer — or a Shift+double-click — opens in
  // the OS default app (see `openEntry`). If the entry belongs to a
  // multi-selection, open EVERY selected file this way; otherwise just this one.
  // Folders keep navigating via handleClick.
  function handleOpen(entry: FileEntry, ev?: React.MouseEvent) {
    if (entry.is_dir) {
      handleClick(entry);
      return;
    }
    const external = ev?.shiftKey ?? false;
    const targets =
      selected.has(entry.path) && selected.size > 1
        ? entries.filter((e) => !e.is_dir && selected.has(e.path))
        : [entry];
    for (const t of targets) {
      if (t.extension === ".zip") void extractArchive(t);
      else openEntry(t, external);
    }
  }

  // Keyboard on the focused tree: Enter opens every selected file, Escape drops
  // the selection, Delete removes it (the right-click Delete's keyboard twin).
  // Only acts while something is selected so it never steals keys from the rest
  // of the panel.
  function handleTreeKeyDown(ev: React.KeyboardEvent) {
    if (selected.size === 0) return;
    // Never hijack Delete/Enter from the in-tree search box or a rename field.
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (ev.key === "Escape") {
      ev.stopPropagation();
      clearSelection();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      // Enter mirrors a double-click; Shift+Enter forces the external app.
      for (const t of entries.filter((e) => !e.is_dir && selected.has(e.path))) {
        if (t.extension === ".zip") void extractArchive(t);
        else openEntry(t, ev.shiftKey);
      }
    } else if (ev.key === "Delete") {
      ev.preventDefault();
      // Mirror the context menu's bulk target set (files and folders alike).
      promptDelete(entries.filter((e) => selected.has(e.path)));
    }
  }

  /** Extract a .zip into a new sibling folder and navigate into it. */
  async function extractArchive(entry: FileEntry) {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      const folderRel = await invoke<string>("extract_archive", {
        projectDir,
        relPath: relForEntry(entry),
      });
      await load(folderRel);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function goUp() {
    const parts = relPath.split("/").filter(Boolean);
    parts.pop();
    load(parts.join("/"));
  }

  function handleEntryMouseEnter(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    // Always shows the name (the row can truncate it); Created/Modified/Ignored
    // lines below are conditional on the entry actually having that data.
    setTooltip({ rect: e.currentTarget.getBoundingClientRect(), entry });
  }

  // Start the native OS drag-out (EXPORT/COPY to another app: a browser, Signal,
  // a file manager, the desktop). Real OLE/NSDragging/GTK drag with an
  // OS-rendered icon; copy semantics, so files are never MOVED out of the
  // project. Reached two ways: a dir's HTML5 dragstart (handleEntryDragStart),
  // and the mid-drag Ctrl handoff inside onEntryPointerDown.
  function beginNativeFileDrag(paths: string[]) {
    // Linux uses our own GTK drag (`start_file_drag`): tauri-plugin-drag's GTK
    // backend hands external targets an EMPTY payload — it tears down its
    // drag-data-get handler at drop-performed, before the target requests the
    // text/uri-list data — so a drop into a browser silently did nothing (it
    // also ships unencoded file:// URIs, which strict consumers discard).
    if (PLATFORM === "linux") {
      void invoke("start_file_drag", { paths }).catch((err) =>
        // Surfaces the most common failure: the backend wasn't rebuilt, so the
        // command doesn't exist yet — the drag silently no-ops otherwise.
        console.error("[eldrun] native file drag-out failed:", err),
      );
      return;
    }
    const begin = (icon: string) =>
      startDrag({ item: paths, icon, mode: "copy" })
        .then(() => dragDbg("startDrag resolved")) // TEMPORARY drag QA
        .catch((err) => {
          dragDbg(`startDrag FAILED: ${String(err)}`); // TEMPORARY drag QA
          // Same visibility for the plugin path (`plugin:drag|start_drag` and
          // `drag_preview_icon` only exist after a backend rebuild).
          console.error("[eldrun] native file drag-out failed:", err);
        });
    // The icon data URL is normally warm by drag time; if not, resolve first.
    if (dragIconDataUrl) void begin(dragIconDataUrl);
    else void warmDragIcon().then(begin);
  }

  function handleEntryDragStart(e: React.DragEvent<HTMLDivElement>, entry: FileEntry) {
    // WebKitGTK's HTML5 drag-out renders no drag image outside the window and
    // doesn't reliably export the file to other apps, so suppress it and hand
    // off to the native OS drag.
    e.preventDefault();
    dragDbg(`dragstart fired ${entry.name} iconWarm=${!!dragIconDataUrl}`); // TEMPORARY drag QA
    // Dragging a row that belongs to a >1 selection exports the whole
    // selection, mirroring the pointer drag-to-tab's multi-drag.
    const paths =
      selected.has(entry.path) && selected.size > 1
        ? entries.filter((en) => selected.has(en.path)).map((en) => en.path)
        : [entry.path];
    beginNativeFileDrag(paths);
  }

  // Start a pointer-based drag from a file row, mirroring TabBar.onTabPointerDown.
  // HTML5 native DnD is unreliable on WebKitGTK (it hijacks the pointer stream
  // and fires pointercancel), so once the pointer crosses a 5px threshold we
  // drive a "file" drag from plain window listeners. On drop, commitFileDrop
  // either opens the file as a frameless embed tab (capability permitting) or
  // falls back to an external launch.
  //
  // R6: we e.preventDefault() here to suppress native DnD and the row's
  // `draggable`/onDragStart is disabled for files (see renderEntry), so both
  // can't fire. The commit fires from THIS handler's window-pointerup — the
  // only listener guaranteed to see the release before pointer capture on
  // WebKitGTK — never from CenterPanel.
  function onEntryPointerDown(
    e: React.PointerEvent,
    entry: FileEntry,
    dragTarget: InternalViewer | "embed" | null,
  ) {
    if (e.button !== 0 || entry.is_dir) return;
    // TEMPORARY drag QA
    dragDbg(`pdown ${entry.name} ctrl=${e.ctrlKey} shift=${e.shiftKey} target=${dragTarget ?? "none"}`);
    // A built-in viewer drives the in-app drop; "embed" means an external
    // handler, so no viewer. `canTab` is whether this file can land on a tab bar
    // / new window at all — only such files take the commitFileDrop path on
    // release. Files without a tab target are still draggable, but ONLY to move
    // them into a folder (drag-to-move); released anywhere else they do nothing.
    const viewer = dragTarget === "embed" ? null : dragTarget;
    const canTab = dragTarget != null;
    // Multi-selection drag: if the pressed row belongs to a >1 selection, the
    // whole selection is dragged; otherwise just this row. `dragEntries` (files
    // + folders) drives drag-to-move; `dragFiles` (file members only, with their
    // built-in viewer resolved) is the tab/window drop payload — folders can move
    // but never become tabs. A release over a tab bar / split / new window
    // creates tabs when `canDrop`: for a single drag only a viewer/embed file
    // qualifies (unchanged); for a multi drag any file member becomes an embed
    // tab.
    const isMultiDrag = selected.has(entry.path) && selected.size > 1;
    const dragEntries = isMultiDrag ? entries.filter((en) => selected.has(en.path)) : [entry];
    const dragFiles: FileDragItem[] = dragEntries
      .filter((en) => !en.is_dir)
      .map((en) => ({ path: en.path, name: en.name, viewer: internalViewerFor(en, disabledViewerSet) ?? undefined }));
    const canDrop = isMultiDrag ? dragFiles.length > 0 : canTab;
    // Ctrl held → the user wants to EXPORT/COPY this file out to another app
    // (Signal, a browser, a file manager). The row arms HTML5 `draggable` while
    // `ctrlHeld` (see renderEntry); its onDragStart suppresses the broken
    // WebKitGTK drag and hands off to the native OS drag (handleEntryDragStart).
    // Bail out here without preventDefault so that gesture takes over instead of
    // the pointer drag-to-tab.
    if (e.ctrlKey) {
      dragDbg("pdown: ctrl bail → native dnd expected (a 'dragstart fired' line should follow)"); // TEMPORARY drag QA
      return;
    }
    // Let the inline run (▶) button own its own clicks — don't seed a drag or
    // swallow the click when the press lands on it.
    if ((e.target as HTMLElement).closest(".file-run-btn")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const captureEl = e.currentTarget as HTMLElement;
    let dragging = false;
    // #42: an open popout of the current scope is a valid drop target — releasing
    // the file over one docks it there as an embed tab instead of spawning a new
    // window. SAME shared session the tab drag (TabBar) uses, so a file dragged
    // over a popout behaves exactly like one dragged over the main window.
    const detached = startDetachedDropSession();

    // Latest in-window client coords ("outside this window" test) and the latest
    // physical desktop cursor (cross-window hit-test, poll-driven — see lib/coords;
    // DOM screenX/Y units diverge across WebKitGTK/WebView2/WKWebView).
    let lastClient = { x: startX, y: startY };
    let lastPhys: PhysPoint | null = null;
    let stopPoll: (() => void) | null = null;

    // Mid-drag Ctrl → arms the native OS EXPORT drag (copy the file(s) out to
    // whatever app the cursor ends up over). Ctrl *before* the press is the
    // multi-select toggle, so export is armed by pressing Ctrl AFTER the drag
    // is underway — symmetric with Shift, which modifies the drop while
    // already dragging (see DragGhost's modifier highlight). Mirrors that:
    // holding Ctrl only MARKS the ghost's "copy out" option; the in-app hover
    // (ghost, folder highlight, popout hover) keeps running unchanged.
    //
    // The gesture then switches between two modes at the WINDOW BOUNDARY, and
    // can switch back and forth as often as the user likes:
    //  - leaving the window with Ctrl held → the OS drag takes over the still-
    //    held button (GTK can only BEGIN a drag while the button is physically
    //    down, so the crossing is the last moment this is possible), and a
    //    release out there drops into the external app.
    //  - coming back INTO the window → the OS drag is cancelled and the in-app
    //    ghost/hover resumes, so re-entering never leaves the user staring at
    //    an OS drag icon over Eldrun's own window.
    // While the OS owns the drag the webview sees no pointer events at all, so
    // the boundary test runs off the OS-cursor poll (physical px → this
    // window's client px via the frame snapshot), which keeps ticking
    // regardless of who holds the pointer grab.
    let nativeActive = false;
    let frame: WindowFrame | null = null;
    // The `eldrun:file-drag-ended` subscription (registered below, once the
    // gesture is real) and whether the gesture has already ended — `listen` is
    // async, so it can resolve after cleanup and must then unsubscribe at once.
    let unlistenEnded: (() => void) | null = null;
    let gestureOver = false;
    const inWindow = (c: { x: number; y: number }) =>
      c.x >= 0 && c.y >= 0 && c.x < window.innerWidth && c.y < window.innerHeight;
    const toNativeDrag = () => {
      if (!dragging || nativeActive) return;
      nativeActive = true;
      // The in-app drop targets are meaningless while the OS owns the drag.
      setMoveTarget(null);
      detached.hover(null, { x: 0, y: 0 }, entry.name);
      beginNativeFileDrag(dragEntries.map((en) => en.path));
    };
    const backToInAppDrag = () => {
      if (!nativeActive) return;
      nativeActive = false;
      void invoke("cancel_file_drag").catch(() => {});
    };
    // Ctrl, tracked as gesture state rather than read off each pointer event.
    // Cancelling the GTK drag hands the pointer back, but NOT the implicit grab
    // the original pointerdown had: the webview then sees plain mousemove while
    // the cursor is over the window and NOTHING once it leaves. So after one
    // handoff, `PointerEvent.ctrlKey` stops arriving exactly where the next
    // handoff would need it — hence a flag the key events maintain, plus the
    // cursor poll below as the position source. (The keydown arm also covers
    // Ctrl pressed while the cursor already sits outside the window.)
    let ctrlDown = false;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Control") return;
      ctrlDown = true;
      if (dragging && !inWindow(lastClient)) toNativeDrag();
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "Control") ctrlDown = false;
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
        dragDbg(`drag engaged ${entry.name}`); // TEMPORARY drag QA
        useDragStore.getState().startFileDrag({
          label: isMultiDrag ? `${dragEntries.length} items` : entry.name,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          filePath: entry.path,
          fileName: entry.name,
          viewer: viewer ?? undefined,
          files: isMultiDrag ? dragFiles : undefined,
        });
        // Built-in viewers render in-app and need no external handler, so skip
        // the embed-capability probe for them. For other embeddable files,
        // prefetch the capability so the drop can resolve embed-vs-external.
        if (!viewer) {
          invoke<EmbedCap>("embed_capability", { path: entry.path, handler: null, projectId })
            .then((cap) => useDragStore.getState().setEmbedCap(cap))
            .catch(() => useDragStore.getState().setEmbedCap(null));
        }
        // Begin resolving popout drop targets now that a real drag is underway.
        void detached.resolve();
        // Capture the terminal pointer event on engines that don't keep delivering
        // it past the source window's HWND (Win/mac); WebKitGTK keeps the implicit
        // grab, so the flag leaves capture off there.
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
            dragDbg("pointer capture ok"); // TEMPORARY drag QA
          } catch (err) {
            dragDbg(`pointer capture FAILED: ${String(err)}`); // TEMPORARY drag QA
            /* capture is best-effort; the OS-cursor poll does not depend on it */
          }
        }
        // This window's geometry, for mapping the polled OS cursor back into
        // client px while the OS drag owns the pointer (see `nativeActive`).
        void snapshotFrame()
          .then((f) => {
            frame = f;
          })
          .catch(() => {});
        // Poll the OS cursor (physical desktop px) to drive the popout hover past
        // the main viewport — DOM pointermove may not cross the OS window boundary.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
          // The poll is the SOLE arbiter of the window boundary, in BOTH
          // directions. DOM pointer events can't be: once the OS drag has run
          // even once, the implicit grab is gone, so they stop at the window
          // edge — exactly where the crossing has to be detected.
          const c = frame ? physToClient(frame, p) : null;
          if (nativeActive) {
            if (!c) return;
            // The OS owns the pointer: this poll is also the only position
            // source, so keep the ghost tracking the cursor for the moment it
            // comes back in — whereupon the OS drag is cancelled and the
            // in-app hover takes over again.
            lastClient = c;
            useDragStore.getState().move(c.x, c.y);
            if (inWindow(c)) backToInAppDrag();
            return;
          }
          if (c && ctrlDown && !inWindow(c)) {
            toNativeDrag();
            return;
          }
          detached.hover(detached.at(p), p, entry.name);
        });
      }
      // While the OS drag owns the pointer, a stray DOM move must not fight the
      // poll for the ghost position or revive the in-app drop targets.
      if (nativeActive) return;
      ctrlDown = ev.ctrlKey;
      lastClient = { x: ev.clientX, y: ev.clientY };
      useDragStore.getState().move(ev.clientX, ev.clientY);
      // Drag-to-move: highlight the folder row / breadcrumb / up button under the
      // cursor as the destination. The drag ghost is pointer-events:none, so
      // elementFromPoint reaches the rows beneath it. A target whose rel matches
      // the file's current folder is a no-op and is ignored.
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const moveEl = overEl?.closest<HTMLElement>("[data-move-rel]") ?? null;
      const moveRel = moveEl?.getAttribute("data-move-rel") ?? null;
      setMoveTarget(moveRel != null && moveRel !== relPath ? moveRel : null);
      // Inside a detached popout, CenterPanel's window-wide drop authority isn't
      // there to resolve the pane under the cursor — do it here so the popout's
      // split/merge preview lights up and the release has a target to commit to.
      // (In the main window CenterPanel owns this; `fileDrop` is null there.)
      if (fileDrop) fileDrop.resolveTarget(ev.clientX, ev.clientY);
    };

    // Tear down the move listener, poll, popout highlight, and pointer capture —
    // however the gesture resolves.
    const cleanup = () => {
      gestureOver = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      setMoveTarget(null);
      stopPoll?.();
      unlistenEnded?.();
      unlistenEnded = null;
      // Clear the popout highlight + tear down the panes listener. `targetAt`
      // still hit-tests the cached pane geometry for the commit below.
      detached.dispose();
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    const commitRelease = async (shiftKey: boolean) => {
      // The OS owns the drag: it is dropping into an external app, and the
      // in-app drop targets don't apply. `eldrun:file-drag-ended` ends the
      // gesture instead (a stray pointerup here must not ALSO spawn a tab or a
      // window on top of the export).
      if (nativeActive) return;
      // Read the drop-target folder BEFORE cleanup() runs — cleanup calls
      // setMoveTarget(null), which nulls moveTargetRef.current, so reading it
      // afterwards always saw null and silently dropped every drag-to-move (the
      // file just stayed put). See git dfcb6e0, which introduced the read below
      // the cleanup() call.
      const moveRel = moveTargetRef.current;
      // TEMPORARY drag QA
      dragDbg(`commit shift=${shiftKey} dragging=${dragging} moveRel=${moveRel ?? "null"} canDrop=${canDrop}`);
      cleanup();
      if (!dragging) {
        // Never moved → a plain click does NOT open. Opening a file is a
        // double-click (onDoubleClick → handleClick); dragging it onto a tab bar
        // is the other gesture. So a single click is a no-op here.
        return;
      }
      // Drag-to-move takes precedence: released over a folder / breadcrumb in the
      // tree → relocate the file(s) there. This is the one gesture available to
      // ALL files (even those with no tab/viewer target). When a multi-selection
      // is being dragged, every selected file moves.
      if (moveRel != null) {
        useDragStore.getState().end();
        for (const de of dragEntries) {
          await moveEntryToFolder(relForEntry(de), de.name, moveRel, de.path);
        }
        return;
      }
      const d = useDragStore.getState().drag;
      if (d == null) return;
      // A file with no tab/viewer/embed target can only be moved (handled above);
      // released anywhere else it does nothing — never leak it out as an external
      // open or an empty embed tab. (Multi drags qualify when any file member can
      // become a tab — see `canDrop`.)
      if (!canDrop) {
        useDragStore.getState().end();
        return;
      }
      // Inside a detached popout: commit against the pane resolved above by the
      // injected controller (a new embed tab into that pane, streamed to the main
      // window as an `add` edit). The main window's cross-window branches below —
      // dock into ANOTHER popout, spawn a new standalone window — don't apply
      // here (a popout can't own the main tab store), so this is the whole commit.
      if (fileDrop) {
        fileDrop.commit(d, projectDir);
        useDragStore.getState().end();
        return;
      }
      // Final physical cursor at release (a fresh read; falls back to the last
      // poll reading if the IPC fails). This is the canonical cross-window space.
      const phys = (await desktopCursor().catch(() => null)) ?? lastPhys;
      // Released over an open popout → dock the file into it as an embed tab,
      // landing in the SPECIFIC pane the popout resolved under the cursor (mirrors
      // a tab dragged onto a popout). BUT only if the popout is actually the front
      // window at the drop point: its bounds can geometrically contain the cursor
      // while it sits BEHIND the main window (the press raised the main window) or
      // another app. Docking into a popout the user can't see is wrong — treat an
      // occluded popout like a release into empty space so a NEW window opens.
      // Shift forces a brand-new standalone window even when released over a
      // front popout — the explicit "don't dock here, give me a fresh window"
      // override the user asked for.
      const overDetached = phys ? detached.at(phys) : null;
      const overFrontDetached =
        !shiftKey &&
        overDetached &&
        (await invoke<boolean>("detached_window_frontmost", {
          registryId: overDetached.label,
        }).catch(() => true));
      if (overDetached && overFrontDetached && phys) {
        commitFileDrop(d, projectId, projectDir, null, {
          scope: overDetached.scope,
          groupId: overDetached.groupId,
          target: detached.targetAt(overDetached, phys),
        });
        useDragStore.getState().end();
        return;
      }
      // Released OUTSIDE the main window (e.g. dragged onto another monitor):
      // open the file in its own standalone detached window at the cursor. Client
      // coords outside [0,inner) is the signal. The new window's bounds feed Rust
      // `.position(x,y)`, which is PHYSICAL → use the physical cursor, not DOM
      // screen coords.
      //
      // A popout under the cursor is NOT treated as "outside" here: a FRONT popout
      // was already docked into above; an OCCLUDED popout (behind the main window)
      // means the main window is what's actually under the cursor, so the release
      // must fall through to the in-window split — spawning a new window the user
      // can't see they're aiming at is exactly the bug this avoids.
      //
      // Shift forces a new window even when released INSIDE the main window: the
      // split/dock preview was suppressed during the drag (see CenterPanel's
      // pointer-move handler), so the only sensible commit is a fresh window.
      const outside = fileDropGoesToNewWindow({
        shiftKey,
        lastClient,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
      const detachBounds =
        outside && phys
          ? {
              x: Math.round(phys.x - 80),
              y: Math.round(phys.y - 8),
              w: 900,
              h: 640,
            }
          : null;
      // TEMPORARY drag QA
      dragDbg(
        `commitFileDrop outside=${outside} reorder=${d.reorderGroup ?? "-"}@${d.reorderIndex ?? "-"} over=${d.overGroup ?? "-"} edge=${d.edge ?? "-"}`,
      );
      commitFileDrop(d, projectId, projectDir, detachBounds);
      useDragStore.getState().end();
    };

    // Escape / blur / a genuine pointercancel (Win/mac) aborts: tear down and drop
    // any in-flight drag without committing.
    const onAbort = () => {
      dragDbg(`file drag abort (dragging=${dragging})`); // TEMPORARY drag QA
      cleanup();
      if (dragging) useDragStore.getState().end();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const unbindRelease = bindDragRelease({
      onCommit: (shiftKey) => void commitRelease(shiftKey),
      onAbort,
    });
    // Once the OS drag owns the pointer, the webview never sees the release, so
    // the backend reports the drop (or the user's abort) that ends the whole
    // gesture. NOT fired by the cancel we ourselves issue on re-entry — that
    // hands control back to the in-app drag, which is still very much alive.
    void listen("eldrun:file-drag-ended", () => {
      unbindRelease();
      onAbort();
    }).then((un) => {
      // `listen` is async: the gesture can already be over when it resolves.
      if (gestureOver) un();
      else unlistenEnded = un;
    });
  }

  function relForEntry(entry: FileEntry): string {
    return relPath ? `${relPath}/${entry.name}` : entry.name;
  }

  // Set the current drag-to-move drop target (a folder rel path, "" = project
  // root, null = none). Keeps the ref (read by the release handler) and the
  // highlight state in sync; the setter is a no-op when unchanged so dragging
  // over the same folder doesn't churn renders.
  function setMoveTarget(rel: string | null) {
    moveTargetRef.current = rel;
    setMoveTargetRel((prev) => (prev === rel ? prev : rel));
  }

  // Relocate a dragged file into a folder shown in the tree (drag-to-move). The
  // backend `move_path` works the same for local and remote (SFTP) projects. A
  // name collision in the destination aborts with an error rather than silently
  // clobbering — moving is meant to be safe.
  async function moveEntryToFolder(sourceRel: string, name: string, destFolderRel: string, sourceAbs: string) {
    const destRel = destFolderRel ? `${destFolderRel}/${name}` : name;
    setLoading(true);
    setError(null);
    try {
      const exists = await invoke<boolean>("project_path_exists", {
        projectDir,
        relPath: destRel,
      }).catch(() => false);
      if (exists) {
        setError(`"${name}" already exists in ${destFolderRel || "the project root"}`);
        setLoading(false);
        return;
      }
      await invoke("move_path", {
        srcProjectDir: projectDir,
        srcRel: sourceRel,
        destProjectDir: projectDir,
        destRel,
      });
      // Retarget any open viewer tab of the moved file/folder (main + detached).
      // `sourceAbs` ends with `sourceRel`, so swapping that tail for `destRel`
      // yields the new absolute path without rebuilding it from `projectDir`.
      const newAbs = `${sourceAbs.slice(0, sourceAbs.length - sourceRel.length)}${destRel}`;
      retargetTabsForRenamedPath(sourceAbs, newAbs);
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function showEntryContextMenu(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    setTooltip(null);
    // Right-clicking a row that ISN'T part of the current selection resets the
    // selection to just it (standard file-manager behavior); right-clicking one
    // that IS keeps the whole multi-selection so the menu can act on all of it.
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
    const row = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      rowRect: { left: row.left, top: row.top, width: row.width, height: row.height },
    });
    probeClipboardImage();
  }

  async function stageEntry(entry: FileEntry) {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      await invoke("git_add_path", { projectDir, relPath: relForEntry(entry) });
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  /** Open the in-app diff viewer for a file. The DiffView viewer resolves the
   *  absolute source path and asks the backend (`git_diff_file`) for the diff,
   *  so we just hand it the path. Re-opening drops any prior diff tab for the
   *  same path (mirrors openPdfTab) so the diff refreshes. */
  function showDiff(entry: FileEntry) {
    setContextMenu(null);
    const store = useTabsStore.getState();
    const prior = store.tabs.find(
      (t) => t.kind === "embed" && t.viewer === "diff" && t.embedPath === entry.path,
    );
    if (prior) store.removeTab(prior.key);
    store.addTab({
      label: entry.name,
      cmd: "",
      cwd: projectDir,
      kind: "embed",
      embedPath: entry.path,
      viewer: "diff",
    });
  }

  /** SSH-sync: open a diverged (amber) file in the three-way merge viewer — the
   *  same PyCharm-style resolve view the orange list opens (local mirror ⇄ merged
   *  ⇄ remote host, per-block take-left/right) — instead of the old
   *  take-local/take-host popup. On open the viewer runs a byte-for-byte test and
   *  self-resolves a metadata-only divergence (identical bytes).
   *
   *  `SyncMergeView` keys off the mirror-side absolute path (`mirrorRoot/rel`), so
   *  build that here from `relForEntry` regardless of which side the tree is
   *  currently listing (the host path is not under the mirror). */
  function openSyncMerge(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId || !mirrorRoot) return;
    const rel = relForEntry(entry);
    const abs = `${mirrorRoot.replace(/[/\\]+$/, "")}/${rel}`;
    const tab = {
      label: basename(abs) || entry.name,
      cmd: "",
      cwd: dirname(abs),
      kind: "embed" as const,
      embedPath: abs,
      viewer: "syncmerge" as const,
    };
    // In a detached popout, stream the tab into that window (its store is
    // authoritative); otherwise reuse an already-open merge tab for this exact
    // file, else add a fresh one to the focused subwindow.
    if (fileDrop) {
      fileDrop.openTab(tab);
      return;
    }
    const store = useTabsStore.getState();
    const prior = store.tabs.find(
      (t) => t.kind === "embed" && t.viewer === "syncmerge" && t.embedPath === abs,
    );
    if (prior) store.setActive(prior.key);
    else store.setActive(store.addTab(tab).key);
  }

  // SSH-sync Phase 1: pull this file/folder into the local mirror (and mark it
  // selected), or stop tracking it. Remote source view only.
  async function syncEntryToLocal(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      await syncPull(projectId, relForEntry(entry));
    } catch (err) {
      setError(String(err));
    }
  }

  async function stopSyncingEntry(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      await syncMarkSelected(projectId, [relForEntry(entry)], false, entry.is_dir);
    } catch (err) {
      setError(String(err));
    }
  }

  // Auto-sync: toggle background bidirectional sync for a file or (recursively) a
  // folder. Turning it on implies tracking; the backend engine reconciles it on
  // its next pass, skipping anything diverged (orange).
  //
  // Turning it ON over a FOLDER is the one click in the app that can start hauling
  // a host tree down in bulk, and byte-sync does not read `.gitignore` — so a
  // deliberately host-side directory (experiment output, checkpoints) is not
  // protected by being gitignored the way it is from lockstep. Price it first and
  // make the user confirm when the answer is big; small folders just proceed.
  async function toggleAutoSyncEntry(entry: FileEntry, on: boolean) {
    setContextMenu(null);
    if (!projectId) return;
    if (on && entry.is_dir && isRemote) {
      try {
        const preview = await syncAutoPreview(projectId, relForEntry(entry));
        if (preview.files > AUTO_SYNC_WARN_FILES || preview.bytes > AUTO_SYNC_WARN_BYTES) {
          setAutoConfirm({ entry, ...preview });
          return;
        }
      } catch {
        // Preview is advisory (a cold pool, an unreadable dir). Failing to price
        // the pull must not block the toggle the user explicitly asked for.
      }
    }
    await applyAutoSync(entry, on);
  }

  // The write half of the toggle, shared by the direct path and the confirm modal.
  async function applyAutoSync(entry: FileEntry, on: boolean) {
    if (!projectId) return;
    setAutoConfirm(null);
    try {
      await syncSetAuto(projectId, [relForEntry(entry)], on, entry.is_dir);
    } catch (err) {
      setError(String(err));
    }
  }

  // SSH-sync Phase 2: push a local mirror file/folder up to the host. A push that
  // a host change would clobber is blocked and queued for per-file resolution.
  async function pushEntryToHost(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    try {
      const { conflicts } = await syncPush(projectId, relForEntry(entry), false);
      if (conflicts.length > 0) setPushConflicts(conflicts);
    } catch (err) {
      setError(String(err));
    }
  }

  // Push the whole local mirror up to the host (root context menu, local source).
  async function pushAllToHost() {
    setContextMenu(null);
    if (!projectId) return;
    try {
      const { conflicts } = await syncPush(projectId, "", false);
      if (conflicts.length > 0) setPushConflicts(conflicts);
    } catch (err) {
      setError(String(err));
    }
  }

  // Resolve the first queued push conflict: keep-local force-pushes, take-host
  // pulls the host copy back, skip drops it. Each advances the queue.
  async function resolvePushConflict(action: "keep" | "host" | "skip") {
    const rel = pushConflicts[0];
    if (!rel || !projectId) return;
    setPushBusy(true);
    try {
      if (action === "keep") await syncPush(projectId, rel, true);
      else if (action === "host") await syncPull(projectId, rel);
      // "skip" leaves both sides as-is.
    } catch (err) {
      setError(String(err));
    } finally {
      setPushBusy(false);
      setPushConflicts((q) => q.slice(1));
      await load(relPath);
    }
  }

  async function updateGitignore(entry: FileEntry, action: "ignore" | "unignore") {
    setContextMenu(null);
    setLoading(true);
    setError(null);
    try {
      await invoke("update_gitignore_rule", {
        projectDir,
        relPath: relForEntry(entry),
        isDir: entry.is_dir,
        action,
      });
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function promptDelete(targets: FileEntry[]) {
    setContextMenu(null);
    if (targets.length > 0) setDeleteConfirm({ entries: targets });
  }

  async function renameEntry(entry: FileEntry) {
    setContextMenu(null);
    const nextName = window.prompt("Rename to:", entry.name);
    if (!nextName?.trim() || nextName.trim() === entry.name) return;
    setLoading(true);
    setError(null);
    try {
      await invoke("rename_path", {
        projectDir,
        oldRel: relForEntry(entry),
        newName: nextName.trim(),
      });
      // Retarget any open viewer tab of this file (main + detached) to the new
      // path. Derive the new absolute path by swapping the basename on the entry's
      // own absolute path (== embedPath), so it holds for local and remote alike.
      const oldAbs = entry.path;
      const newAbs = `${oldAbs.slice(0, oldAbs.lastIndexOf("/") + 1)}${nextName.trim()}`;
      retargetTabsForRenamedPath(oldAbs, newAbs);
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function createEntry(kind: "file" | "dir") {
    setContextMenu(null);
    const label = kind === "file" ? "New file name:" : "New folder name:";
    const name = window.prompt(label, "");
    const trimmed = name?.trim();
    if (!trimmed) return;
    const rel = relPath ? `${relPath}/${trimmed}` : trimmed;
    setLoading(true);
    setError(null);
    try {
      await invoke(kind === "file" ? "create_file" : "create_dir", {
        projectDir,
        relPath: rel,
      });
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function copyEntries(targets: FileEntry[], op: "copy" | "cut") {
    setContextMenu(null);
    if (targets.length === 0) return;
    setClipboardEntries(
      targets.map((entry) => ({
        projectDir,
        relPath: relForEntry(entry),
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
        op,
      })),
    );
  }

  /** Suggest a name not already present in the current folder, appending
   *  " copy"/" copy N" (before the extension) until it is free. `extraTaken`
   *  adds names already claimed earlier in a bulk paste (which hasn't re-listed
   *  yet) so two pasted items can't collide with each other. */
  function suggestPasteName(name: string, extraTaken?: ReadonlySet<string>): string {
    const taken = new Set(rawEntries.map((e) => e.name));
    if (extraTaken) for (const n of extraTaken) taken.add(n);
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; ; i++) {
      const candidate = `${stem} copy${i > 1 ? ` ${i}` : ""}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  function openPastePrompt() {
    setContextMenu(null);
    if (!clipboard) return;
    setPastePrompt({ kind: "file", name: suggestPasteName(clipboard.name), error: null });
  }

  function openScreenshotPrompt() {
    setContextMenu(null);
    setPastePrompt({ kind: "image", name: suggestPasteName("screenshot.png"), error: null });
  }

  // The context-menu Paste entry. A single clipboard item keeps its rename
  // prompt (openPastePrompt); a multi-item clipboard pastes in bulk (pasteAll).
  function renderPasteButton() {
    if (clipboardEntries.length === 0) return null;
    const multi = clipboardEntries.length > 1;
    const move = clipboard?.op === "cut" ? " (move)" : "";
    return (
      <button onClick={() => (multi ? void pasteAll() : openPastePrompt())}>
        {multi
          ? `Paste ${clipboardEntries.length} items${move}`
          : `Paste${move} “${clipboard?.name}”`}
      </button>
    );
  }

  // Paste a multi-item clipboard into the current folder in one go — no per-file
  // rename prompt; each collision is auto-resolved with " copy". The single-item
  // paste keeps its rename prompt (openPastePrompt / confirmPaste).
  async function pasteAll() {
    setContextMenu(null);
    if (clipboardEntries.length === 0) return;
    setLoading(true);
    setError(null);
    const claimed = new Set<string>();
    try {
      for (const cb of clipboardEntries) {
        const newName = suggestPasteName(cb.name, claimed);
        claimed.add(newName);
        const destRel = relPath ? `${relPath}/${newName}` : newName;
        await invoke(cb.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: cb.projectDir,
          srcRel: cb.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        // Same-project cut relocates within this tree → retarget any open viewer
        // tab of the moved file (mirrors confirmPaste's single-item handling).
        if (cb.op === "cut" && cb.projectDir === projectDir) {
          const oldAbs = cb.path;
          const newAbs = `${oldAbs.slice(0, oldAbs.length - cb.relPath.length)}${destRel}`;
          retargetTabsForRenamedPath(oldAbs, newAbs);
        }
      }
      if (clipboardEntries.some((c) => c.op === "cut")) clearClipboard();
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function confirmPaste() {
    if (!pastePrompt) return;
    const newName = pastePrompt.name.trim();
    if (!newName || newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
      setPastePrompt({ ...pastePrompt, error: "Invalid file name" });
      return;
    }
    const destRel = relPath ? `${relPath}/${newName}` : newName;
    setPasteBusy(true);
    try {
      if (pastePrompt.kind === "image") {
        await invoke("save_clipboard_image", { projectDir, relPath: destRel });
      } else {
        if (!clipboard) return;
        await invoke(clipboard.op === "cut" ? "move_path" : "copy_path", {
          srcProjectDir: clipboard.projectDir,
          srcRel: clipboard.relPath,
          destProjectDir: projectDir,
          destRel,
        });
        if (clipboard.op === "cut") {
          // A same-project cut relocates within this scope's tree, so retarget any
          // open viewer tab of the moved file (main + detached). A cross-project
          // cut lands in a different scope than the source tab, which this
          // current-scope helper doesn't own, so leave it (reopen to refresh).
          if (clipboard.projectDir === projectDir) {
            const oldAbs = clipboard.path;
            const newAbs = `${oldAbs.slice(0, oldAbs.length - clipboard.relPath.length)}${destRel}`;
            retargetTabsForRenamedPath(oldAbs, newAbs);
          }
          clearClipboard();
        }
      }
      setPastePrompt(null);
      await load(relPath);
    } catch (err) {
      setPastePrompt({ ...pastePrompt, error: String(err) });
    } finally {
      setPasteBusy(false);
    }
  }

  function showRootContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    setTooltip(null);
    setContextMenu({ x: e.clientX, y: e.clientY, entry: null, rowRect: null });
    probeClipboardImage();
  }

  // Ask the backend whether a screenshot/image is on the system clipboard so the
  // open context menu can reveal "Paste screenshot". Async, so the menu shows
  // immediately and the option appears once the probe resolves.
  function probeClipboardImage() {
    invoke<boolean>("clipboard_has_image")
      .then(setClipboardImage)
      .catch(() => setClipboardImage(false));
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    const targets = deleteConfirm.entries;
    setDeleteConfirm(null);
    setLoading(true);
    setError(null);
    try {
      for (const entry of targets) {
        await invoke(entry.is_dir ? "delete_dir" : "delete_file", {
          projectDir,
          relPath: relForEntry(entry),
        });
        // Close any open viewer tab for the deleted file/folder (main + detached).
        closeTabsForDeletedPath(entry.path);
      }
      clearSelection();
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  function runShellScript(event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    const remoteForegroundOnly = remoteListing;
    if (runInBackground && !remoteForegroundOnly) {
      // Detached spawn: no tab, no captured output. The activity store tracks
      // the run (and the app-lifetime `script-finished` listener clears it) so
      // the spinner survives right-panel hide/show — see TODO group R #34.
      runScript(entry.path, projectDir);
      return;
    }
    const interp = shellRunnerFor(entry.extension, PLATFORM) as ScriptShell | null;
    if (!interp) return; // not a shell type we know how to run
    const plan = shellScriptRunPlan({
      project,
      treeRoot: projectDir,
      syncSource,
      scriptPath: entry.path,
      interp,
    });
    if (!plan) {
      setError(`Run failed: ${entry.path} is outside the current project tree`);
      return;
    }
    const tab = {
      label: `▶ ${entry.name}`,
      cmd: interp,
      cwd: plan.cwd,
      kind: "shell" as const,
      initialInput: plan.initialInput,
      runFile: entry.path,
      location: plan.location,
    };
    // Same placement policy as the Python Run: stream into a detached popout when
    // we're in one, else the focused subwindow of this project.
    if (fileDrop) fileDrop.openTab(tab);
    else useTabsStore.getState().addTabToScope(projectId ?? "root", tab);
  }

  /** Run a Python file: open a terminal tab in the project's scope running the
   *  project's interpreter on it. Same mechanism as the viewer's Run button
   *  (`lib/pythonRun`), so it inherits remote-host/container locality and picks
   *  up the project's pinned/auto-detected interpreter. */
  function runPythonScript(event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    launchPython(entry, pyArgsByPath[entry.path]);
  }

  /** Open a run terminal for `entry`, appending `args` to the command line (see
   *  `lib/pythonRun`). Same placement as the viewer's Run; failures surface into
   *  the tree's error banner. */
  function launchPython(entry: FileEntry, args?: string) {
    runPythonFile({
      file: entry.path,
      projectDir: runCwd(projectDir, entry.path),
      scope: projectId ?? "root",
      projectId,
      args,
      // In a detached popout `fileDrop` is set → the tab streams into that window;
      // in the main window it lands in the project's focused subwindow.
      place: placeForFocused(fileDrop),
    }).catch((err) => setError(`Run failed: ${String(err)}`));
  }

  /** Open (or refresh) the in-app PDF viewer tab for a freshly compiled PDF.
   *  The viewer reads the bytes once on mount, so on a recompile we drop any
   *  existing tab for this path and add a fresh one to pick up the new output. */
  function openPdfTab(pdfPath: string) {
    const store = useTabsStore.getState();
    const prior = store.tabs.find(
      (t) => t.kind === "embed" && t.viewer === "pdf" && t.embedPath === pdfPath,
    );
    if (prior) store.removeTab(prior.key);
    store.addTab({
      label: basename(pdfPath) || pdfPath,
      cmd: "",
      cwd: projectDir,
      kind: "embed",
      embedPath: pdfPath,
      viewer: "pdf",
    });
  }

  /** Compile a .tex file to PDF, then refresh the tree (the PDF appears) and
   *  optionally open it in the in-app viewer. Build feedback is the inline
   *  spinner on the row; failures surface in the tree error banner. */
  async function compileTex(entry: FileEntry, openPdf: boolean) {
    setContextMenu(null);
    if (compiling.has(entry.path)) return;
    setCompiling((s) => new Set(s).add(entry.path));
    setError(null);
    try {
      const res = await invoke<TexCompileResult>("compile_tex", {
        path: entry.path,
        engine: null,
      });
      if (!res.success) {
        const detail = lastLogLine(res.log);
        setError(`Compile failed for ${entry.name}${detail ? `: ${detail}` : ""}`);
        return;
      }
      await load(relPath);
      if (openPdf && res.pdf_path) openPdfTab(res.pdf_path);
    } catch (err) {
      setError(String(err));
    } finally {
      setCompiling((s) => {
        const next = new Set(s);
        next.delete(entry.path);
        return next;
      });
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!projectDir) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== "");
    if (!files.length) return;
    setLoading(true);
    setError(null);
    try {
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const rel = relPath ? `${relPath}/${file.name}` : file.name;
        await invoke("write_project_file_bytes", {
          projectDir,
          relPath: rel,
          content: Array.from(new Uint8Array(buf)),
        });
      }
      await load(relPath);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  if (!projectDir) {
    return (
      <div className="file-tree-empty">No project selected</div>
    );
  }

  // Disconnected remote project: the tree can't be listed without freezing the
  // app (sync remote commands on the main thread). Show a note and let the user
  // reconnect from the header lamp; the tree re-lists once the pool is up.
  if (remoteBlocked) {
    return (
      <div className="file-tree-empty">
        {remoteSshState === "connecting"
          ? "Connecting to the remote host…"
          : "Disconnected — reconnect (header lamp) to browse files."}
      </div>
    );
  }

  // Whether the search results replace the browsed listing. The search box is
  // only offered on a local-source tree (its backends walk the local path).
  const canSearch = !remoteListing;
  const searching = canSearch && search.trim().length > 0;
  // Folder the search is confined to: the browsed folder by default, the whole
  // project when "root" is chosen (or when already at the root).
  const searchScope = searchRoot ? "" : relPath;
  const scopeLabel = relPath ? basename(relPath) || relPath : "";

  return (
    <div
      ref={treeRootRef}
      className={`file-tree${isDragOver ? " drag-over" : ""}`}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleTreeKeyDown}
      onMouseDown={() => setContextMenu(null)}
      onContextMenu={showRootContextMenu}
    >
      {/* Sticky header: the remote/refresh bar, the in-tree search box and the
          breadcrumb path line stay pinned while the tree body scrolls (the sort
          row lives above the scroll container and is already fixed). They share
          ONE sticky wrapper so they stack instead of each pinning to top:0 and
          colliding — which is what hid the path line behind the search box.
          Shared by the right panel and the Files (Project) tab (both render
          FileTree), so both get the fixed path line. */}
      <div className="file-tree-head">
      {remoteListing && (
        <div className="file-tree-remote-bar" title="Remote project — live updates are off; refresh to re-list">
          <button
            className="file-tree-up file-tree-refresh"
            onClick={() => { load(relPath); if (projectId) void refreshSyncStatus(projectId); }}
            disabled={loading}
            title="Refresh (re-list over SFTP)"
            aria-label="Refresh"
          >
            ↻
          </button>
          <span className="file-tree-remote-label">remote</span>
          {syncProgress && (
            <span className="file-tree-sync-progress" title={`Syncing ${syncProgress.rel || "…"}`}>
              ⟳ {syncProgress.done}/{syncProgress.total}
            </span>
          )}
        </div>
      )}
      {canSearch && (
        <div className="file-tree-search">
          <div className="file-tree-search-row">
            <input
              type="text"
              className="file-tree-search-input"
              value={search}
              placeholder={
                searchMode === "name"
                  ? searchScope
                    ? `Find files in ${scopeLabel}…`
                    : "Find files…"
                  : searchScope
                    ? `Search in ${scopeLabel}…`
                    : "Search in files…"
              }
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Keep the tree's Enter/Escape handler out of the input.
                e.stopPropagation();
                if (e.key === "Escape") setSearch("");
              }}
            />
            {search && (
              <button
                type="button"
                className="file-tree-search-clear"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}
          </div>
          <div className="file-tree-search-modes">
            <button
              type="button"
              className={`file-tree-search-mode${searchMode === "name" ? " active" : ""}`}
              aria-pressed={searchMode === "name"}
              onClick={() => setSearchMode("name")}
              title="Search file and folder names"
            >
              Name
            </button>
            <button
              type="button"
              className={`file-tree-search-mode${searchMode === "content" ? " active" : ""}`}
              aria-pressed={searchMode === "content"}
              onClick={() => setSearchMode("content")}
              title="Search inside file contents"
            >
              Content
            </button>
            {searchMode === "content" && (
              <button
                type="button"
                className={`file-tree-search-mode${searchCase ? " active" : ""}`}
                aria-pressed={searchCase}
                onClick={() => setSearchCase((v) => !v)}
                title="Case sensitive"
              >
                Aa
              </button>
            )}
            {/* Scope: search under the browsed folder (default) or the whole
                project. Only shown in a subfolder — at the root they're the same. */}
            {relPath && (
              <span className="file-tree-search-scope">
                <button
                  type="button"
                  className={`file-tree-search-mode file-tree-search-scope-folder${!searchRoot ? " active" : ""}`}
                  aria-pressed={!searchRoot}
                  onClick={() => setSearchRoot(false)}
                  title={`Search under ${relPath}`}
                >
                  {scopeLabel}
                </button>
                <button
                  type="button"
                  className={`file-tree-search-mode${searchRoot ? " active" : ""}`}
                  aria-pressed={searchRoot}
                  onClick={() => setSearchRoot(true)}
                  title="Search the whole project"
                >
                  root
                </button>
              </span>
            )}
          </div>
        </div>
      )}
      {!searching && pathEdit !== null && (
        <div className="file-tree-breadcrumb file-tree-path-edit">
          <input
            ref={pathEditRef}
            className="file-tree-path-input"
            value={pathEdit}
            spellCheck={false}
            onChange={(e) => setPathEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPathEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPathEdit(null);
              }
            }}
            onBlur={() => setPathEdit(null)}
          />
        </div>
      )}
      {!searching && pathEdit === null && relPath && (() => {
        // Parent of the current folder — the up button doubles as a drag-to-move
        // target ("move into the parent dir"). The breadcrumb crumbs cover the
        // other ancestors (and ⌂ the project root).
        const parentRel = relPath.split("/").filter(Boolean).slice(0, -1).join("/");
        return (
        <div
          className="file-tree-breadcrumb"
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            startPathEdit();
          }}
        >
          <button
            className={`file-tree-up${moveTargetRel === parentRel ? " move-drop-target" : ""}`}
            data-move-rel={parentRel}
            onClick={goUp}
            title="Go up"
          >
            ↑
          </button>
          <button
            className={`file-tree-crumb${moveTargetRel === "" ? " move-drop-target" : ""}`}
            data-move-rel=""
            onClick={() => load("")}
            title="Project root"
          >
            ⌂
          </button>
          {relPath.split("/").filter(Boolean).map((seg, i, arr) => {
            const target = arr.slice(0, i + 1).join("/");
            const isLast = i === arr.length - 1;
            // When a remote listing failed, `missingCrumbDepth` marks where the
            // path leaves the host tree: segments before it exist on the host
            // (on-host), segments from it on are local-only (missing). The cue is
            // shape first — strike-through + a ⊘ badge for missing — with a colour
            // tint only as reinforcement, so it reads without relying on colour.
            const missing = missingCrumbDepth !== null && i >= missingCrumbDepth;
            const onHost = missingCrumbDepth !== null && i < missingCrumbDepth;
            return (
              <React.Fragment key={target}>
                <span className="file-tree-crumb-sep">/</span>
                <button
                  className={`file-tree-crumb${isLast ? " current" : ""}${moveTargetRel === target ? " move-drop-target" : ""}${missing ? " crumb-missing" : ""}${onHost ? " crumb-on-host" : ""}`}
                  data-move-rel={target}
                  onClick={() => { if (!isLast) load(target); }}
                  title={missing ? `${target}\nNot on the remote host — local-only` : onHost ? `${target}\nOn the remote host` : target}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
          <span
            className="file-tree-path-total"
            title={sizeTitle(groupSizes.regular, groupSizes.regularIgnored, "Total size of the files shown here")}
          >
            {fmtSize(groupSizes.regular)}
          </span>
        </div>
        );
      })()}
      </div>
      {loading && <div className="file-tree-loading">Loading…</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {!searching && pathEdit === null && !relPath && (
        <label
          className="file-tree-scaffold-toggle"
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            startPathEdit();
          }}
        >
          <Toggle size="sm" checked={separateScaffold} onChange={(e) => setSeparateScaffold(e.target.checked)} />
          Separate scaffold
          <span
            className="file-tree-path-total"
            title={sizeTitle(groupSizes.regular, groupSizes.regularIgnored, "Total size of the files shown here")}
          >
            {fmtSize(groupSizes.regular)}
          </span>
        </label>
      )}
      {searching && (
        <FileTreeSearch
          projectDir={projectDir}
          projectId={projectId}
          query={search}
          mode={searchMode}
          caseSensitive={searchCase}
          scopeRel={searchScope}
          onReveal={revealPath}
        />
      )}
      {!searching && (() => {
        // Sections (regular / collapsible scaffold / collapsible gitignored) are
        // computed once in the `sections` memo above and shared with the
        // selection click handler so a shift-range spans exactly these rows.
        const { regular, standard, gitignored } = sections;

        function renderEntry(e: FileEntry, isScaffold = false, isGitignored = false) {
          const status = isGitignored ? undefined : gitStatuses[e.name];
          const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
          // A folder's headline number is its non-ignored weight — the part
          // that's actually "yours" — with the full total + ignored split
          // available on hover; the gitignored section shows a folder's whole
          // size plainly since there nothing but ignored content is left.
          // A folder in the gitignored section never subtracts: it may still
          // carry a `dirIgnoredBytes` entry (the breakdown is dispatched from
          // the first render, when `git_file_statuses` hasn't landed yet and
          // every folder still looks regular), and there the ignored figure is
          // the folder's WHOLE size — subtracting it would show a plain 0 B.
          const dirTotal = e.is_dir ? dirSizes[e.path] : undefined;
          const dirIgnored = e.is_dir && !isGitignored ? dirIgnoredBytes[e.path] : undefined;
          const dirShown = dirTotal !== undefined ? dirTotal - (dirIgnored ?? 0) : undefined;
          const canShRun = !e.is_dir && shellRunnerFor(e.extension, PLATFORM) !== null;
          // Run only for a Python "main" script (see the `pyMainByPath` effect
          // above) — a remote-source listing can't cheaply check content, so it
          // keeps the old any-.py-file behavior instead of hiding Run entirely.
          const canPyRun = !e.is_dir && isPythonPath(e.path)
            && (remoteListing || (pyMainByPath[e.path] ?? false));
          const canRun = canShRun || canPyRun;
          // "Running" drives the green pulse + title/aria and unions both run
          // paths: a detached `.sh` tracked by real process liveness
          // (`runningScripts`), and a tab-backed run (Python / foreground shell)
          // whose tab is producing output (`runningRunFiles`, busy-gated).
          const isRunning = runningScripts.has(e.path) || runningRunFiles.has(e.path);
          // But only the detached path LOCKS the button: it has no tab to watch
          // and a second click would double-spawn. A tab-backed run stays
          // clickable so a re-run can replace the tab mid-session.
          const runLocked = runningScripts.has(e.path);
          const isCompiling = compiling.has(e.path);
          const dragTarget = draggableToTab(e);
          const isMoveTarget = e.is_dir && moveTargetRel === relForEntry(e);
          // SSH-sync Phase 1: per-path mirror state, symmetric across the
          // remote-source and local-mirror trees. Each non-resting state gets a
          // colored action button left of the icon: red for `none` (not synced)
          // — pull/push it; orange for `amber` (host diverged from our mirror) —
          // view the diff. `green` (in sync) is the resting state and shows
          // nothing.
          const syncTracked = remoteListing || treatLocal;
          const rel = syncTracked ? relForEntry(e) : "";
          // A folder with no manifest entry of its own falls back to the rolled-up
          // state of its tracked descendants (`dirSyncAgg`): green when it contains
          // tracked files and they are all green (so no misleading red push button),
          // else `none`. Files, and folders that DO have an own entry, keep the
          // direct lookup. `none` remains the default when nothing is known.
          const syncState: SyncFileState = !syncTracked
            ? "none"
            : syncStatus?.[rel]?.state ??
              (e.is_dir && dirSyncAgg[rel]?.any
                ? dirSyncAgg[rel].allGreen
                  ? "green"
                  : "none"
                : "none");
          // Auto-sync glyph: shown on both the remote and local trees when this
          // path (or an ancestor auto folder) is set to auto-sync. Coexists with
          // the amber ± button — an auto path that went orange is exactly what the
          // user must resolve manually.
          const autoSync = syncTracked ? !!syncStatus?.[rel]?.auto : false;
          // Local-mirror view only: a folder that exists in the mirror but not on
          // the host (its name is absent from the host readdir, `hostChildNames`).
          // Dimmed + tagged so "Local" mode never implies the whole tree is on the
          // remote. `hostChildNames === null` (unknown / disconnected) flags nothing.
          const notOnRemote =
            e.is_dir &&
            treatLocal &&
            hostChildNames !== null &&
            !hostChildNames.has(e.name);
          return (
            <div
              key={e.path}
              className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${isScaffold || isGitignored ? " scaffold" : ""}${isMoveTarget ? " move-drop-target" : ""}${selected.has(e.path) ? " selected" : ""}${notOnRemote ? " not-on-remote" : ""}`}
              // Row key for jump-to-path reveal scroll (search results).
              data-entry-path={e.path}
              // Folders are drag-to-move destinations: dropping a dragged file
              // here relocates it (hit-tested by data-move-rel in the drag).
              data-move-rel={e.is_dir ? relForEntry(e) : undefined}
              // Dirs: single-click navigates + native DnD (file export).
              // Files, plain drag: pointer-based drag onto a tab bar for
              // drag-to-tab files (built-in viewer OR embeddable handler); R6 —
              // native DnD disabled then so it can't hijack the pointer. Opened
              // by double-click.
              // Files, CTRL held: arm native HTML5 DnD so any file can be dragged
              // out into an embedded browser / external target like Signal (the
              // pointer drag-to-tab bails on Ctrl, see onEntryPointerDown).
              onClick={(ev) => handleRowClick(ev, e)}
              onDoubleClick={e.is_dir ? undefined : (ev) => handleOpen(e, ev)}
              onContextMenu={(ev) => showEntryContextMenu(ev, e)}
              draggable={e.is_dir || ctrlHeld}
              onDragStart={
                e.is_dir || ctrlHeld
                  ? (ev) => handleEntryDragStart(ev, e)
                  : (ev) => ev.preventDefault()
              }
              // Every file arms the pointer drag — files with a tab/viewer target
              // can drop onto a tab bar, and ALL files can be dragged into a
              // folder to move them. Folders aren't dragged (they navigate).
              onPointerDown={!e.is_dir ? (ev) => onEntryPointerDown(ev, e, dragTarget) : undefined}
              onMouseEnter={(ev) => handleEntryMouseEnter(ev, e)}
              onMouseLeave={() => setTooltip(null)}
            >
              <GitMarker status={status} />
              {/* Fixed-width sync slot: always reserved on a sync-tracked tree so
                  file/folder names stay left-aligned whether or not the row has an
                  action button. `none` → red sync/push button; `amber` → orange
                  diff button; `green` → empty (in sync). */}
              {syncTracked && (
                <span className="file-sync-slot">
                  {syncState === "none" && (() => {
                    const anyBusy = !!syncProgress;
                    const thisBusy = syncProgress?.rel === rel;
                    return (
                      <button
                        type="button"
                        className={`file-sync-btn${thisBusy ? " busy" : ""}`}
                        title={remoteListing ? "Sync to local" : "Push to host"}
                        aria-label={remoteListing ? "Sync to local" : "Push to host"}
                        disabled={anyBusy}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          void (remoteListing ? syncEntryToLocal(e) : pushEntryToHost(e));
                        }}
                      >
                        {thisBusy ? <span className="file-run-spinner" /> : "⇄"}
                      </button>
                    );
                  })()}
                  {syncState === "amber" && !e.is_dir && (
                    <button
                      type="button"
                      className="file-diff-btn"
                      title="Host and local differ — compare and resolve"
                      aria-label="Compare host vs local and resolve"
                      onClick={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        openSyncMerge(e);
                      }}
                    >
                      ±
                    </button>
                  )}
                  {/* Auto-sync indicator (non-interactive): only when the slot has
                      no action button, so it never crowds out the red/orange
                      controls. Amber auto paths still show ± (needs resolving). */}
                  {autoSync && syncState === "green" && (
                    <span
                      className="file-autosync-icon"
                      title="Auto-syncing"
                      aria-label="Auto-syncing"
                    >
                      ⟳
                    </span>
                  )}
                </span>
              )}
              {canRun && (
                <button
                  type="button"
                  className={`file-run-btn${isRunning ? " running" : ""}`}
                  // No native `title` here on purpose: hovering this button sits
                  // inside the row, which already has the row's own portaled
                  // tooltip open (below) — a browser title tooltip on top of it
                  // would be a second, uncontrolled hover. Everything it would
                  // have said (run/args/right-click hint) lives in that tooltip
                  // instead.
                  aria-label={isRunning ? `Running ${e.name}` : `Run ${e.name}`}
                  onClick={(ev) => (canPyRun ? runPythonScript(ev, e) : runShellScript(ev, e))}
                  // Right-click a Python Run button → set arguments (sys.argv). For a
                  // shell script there's nothing to offer, so just swallow it so it
                  // doesn't fall through to the row's file context menu.
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (canPyRun) {
                      setArgsPopover({
                        entry: e,
                        x: ev.clientX,
                        y: ev.clientY,
                        draft: pyArgsByPath[e.path] ?? "",
                      });
                    }
                  }}
                  disabled={runLocked}
                >
                  ▶
                </button>
              )}
              {isCompiling && (
                <span
                  className="file-run-btn running"
                  title={`Compiling ${e.name}…`}
                  aria-label={`Compiling ${e.name}`}
                >
                  <span className="file-run-spinner" />
                </span>
              )}
              <span className="file-icon">{e.is_dir ? folderIcon() : fileIcon(e.extension)}</span>
              <span className="file-name">{e.name}</span>
              {notOnRemote && (
                <span
                  className="file-offhost-tag"
                  title="This folder exists only in the local mirror — it isn't on the remote host yet."
                  aria-label="Local only — not on the remote host"
                >
                  local only
                </span>
              )}
              {e.is_dir && isScanExcluded(relForEntry(e)) ? (
                // Stands in for the size rather than sitting beside it: there is no
                // size to show, and saying why is more use than an empty column.
                <span
                  className="file-size file-size-excluded"
                  title="Excluded from scans — its size isn't computed and its file activity isn't counted. Right-click to include it again."
                >
                  not scanned
                </span>
              ) : e.is_dir ? (
                dirShown !== undefined && (
                  <span className={`file-size ${sizeCategory(dirShown)}`}>
                    {fmtSize(dirShown)}
                  </span>
                )
              ) : (
                <span className={`file-size ${sizeClass}`}>{fmtSize(e.size)}</span>
              )}
            </div>
          );
        }

        return (
          <>
            {regular.map((e) => renderEntry(e, false))}
            {standard.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={scaffoldExpanded}
                  onClick={() => setScaffoldExpanded((v) => !v)}
                  title={scaffoldExpanded ? "Collapse scaffold files" : "Expand scaffold files"}
                >
                  <span className="file-tree-hidden-caret">{scaffoldExpanded ? "▾" : "▸"}</span>
                  scaffold ({standard.length})
                  <span
                    className="file-tree-path-total"
                    title={sizeTitle(groupSizes.standard, groupSizes.standardIgnored, "Total size of the scaffold group")}
                  >
                    {fmtSize(groupSizes.standard)}
                  </span>
                </button>
                {scaffoldExpanded && standard.map((e) => renderEntry(e, true))}
              </>
            )}
            {gitignored.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={gitignoredExpanded}
                  onClick={() => setGitignoredExpanded((v) => {
                    const next = !v;
                    try { localStorage.setItem(GITIGNORED_EXPANDED_KEY, next ? "1" : "0"); } catch { /* ignore storage failures */ }
                    return next;
                  })}
                  title={gitignoredExpanded ? "Collapse gitignored files" : "Expand gitignored files"}
                >
                  <span className="file-tree-hidden-caret">{gitignoredExpanded ? "▾" : "▸"}</span>
                  gitignored ({gitignored.length})
                  <span className="file-tree-path-total" title="Total size of the gitignored group">
                    {fmtSize(groupSizes.gitignored)}
                  </span>
                </button>
                {gitignoredExpanded && gitignored.map((e) => renderEntry(e, false, true))}
              </>
            )}
          </>
        );
      })()}
      {contextMenu?.rowRect && createPortal(
        <div
          key={contextMenu.entry?.path ?? "root"}
          className="file-entry-highlight"
          style={{
            left: contextMenu.rowRect.left,
            top: contextMenu.rowRect.top,
            width: contextMenu.rowRect.width,
            height: contextMenu.rowRect.height,
          }}
        />,
        document.body,
      )}
      {argsPopover &&
        createPortal(
          <div className="file-run-args-backdrop" onMouseDown={() => setArgsPopover(null)}>
            <div
              ref={argsPopoverRef}
              className="file-run-args"
              style={{ left: argsPopover.x, top: argsPopover.y }}
              onMouseDown={(ev) => ev.stopPropagation()}
              role="dialog"
              aria-label={`Run arguments for ${argsPopover.entry.name}`}
            >
              <label className="file-run-args-label">
                Arguments (sys.argv) — {argsPopover.entry.name}
              </label>
              <input
                ref={argsInputRef}
                className="file-run-args-input"
                value={argsPopover.draft}
                spellCheck={false}
                placeholder="--epochs 5 data.csv"
                onChange={(ev) =>
                  setArgsPopover((p) => (p ? { ...p, draft: ev.target.value } : p))
                }
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    const a = argsPopover.draft.trim();
                    setPyArgs(argsPopover.entry.path, a);
                    launchPython(argsPopover.entry, a);
                    setArgsPopover(null);
                  } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    setArgsPopover(null);
                  }
                }}
              />
              <div className="file-run-args-row">
                <button
                  type="button"
                  className="file-run-args-btn"
                  onClick={() => {
                    const a = argsPopover.draft.trim();
                    setPyArgs(argsPopover.entry.path, a);
                    launchPython(argsPopover.entry, a);
                    setArgsPopover(null);
                  }}
                >
                  ▶ Run
                </button>
                <button
                  type="button"
                  className="file-run-args-btn"
                  onClick={() => {
                    const a = argsPopover.draft.trim();
                    setPyArgs(argsPopover.entry.path, a);
                    setArgsPopover(null);
                  }}
                  title="Remember these arguments without running now"
                >
                  Save
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu file-browser-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!contextMenu.entry && (
            <>
              {onOpenFolderTab && (
                <>
                  <button
                    onClick={() => {
                      setContextMenu(null);
                      onOpenFolderTab(relPath);
                    }}
                  >
                    Open this view in a new tab
                  </button>
                  <hr />
                </>
              )}
              <button onClick={() => createEntry("file")}>
                New File
              </button>
              <button onClick={() => createEntry("dir")}>
                New Folder
              </button>
              {treatLocal && (
                <>
                  <hr />
                  <button onClick={() => pushAllToHost()}>
                    Push all to host
                  </button>
                </>
              )}
              {(clipboard || clipboardImage) && <hr />}
              {renderPasteButton()}
              {clipboardImage && (
                <button onClick={openScreenshotPrompt}>
                  Paste screenshot
                </button>
              )}
            </>
          )}
          {contextMenu.entry && (() => {
            const entry = contextMenu.entry;
            // When the right-clicked row is part of a >1 selection, the menu acts
            // on the whole selection (bulk Copy/Cut/Delete only — the per-file
            // actions like Rename / Stage / Set-default-app don't generalise).
            const menuEntries =
              selected.has(entry.path) && selected.size > 1
                ? entries.filter((en) => selected.has(en.path))
                : [entry];
            if (menuEntries.length > 1) {
              const n = menuEntries.length;
              return (
                <>
                  <button onClick={() => copyEntries(menuEntries, "copy")}>Copy {n} items</button>
                  <button onClick={() => copyEntries(menuEntries, "cut")}>Cut {n} items</button>
                  {renderPasteButton()}
                  <hr />
                  <button className="danger" onClick={() => promptDelete(menuEntries)}>
                    Delete {n} items
                  </button>
                </>
              );
            }
            const status = gitStatuses[entry.name];
            const isTex = !entry.is_dir && entry.extension === ".tex";
            const isZip = !entry.is_dir && entry.extension === ".zip";
            const entryRel = relForEntry(entry);
            const syncSel = remoteListing ? syncStatus?.[entryRel]?.selected : false;
            // Auto-sync is symmetric across the remote/local trees (both are
            // sync-tracked); read the effective flag either way.
            const syncTracked = remoteListing || treatLocal;
            const autoOn = syncTracked ? !!syncStatus?.[entryRel]?.auto : false;
            return (
              <>
                {onOpenFolderTab && entry.is_dir && (
                  <>
                    <button
                      onClick={() => {
                        setContextMenu(null);
                        onOpenFolderTab(entryRel);
                      }}
                    >
                      Open in a new tab
                    </button>
                    <hr />
                  </>
                )}
                {/* Local trees only: the exclusion governs the LOCAL walks (the
                    size walk and the churn watcher). A remote folder's size comes
                    from `du` on the host, which this list has no say over. */}
                {onToggleScanExcluded && entry.is_dir && !remoteListing && (
                  <>
                    <button
                      onClick={() => {
                        setContextMenu(null);
                        const now = isScanExcluded(entryRel);
                        onToggleScanExcluded(entryRel, !now);
                        // Drop any size already shown for the folder: leaving the
                        // old number up would claim a figure we've stopped keeping
                        // current. Re-including re-requests it via `requestedSizes`.
                        requestedSizes.current.delete(entry.path);
                        setDirSizes((m) => {
                          const next = { ...m };
                          delete next[entry.path];
                          return next;
                        });
                        setDirIgnoredBytes((m) => {
                          const next = { ...m };
                          delete next[entry.path];
                          return next;
                        });
                      }}
                      title={
                        isScanExcluded(entryRel)
                          ? "Resume computing this folder's size and counting its file activity"
                          : "Never walk this folder: no size calculation, no file-activity counting"
                      }
                    >
                      {isScanExcluded(entryRel) ? "Include in scans" : "Exclude from scans"}
                    </button>
                    <hr />
                  </>
                )}
                {remoteListing && (
                  <>
                    <button onClick={() => syncEntryToLocal(entry)}>
                      {entry.is_dir ? "Sync folder to local" : "Sync to local"}
                    </button>
                    {syncSel && (
                      <button onClick={() => stopSyncingEntry(entry)}>
                        Stop syncing
                      </button>
                    )}
                    <hr />
                  </>
                )}
                {treatLocal && (
                  <>
                    <button onClick={() => pushEntryToHost(entry)}>
                      {entry.is_dir ? "Push folder to host" : "Push to host"}
                    </button>
                    <hr />
                  </>
                )}
                {syncTracked && (
                  <>
                    <button onClick={() => toggleAutoSyncEntry(entry, !autoOn)}>
                      {autoOn
                        ? entry.is_dir
                          ? "Stop auto-syncing folder"
                          : "Stop auto-syncing"
                        : entry.is_dir
                          ? "Auto-sync this folder"
                          : "Auto-sync this file"}
                    </button>
                    <hr />
                  </>
                )}
                {isZip && (
                  <>
                    <button onClick={() => extractArchive(entry)}>
                      Extract here
                    </button>
                    <hr />
                  </>
                )}
                {isTex && texCap?.available && (
                  <>
                    <button
                      onClick={() => compileTex(entry, true)}
                      disabled={compiling.has(entry.path)}
                    >
                      Compile &amp; View PDF
                    </button>
                    <button
                      onClick={() => compileTex(entry, false)}
                      disabled={compiling.has(entry.path)}
                    >
                      Compile PDF
                    </button>
                    <hr />
                  </>
                )}
                {(status === "modified" || status === "untracked") && (
                  <button onClick={() => stageEntry(entry)}>
                    Stage (git add)
                  </button>
                )}
                {status && !entry.is_dir && (
                  <button onClick={() => showDiff(entry)}>
                    Show diff
                  </button>
                )}
                <button onClick={() => updateGitignore(entry, "ignore")}>
                  Add to .gitignore
                </button>
                <button onClick={() => updateGitignore(entry, "unignore")}>
                  Show from .gitignore
                </button>
                {!entry.is_dir && entry.extension && (
                  <>
                    <hr />
                    <button onClick={() => { setContextMenu(null); setDefaultAppFor(entry); }}>
                      Set default app…
                    </button>
                  </>
                )}
                <hr />
                <button onClick={() => copyEntries([entry], "copy")}>
                  Copy
                </button>
                <button onClick={() => copyEntries([entry], "cut")}>
                  Cut
                </button>
                {renderPasteButton()}
                {clipboardImage && (
                  <button onClick={openScreenshotPrompt}>
                    Paste screenshot
                  </button>
                )}
                <hr />
                <button onClick={() => renameEntry(entry)}>
                  Rename
                </button>
                <button className="danger" onClick={() => promptDelete([entry])}>
                  Delete
                </button>
              </>
            );
          })()}
          <button onClick={() => setContextMenu(null)}>Cancel</button>
        </div>,
        document.body,
      )}
      {deleteConfirm && createPortal(
        <div className="modal-backdrop" onMouseDown={() => setDeleteConfirm(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            {deleteConfirm.entries.length === 1 ? (
              <>
                <h2>Delete {deleteConfirm.entries[0].is_dir ? "Folder" : "File"}</h2>
                <p>
                  Delete <strong>{deleteConfirm.entries[0].name}</strong>? This permanently removes it from the project.
                </p>
                <div className="file-delete-path">{relForEntry(deleteConfirm.entries[0])}</div>
              </>
            ) : (
              <>
                <h2>Delete {deleteConfirm.entries.length} items</h2>
                <p>
                  Delete these <strong>{deleteConfirm.entries.length}</strong> items? This permanently removes them from the project.
                </p>
                <div className="file-delete-path">
                  {deleteConfirm.entries.map((e) => e.name).join(", ")}
                </div>
              </>
            )}
            <div className="file-delete-actions">
              <button type="button" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button type="button" className="danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {autoConfirm && createPortal(
        <div className="modal-backdrop" onMouseDown={() => setAutoConfirm(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Auto-sync this folder?</h2>
            <p>
              Auto-syncing <strong>{autoConfirm.entry.name}</strong> will pull{" "}
              <strong>{autoConfirm.files.toLocaleString()} files</strong> (
              {fmtSize(autoConfirm.bytes)}) from the host into the local mirror, and
              keep pulling as it changes.
            </p>
            <p>
              Auto-sync copies bytes and <strong>does not read .gitignore</strong>, so
              files kept on the host on purpose — experiment output, checkpoints, data
              — are synced like any other.
            </p>
            <div className="file-delete-path">{relForEntry(autoConfirm.entry)}</div>
            <div className="file-delete-actions">
              <button type="button" onClick={() => setAutoConfirm(null)}>Cancel</button>
              <button
                type="button"
                onClick={() => applyAutoSync(autoConfirm.entry, true)}
              >
                Auto-sync anyway
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {pushConflicts.length > 0 && createPortal(
        <div className="modal-backdrop" onMouseDown={() => !pushBusy && resolvePushConflict("skip")}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Host changed since last sync</h2>
            <p>
              <strong>{basename(pushConflicts[0]) || pushConflicts[0]}</strong> was
              modified on the host since you last synced it. Pushing your local copy
              would overwrite that change.
            </p>
            <div className="file-delete-path">{pushConflicts[0]}</div>
            {pushConflicts.length > 1 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {pushConflicts.length - 1} more conflict{pushConflicts.length - 1 > 1 ? "s" : ""} after this.
              </p>
            )}
            <div className="file-delete-actions">
              <button type="button" disabled={pushBusy} onClick={() => resolvePushConflict("skip")}>
                Skip
              </button>
              <button type="button" disabled={pushBusy} onClick={() => resolvePushConflict("host")}>
                Take host
              </button>
              <button type="button" className="danger" disabled={pushBusy} onClick={() => resolvePushConflict("keep")}>
                Keep local
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {pastePrompt && createPortal(
        <div className="modal-backdrop" onMouseDown={() => !pasteBusy && setPastePrompt(null)}>
          <div className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>
              {pastePrompt.kind === "image"
                ? "Paste Screenshot"
                : `Paste ${clipboard?.isDir ? "Folder" : "File"}`}
            </h2>
            <p>
              {pastePrompt.kind === "image" ? (
                <>Save clipboard image</>
              ) : (
                <>
                  {clipboard?.op === "cut" ? "Move" : "Copy"} <strong>{clipboard?.name}</strong>
                </>
              )}{" "}
              into <strong>{relPath || basename(projectDir) || "project root"}</strong> as:
            </p>
            <input
              className="file-paste-name"
              autoFocus
              value={pastePrompt.name}
              disabled={pasteBusy}
              onChange={(e) => setPastePrompt({ ...pastePrompt, name: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmPaste();
                if (e.key === "Escape") setPastePrompt(null);
              }}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 6,
                fontSize: 12,
                background: "var(--bg-panel)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 6px",
                fontFamily: "inherit",
              }}
            />
            {pastePrompt.error && (
              <div className="file-delete-path" style={{ color: "var(--danger, #f85149)" }}>
                {pastePrompt.error}
              </div>
            )}
            <div className="file-delete-actions">
              <button type="button" onClick={() => setPastePrompt(null)} disabled={pasteBusy}>Cancel</button>
              <button type="button" onClick={confirmPaste} disabled={pasteBusy || !pastePrompt.name.trim()}>
                {pastePrompt.kind === "file" && clipboard?.op === "cut" ? "Move" : "Paste"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {defaultAppFor && defaultAppFor.extension && (
        <SetDefaultAppDialog
          ext={defaultAppFor.extension}
          fileName={defaultAppFor.name}
          localFile={localFile}
          onClose={() => setDefaultAppFor(null)}
        />
      )}
      {tooltip && createPortal(
        <div
          className="file-tooltip"
          // Anchor on whichever side of the row has more room, so the tooltip pops
          // *away* from the panel edge: docked right → opens left (the default),
          // docked left → the row sits near x:0 and it opens right instead. Keyed
          // off the row's own rect, so it does the right thing in a centred tab too.
          style={
            window.innerWidth - tooltip.rect.right > tooltip.rect.left
              ? { left: tooltip.rect.right + 8, top: tooltip.rect.top }
              : { right: window.innerWidth - tooltip.rect.left + 8, top: tooltip.rect.top }
          }
        >
          <div className="file-tooltip-name">{tooltip.entry.name}</div>
          {tooltip.entry.created_secs && (
            <div><span className="file-tooltip-label">Created </span>{fmtModified(tooltip.entry.created_secs)}</div>
          )}
          {tooltip.entry.modified_secs && (
            <div><span className="file-tooltip-label">Modified</span>{fmtModified(tooltip.entry.modified_secs)}</div>
          )}
          {/* Same rule as the row: no ignored/total split for a folder that is
              itself ignored — "412 MB of 412 MB ignored" says nothing. */}
          {tooltip.entry.is_dir
            && gitStatuses[tooltip.entry.name] !== "ignored"
            && dirIgnoredBytes[tooltip.entry.path] !== undefined && (
            <div>
              <span className="file-tooltip-label">Ignored </span>
              {fmtSize(dirIgnoredBytes[tooltip.entry.path])}
              {dirSizes[tooltip.entry.path] !== undefined && ` of ${fmtSize(dirSizes[tooltip.entry.path])} total`}
            </div>
          )}
          {!tooltip.entry.is_dir && isPythonPath(tooltip.entry.path) && (
            (remoteListing || pyMainByPath[tooltip.entry.path] || pyArgsByPath[tooltip.entry.path])
          ) && (
            <>
              {(remoteListing || pyMainByPath[tooltip.entry.path]) && (
                <div>
                  <span className="file-tooltip-label">Run </span>
                  Right-click ▶ to set arguments
                </div>
              )}
              {/* Nested under Run, not a top-level "Run args" row — and shown
                  even when the file above lost its Run button (no `__main__`
                  guard), so args set earlier don't just look lost. */}
              {pyArgsByPath[tooltip.entry.path] && (
                <div className="file-tooltip-sub">
                  <span className="file-tooltip-label">args </span>
                  {pyArgsByPath[tooltip.entry.path]}
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
